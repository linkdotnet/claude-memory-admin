// The single most important guarantee: parsing a MEMORY.md and writing it back
// with no deletions must produce identical bytes. Real indexes are hand-written
// prose with headings and nested bullets, and mangling one would be silent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { parseIndex, removeIndexEntries, insertLines } from '../src/parse.mjs';
import { allRoots, memoryDirs } from './helpers.mjs';

const dirs = allRoots.flatMap(memoryDirs);

test('parsed MEMORY.md round-trips byte for byte', () => {
  assert.ok(dirs.length > 0, 'expected at least one MEMORY.md to check');

  for (const dir of dirs) {
    const file = path.join(dir, 'MEMORY.md');
    const original = fs.readFileSync(file, 'utf8');
    const parsed = parseIndex(original);
    assert.equal(parsed.lines.join('\n'), original, `${file} did not survive a parse/join`);
    assert.equal(parsed.parsedLines.length, parsed.lines.length, `${file} lost lines during classification`);
  }
});

test('removing a non-existent entry changes nothing', () => {
  for (const dir of dirs) {
    const original = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
    const { text, removed } = removeIndexEntries(original, 'definitely-not-a-real-file.md');
    assert.equal(text, original);
    assert.deepEqual(removed, []);
  }
});

test('remove then re-insert restores the original bytes', () => {
  for (const dir of dirs) {
    const original = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
    for (const entry of parseIndex(original).entries) {
      const { text, removed } = removeIndexEntries(original, entry.file);
      assert.ok(removed.length > 0, `expected to remove something for ${entry.file}`);
      assert.equal(insertLines(text, removed), original, `re-inserting ${entry.file} did not restore the file`);
    }
  }
});

test('removing several entries at once is undone by one re-insert', () => {
  for (const dir of dirs) {
    const original = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
    const files = parseIndex(original).entries.map((e) => e.file);
    if (files.length < 2) continue;
    const { text, removed } = removeIndexEntries(original, files);
    assert.equal(insertLines(text, removed), original, `${dir}: bulk removal did not round-trip`);
  }
});
