// Every mutation test runs on a throwaway copy of the store.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  addIndexEntry,
  addIndexEntryPreview,
  deleteMemories,
  deleteMemory,
  deletePreview,
  deleteIndexLine,
  deleteProject,
  editIndexHook,
  mergeMemories,
  mergePreview,
  moveIndexEntry,
  projectDeletePreview,
  removeWikilink,
  restoreMemory,
  safeMemoryPath,
} from '../src/mutate.mjs';
import { buildProject, listTrash } from '../src/model.mjs';
import { parseIndex } from '../src/parse.mjs';
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

    const { record } = deleteMemory(dir, target.file);
    const after = snapshot(dir);
    assert.ok(!(target.file in after), 'the file should be gone from the memory dir');
    assert.ok(fs.existsSync(path.join(dir, '.trash', record.files[0].trashedFile)), 'the file should be in .trash');
    assert.notEqual(after['MEMORY.md'], before['MEMORY.md'], 'the index bullet should have been removed');

    // Everything except MEMORY.md and the deleted file must be untouched.
    for (const [name, content] of Object.entries(before)) {
      if (name === 'MEMORY.md' || name === target.file) continue;
      assert.equal(after[name], content, `${name} changed during an unrelated delete`);
    }

    const result = restoreMemory(dir, record.id);
    assert.equal(result.indexRestored, 'exact');
    assert.deepEqual(snapshot(dir), before, 'restore did not reproduce the original bytes');
  });
});

test('deleting only removes the target bullet from MEMORY.md', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    const indexBefore = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8').split('\n');
    const target = buildProject(root, SLUG).memories.find((m) => m.status === 'indexed');

    const { record } = deleteMemory(dir, target.file);
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

    const preview = deletePreview(dir, target.file);
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
    const { record } = deleteMemory(dir, target.file);

    const indexPath = path.join(dir, 'MEMORY.md');
    fs.writeFileSync(indexPath, `${fs.readFileSync(indexPath, 'utf8')}- [Added later](later.md) — from another session\n`);

    const result = restoreMemory(dir, record.id);
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

    deleteIndexLine(dir, dangling.index, dangling.text);
    assert.ok(!fs.readFileSync(indexPath, 'utf8').includes('ghost-that-does-not-exist'));

    assert.throws(() => deleteIndexLine(dir, 0, 'not what is on that line'), /changed since/);
  });
});

test('path traversal is refused', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    for (const bad of ['../MEMORY.md', '../../secret.md', '/etc/passwd', 'sub/dir.md', '.hidden.md', 'notes.txt', '']) {
      assert.throws(() => safeMemoryPath(dir, bad), Error, `should refuse "${bad}"`);
    }
    assert.throws(() => deleteMemory(dir, '../MEMORY.md'), Error);
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

    const { record } = deleteMemory(dir, orphanFile);
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

    const { record } = deleteMemory(dir, target.file, linked);
    assert.equal(record.files.length, 1 + linked.length);
    for (const file of [target.file, ...linked]) {
      assert.ok(!fs.existsSync(path.join(dir, file)), `${file} should be gone`);
    }

    // One record undoes the whole cascade.
    const result = restoreMemory(dir, record.id);
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

    const { record } = deleteMemories(dir, picks);
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
    const preview = projectDeletePreview(dir);
    assert.ok(preview.files.length > 0);
    assert.equal(preview.hasIndex, true);

    const { record } = deleteProject(dir);
    assert.equal(record.kind, 'project');
    assert.equal(record.files.length, preview.files.length);
    assert.ok(record.indexTrashedFile, 'MEMORY.md should have been trashed too');
    assert.deepEqual(snapshot(dir), {}, 'the memory dir should be empty');

    const project = buildProject(root, SLUG);
    assert.equal(project.memories.length, 0);
    assert.equal(project.hasIndex, false);

    const result = restoreMemory(dir, record.id);
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
    const { occurrences, record } = removeWikilink(dir, broken.from, broken.target);
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

    restoreMemory(dir, record.id);
    assert.deepEqual(snapshot(dir), before, 'the unlink did not restore cleanly');
  });
});

