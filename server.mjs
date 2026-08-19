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
import { resolveInstructions } from './src/instructions.mjs';
import { settingsReport } from './src/settings.mjs';
import { listStores } from './src/stores.mjs';
import { forgetPath, rememberPath } from './src/pathcache.mjs';
import { searchAll } from './src/search.mjs';
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

function storeProjectDir(store) {
  if (store.kind !== 'auto') return store.projectPath || null;
  return store.pathExists ? store.path : null;
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
      stores: listStores(ROOT),
    });
  }

  if (segments.length === 2 && segments[1] === 'search' && req.method === 'GET') {
    return sendJson(res, 200, searchAll(ROOT, url.searchParams.get('q') || ''));
  }

  if (segments[1] !== 'stores' || segments.length < 3) {
    return sendJson(res, 404, { error: 'Unknown endpoint' });
  }

  const store = requireStore(decodeURIComponent(segments[2]));
  const dir = store.dir;
  const action = segments.slice(3).join('/');

  if (!action && req.method === 'GET') {
    return sendJson(res, 200, buildStore(store));
  }

  // What a session starting in this store's project would load as instructions.
  // Read-only, and scoped to a directory the app already discovered rather than
  // one named in the request.
  if (action === 'instructions' && req.method === 'GET') {
    const projectDir = storeProjectDir(store);
    if (!projectDir) return sendJson(res, 200, { projectDir: null, files: [], problems: [], excluded: [], totals: null });
    return sendJson(res, 200, resolveInstructions(projectDir));
  }

  if (action === 'settings' && req.method === 'GET') {
    return sendJson(res, 200, settingsReport({ projectDir: storeProjectDir(store) }));
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
    if (open && !process.env.NO_OPEN) {
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      spawn(opener, [address], { stdio: 'ignore', detached: true }).unref();
    }
  });
  return server;
}

// Running `node server.mjs` directly still just works.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startServer();
}
