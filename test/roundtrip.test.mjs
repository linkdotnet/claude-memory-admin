// The single most important guarantee: parsing a MEMORY.md and writing it back
// with no deletions must produce identical bytes. Real indexes are hand-written
// prose with headings and nested bullets, and mangling one would be silent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { parseIndex, removeIndexEntries, insertLines, setIndexHook, moveIndexEntry } from '../src/parse.mjs';
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

test('rewriting a hook and putting the original back restores the bytes', () => {
  for (const dir of dirs) {
    const original = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
    for (const entry of parseIndex(original).entries) {
      if (entry.text !== entry.text.trimEnd()) continue;
      const edited = setIndexHook(original, entry.index, entry.text, 'placeholder hook');
      assert.notEqual(edited.text, original, `${dir}: editing ${entry.file} changed nothing`);
      const restored = setIndexHook(edited.text, entry.index, edited.after, entry.hook);
      assert.equal(restored.text, original, `${dir}: restoring the hook on ${entry.file} lost bytes`);
    }
  }
});

test('a hook edit never disturbs another line', () => {
  for (const dir of dirs) {
    const original = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
    const before = original.split('\n');
    for (const entry of parseIndex(original).entries) {
      const after = setIndexHook(original, entry.index, entry.text, 'x').text.split('\n');
      assert.equal(after.length, before.length, `${dir}: line count changed editing ${entry.file}`);
      for (let i = 0; i < before.length; i++) {
        if (i === entry.index) continue;
        assert.equal(after[i], before[i], `${dir}: line ${i + 1} changed editing ${entry.file}`);
      }
    }
  }
});

test('moving an entry keeps every line of the index', () => {
  for (const dir of dirs) {
    const original = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
    const before = original.split('\n');
    for (const entry of parseIndex(original).entries) {
      if (entry.index === 0) continue;
      const moved = moveIndexEntry(original, entry.index, entry.text, 0).text.split('\n');
      assert.deepEqual([...moved].sort(), [...before].sort(), `${dir}: moving ${entry.file} lost or added a line`);
    }
  }
});