test('unlinking refuses when the target is not actually present', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    const file = buildProject(root, SLUG).memories[0].file;
    assert.throws(() => removeWikilink(dir, file, 'not-a-link-in-here'), /No \[\[/);
    assert.throws(() => removeWikilink(dir, '../MEMORY.md', 'x'), Error);
  });
});

test('a project delete never touches anything outside memory/', () => {
  withFixture((root) => {
    const projectDir = path.join(root, SLUG);
    const dir = path.join(projectDir, 'memory');

    // Stand in for the session transcripts that live beside memory/.
    fs.writeFileSync(path.join(projectDir, 'sentinel.jsonl'), '{"cwd":"/somewhere"}\n');
    const siblingsBefore = fs.readdirSync(projectDir).sort();

    deleteProject(dir);

    assert.deepEqual(fs.readdirSync(projectDir).sort(), siblingsBefore, 'sibling files changed');
    assert.equal(fs.readFileSync(path.join(projectDir, 'sentinel.jsonl'), 'utf8'), '{"cwd":"/somewhere"}\n');
    assert.ok(fs.existsSync(dir), 'the memory dir itself should remain');
  });
});

const HYPHEN_SLUG = '-Users-demo-repos-hyphen';

function readIndexFile(dir) {
  return fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
}

test('editing a hook then restoring leaves the memory dir byte-identical', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    const before = snapshot(dir);
    const entry = parseIndex(readIndexFile(dir)).entries[0];

    const { record, after } = editIndexHook(dir, {
      lineIndex: entry.index,
      expectedText: entry.text,
      hook: 'much shorter now',
    });
    assert.match(after, /much shorter now$/);
    assert.notEqual(readIndexFile(dir), before['MEMORY.md']);

    const result = restoreMemory(dir, record.id);
    assert.equal(result.indexRestored, 'exact');
    assert.deepEqual(snapshot(dir), before);
  });
});

test('editing a hook touches only that one line', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    const before = readIndexFile(dir).split('\n');
    const entry = parseIndex(readIndexFile(dir)).entries[0];

    editIndexHook(dir, { lineIndex: entry.index, expectedText: entry.text, hook: 'x' });
    const after = readIndexFile(dir).split('\n');

    assert.equal(after.length, before.length);
    for (let i = 0; i < before.length; i++) {
      if (i === entry.index) continue;
      assert.equal(after[i], before[i], `line ${i + 1} changed`);
    }
  });
});

test('a hook edit keeps the separator a hyphen-only project uses', () => {
  withFixture((root) => {
    const dir = path.join(root, HYPHEN_SLUG, 'memory');
    const entry = parseIndex(readIndexFile(dir)).entries[0];
    const { after } = editIndexHook(dir, { lineIndex: entry.index, expectedText: entry.text, hook: 'kept' });
    assert.equal(after, '- [No em-dashes](no-em-dashes.md) - kept');
    assert.ok(!after.includes('—'));
  });
});

test('a hook edit refuses a line that moved underneath it', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    const entry = parseIndex(readIndexFile(dir)).entries[0];
    assert.throws(
      () => editIndexHook(dir, { lineIndex: entry.index, expectedText: 'not what is there', hook: 'x' }),
      /changed since this was loaded/,
    );
    assert.equal(parseIndex(readIndexFile(dir)).entries[0].text, entry.text);
  });
});

test('moving an entry then restoring leaves the memory dir byte-identical', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    const before = snapshot(dir);
    const entries = parseIndex(readIndexFile(dir)).entries;
    const last = entries[entries.length - 1];

    const { record, toIndex } = moveIndexEntry(dir, {
      lineIndex: last.index,
      expectedText: last.text,
      toIndex: 0,
    });
    assert.equal(toIndex, 0);
    assert.equal(readIndexFile(dir).split('\n')[0], last.text);

    assert.equal(restoreMemory(dir, record.id).indexRestored, 'exact');
    assert.deepEqual(snapshot(dir), before);
  });
});

