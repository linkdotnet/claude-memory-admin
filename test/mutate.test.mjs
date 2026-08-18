// Every mutation test runs on a throwaway copy of the store.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  deleteMemories,
  deleteMemory,
  deletePreview,
  deleteIndexLine,
  deleteProject,
  projectDeletePreview,
  removeWikilink,
  restoreMemory,
  safeMemoryPath,
} from '../src/mutate.mjs';
import { buildProject } from '../src/model.mjs';
import { makeFixture, cleanup, snapshot, FIXTURE_SLUG } from './helpers.mjs';

// Runs on the committed fixture, so these cover the same ground on CI as they do
// locally. Every case works on a throwaway copy.
const SLUG = FIXTURE_SLUG;

function withFixture(run) {
  const root = makeFixture();
  try {
    return run(root);
  } finally {
    cleanup(root);
  }
}

test('delete then restore leaves the memory dir byte-identical', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    const before = snapshot(dir);
    const target = buildProject(root, SLUG).memories.find((m) => m.status === 'indexed');
    assert.ok(target, 'expected an indexed memory to delete');

    const { record } = deleteMemory(root, SLUG, target.file);
    const after = snapshot(dir);
    assert.ok(!(target.file in after), 'the file should be gone from the memory dir');
    assert.ok(fs.existsSync(path.join(dir, '.trash', record.files[0].trashedFile)), 'the file should be in .trash');
    assert.notEqual(after['MEMORY.md'], before['MEMORY.md'], 'the index bullet should have been removed');

    // Everything except MEMORY.md and the deleted file must be untouched.
    for (const [name, content] of Object.entries(before)) {
      if (name === 'MEMORY.md' || name === target.file) continue;
      assert.equal(after[name], content, `${name} changed during an unrelated delete`);
    }

    const result = restoreMemory(root, SLUG, record.id);
    assert.equal(result.indexRestored, 'exact');
    assert.deepEqual(snapshot(dir), before, 'restore did not reproduce the original bytes');
  });
});

test('deleting only removes the target bullet from MEMORY.md', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    const indexBefore = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8').split('\n');
    const target = buildProject(root, SLUG).memories.find((m) => m.status === 'indexed');

    const { record } = deleteMemory(root, SLUG, target.file);
    const indexAfter = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8').split('\n');
    const removedIndices = new Set(record.removedLines.map((l) => l.index));
    const expected = indexBefore.filter((_, i) => !removedIndices.has(i));
    assert.deepEqual(indexAfter, expected, 'lines other than the removed bullet changed');
    for (const line of record.removedLines) {
      assert.ok(line.text.includes(target.file), 'only lines pointing at the target should be removed');
    }
  });
});

test('the preview reports collateral without changing anything', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    const before = snapshot(dir);
    const project = buildProject(root, SLUG);
    // Pick a memory something else links to, so there is collateral to report.
    const target = project.memories.find((m) => m.inbound.length > 0) || project.memories[0];

    const preview = deletePreview(root, SLUG, target.file);
    assert.equal(preview.exists, true);
    assert.equal(preview.name, target.name);
    assert.equal(preview.inboundWikilinks.length, target.inbound.length);
    assert.deepEqual(snapshot(dir), before, 'preview must not touch the filesystem');
  });
});

test('restoring after MEMORY.md moved on appends instead of splicing blindly', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    const target = buildProject(root, SLUG).memories.find((m) => m.status === 'indexed');
    const { record } = deleteMemory(root, SLUG, target.file);

    const indexPath = path.join(dir, 'MEMORY.md');
    fs.writeFileSync(indexPath, `${fs.readFileSync(indexPath, 'utf8')}- [Added later](later.md) — from another session\n`);

    const result = restoreMemory(root, SLUG, record.id);
    assert.equal(result.indexRestored, 'appended');
    const text = fs.readFileSync(indexPath, 'utf8');
    assert.ok(text.includes('Added later'), 'the concurrent edit must survive');
    assert.ok(text.includes(target.file), 'the restored pointer must be present');
  });
});

test('a dangling pointer line can be removed on its own', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    const indexPath = path.join(dir, 'MEMORY.md');
    const injected = '- [Ghost](ghost-that-does-not-exist.md) — points at nothing';
    fs.writeFileSync(indexPath, `${fs.readFileSync(indexPath, 'utf8')}${injected}\n`);

    const project = buildProject(root, SLUG);
    const dangling = project.health.danglingIndex.find((d) => d.file === 'ghost-that-does-not-exist.md');
    assert.ok(dangling, 'the injected pointer should be reported as dangling');

    deleteIndexLine(root, SLUG, dangling.index, dangling.text);
    assert.ok(!fs.readFileSync(indexPath, 'utf8').includes('ghost-that-does-not-exist'));

    assert.throws(() => deleteIndexLine(root, SLUG, 0, 'not what is on that line'), /changed since/);
  });
});

test('path traversal is refused', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    for (const bad of ['../MEMORY.md', '../../secret.md', '/etc/passwd', 'sub/dir.md', '.hidden.md', 'notes.txt', '']) {
      assert.throws(() => safeMemoryPath(dir, bad), Error, `should refuse "${bad}"`);
    }
    assert.throws(() => deleteMemory(root, SLUG, '../MEMORY.md'), Error);
    assert.ok(fs.existsSync(path.join(dir, 'MEMORY.md')), 'MEMORY.md must survive a traversal attempt');
  });
});

