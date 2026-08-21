// The API surface of the global store.
//
// The write refusal is checked as a function rather than over HTTP on purpose.
// A global store's directory is ~/.claude itself, and the mutation handlers
// below the guard would happily trash CLAUDE.md if it ever stopped throwing. A
// test that proved that by trying it would destroy the developer's instructions
// on the run where it first regressed, which is not a price worth paying for
// covering the same line.

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { refuseWritesToGlobal, startServer } from '../server.mjs';
import { listStores } from '../src/stores.mjs';
import { FIXTURE_ROOT } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(here, 'fixtures', 'instructions', 'user-home');

test('the global store refuses every method that could write', () => {
  const global = listStores(FIXTURE_ROOT, { home: HOME })[0];
  assert.equal(global.kind, 'global');

  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    assert.throws(() => refuseWritesToGlobal(global, method), /read-only/);
  }
  assert.doesNotThrow(() => refuseWritesToGlobal(global, 'GET'));
});

test('every other kind of store is left writable', () => {
  for (const store of listStores(FIXTURE_ROOT, { home: HOME }).filter((s) => s.kind !== 'global')) {
    assert.doesNotThrow(() => refuseWritesToGlobal(store, 'POST'));
  }
});

test('the issue sweep counts every store without shipping any of their models', async () => {
  const server = startServer({ port: 0, root: FIXTURE_ROOT, open: false });
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const listing = await (await fetch(`${base}/api/stores`)).json();
    const sweep = await (await fetch(`${base}/api/stores/issues`)).json();

    assert.deepEqual(
      sweep.stores.map((s) => s.id).sort(),
      listing.stores.map((s) => s.id).sort(),
      'every listed store gets a dot',
    );

    for (const summary of sweep.stores) {
      assert.ok(['ok', 'warn', 'bad'].includes(summary.severity));
      assert.equal(typeof summary.issueCount, 'number');
      assert.ok(!('memories' in summary) && !('health' in summary), 'counts only, never the model');
    }

    const messy = listing.stores.find((s) => s.slug === '-Users-demo-repos-messy');
    const model = await (await fetch(`${base}/api/stores/${encodeURIComponent(messy.id)}`)).json();
    const summary = sweep.stores.find((s) => s.id === messy.id);
    assert.equal(summary.issueCount, model.health.issueCount, 'the dot and the badge count the same issues');
    assert.equal(summary.severity, 'bad');
  } finally {
    server.close();
  }
});

test('the active-sessions endpoint answers with a session list, tagged with the store it belongs to', async () => {
  const server = startServer({ port: 0, root: FIXTURE_ROOT, open: false });
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const active = await (await fetch(`${base}/api/stores/active`)).json();
    assert.ok(Array.isArray(active.sessions));
    for (const session of active.sessions) {
      assert.equal(typeof session.pid, 'number');
      assert.ok('storeId' in session);
    }
  } finally {
    server.close();
  }
});

test('a store with no project directory refuses the path check instead of guessing one', async () => {
  const server = startServer({ port: 0, root: FIXTURE_ROOT, open: false });
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const listing = await (await fetch(`${base}/api/stores`)).json();
    const unresolved = listing.stores.find((s) => s.kind === 'auto' && s.resolvedBy === 'unresolved');
    if (!unresolved) return;

    const response = await fetch(`${base}/api/stores/${encodeURIComponent(unresolved.id)}/path-check`);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /not tied to a project directory/);
  } finally {
    server.close();
  }
});

test('the global store answers the read endpoints and holds no memory', async () => {
  const server = startServer({ port: 0, root: FIXTURE_ROOT, open: false });
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const listing = await (await fetch(`${base}/api/stores`)).json();
    const global = listing.stores.find((s) => s.kind === 'global');
    assert.ok(global, 'the listing must offer the user scope');
    assert.equal(listing.stores[0].id, global.id, 'and offer it first');

    const model = await (await fetch(`${base}/api/stores/${encodeURIComponent(global.id)}`)).json();
    // ~/.claude is full of .md files that are not memories, and the model must
    // not present them as any.
    assert.deepEqual(model.memories, []);
    assert.equal(model.index, null);
    assert.deepEqual(model.trash, []);

    const instructions = await (await fetch(`${base}/api/stores/${encodeURIComponent(global.id)}/instructions`)).json();
    assert.equal(instructions.projectDir, null);
    assert.ok(instructions.totals, 'the user scope resolves without a project');
    assert.ok(instructions.files.every((f) => f.scope === 'user' || f.scope === 'managed'));

    // Aimed at path/remember rather than project/delete: both sit behind the same
    // guard, and this one's handler is harmless if the guard ever stops running,
    // while the other one's would trash the developer's real CLAUDE.md. The
    // message is asserted because the unguarded handler would refuse too, with a
    // different one.
    const refused = await fetch(`${base}/api/stores/${encodeURIComponent(global.id)}/path/remember`, { method: 'POST' });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /read-only/);
  } finally {
    server.close();
  }
});

