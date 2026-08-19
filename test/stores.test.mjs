import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildStore } from '../src/model.mjs';
import { deleteMemory, safeMemoryPath } from '../src/mutate.mjs';
import { listAgentStores, listStores } from '../src/stores.mjs';
import { searchAll } from '../src/search.mjs';
import { FIXTURE_ROOT } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const AGENTS = path.join(here, 'fixtures', 'agents');
const USER_DIR = path.join(AGENTS, 'user-scope');
const REPO = path.join(AGENTS, 'repo');

test('all three subagent memory scopes are discovered', () => {
  const stores = listAgentStores({ userDir: USER_DIR, projectPaths: [REPO] });
  assert.deepEqual(
    stores.map((s) => `${s.kind}/${s.agentName}`).sort(),
    ['agent-local/scratch', 'agent-project/code-reviewer', 'agent-user/code-reviewer'],
  );
  // The same agent name in two scopes is two different stores, not one.
  assert.equal(new Set(stores.map((s) => s.id)).size, 3);
});

test('a repository reached twice contributes its agent stores once', () => {
  // A worktree and its root both resolve into the same project entry, so the
  // same directory arrives more than once and must not be listed twice.
  const stores = listAgentStores({ userDir: USER_DIR, projectPaths: [REPO, REPO] });
  assert.equal(stores.filter((s) => s.kind === 'agent-project').length, 1);
});

test('a repository with no agent memory contributes nothing', () => {
  const stores = listAgentStores({ userDir: USER_DIR, projectPaths: [os.tmpdir()] });
  assert.ok(stores.every((s) => s.kind === 'agent-user'));
});

test('a subagent store builds the same model an auto memory store does', () => {
  const [store] = listAgentStores({ userDir: USER_DIR, projectPaths: [] });
  const model = buildStore(store);

  assert.equal(model.kind, 'agent-user');
  assert.equal(model.memories.length, 2);
  assert.equal(model.hasIndex, true);
  // The index, graph, load meter and health all come out populated, because
  // none of them ever knew which kind of store they were reading.
  assert.equal(model.stats.index.lineLimit, 200);
  assert.ok(model.stats.index.lines > 0);
  assert.equal(model.graph.edges.length, 1, 'naming-drift links to test-gaps');
  assert.equal(model.health.issueCount, 0);
});

test('health finds a broken wikilink in a subagent store', () => {
  const store = listAgentStores({ userDir: USER_DIR, projectPaths: [REPO] })
    .find((s) => s.kind === 'agent-project');
  const model = buildStore(store);
  assert.deepEqual(model.health.danglingWikilinks.map((l) => l.target), ['missing-note']);
});

test('writes into a subagent store stay inside it', () => {
  // The confinement check is handed the store directory rather than deriving it
  // from a root and a slug, so it has to hold for a store anywhere on disk.
  const [store] = listAgentStores({ userDir: USER_DIR, projectPaths: [] });
  assert.throws(() => safeMemoryPath(store.dir, '../../escape.md'), /plain \.md filename/);
  assert.throws(() => safeMemoryPath(store.dir, '/etc/passwd'), /plain \.md filename/);
  assert.equal(safeMemoryPath(store.dir, 'test-gaps.md'), path.join(store.dir, 'test-gaps.md'));
});

test('deleting from a subagent store is trashed and restorable like any other', () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-admin-agent-'));
  try {
    fs.cpSync(path.join(USER_DIR, 'code-reviewer'), copy, { recursive: true });
    const { record } = deleteMemory(copy, 'test-gaps.md');
    assert.equal(fs.existsSync(path.join(copy, 'test-gaps.md')), false);
    assert.ok(fs.existsSync(path.join(copy, '.trash', record.files[0].trashedFile)));
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test('listStores returns every auto memory project as a store', () => {
  const stores = listStores(FIXTURE_ROOT);
  const auto = stores.filter((s) => s.kind === 'auto');
  assert.ok(auto.length >= 4);
  assert.ok(auto.every((s) => s.id.startsWith('auto:') && s.dir.endsWith(path.join(s.slug, 'memory'))));
});

test('search spans stores and reports which one each hit came from', () => {
  const found = searchAll(FIXTURE_ROOT, 'postcss');
  assert.ok(found.stores.length > 0, 'expected a hit in the fixture store');
  assert.ok(found.total > 0);
  for (const store of found.stores) {
    assert.ok(store.id, 'every result group must name the store it came from');
    assert.ok(store.kind);
  }
});

test('the user scope is listed first, as a store that holds no memory', () => {
  const home = path.join(here, 'fixtures', 'instructions', 'user-home');
  const stores = listStores(FIXTURE_ROOT, { home });

  assert.equal(stores[0].kind, 'global', 'the global entry leads the list');
  const global = stores[0];
  assert.equal(global.dir, path.join(home, '.claude'));
  assert.ok(global.id.startsWith('global:'));
  // False on purpose: it is what keeps ~/.claude out of search and out of
  // everything else that reads memory files off a store directory.
  assert.equal(global.hasMemoryDir, false);
  assert.equal(global.hasIndex, false);
  assert.equal(global.memoryCount, 0);
  assert.equal(stores.filter((s) => s.kind === 'global').length, 1);
});

test('the global store id is stable across calls', () => {
  const home = path.join(here, 'fixtures', 'instructions', 'user-home');
  const first = listStores(FIXTURE_ROOT, { home })[0].id;
  const second = listStores(FIXTURE_ROOT, { home })[0].id;
  assert.equal(first, second);
});

test('search never reaches into the user scope', () => {
  const home = path.join(here, 'fixtures', 'instructions', 'user-home');
  // "conventions" appears in the fixture home's CLAUDE.md, which is an
  // instruction file and must never be searched as if it were a memory.
  const found = searchAll(FIXTURE_ROOT, 'conventions');
  assert.ok(!found.stores.some((s) => s.kind === 'global'));
  assert.ok(listStores(FIXTURE_ROOT, { home }).some((s) => s.kind === 'global'));
});
