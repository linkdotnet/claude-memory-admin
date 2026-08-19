import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkDuplicateIndexEntry,
  checkDuplicateLoad,
  checkDuplicateNames,
  checkEmptyBody,
  checkEmptyInstructionFile,
  checkEmptySection,
  checkHookRepeatsDescription,
  checkIndexContinuation,
  checkMissingDescription,
  checkUnknownType,
} from '../src/checks.mjs';
import { parseIndex } from '../src/parse.mjs';

const memory = (over = {}) => ({
  file: 'a.md',
  name: 'a',
  description: 'a description long enough to matter',
  type: 'reference',
  hasFrontmatter: true,
  body: 'A body with enough words in it to clear the stub threshold comfortably.',
  entry: null,
  ...over,
});

test('two files claiming one name are reported once, with the reachable one named', () => {
  const [issue] = checkDuplicateNames([
    memory({ file: 'first.md', name: 'shared' }),
    memory({ file: 'second.md', name: 'shared' }),
    memory({ file: 'other.md', name: 'other' }),
  ]);
  assert.equal(issue.kind, 'duplicate-name');
  assert.equal(issue.severity, 'bad');
  assert.deepEqual(issue.files, ['first.md', 'second.md']);
  assert.equal(issue.reachable, 'first.md', 'the resolver keeps the first, so that is the one links reach');
});

test('a name used once is not reported', () => {
  assert.deepEqual(checkDuplicateNames([memory(), memory({ file: 'b.md', name: 'b' })]), []);
});

test('a blank description is reported, a missing frontmatter block is left alone', () => {
  const issues = checkMissingDescription([
    memory({ file: 'blank.md', description: '   ' }),
    memory({ file: 'none.md', description: '', hasFrontmatter: false }),
  ]);
  assert.deepEqual(issues.map((i) => i.file), ['blank.md']);
});

test('only the four documented types pass, and only for files that have frontmatter', () => {
  const issues = checkUnknownType([
    memory({ file: 'ok.md', type: 'feedback' }),
    memory({ file: 'bogus.md', type: 'bogus' }),
    memory({ file: 'none.md', type: 'unknown', hasFrontmatter: false }),
  ]);
  assert.deepEqual(issues.map((i) => i.file), ['bogus.md']);
});

test('a stub body is measured without its whitespace', () => {
  const issues = checkEmptyBody([
    memory({ file: 'stub.md', body: '\n\n   TODO   \n\n' }),
    memory({ file: 'real.md' }),
  ]);
  assert.deepEqual(issues.map((i) => i.file), ['stub.md']);
  assert.equal(issues[0].chars, 4);
});

test('a hook is only flagged when it restates the description it points at', () => {
  const repeats = memory({
    file: 'echo.md',
    description: 'The same concept under three names',
    entry: { index: 3, hook: 'the same concept under three names', text: '- [E](echo.md) — ...' },
  });
  const reordered = memory({
    file: 'reordered.md',
    description: 'Feature flags stay plain booleans',
    entry: { index: 4, hook: 'plain booleans, feature flags stay', text: '' },
  });
  const genuine = memory({
    file: 'genuine.md',
    description: 'The same concept under three names',
    entry: { index: 5, hook: 'check this one first, it recurs', text: '' },
  });

  const flagged = checkHookRepeatsDescription([repeats, reordered, genuine]).map((i) => i.file);
  assert.deepEqual(flagged, ['echo.md', 'reordered.md'], 'word order alone must not hide the repetition');
});

test('a memory with no index entry has no hook to compare', () => {
  assert.deepEqual(checkHookRepeatsDescription([memory({ entry: null })]), []);
});

test('a file bulleted twice is reported once, offering the later line for removal', () => {
  const index = parseIndex([
    '# Index',
    '',
    '- [One](one.md) — first',
    '- [One again](one.md) — second',
    '- [Two](two.md) — only once',
    '',
  ].join('\n'));

  const [issue] = checkDuplicateIndexEntry(index);
  assert.equal(issue.kind, 'duplicate-index-entry');
  assert.equal(issue.severity, 'bad');
  assert.deepEqual(issue.lines, [2, 3]);
  assert.equal(issue.removable.index, 3, 'the first mention stays, the later one goes');
});

test('a heading is empty only when nothing under it is an entry, subheadings included', () => {
  const index = parseIndex([
    '# Memory',
    '',
    '## Preferences',
    '- [A](a.md) — hook',
    '',
    '## Nothing Here',
    'just prose, no bullets',
    '',
    '## Also Fine',
    '- [B](b.md) — hook',
  ].join('\n'));

  assert.deepEqual(checkEmptySection(index).map((i) => i.section), ['Nothing Here']);
});

test('continuation lines are aggregated into one issue rather than one per entry', () => {
  const index = parseIndex([
    '- [A](a.md) — hook',
    '  - a nested detail',
    '  - and another',
    '- [B](b.md) — hook',
    '- [C](c.md) — hook',
    '  continued',
  ].join('\n'));

  const [issue] = checkIndexContinuation(index);
  assert.equal(issue.count, 2);
  assert.equal(issue.extraLines, 3);
  assert.deepEqual(issue.entries.map((e) => e.file), ['a.md', 'c.md']);
});

test('an index with one line per entry produces no continuation issue', () => {
  const index = parseIndex('- [A](a.md) — hook\n- [B](b.md) — hook\n');
  assert.deepEqual(checkIndexContinuation(index), []);
});

test('a file reached by two chains is reported once, with the cost of the extra read', () => {
  const [issue] = checkDuplicateLoad([
    { file: '/repo/shared.md', scope: 'user', kind: 'import', importedBy: '/home/.claude/CLAUDE.md', tokens: 120 },
    { file: '/repo/shared.md', scope: 'project', kind: 'import', importedBy: '/repo/CLAUDE.md', tokens: 120 },
    { file: '/repo/CLAUDE.md', scope: 'project', kind: 'claude-md', tokens: 50 },
  ]);
  assert.equal(issue.kind, 'duplicate-load');
  assert.equal(issue.count, 2);
  assert.equal(issue.wastedTokens, 120);
  assert.deepEqual(issue.via, ['/home/.claude/CLAUDE.md', '/repo/CLAUDE.md']);
});

test('one file reached once is not a duplicate load', () => {
  assert.deepEqual(checkDuplicateLoad([{ file: '/repo/CLAUDE.md', scope: 'project', kind: 'claude-md', tokens: 50 }]), []);
});

test('an instruction file is empty when nothing but frontmatter survives', () => {
  const issues = checkEmptyInstructionFile([
    { file: '/repo/.claude/rules/blank.md', scope: 'project', kind: 'rule', text: '---\npaths: ["**/*.ts"]\n---\n\n' },
    { file: '/repo/CLAUDE.md', scope: 'project', kind: 'claude-md', text: '# Rules\n\nUse tabs, not spaces, everywhere.\n' },
  ]);
  assert.deepEqual(issues.map((i) => i.file), ['/repo/.claude/rules/blank.md']);
});

test('a file loaded twice is reported empty at most once', () => {
  const twice = { file: '/repo/blank.md', scope: 'user', kind: 'import', text: '---\na: b\n---\n' };
  assert.equal(checkEmptyInstructionFile([twice, { ...twice, scope: 'project' }]).length, 1);
});