test('moving an entry keeps every line, just in a new order', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    const before = readIndexFile(dir).split('\n');
    const entries = parseIndex(readIndexFile(dir)).entries;
    const last = entries[entries.length - 1];

    moveIndexEntry(dir, { lineIndex: last.index, expectedText: last.text, toIndex: 0 });
    const after = readIndexFile(dir).split('\n');

    assert.deepEqual([...after].sort(), [...before].sort());
  });
});

test('adding an orphan to the index then restoring leaves it byte-identical', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    const before = snapshot(dir);
    const orphan = buildProject(root, SLUG).memories.find((memory) => memory.status === 'orphan');
    assert.ok(orphan, 'the fixture should carry an orphan');

    const { record, line } = addIndexEntry(dir, { file: orphan.file, section: 'Conventions' });
    assert.ok(line.includes(`(${orphan.file})`));

    const rebuilt = buildProject(root, SLUG);
    assert.equal(rebuilt.memories.find((m) => m.file === orphan.file).status, 'indexed');
    assert.equal(rebuilt.memories.find((m) => m.file === orphan.file).section, 'Conventions');

    assert.equal(restoreMemory(dir, record.id).indexRestored, 'exact');
    assert.deepEqual(snapshot(dir), before);
  });
});

test('adding an entry that already exists is refused', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    const before = snapshot(dir);
    const indexed = buildProject(root, SLUG).memories.find((memory) => memory.status === 'indexed');

    assert.throws(() => addIndexEntry(dir, { file: indexed.file }), /already has an entry/);
    assert.deepEqual(snapshot(dir), before);
  });
});

test('adding an entry for a file that is not there is refused', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    assert.throws(() => addIndexEntry(dir, { file: 'nothing-here.md' }), /No such memory/);
    assert.throws(() => addIndexEntry(dir, { file: '../escape.md' }), /plain \.md filename/);
  });
});

test('adding an entry to a project with no MEMORY.md creates one, and undo removes it', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    fs.unlinkSync(path.join(dir, 'MEMORY.md'));
    const before = snapshot(dir);
    const orphan = buildProject(root, SLUG).memories[0];

    const { record } = addIndexEntry(dir, { file: orphan.file });
    assert.ok(fs.existsSync(path.join(dir, 'MEMORY.md')));
    assert.ok(readIndexFile(dir).includes(orphan.file));

    restoreMemory(dir, record.id);
    assert.ok(!fs.existsSync(path.join(dir, 'MEMORY.md')));
    assert.deepEqual(snapshot(dir), before);
  });
});

test('a created MEMORY.md is not deleted once it has been changed', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    fs.unlinkSync(path.join(dir, 'MEMORY.md'));
    const orphan = buildProject(root, SLUG).memories[0];

    const { record } = addIndexEntry(dir, { file: orphan.file });
    fs.appendFileSync(path.join(dir, 'MEMORY.md'), '- something a human added\n');

    assert.throws(() => restoreMemory(dir, record.id), /not deleting it/);
    assert.ok(fs.existsSync(path.join(dir, 'MEMORY.md')));
  });
});

test('a preview reports what adding an entry would write', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    const before = snapshot(dir);
    const orphan = buildProject(root, SLUG).memories.find((memory) => memory.status === 'orphan');

    const preview = addIndexEntryPreview(dir, { file: orphan.file, section: 'Conventions' });
    assert.equal(preview.alreadyIndexed, false);
    assert.ok(preview.sections.includes('Conventions'));
    assert.ok(preview.line.startsWith('- ['));
    assert.ok(preview.line.includes(' — '));

    assert.deepEqual(snapshot(dir), before, 'a preview must not write anything');
  });
});

test('every index edit leaves a restorable trash record', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    const entry = parseIndex(readIndexFile(dir)).entries[0];
    const { record } = editIndexHook(dir, { lineIndex: entry.index, expectedText: entry.text, hook: 'x' });

    const listed = listTrash(dir).find((item) => item.id === record.id);
    assert.ok(listed, 'the edit should appear in the trash listing');
    assert.equal(listed.present, true, 'the Trash tab must offer a Restore button for it');
  });
});

