// Local-only HTTP server: static frontend plus a small JSON API over the
// memory store. Binds 127.0.0.1 and never serves anything outside ./public
// and the two vendored browser bundles.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { projectsRoot, resolveRoot } from './src/projects.mjs';
import { buildStore } from './src/model.mjs';
import { resolveGlobalInstructions, resolveInstructions, summarise } from './src/instructions.mjs';
import { settingsReport, summariseSettings } from './src/settings.mjs';
import { costReport, writeUserSetting } from './src/cost.mjs';
import { AGENTS_DIR, AGENT_FIELDS, agentsDirExists, listAllAgents, setAgentField } from './src/agents.mjs';
import { listStores } from './src/stores.mjs';
import { forgetPath, rememberPath } from './src/pathcache.mjs';
import { searchAll } from './src/search.mjs';
import { verifyPaths } from './src/pathcheck.mjs';
import { detectTools, toolReport } from './src/tools.mjs';
import { sessionsWithSummaries, transcriptDir } from './src/sessions.mjs';
import { readLiveSessions } from './src/liveSessions.mjs';
import {
  addIndexEntry,
  addIndexEntryPreview,
  deleteIndexLine,
  deleteMemories,
  deleteMemory,
  deletePreview,
  deleteProject,
  editIndexHook,
  mergeMemories,
  mergePreview,
  moveIndexEntry,
  projectDeletePreview,
  removeWikilink,
  restoreMemory,
} from './src/mutate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, 'public');

/**
 * Locate the browser builds of the two dependencies.
 *
 * A hard-coded ./node_modules path breaks as soon as the package is installed
 * globally and npm hoists dependencies somewhere else. import.meta.resolve
 * follows the same resolution the runtime would, and picks the `import`
 * condition, which is what gives the ESM build rather than the CommonJS one.
 */
function resolveVendor(specifier) {
  try {
    return fileURLToPath(import.meta.resolve(specifier));
  } catch {
    return null;
  }
}

const VENDOR = {
  '/vendor/marked.js': resolveVendor('marked'),
  '/vendor/purify.js': resolveVendor('dompurify'),
};

let ROOT = projectsRoot();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * An id is only ever accepted if it names a store we actually discovered, which
 * is what keeps a request from addressing a directory the app never found.
 */
function requireStore(id) {
  const store = listStores(ROOT).find((candidate) => candidate.id === id);
  if (!store) throw new Error(`Unknown store: ${id}`);
  return store;
}

const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || null;
  } catch {
    return null;
  }
})();

/**
 * Every agent definition on the machine: the user directory plus the agents
 * directory of each repository auto memory has already resolved a path for.
 * Nothing here guesses at a repository that was not confirmed somewhere else.
 */
function allAgents() {
  const projectPaths = listStores(ROOT)
    .filter((store) => store.kind === 'auto' && store.pathExists)
    .flatMap((store) => [store.path, ...(store.workingDirs || [])]);
  return listAllAgents({ projectPaths });
}

/** Each subagent memory store next to the definition that asks for it, for the agents panel. */
function agentStoreLinks() {
  return listStores(ROOT)
    .filter((store) => String(store.kind).startsWith('agent-'))
    .map((store) => ({
      id: store.id,
      kind: store.kind,
      agentName: store.agentName,
      projectPath: store.projectPath,
      memoryCount: store.memoryCount,
      declaredBy: store.declaredBy ?? null,
      declaredScope: store.declaredScope ?? null,
      linked: Boolean(store.linked),
      defined: Boolean(store.defined),
      inert: Boolean(store.inert),
      inertBy: store.inertBy ?? null,
    }));
}

/**
 * Hand the address to whatever opens a URL here, and never let that decide
 * whether the server runs.
 *
 * `start` is a cmd.exe builtin rather than a program, so spawning it by name
 * fails on Windows; the documented form is `cmd /c start "" <url>`, where the
 * empty string is the window title `start` would otherwise read the URL as. On
 * Linux `xdg-open` is simply missing on a minimal install and inside some
 * containers. Either way the failure arrives as an async 'error' event, which
 * with no listener is an uncaught exception that would take down a server that
 * had already printed its address and was working perfectly well.
 */
