import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { indexStats, loadedIndex, loadedIndexText, findDuplicates, INDEX_LINE_LIMIT, INDEX_BYTE_LIMIT } from '../src/stats.mjs';
import { allRoots, memoryDirs } from './helpers.mjs';

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

test('the line map survives frontmatter and comments being stripped', () => {
  // Stripping shifts every loaded line away from the line it came from, so the
  // cutoff has to be reported in raw line numbers or it points at the wrong place.
  const head = ['---', 'title: notes', '---', '<!-- a maintainer note -->'];
  const bullets = Array.from({ length: 210 }, (_, i) => `- [E${i}](e${i}.md) — x`);
  const raw = [...head, ...bullets].join('\n');

  const loaded = loadedIndex(raw);
  assert.equal(loaded.rawLineFor.length, 210);
  // The first loaded line is the first bullet, which is raw line 4.
  assert.equal(loaded.rawLineFor[0], 4);
  assert.equal(loaded.rawLineFor[200], 204);
});

test('an over-long index names the entries that stop being loaded', () => {
  const head = ['---', 'title: notes', '---', '<!-- a maintainer note -->'];
  const bullets = Array.from({ length: 210 }, (_, i) => `- [E${i}](e${i}.md) — x`);
  const raw = [...head, ...bullets].join('\n');
  const entries = bullets.map((_, i) => ({ index: 4 + i, file: `e${i}.md`, title: `E${i}`, hook: 'x' }));

  const { cutoff } = indexStats(raw, entries);
  assert.equal(cutoff.by, 'lines');
  assert.equal(cutoff.rawLine, 204);
  assert.equal(cutoff.droppedLines, 10);
  assert.deepEqual(cutoff.droppedEntries.map((e) => e.file), Array.from({ length: 10 }, (_, i) => `e${200 + i}.md`));
});

test('a byte-bound index is cut on bytes, not lines', () => {
  const bullets = Array.from({ length: 10 }, (_, i) => `- [E${i}](e${i}.md) — ${'x'.repeat(3000)}`);
  const entries = bullets.map((_, i) => ({ index: i, file: `e${i}.md`, title: `E${i}`, hook: 'x' }));
  const { cutoff } = indexStats(bullets.join('\n'), entries);

  assert.equal(cutoff.by, 'bytes');
  assert.ok(cutoff.rawLine > 0 && cutoff.rawLine < 10, `cut inside the file, got ${cutoff.rawLine}`);
  assert.ok(cutoff.droppedEntries.length > 0);
});

test('an index inside the limit has no cutoff', () => {
  assert.equal(indexStats('- [A](a.md) — one\n', [{ index: 0, file: 'a.md', title: 'A', hook: 'one' }]).cutoff, null);
});

test('the line map agrees with the loaded text on every real index', () => {
  // The count used to come from splitting the loaded text and dropping a trailing
  // blank. The map has to reproduce that exactly, or the meter and the cutoff
  // would be measuring two different things.
  const countByOldRule = (text) =>
    text.split('\n').filter((line, i, all) => i < all.length - 1 || line.length > 0).length;

  for (const dir of allRoots.flatMap(memoryDirs)) {
    const raw = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
    const loaded = loadedIndex(raw);
    assert.equal(loaded.text, loadedIndexText(raw), dir);
    assert.equal(loaded.rawLineFor.length, countByOldRule(loaded.text), dir);
    // Every loaded line must map to a real line of the file, in order.
    const rawLines = raw.split('\n');
    for (let i = 0; i < loaded.rawLineFor.length; i++) {
      assert.ok(loaded.rawLineFor[i] < rawLines.length, `${dir} line ${i}`);
      if (i > 0) assert.ok(loaded.rawLineFor[i] > loaded.rawLineFor[i - 1], `${dir} line ${i} went backwards`);
    }
  }
});