test('merging then restoring leaves the memory dir byte-identical', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    const before = snapshot(dir);
    const memories = buildProject(root, SLUG).memories;
    const into = memories.find((m) => m.status === 'indexed');
    const from = memories.find((m) => m.file !== into.file && m.status === 'indexed');

    const { record } = mergeMemories(dir, { into: into.file, from: from.file });
    const after = snapshot(dir);
    assert.ok(!(from.file in after), 'the source should be gone from the memory dir');
    assert.ok(after[into.file].includes(`## ${from.name}`));
    assert.ok(!after['MEMORY.md'].includes(`(${from.file})`));

    assert.equal(restoreMemory(dir, record.id).kind, 'merge');
    assert.deepEqual(snapshot(dir), before);
  });
});

test('a merge repoints the wikilinks that pointed at the source', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    fs.writeFileSync(path.join(dir, 'target.md'), '---\nname: target\n---\n\nThe surviving memory.\n');
    fs.writeFileSync(path.join(dir, 'source.md'), '---\nname: source\n---\n\nWorth keeping.\n');
    fs.writeFileSync(
      path.join(dir, 'pointer.md'),
      '---\nname: pointer\n---\n\nSee [[source]] and [[source|the source]] and [[target]].\n',
    );

    const { retargeted } = mergeMemories(dir, { into: 'target.md', from: 'source.md' });
    assert.equal(retargeted, 1);

    const pointer = fs.readFileSync(path.join(dir, 'pointer.md'), 'utf8');
    assert.ok(pointer.includes('[[target]] and [[target|the source]]'));
    assert.ok(!pointer.includes('[[source'));

    const dangling = buildProject(root, SLUG).health.danglingWikilinks;
    assert.deepEqual(dangling.filter((link) => link.target === 'source'), []);
  });
});

test('a merge unwraps a link the survivor had to the source rather than self-linking', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    fs.writeFileSync(path.join(dir, 'target.md'), '---\nname: target\n---\n\nBuilds on [[source]] directly.\n');
    fs.writeFileSync(path.join(dir, 'source.md'), '---\nname: source\n---\n\nWorth keeping.\n');

    const { unwrapped } = mergeMemories(dir, { into: 'target.md', from: 'source.md' });
    assert.equal(unwrapped, 1);

    const merged = fs.readFileSync(path.join(dir, 'target.md'), 'utf8');
    assert.ok(merged.includes('Builds on source directly.'));
    assert.ok(!merged.includes('[[target]]'), 'the merge must not leave a self-link');
  });
});

test('a merge leaves prose mentions in MEMORY.md alone and reports them', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    const project = buildProject(root, SLUG);
    const inline = project.memories.find((m) => m.status === 'referenced');
    assert.ok(inline, 'the fixture should carry a file linked only mid-sentence');
    const into = project.memories.find((m) => m.status === 'indexed');

    const preview = mergePreview(dir, { into: into.file, from: inline.file });
    assert.ok(preview.inlineRefs.length, 'the preview should name the prose mention');

    const beforeIndex = readIndexFile(dir);
    mergeMemories(dir, { into: into.file, from: inline.file });
    assert.equal(readIndexFile(dir), beforeIndex, 'a prose mention must not be rewritten');
  });
});

test('a merge preview writes nothing', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    const before = snapshot(dir);
    const memories = buildProject(root, SLUG).memories;
    mergePreview(dir, { into: memories[0].file, from: memories[1].file });
    assert.deepEqual(snapshot(dir), before);
  });
});

test('a memory cannot be merged into itself or into a file that is not there', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    const file = buildProject(root, SLUG).memories[0].file;
    assert.throws(() => mergeMemories(dir, { into: file, from: file }), /into itself/);
    assert.throws(() => mergeMemories(dir, { into: file, from: 'gone.md' }), /No such memory/);
    assert.throws(() => mergeMemories(dir, { into: file, from: '../escape.md' }), /plain \.md filename/);
  });
});

test('a merge leaves a restorable trash record', () => {
  withFixture((root) => {
    const dir = path.join(root, SLUG, 'memory');
    const memories = buildProject(root, SLUG).memories;
    const { record } = mergeMemories(dir, { into: memories[0].file, from: memories[1].file });
    const listed = listTrash(dir).find((item) => item.id === record.id);
    assert.ok(listed);
    assert.equal(listed.present, true);
  });
});
