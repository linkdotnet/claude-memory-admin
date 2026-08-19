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