function openBrowser(address) {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [address]]
    : process.platform === 'win32'
      ? [process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', 'start', '""', address.replace(/&/g, '^&')]]
      : ['xdg-open', [address]];

  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {
      console.log('Could not open a browser automatically - open the address above yourself.');
    });
    child.unref();
  } catch {
    console.log('Could not open a browser automatically - open the address above yourself.');
  }
}

function storeProjectDir(store) {
  // The global store is the user scope itself, which no project owns.
  if (store.kind === 'global') return null;
  if (store.kind !== 'auto') return store.projectPath || null;
  return store.pathExists ? store.path : null;
}

/**
 * The global store holds instructions, not memory, and its directory is ~/.claude
 * itself. Every memory write endpoint below resolves a target inside `store.dir`,
 * so without this guard a delete aimed at it would land on the user's CLAUDE.md
 * and settings rather than on a memory file. It is refused here once rather than
 * in each of the fifteen handlers.
 *
 * The Cost handlers are the two exceptions, and the only writes this app makes
 * outside a memory store. They do not take a path from the request at all: one
 * writes an allowlisted key to ~/.claude/settings.json, the other one of two
 * frontmatter fields in a named file inside ~/.claude/agents. Neither can reach
 * an instruction file, which is what the rest of this guard exists to protect.
 */
const GLOBAL_WRITE_ACTIONS = new Set(['cost/setting', 'cost/agent']);

export function refuseWritesToGlobal(store, method, action = null) {
  if (store.kind !== 'global' || method === 'GET') return;
  if (action && GLOBAL_WRITE_ACTIONS.has(action)) return;
  throw new Error('The global store is read-only: it holds instruction files, not memory.');
}

/** A store with nothing to build a memory model from, in the shape the frontend expects. */
function emptyModel(store) {
  return {
    ...store,
    index: null,
    memories: [],
    graph: { nodes: [], edges: [], dangling: [] },
    health: { orphans: [], referencedOnly: [], danglingIndex: [], danglingWikilinks: [], nameMismatches: [], missingFrontmatter: [], longHooks: [], issues: [], issueCount: 0, severity: 'ok' },
    stats: null,
    duplicates: [],
    trash: [],
  };
}

const WORST = { ok: 0, warn: 1, bad: 2 };
const worst = (...severities) => severities.reduce((a, b) => (WORST[b] > WORST[a] ? b : a), 'ok');

/**
 * Counts only, for every store at once, so the sidebar can say which project is
 * in trouble before anything is opened. The full models are an order of
 * magnitude larger and none of them is needed to draw a dot.
 */
function issueSweep() {
  return listStores(ROOT).map((store) => {
    const summary = { id: store.id, issueCount: 0, severity: 'ok', context: 0, settings: 0 };

    if (store.kind !== 'global') {
      try {
        const { health } = buildStore(store);
        summary.issueCount = health.issueCount;
        summary.severity = health.severity;
      } catch { /* a store that cannot be read has nothing to report */ }
    }

    const projectDir = storeProjectDir(store);
    try {
      const instructions = store.kind === 'global'
        ? summarise(resolveGlobalInstructions().problems)
        : projectDir ? summarise(resolveInstructions(projectDir).problems) : null;
      if (instructions) {
        summary.context = instructions.count;
        summary.severity = worst(summary.severity, instructions.severity);
      }
    } catch { /* unreadable instruction chain is reported by the tab itself */ }

    if (projectDir) {
      try {
        const settings = summariseSettings(settingsReport({ projectDir }).problems);
        summary.settings = settings.count;
        summary.severity = worst(summary.severity, settings.severity);
      } catch { /* likewise */ }
    }

    return summary;
  });
}

