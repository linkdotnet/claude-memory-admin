// The only code that writes inside a memory store. Everything else is read-only.
//
// Every entry point takes the store's directory rather than a root and a slug:
// auto memory and subagent memory live in unrelated places on disk but hold the
// same MEMORY.md-plus-topic-files shape, so nothing below needs to know which
// kind it is working on.
//
// Deletes are soft: the file moves into memory/.trash/ and a restore record
// captures the MEMORY.md lines that were removed, with their original indices,
// so the whole operation can be undone.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseIndex, removeIndexEntries, removeLine, insertLines, unwrapWikilink } from './parse.mjs';
import { listMemoryFiles } from './projects.mjs';
import { TRASH_DIR, loadMemory } from './model.mjs';

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
}

/**
 * Reject anything that is not a plain filename inside this project's memory dir.
 * Checked before touching the filesystem, and again via realpath after, so a
 * symlink cannot be used to escape.
 */
export function safeMemoryPath(dir, file) {
  if (typeof file !== 'string' || !file || file.includes('\0')) {
    throw new Error('Invalid filename');
  }
  if (file !== path.basename(file) || file.startsWith('.') || !file.endsWith('.md')) {
    throw new Error(`Refusing to touch "${file}": must be a plain .md filename`);
  }
  const full = path.join(dir, file);
  const rel = path.relative(dir, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path escapes the memory directory');
  }
  if (fs.existsSync(full)) {
    const realDir = fs.realpathSync(dir);
    const realFull = fs.realpathSync(full);
    if (path.relative(realDir, realFull).startsWith('..')) {
      throw new Error('Path escapes the memory directory');
    }
  }
  return full;
}

function indexPath(dir) {
  return path.join(dir, 'MEMORY.md');
}

