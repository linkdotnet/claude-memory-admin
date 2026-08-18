// Local-only HTTP server: static frontend plus a small JSON API over the
// memory store. Binds 127.0.0.1 and never serves anything outside ./public
// and the two vendored browser bundles.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { listProjects, projectsRoot } from './src/projects.mjs';
import { buildProject } from './src/model.mjs';
import { searchAll } from './src/search.mjs';
import {
  deleteIndexLine,
  deleteMemories,
  deleteMemory,
  deletePreview,
  deleteProject,
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

/** A slug is only ever accepted if it names a directory we actually discovered. */
function requireSlug(slug) {
  const known = listProjects(ROOT).some((p) => p.slug === slug);
  if (!known) throw new Error(`Unknown project: ${slug}`);
  return slug;
}

async function handleApi(req, res, url) {
  const segments = url.pathname.split('/').filter(Boolean); // ['api', 'projects', ...]

  if (segments.length === 2 && segments[1] === 'projects' && req.method === 'GET') {
    return sendJson(res, 200, { root: ROOT, projects: listProjects(ROOT) });
  }

  if (segments.length === 2 && segments[1] === 'search' && req.method === 'GET') {
    return sendJson(res, 200, searchAll(ROOT, url.searchParams.get('q') || ''));
  }

  if (segments[1] !== 'projects' || segments.length < 3) {
    return sendJson(res, 404, { error: 'Unknown endpoint' });
  }

  const slug = requireSlug(decodeURIComponent(segments[2]));
  const action = segments.slice(3).join('/');

  if (!action && req.method === 'GET') {
    return sendJson(res, 200, buildProject(ROOT, slug));
  }

  if (action === 'delete-preview' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, deletePreview(ROOT, slug, body.file));
  }

  if (action === 'delete' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, deleteMemory(ROOT, slug, body.file, body.alsoDelete || []));
  }

  if (action === 'delete-many' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, deleteMemories(ROOT, slug, body.files || [], { label: body.label || null }));
  }

  if (action === 'project/delete-preview' && req.method === 'POST') {
    return sendJson(res, 200, projectDeletePreview(ROOT, slug));
  }

  if (action === 'project/delete' && req.method === 'POST') {
    return sendJson(res, 200, deleteProject(ROOT, slug));
  }

  if (action === 'wikilink/remove' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, removeWikilink(ROOT, slug, body.file, body.target));
  }

  if (action === 'restore' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, restoreMemory(ROOT, slug, body.id));
  }

  if (action === 'index-line/delete' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, deleteIndexLine(ROOT, slug, body.lineIndex, body.expectedText));
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