test('deleting a memory that is not in the index still works', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    const orphanFile = 'a-fresh-orphan.md';
    fs.writeFileSync(path.join(dir, orphanFile), '---\nname: a-fresh-orphan\n---\n\nNot indexed.\n');
    const indexBefore = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');

    const project = buildProject(root, SLUG);
    assert.equal(project.memories.find((m) => m.file === orphanFile).status, 'orphan');

    const { record } = deleteMemory(root, SLUG, orphanFile);
    assert.deepEqual(record.removedLines, [], 'there was no pointer to remove');
    assert.equal(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), indexBefore, 'MEMORY.md must not change');
    assert.ok(!fs.existsSync(path.join(dir, orphanFile)));
  });
});

test('a cascading delete removes every selected memory in one undoable step', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    const before = snapshot(dir);
    const project = buildProject(root, SLUG);
    const target = project.memories.find((m) => m.inbound.length > 0);
    assert.ok(target, 'expected a memory with inbound links');
    const linked = target.inbound.map((i) => i.from);

    const { record } = deleteMemory(root, SLUG, target.file, linked);
    assert.equal(record.files.length, 1 + linked.length);
    for (const file of [target.file, ...linked]) {
      assert.ok(!fs.existsSync(path.join(dir, file)), `${file} should be gone`);
    }

    // One record undoes the whole cascade.
    const result = restoreMemory(root, SLUG, record.id);
    assert.equal(result.indexRestored, 'exact');
    assert.deepEqual(snapshot(dir), before, 'the cascade did not restore cleanly');
  });
});

test('index lines from a cascade keep their original positions', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    const lines = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8').split('\n');
    const project = buildProject(root, SLUG);
    const picks = project.memories.filter((m) => m.status === 'indexed').slice(0, 3).map((m) => m.file);

    const { record } = deleteMemories(root, SLUG, picks);
    // Each recorded index must still name the line it came from in the ORIGINAL
    // file - the bug a naive one-at-a-time removal introduces.
    for (const removed of record.removedLines) {
      assert.equal(lines[removed.index], removed.text, `line ${removed.index} was recorded wrong`);
    }
  });
});

test('deleting a whole project trashes every memory and MEMORY.md', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    const before = snapshot(dir);
    const preview = projectDeletePreview(root, SLUG);
    assert.ok(preview.files.length > 0);
    assert.equal(preview.hasIndex, true);

    const { record } = deleteProject(root, SLUG);
    assert.equal(record.kind, 'project');
    assert.equal(record.files.length, preview.files.length);
    assert.ok(record.indexTrashedFile, 'MEMORY.md should have been trashed too');
    assert.deepEqual(snapshot(dir), {}, 'the memory dir should be empty');

    const project = buildProject(root, SLUG);
    assert.equal(project.memories.length, 0);
    assert.equal(project.hasIndex, false);

    const result = restoreMemory(root, SLUG, record.id);
    assert.equal(result.indexRestored, 'exact');
    assert.deepEqual(snapshot(dir), before, 'the project did not restore byte-identically');
  });
});

test('removing a broken wikilink unwraps it and leaves the prose intact', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    const before = snapshot(dir);
    const project = buildProject(root, SLUG);
    const broken = project.health.danglingWikilinks[0];
    assert.ok(broken, 'expected a dangling wikilink in the fixture');

    const originalText = fs.readFileSync(path.join(dir, broken.from), 'utf8');
    const { occurrences, record } = removeWikilink(root, SLUG, broken.from, broken.target);
    assert.ok(occurrences >= 1);

    const after = fs.readFileSync(path.join(dir, broken.from), 'utf8');
    assert.ok(!after.includes(`[[${broken.target}]]`), 'the link markup should be gone');
    assert.ok(after.includes(broken.target), 'the target text itself should remain');
    assert.equal(after.length, originalText.length - occurrences * 4, 'only the brackets should have gone');

    // Nothing else in the project was touched.
    for (const [name, content] of Object.entries(before)) {
      if (name === broken.from) continue;
      assert.equal(snapshot(dir)[name], content, `${name} changed during an unlink`);
    }

    restoreMemory(root, SLUG, record.id);
    assert.deepEqual(snapshot(dir), before, 'the unlink did not restore cleanly');
  });
});

test('unlinking refuses when the target is not actually present', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    const file = buildProject(root, SLUG).memories[0].file;
    assert.throws(() => removeWikilink(root, SLUG, file, 'not-a-link-in-here'), /No \[\[/);
    assert.throws(() => removeWikilink(root, SLUG, '../MEMORY.md', 'x'), Error);
  });
});

test('a project delete never touches anything outside memory/', () => {
  withFixture((root) => {
    const projectDir = path.join(root, SLUG);
    const dir = path.join(projectDir, 'memory');

    // Stand in for the session transcripts that live beside memory/.
    fs.writeFileSync(path.join(projectDir, 'sentinel.jsonl'), '{"cwd":"/somewhere"}\n');
    const siblingsBefore = fs.readdirSync(projectDir).sort();

    deleteProject(root, SLUG);

    assert.deepEqual(fs.readdirSync(projectDir).sort(), siblingsBefore, 'sibling files changed');
    assert.equal(fs.readFileSync(path.join(projectDir, 'sentinel.jsonl'), 'utf8'), '{"cwd":"/somewhere"}\n');
    assert.ok(fs.existsSync(dir), 'the memory dir itself should remain');
  });
});