function readIndex(dir) {
  try {
    return fs.readFileSync(indexPath(dir), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Replace MEMORY.md atomically: write a sibling temp file, fsync it, rename over
 * the target. A .backup copy is kept for the duration and restored if anything
 * throws, so a crash can never leave a truncated index.
 */
function writeFileAtomic(dir, name, text) {
  const target = path.join(dir, name);
  const tmp = path.join(dir, `.${name}.tmp-${process.pid}`);
  const backup = path.join(dir, `.${name}.backup`);
  const original = fs.existsSync(target) ? fs.readFileSync(target) : null;

  if (original !== null) fs.writeFileSync(backup, original);
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
  } catch (err) {
    if (original !== null) fs.writeFileSync(target, original);
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  } finally {
    try { if (fs.existsSync(backup)) fs.unlinkSync(backup); } catch { /* best effort */ }
  }
}

const writeIndexAtomic = (dir, text) => writeFileAtomic(dir, 'MEMORY.md', text);

/**
 * What a delete would do, without doing it. This is what the confirm dialog
 * renders, so it has to be exhaustive about the collateral.
 */
export function deletePreview(dir, file) {
  const full = safeMemoryPath(dir, file);
  const exists = fs.existsSync(full);
  const indexText = readIndex(dir);
  const parsed = indexText === null ? null : parseIndex(indexText);

  const indexLines = parsed
    ? parsed.entries.filter((e) => e.file === file).map((e) => ({ index: e.index, text: e.text }))
    : [];

  // Continuation lines get removed along with their bullet.
  const continuations = [];
  if (parsed) {
    for (const entry of indexLines) {
      for (let i = entry.index + 1; i < parsed.lines.length; i++) {
        const line = parsed.lines[i];
        if (!line.trim() || !/^[ \t]/.test(line)) break;
        continuations.push({ index: i, text: line });
      }
    }
  }

  // Links inside prose are deliberately left alone: cutting them out would
  // mangle the sentence around them. They are reported so they can be fixed
  // by hand.
  const inlineRefs = parsed
    ? parsed.inlineLinks.filter((l) => l.file === file).map((l) => ({ index: l.index, text: l.text }))
    : [];

  const target = exists ? loadMemory(dir, file) : null;
  const inboundWikilinks = [];
  if (target) {
    const dirFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md' && f !== file);
    for (const other of dirFiles) {
      const memory = loadMemory(dir, other);
      if (!memory) continue;
      for (const outbound of memory.outbound) {
        if (outbound === target.name || outbound === target.stem) {
          const entry = parsed ? parsed.entries.find((e) => e.file === other) : null;
          inboundWikilinks.push({
            from: other,
            fromName: memory.name,
            description: memory.description,
            target: outbound,
            indexLine: entry ? { index: entry.index, text: entry.text } : null,
          });
        }
      }
    }
  }

  return {
    file,
    exists,
    name: target ? target.name : null,
    description: target ? target.description : null,
    indexLines,
    continuations,
    inlineRefs,
    inboundWikilinks,
    hasIndex: indexText !== null,
  };
}

/**
 * Trash one or more memories and drop their index bullets as ONE undoable
 * operation. Cascading deletes (a memory plus the memories linking to it) and
 * clearing a whole project both come through here, so there is a single restore
 * path rather than three.
 */
export function deleteMemories(dir, files, { includeIndex = false, label = null } = {}) {
  const wanted = [...new Set([].concat(files))];
  if (!wanted.length) throw new Error('Nothing selected to delete');

  const targets = wanted.map((file) => {
    const full = safeMemoryPath(dir, file);
    if (!fs.existsSync(full)) throw new Error(`No such memory: ${file}`);
    const memory = loadMemory(dir, file);
    return { file, full, name: memory?.name || file, description: memory?.description || '' };
  });

  const trashPath = path.join(dir, TRASH_DIR);
  fs.mkdirSync(trashPath, { recursive: true });
  const stamp = timestamp();
  const indexBefore = readIndex(dir);

  // All index lines are computed against the original text in one pass, so the
  // recorded indices still describe the file we started from.
  let removed = [];
  let indexAfter = indexBefore;
  if (indexBefore !== null && !includeIndex) {
    const result = removeIndexEntries(indexBefore, wanted);
    removed = result.removed;
    indexAfter = result.text;
  }

  // Files move first: if a later step fails they are recoverable from .trash
  // rather than lost, and the moves already made are rolled back.
  const moved = [];
  try {
    for (const target of targets) {
      const trashedFile = `${stamp}_${target.file}`;
      fs.renameSync(target.full, path.join(trashPath, trashedFile));
      moved.push({ ...target, trashedFile });
    }
    if (includeIndex && indexBefore !== null) {
      const trashedIndex = `${stamp}_MEMORY.md`;
      fs.renameSync(indexPath(dir), path.join(trashPath, trashedIndex));
      moved.indexTrashed = trashedIndex;
    } else if (indexBefore !== null && indexAfter !== indexBefore) {
      writeIndexAtomic(dir, indexAfter);
    }
  } catch (err) {
    for (const entry of moved) {
      try { fs.renameSync(path.join(trashPath, entry.trashedFile), entry.full); } catch { /* best effort */ }
    }
    throw err;
  }

  const record = {
    version: 2,
    kind: includeIndex ? 'project' : 'memories',
    id: `${stamp}_${includeIndex ? 'project' : targets[0].file}`,
    label: label || (targets.length === 1 ? targets[0].name : `${targets.length} memories`),
    deletedAt: new Date().toISOString(),
    files: moved.map(({ file, trashedFile, name, description }) => ({ file, trashedFile, name, description })),
    indexTrashedFile: moved.indexTrashed || null,
    removedLines: removed,
    indexSha256Before: indexBefore === null ? null : sha256(indexBefore),
    indexSha256After: indexAfter === null || includeIndex ? null : sha256(indexAfter),
  };
  fs.writeFileSync(path.join(trashPath, `${record.id}.restore.json`), JSON.stringify(record, null, 2));
  return { deleted: true, record };
}

/** Single-memory delete, optionally cascading to the memories that link to it. */
export function deleteMemory(dir, file, alsoDelete = []) {
  const extra = [].concat(alsoDelete).filter((f) => f && f !== file);
  return deleteMemories(dir, [file, ...extra]);
}

/** What clearing a whole project would remove. */
export function projectDeletePreview(dir) {
  const files = listMemoryFiles(dir);
  const indexText = readIndex(dir);
  return {
    files: files.map((file) => {
      const memory = loadMemory(dir, file);
      return { file, name: memory?.name || file, description: memory?.description || '' };
    }),
    hasIndex: indexText !== null,
    indexLines: indexText === null ? 0 : indexText.split('\n').length,
  };
}

/** Trash every memory in a project, MEMORY.md included, as one operation. */
export function deleteProject(dir) {
  const files = listMemoryFiles(dir);
  const indexText = readIndex(dir);
  if (!files.length && indexText === null) throw new Error('This project has no memory to delete');

  if (!files.length) {
    // Only MEMORY.md exists: trash it on its own.
    const trashPath = path.join(dir, TRASH_DIR);
    fs.mkdirSync(trashPath, { recursive: true });
    const stamp = timestamp();
    const trashedIndex = `${stamp}_MEMORY.md`;
    fs.renameSync(indexPath(dir), path.join(trashPath, trashedIndex));
    const record = {
      version: 2,
      kind: 'project',
      id: `${stamp}_project`,
      label: 'MEMORY.md',
      deletedAt: new Date().toISOString(),
      files: [],
      indexTrashedFile: trashedIndex,
      removedLines: [],
      indexSha256Before: sha256(indexText),
      indexSha256After: null,
    };
    fs.writeFileSync(path.join(trashPath, `${record.id}.restore.json`), JSON.stringify(record, null, 2));
    return { deleted: true, record };
  }

  return deleteMemories(dir, files, {
    includeIndex: indexText !== null,
    label: `whole project (${files.length} memories)`,
  });
}

/**
 * Turn a broken `[[target]]` into plain text in one memory. The original file
 * is copied into .trash first so the edit can be undone like any delete.
 */
export function removeWikilink(dir, file, target) {
  const full = safeMemoryPath(dir, file);
  if (!fs.existsSync(full)) throw new Error(`No such memory: ${file}`);
  if (typeof target !== 'string' || !target.trim()) throw new Error('No link target given');

  const original = fs.readFileSync(full, 'utf8');
  const { text, count } = unwrapWikilink(original, target);
  if (count === 0) throw new Error(`No [[${target}]] found in ${file}`);

  const trashPath = path.join(dir, TRASH_DIR);
  fs.mkdirSync(trashPath, { recursive: true });
  const stamp = timestamp();
  const backupFile = `${stamp}_${file}.before-unlink.md`;
  fs.writeFileSync(path.join(trashPath, backupFile), original);

  try {
    writeFileAtomic(dir, file, text);
  } catch (err) {
    try { fs.unlinkSync(path.join(trashPath, backupFile)); } catch { /* best effort */ }
    throw err;
  }

  const record = {
    version: 2,
    kind: 'wikilink',
    id: `${stamp}_${file}.unlink`,
    label: `[[${target}]] in ${file}`,
    deletedAt: new Date().toISOString(),
    sourceFile: file,
    target,
    occurrences: count,
    backupFile,
    files: [],
    removedLines: [],
  };
  fs.writeFileSync(path.join(trashPath, `${record.id}.restore.json`), JSON.stringify(record, null, 2));
  return { removed: true, occurrences: count, record };
}

/** Undo any trashed operation: a delete, a cascade, a project clear, or an unlink. */
export function restoreMemory(dir, id) {
  const trashPath = path.join(dir, TRASH_DIR);
  const recordPath = path.join(trashPath, `${id}.restore.json`);
  if (!fs.existsSync(recordPath)) throw new Error('No such trash record');

  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));

  if (record.kind === 'wikilink') {
    safeMemoryPath(dir, record.sourceFile);
    const backup = path.join(trashPath, record.backupFile);
    if (!fs.existsSync(backup)) throw new Error('The backup copy is gone');
    writeFileAtomic(dir, record.sourceFile, fs.readFileSync(backup, 'utf8'));
    fs.unlinkSync(backup);
    fs.unlinkSync(recordPath);
    return { restored: true, file: record.sourceFile, indexRestored: 'n/a', kind: 'wikilink' };
  }

  // Older single-file records used `memoryFile`/`trashedFile` at the top level.
  const entries = record.files?.length
    ? record.files
    : [{ file: record.memoryFile, trashedFile: record.trashedFile }];

  for (const entry of entries) {
    const target = safeMemoryPath(dir, entry.file);
    if (fs.existsSync(target)) throw new Error(`${entry.file} already exists - not overwriting it`);
    if (!fs.existsSync(path.join(trashPath, entry.trashedFile))) {
      throw new Error(`The trashed copy of ${entry.file} is gone`);
    }
  }

  for (const entry of entries) {
    fs.renameSync(path.join(trashPath, entry.trashedFile), path.join(dir, entry.file));
  }

  let indexRestored = 'skipped';
  if (record.indexTrashedFile) {
    // A whole-project clear took MEMORY.md with it.
    if (fs.existsSync(indexPath(dir))) {
      indexRestored = 'skipped';
    } else {
      fs.renameSync(path.join(trashPath, record.indexTrashedFile), indexPath(dir));
      indexRestored = 'exact';
    }
  } else {
    const current = readIndex(dir);
    if (current !== null && record.removedLines?.length) {
      // Only splice lines back at their exact positions if MEMORY.md is still
      // what the delete left behind; otherwise append and say so.
      if (sha256(current) === record.indexSha256After) {
        writeIndexAtomic(dir, insertLines(current, record.removedLines));
        indexRestored = 'exact';
      } else {
        const suffix = record.removedLines.map((l) => l.text).join('\n');
        const separator = current.endsWith('\n') ? '' : '\n';
        writeIndexAtomic(dir, `${current}${separator}${suffix}\n`);
        indexRestored = 'appended';
      }
    }
  }

  fs.unlinkSync(recordPath);
  return { restored: true, files: entries.map((e) => e.file), indexRestored, kind: record.kind || 'memories' };
}

/** Drop a single MEMORY.md line, used to clear a pointer whose file is gone. */
export function deleteIndexLine(dir, lineIndex, expectedText) {
  const current = readIndex(dir);
  if (current === null) throw new Error('This project has no MEMORY.md');

  const { text, removed } = removeLine(current, lineIndex, expectedText);
  writeIndexAtomic(dir, text);
  return { removed };
}
