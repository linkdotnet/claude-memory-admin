import assert from 'node:assert/strict';
import test from 'node:test';

import { indexStats, loadedIndexText, findDuplicates, INDEX_LINE_LIMIT, INDEX_BYTE_LIMIT } from '../src/stats.mjs';

test('frontmatter and HTML comments do not count toward the load limit', () => {
  // Claude Code strips both before loading the index, so measuring the raw file
  // would overstate the size and produce false warnings.
  const raw = ['---', 'title: notes', '---', '<!-- a maintainer note -->', '- [A](a.md) — one', ''].join('\n');
  const loaded = loadedIndexText(raw);
  assert.ok(!loaded.includes('title: notes'));
  assert.ok(!loaded.includes('maintainer note'));
  assert.ok(loaded.includes('- [A](a.md)'));
});

test('the meter reports the limit that actually binds', () => {
  const manyShortLines = Array.from({ length: 210 }, (_, i) => `- [E${i}](e${i}.md) — x`).join('\n');
  const lineBound = indexStats(manyShortLines, []);
  assert.equal(lineBound.limitedBy, 'lines');
  assert.equal(lineBound.overLimit, true);
  assert.ok(lineBound.lines > INDEX_LINE_LIMIT);

  const fewLongLines = Array.from({ length: 10 }, () => `- [E](e.md) — ${'x'.repeat(3000)}`).join('\n');
  const byteBound = indexStats(fewLongLines, []);
  assert.equal(byteBound.limitedBy, 'bytes');
  assert.equal(byteBound.overLimit, true);
  assert.ok(byteBound.bytes > INDEX_BYTE_LIMIT);
});

test('a small index is reported as comfortably inside the limit', () => {
  const stats = indexStats('- [A](a.md) — one\n', [{ hook: 'one' }]);
  assert.equal(stats.level, 'ok');
  assert.equal(stats.overLimit, false);
  assert.equal(stats.nearLimit, false);
});

test('long hooks are found and ranked longest first', () => {
  const entries = [
    { index: 1, file: 'a.md', title: 'A', hook: 'x'.repeat(250) },
    { index: 2, file: 'b.md', title: 'B', hook: 'short' },
    { index: 3, file: 'c.md', title: 'C', hook: 'y'.repeat(400) },
  ];
  const stats = indexStats('- x\n', entries);
  assert.deepEqual(stats.longHooks.map((h) => h.file), ['c.md', 'a.md']);
  assert.equal(stats.longestHook, 400);
});

test('overlap detection is not fooled by a shared naming prefix', () => {
  // Character-trigram similarity scored these as near-duplicates purely because
  // of the shared "admincenter" prefix. Rarity weighting is what fixes it.
  const memories = [
    { file: 'a.md', name: 'admincenter-webpack-builder-cache', description: 'legacy browser builder caching build options' },
    { file: 'b.md', name: 'permissions-cache-in-admincenter', description: 'permission reads cached and invalidated in AdminCenter' },
    { file: 'c.md', name: 'tailwind-v4-setup', description: 'Tailwind v4 CSS-first config lives in theme.css' },
    { file: 'd.md', name: 'tailwind-v4-migration-gotchas', description: 'Tailwind v4 migration regressions and gotchas' },
  ];
  const pairs = findDuplicates(memories, 0.05);
  const top = pairs[0];
  assert.ok(
    (top.a.file === 'c.md' && top.b.file === 'd.md') || (top.a.file === 'd.md' && top.b.file === 'c.md'),
    `expected the tailwind pair to rank first, got ${top.a.name} <> ${top.b.name}`,
  );
});