test('the sessions endpoint reads the transcripts beside a store, and refuses stores that have none', async () => {
  const server = startServer({ port: 0, root: FIXTURE_ROOT, open: false });
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const listing = await (await fetch(`${base}/api/stores`)).json();
    const alpha = listing.stores.find((s) => s.slug === '-Users-demo-repos-alpha');
    const data = await (await fetch(`${base}/api/stores/${encodeURIComponent(alpha.id)}/sessions`)).json();

    assert.equal(data.count, 1, 'the subagent transcript is not a session');
    assert.equal(data.sessions[0].title, 'Alpha project conventions');
    assert.equal(data.days, 30);
    assert.ok(!('file' in data.sessions[0]) || path.isAbsolute(data.sessions[0].file));

    for (const kind of ['global', 'agent-user']) {
      const store = listing.stores.find((s) => s.kind === kind);
      if (!store) continue;
      const response = await fetch(`${base}/api/stores/${encodeURIComponent(store.id)}/sessions`);
      assert.equal(response.status, 400, `${kind} should have no sessions endpoint`);
      assert.match((await response.json()).error, /no session transcripts/);
    }
  } finally {
    server.close();
  }
});

test('the store model carries provenance for every memory that claims one', async () => {
  const server = startServer({ port: 0, root: FIXTURE_ROOT, open: false });
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const listing = await (await fetch(`${base}/api/stores`)).json();
    const alpha = listing.stores.find((s) => s.slug === '-Users-demo-repos-alpha');
    const model = await (await fetch(`${base}/api/stores/${encodeURIComponent(alpha.id)}`)).json();

    const byFile = new Map(model.memories.map((m) => [m.file, m]));
    assert.equal(byFile.get('alpha-setup.md').origin.present, true, 'its transcript is still on disk');
    assert.equal(byFile.get('beta-conventions.md').origin.present, false, 'its transcript is swept');
    assert.equal(model.sessions.count, 1);
    assert.equal(model.sessions.retentionDays, 30);
  } finally {
    server.close();
  }
});

test('the store listing names the companion tools it found on PATH', async () => {
  const server = startServer({ port: 0, root: FIXTURE_ROOT, open: false });
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const listing = await (await fetch(`${base}/api/stores`)).json();
    assert.ok(Array.isArray(listing.tools));
    const rtk = listing.tools.find((tool) => tool.id === 'rtk');
    assert.ok(rtk, 'rtk is the tool the tab strip asks about');
    assert.equal(typeof rtk.found, 'boolean');
    assert.equal(rtk.found ? typeof rtk.path : rtk.path, rtk.found ? 'string' : null);
    for (const tool of listing.tools) {
      assert.equal(typeof tool.label, 'string');
      assert.match(tool.repo, /^https:\/\//);
    }
  } finally {
    server.close();
  }
});

test('a machine without rtk is told so, rather than served a stack trace', async () => {
  const server = startServer({ port: 0, root: FIXTURE_ROOT, open: false });
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const realPath = process.env.PATH;

  try {
    process.env.PATH = '';
    const listing = await (await fetch(`${base}/api/stores`)).json();
    assert.ok(listing.tools.length > 0);
    for (const tool of listing.tools) {
      assert.equal(tool.found, false);
      assert.equal(tool.path, null);
      assert.match(tool.repo, /^https:\/\//);
    }

    const store = listing.stores.find((s) => s.kind === 'auto');
    const response = await fetch(`${base}/api/stores/${encodeURIComponent(store.id)}/tools/rtk`);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /rtk is not installed/);

    const unknown = await fetch(`${base}/api/stores/${encodeURIComponent(store.id)}/tools/whoami`);
    assert.equal(unknown.status, 400);
    assert.match((await unknown.json()).error, /Unknown tool/);
  } finally {
    process.env.PATH = realPath;
    server.close();
  }
});
