// Structural assertions, run against the committed fixture so they hold on CI,
// and against the real store as an extra guard when it is present.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { buildProject } from '../src/model.mjs';
import { listProjects } from '../src/projects.mjs';
import { allRoots, FIXTURE_ROOT, FIXTURE_SLUG, hasRealStore, REAL_ROOT } from './helpers.mjs';

const KINDS = new Set(
  [...fs.readFileSync(new URL('../public/app.mjs', import.meta.url), 'utf8')
    .matchAll(/item\.kind === '([a-z-]+)'/g)].map((match) => match[1]),
);

test('slugs resolve to real paths, or admit that they did not', () => {
  for (const root of allRoots) {
    const projects = listProjects(root);
    assert.ok(projects.length > 0, `${root} produced no projects`);
    for (const project of projects) {
      // An unresolved slug must present itself as a slug, never as a guessed path.
      if (project.resolvedBy === 'unresolved') assert.equal(project.path, project.slug);
      else assert.ok(project.path.startsWith('/'), `${project.slug} produced a non-absolute path`);
    }
  }
});

test('a cwd in a session transcript is used in preference to decoding the slug', () => {
  const project = listProjects(FIXTURE_ROOT).find((p) => p.slug === FIXTURE_SLUG);
  assert.equal(project.resolvedBy, 'transcript');
  assert.equal(project.path, '/Users/demo/repos/alpha');
});

test('a file linked only mid-sentence is "referenced", not an orphan', () => {
  const project = buildProject(FIXTURE_ROOT, FIXTURE_SLUG);
  const inline = project.memories.find((m) => m.file === 'inline-only.md');
  assert.equal(inline.status, 'referenced');
  assert.ok(!project.health.orphans.includes('inline-only.md'));

  // A file nothing points at is a real orphan, and must be told apart from it.
  assert.equal(project.memories.find((m) => m.file === 'orphan-note.md').status, 'orphan');
});

test('a memory with root-level frontmatter still reports its type', () => {
  const project = buildProject(FIXTURE_ROOT, FIXTURE_SLUG);
  const flat = project.memories.find((m) => m.file === 'flat-frontmatter.md');
  assert.equal(flat.type, 'project', 'root-level `type:` must be picked up, not reported as unknown');
  assert.equal(flat.metadata.originSessionId, '9f1c0000-0000-4000-8000-000000000005');
  assert.equal(flat.nameMatchesFile, false);
});

test('every memory gets a status and inbound links mirror outbound ones', () => {
  for (const root of allRoots) {
    for (const listed of listProjects(root).filter((p) => p.memoryCount > 0)) {
      const project = buildProject(root, listed.slug);
      const outbound = project.memories.flatMap((m) => m.outboundResolved.filter((o) => o.file));
      const inbound = project.memories.flatMap((m) => m.inbound);
      assert.equal(outbound.length, inbound.length, `${listed.slug}: link directions disagree`);
      assert.equal(outbound.length, project.graph.edges.length);
      for (const memory of project.memories) {
        assert.ok(['indexed', 'referenced', 'orphan'].includes(memory.status));
      }
    }
  }
});

test('a wikilink with no target is reported, not silently dropped', () => {
  const project = buildProject(FIXTURE_ROOT, FIXTURE_SLUG);
  const dangling = project.health.danglingWikilinks;
  assert.equal(dangling.length, 1);
  assert.equal(dangling[0].target, 'a-memory-that-does-not-exist');
  assert.equal(dangling[0].from, 'beta-conventions.md');
});

test('the health badge count always matches the number of rendered issues', () => {
  // Two separate bugs came from counting a category the Health tab did not
  // render: a badge of 5 over 4 rows, and a badge of 1 over an empty tab.
  // health.issues is now the only source for both.
  for (const root of allRoots) {
    for (const listed of listProjects(root).filter((p) => p.hasMemoryDir)) {
      const { health } = buildProject(root, listed.slug);
      assert.equal(health.issueCount, health.issues.length, `${listed.slug}: count and list disagree`);
      for (const item of health.issues) {
        assert.ok(KINDS.has(item.kind), `${listed.slug}: "${item.kind}" is counted but the UI cannot render it`);
        assert.ok(['bad', 'warn'].includes(item.severity));
      }
    }
  }
});

test('every check reaches health.issues, and severity follows the worst of them', () => {
  const { health } = buildProject(FIXTURE_ROOT, '-Users-demo-repos-messy');
  const kinds = new Set(health.issues.map((item) => item.kind));

  for (const kind of [
    'duplicate-name', 'duplicate-index-entry', 'missing-description', 'unknown-type',
    'empty-body', 'hook-repeats-description', 'empty-section', 'index-continuation',
  ]) {
    assert.ok(kinds.has(kind), `${kind} never reached health.issues`);
  }

  assert.equal(health.severity, 'bad');
  assert.equal(health.issues[0].severity, 'bad', 'bad issues sort ahead of warnings');
});

test('a store with nothing wrong reports an ok severity and no issues', () => {
  const { health } = buildProject(FIXTURE_ROOT, '-Users-demo-repos-hyphen');
  assert.equal(health.issueCount, 0);
  assert.equal(health.severity, 'ok');
});

test('long hooks are surfaced as exactly one aggregated issue', () => {
  for (const root of allRoots) {
    for (const listed of listProjects(root).filter((p) => p.hasMemoryDir)) {
      const { health } = buildProject(root, listed.slug);
      const rows = health.issues.filter((i) => i.kind === 'long-hooks');
      assert.equal(rows.length, health.longHooks.length ? 1 : 0);
      if (rows.length) assert.equal(rows[0].count, health.longHooks.length);
    }
  }
});

test('an empty memory directory does not throw', () => {
  const project = buildProject(FIXTURE_ROOT, '-Users-demo-repos-empty');
  assert.equal(project.memories.length, 0);
  assert.equal(project.hasIndex, false);
  assert.equal(project.health.issueCount, 0);
  assert.deepEqual(project.graph.edges, []);
});

test('a project with no memory directory still builds', () => {
  const project = buildProject(FIXTURE_ROOT, '-Users-demo-repos-nomemory');
  assert.equal(project.hasMemoryDir, false);
  assert.equal(project.hasIndex, false);
  assert.equal(project.memories.length, 0);
});

test('the real store, when present, parses without surprises', { skip: !hasRealStore && 'no real store' }, () => {
  const projects = listProjects(REAL_ROOT);
  assert.ok(projects.length > 0);
  const viaTranscript = projects.filter((p) => p.resolvedBy === 'transcript');
  assert.ok(viaTranscript.length >= projects.length / 2, 'most real projects should resolve from a transcript');
});