async function handleApi(req, res, url) {
  const segments = url.pathname.split('/').filter(Boolean); // ['api', 'projects', ...]

  if (segments.length === 2 && segments[1] === 'stores' && req.method === 'GET') {
    const origin = resolveRoot();
    return sendJson(res, 200, {
      root: ROOT,
      // Which settings layer chose this store, so a non-default one is visible
      // rather than something the user has to infer from unfamiliar contents.
      rootSource: origin.path === ROOT ? origin.source : 'flag',
      rootFile: origin.path === ROOT ? origin.file : null,
      rootWarning: origin.invalid,
      version: VERSION,
      tools: detectTools(),
      stores: listStores(ROOT),
    });
  }

  if (segments.length === 2 && segments[1] === 'search' && req.method === 'GET') {
    return sendJson(res, 200, searchAll(ROOT, url.searchParams.get('q') || ''));
  }

  // Ahead of requireStore, which would otherwise read "issues" as a store id.
  // Real ids always carry a "kind:" prefix, so the two can never collide.
  if (segments.length === 3 && segments[1] === 'stores' && segments[2] === 'issues' && req.method === 'GET') {
    return sendJson(res, 200, { stores: issueSweep() });
  }

  // Same "ahead of requireStore" reasoning as the issues sweep above: real
  // store ids always carry a "kind:" prefix, so "active" can never collide.
  if (segments.length === 3 && segments[1] === 'stores' && segments[2] === 'active' && req.method === 'GET') {
    const live = readLiveSessions();
    const projectStores = listStores(ROOT).filter((s) => s.kind === 'auto' && s.pathExists);
    const sessions = live.map((session) => ({
      ...session,
      storeId: projectStores.find((s) => s.path === session.cwd)?.id ?? null,
    }));
    return sendJson(res, 200, { sessions });
  }

  if (segments[1] !== 'stores' || segments.length < 3) {
    return sendJson(res, 404, { error: 'Unknown endpoint' });
  }

  const store = requireStore(decodeURIComponent(segments[2]));
  const action = segments.slice(3).join('/');
  refuseWritesToGlobal(store, req.method, action);
  const dir = store.dir;

  if (!action && req.method === 'GET') {
    // buildStore reads every .md in the directory as a memory file, which for
    // ~/.claude would present CLAUDE.md and its neighbours as memories.
    return sendJson(res, 200, store.kind === 'global' ? emptyModel(store) : buildStore(store));
  }

  // What a session starting in this store's project would load as instructions.
  // Read-only, and scoped to a directory the app already discovered rather than
  // one named in the request.
  if (action === 'instructions' && req.method === 'GET') {
    if (store.kind === 'global') return sendJson(res, 200, resolveGlobalInstructions());
    const projectDir = storeProjectDir(store);
    if (!projectDir) return sendJson(res, 200, { projectDir: null, files: [], problems: [], excluded: [], totals: null });
    return sendJson(res, 200, resolveInstructions(projectDir));
  }

  // Opt-in, and the only read this app makes into a project's own tree. Refused
  // outright when nothing resolved a project directory, so a store can never be
  // talked into stat-ing a path it has no business knowing about.
  if (action === 'path-check' && req.method === 'GET') {
    const projectDir = storeProjectDir(store);
    if (!projectDir) {
      return sendJson(res, 400, { error: 'This store is not tied to a project directory, so there is nothing to check paths against.' });
    }
    const { memories } = buildStore(store);
    return sendJson(res, 200, verifyPaths(projectDir, memories));
  }

  if (action === 'sessions' && req.method === 'GET') {
    const slugDir = transcriptDir(store);
    if (!slugDir) {
      return sendJson(res, 400, { error: 'This store keeps no session transcripts.' });
    }
    return sendJson(res, 200, sessionsWithSummaries(slugDir, { projectDir: storeProjectDir(store) }));
  }

  if (action.startsWith('tools/') && req.method === 'GET') {
    const target = {
      projectDir: store.kind === 'global' ? null : storeProjectDir(store),
      slug: store.kind === 'auto' ? store.slug : null,
    };
    return sendJson(res, 200, await toolReport(action.slice('tools/'.length), target));
  }

  if (action === 'settings' && req.method === 'GET') {
    return sendJson(res, 200, settingsReport({ projectDir: storeProjectDir(store) }));
  }

  // The Cost segment. User scope only: the knobs it writes are about every
  // session on the machine, and the file it writes them to is ~/.claude/settings.json.
  if ((action === 'cost' || action.startsWith('cost/')) && store.kind !== 'global') {
    return sendJson(res, 400, { error: 'The cost settings are user-scope, and are edited from the Global entry.' });
  }

  if (action === 'cost' && req.method === 'GET') {
    return sendJson(res, 200, {
      settings: costReport(),
      // Project-scope definitions come along read-only: an agent with
      // `memory: project` lives in a repository rather than in the user
      // directory, and leaving it out would show its memory store as belonging
      // to no agent at all.
      agents: allAgents(),
      agentsDir: AGENTS_DIR,
      agentsDirExists: agentsDirExists(),
      agentFields: AGENT_FIELDS,
      agentStores: agentStoreLinks(),
    });
  }

  if (action === 'cost/setting' && req.method === 'POST') {
    const body = await readBody(req);
    writeUserSetting(body.key, body.value ?? null);
    return sendJson(res, 200, { settings: costReport() });
  }

  if (action === 'cost/agent' && req.method === 'POST') {
    const body = await readBody(req);
    setAgentField(body.file, body.field, body.value ?? null);
    return sendJson(res, 200, {
      agents: allAgents(),
      agentsDir: AGENTS_DIR,
      agentsDirExists: agentsDirExists(),
      agentStores: agentStoreLinks(),
    });
  }

  if (action === 'delete-preview' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, deletePreview(dir, body.file));
  }

  if (action === 'delete' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, deleteMemory(dir, body.file, body.alsoDelete || []));
  }

  if (action === 'delete-many' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, deleteMemories(dir, body.files || [], { label: body.label || null }));
  }

  if (action === 'project/delete-preview' && req.method === 'POST') {
    return sendJson(res, 200, projectDeletePreview(dir));
  }

  if (action === 'project/delete' && req.method === 'POST') {
    return sendJson(res, 200, deleteProject(dir));
  }

  if (action === 'wikilink/remove' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, removeWikilink(dir, body.file, body.target));
  }

  if (action === 'restore' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, restoreMemory(dir, body.id));
  }

  // The only write outside a memory directory, and only ever on request: it
  // records a path the user confirmed so the store keeps its name after Claude
  // Code sweeps the transcripts that proved it.
  if (action === 'path/remember' && req.method === 'POST') {
    if (store.kind !== 'auto') throw new Error('Only project stores have a path to remember');
    const body = await readBody(req);
    return sendJson(res, 200, rememberPath(store.slug, body.path));
  }

  if (action === 'path/forget' && req.method === 'POST') {
    if (store.kind !== 'auto') throw new Error('Only project stores have a path to remember');
    return sendJson(res, 200, forgetPath(store.slug));
  }

  if (action === 'index/hook' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, editIndexHook(dir, body));
  }

  if (action === 'index/move' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, moveIndexEntry(dir, body));
  }

  if (action === 'index/add-preview' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, addIndexEntryPreview(dir, body));
  }

  if (action === 'index/add' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, addIndexEntry(dir, body));
  }

  if (action === 'merge-preview' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, mergePreview(dir, body));
  }

  if (action === 'merge' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, mergeMemories(dir, body));
  }

  if (action === 'index-line/delete' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, deleteIndexLine(dir, body.lineIndex, body.expectedText));
  }

  return sendJson(res, 404, { error: 'Unknown endpoint' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      sendJson(res, 400, { error: err.message });
    });
    return;
  }

  if (VENDOR[url.pathname]) return sendFile(res, VENDOR[url.pathname]);

  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const resolved = path.join(PUBLIC, path.normalize(requested).replace(/^(\.\.[/\\])+/, ''));
  if (!resolved.startsWith(PUBLIC)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  sendFile(res, resolved);
});

export function startServer({ port, root, open = true } = {}) {
  if (root) {
    process.env.MEMORY_ROOT = root;
    ROOT = projectsRoot();
  }
  // Number(undefined) is NaN, which ?? does not catch - check PORT is set first.
  const listenPort = port ?? (process.env.PORT ? Number(process.env.PORT) : 4173);

  for (const [route, file] of Object.entries(VENDOR)) {
    if (!file) {
      console.error(`Could not resolve the dependency behind ${route}. Try reinstalling the package.`);
      process.exit(1);
    }
  }

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${listenPort} is already in use. Pass --port to pick another.`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(listenPort, '127.0.0.1', () => {
    const address = `http://localhost:${listenPort}`;
    console.log(`Memory Admin  ->  ${address}`);
    console.log(`Reading       ->  ${ROOT}`);
    if (open && !process.env.NO_OPEN) openBrowser(address);
  });
  return server;
}

// Running `node server.mjs` directly still just works.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startServer();
}
