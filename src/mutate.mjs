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
import {
  parseIndex,
  removeIndexEntries,
  removeLine,
  insertLines,
  unwrapWikilink,
  retargetWikilink,
  setIndexHook,
  moveIndexEntry as moveIndexEntryText,
  sectionInsertIndex,
  sectionStartIndex,
  topInsertIndex,
  insertIndexEntry,
  dominantSeparator,
} from './parse.mjs';
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
 * Replace a file atomically: write a sibling temp file, fsync it, rename over
 * the target. A .backup copy is kept for the duration and restored if anything
 * throws, so a crash can never leave a truncated file behind.
 *
 * Exported because the settings and agent writers outside this module need the
 * same guarantee, and a second implementation of it is a second chance to get
 * the crash path wrong.
 */
export function writeFileAtomic(dir, name, text) {
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

  if (record.kind === 'index-edit') {
    const current = readIndex(dir);
    const unchanged = current !== null && sha256(current) === record.indexSha256After;

    if (record.indexCreated) {
      if (!unchanged) throw new Error('MEMORY.md has changed since it was created - not deleting it');
      fs.unlinkSync(indexPath(dir));
      fs.unlinkSync(recordPath);
      return { restored: true, file: 'MEMORY.md', indexRestored: 'exact', kind: 'index-edit' };
    }

    const backup = path.join(trashPath, record.indexBackupFile);
    if (!fs.existsSync(backup)) throw new Error('The backup copy of MEMORY.md is gone');
    writeIndexAtomic(dir, fs.readFileSync(backup, 'utf8'));
    fs.unlinkSync(backup);
    fs.unlinkSync(recordPath);
    return {
      restored: true,
      file: 'MEMORY.md',
      indexRestored: unchanged ? 'exact' : 'overwritten',
      kind: 'index-edit',
    };
  }

  if (record.kind === 'merge') {
    const entry = record.files[0];
    safeMemoryPath(dir, entry.file);
    if (fs.existsSync(path.join(dir, entry.file))) {
      throw new Error(`${entry.file} already exists - not overwriting it`);
    }
    for (const backup of record.backups) {
      if (!fs.existsSync(path.join(trashPath, backup.backupFile))) {
        throw new Error(`The backup copy of ${backup.file} is gone`);
      }
    }
    if (!fs.existsSync(path.join(trashPath, entry.trashedFile))) {
      throw new Error(`The trashed copy of ${entry.file} is gone`);
    }

    for (const backup of record.backups) {
      writeFileAtomic(dir, backup.file, fs.readFileSync(path.join(trashPath, backup.backupFile), 'utf8'));
    }
    fs.renameSync(path.join(trashPath, entry.trashedFile), path.join(dir, entry.file));
    for (const backup of record.backups) fs.unlinkSync(path.join(trashPath, backup.backupFile));
    fs.unlinkSync(recordPath);

    return { restored: true, files: [entry.file, record.into], indexRestored: 'exact', kind: 'merge' };
  }

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

function trashDir(dir) {
  const trashPath = path.join(dir, TRASH_DIR);
  fs.mkdirSync(trashPath, { recursive: true });
  return trashPath;
}

function backupInto(trashPath, name, text) {
  fs.writeFileSync(path.join(trashPath, name), text);
  return name;
}

function editIndex(dir, { op, label, apply }) {
  const before = readIndex(dir);
  const created = before === null;
  const { text, ...detail } = apply(before);

  const trashPath = trashDir(dir);
  const stamp = timestamp();
  const backupFile = created ? null : backupInto(trashPath, `${stamp}_MEMORY.md.before-${op}.md`, before);

  try {
    writeIndexAtomic(dir, text);
  } catch (err) {
    if (backupFile) {
      try { fs.unlinkSync(path.join(trashPath, backupFile)); } catch { /* best effort */ }
    }
    throw err;
  }

  const record = {
    version: 2,
    kind: 'index-edit',
    op,
    id: `${stamp}_${op}`,
    label,
    deletedAt: new Date().toISOString(),
    indexBackupFile: backupFile,
    indexCreated: created,
    indexSha256Before: created ? null : sha256(before),
    indexSha256After: sha256(text),
    files: [],
    removedLines: [],
  };
  fs.writeFileSync(path.join(trashPath, `${record.id}.restore.json`), JSON.stringify(record, null, 2));
  return { record, ...detail };
}

function requireIndex(text) {
  if (text === null) throw new Error('This project has no MEMORY.md');
  return text;
}

export function editIndexHook(dir, { lineIndex, expectedText, hook }) {
  return editIndex(dir, {
    op: 'hook',
    label: `hook on MEMORY.md line ${Number(lineIndex) + 1}`,
    apply: (current) => {
      const result = setIndexHook(requireIndex(current), lineIndex, expectedText, hook);
      return { text: result.text, before: result.before, after: result.after, edited: true };
    },
  });
}

function resolveMoveTarget(parsed, { toIndex, section, top }) {
  if (toIndex !== undefined && toIndex !== null) return Number(toIndex);
  if (top) return topInsertIndex(parsed);
  if (section) return sectionStartIndex(parsed, section);
  throw new Error('No target given for the move');
}

export function moveIndexEntry(dir, { lineIndex, expectedText, toIndex, section = null, top = false }) {
  return editIndex(dir, {
    op: 'move',
    label: `moved MEMORY.md line ${Number(lineIndex) + 1}`,
    apply: (current) => {
      const text = requireIndex(current);
      const target = resolveMoveTarget(parseIndex(text), { toIndex, section, top });
      const result = moveIndexEntryText(text, lineIndex, expectedText, target);
      return { text: result.text, moved: result.moved, toIndex: result.toIndex, movedEntry: true };
    },
  });
}

function composeEntry(current, memory, title, hook) {
  const parsed = current === null ? null : parseIndex(current);
  const separator = parsed ? dominantSeparator(parsed) : ' — ';
  const label = String(title ?? '').trim() || memory.name;
  const text = String(hook ?? '').trim();
  if (/[\r\n]/.test(label) || /[\r\n]/.test(String(hook ?? ''))) {
    throw new Error('An index entry has to stay on one line');
  }
  const bullet = `- [${label.replace(/[[\]]/g, '')}](${memory.file})`;
  return text ? `${bullet}${separator}${text}` : bullet;
}

function requireIndexable(dir, file) {
  const full = safeMemoryPath(dir, file);
  if (!fs.existsSync(full)) throw new Error(`No such memory: ${file}`);
  const memory = loadMemory(dir, file);
  if (!memory) throw new Error(`Could not read ${file}`);
  return memory;
}

export function addIndexEntryPreview(dir, { file, section = null, title = null, hook = null }) {
  const memory = requireIndexable(dir, file);
  const current = readIndex(dir);
  const parsed = current === null ? null : parseIndex(current);
  const existing = parsed ? parsed.entries.find((entry) => entry.file === file) : null;

  return {
    file,
    name: memory.name,
    description: memory.description,
    sections: parsed
      ? [...new Set(parsed.parsedLines.filter((line) => line.kind === 'heading').map((line) => line.section))]
      : [],
    hasIndex: current !== null,
    alreadyIndexed: Boolean(existing),
    existingLine: existing ? { index: existing.index, text: existing.text } : null,
    line: composeEntry(current, memory, title ?? memory.name, hook ?? memory.description),
    at: parsed ? sectionInsertIndex(parsed, section) : 2,
  };
}

export function addIndexEntry(dir, { file, section = null, title = null, hook = null }) {
  const memory = requireIndexable(dir, file);

  return editIndex(dir, {
    op: 'add',
    label: `index entry for ${file}`,
    apply: (current) => {
      const line = composeEntry(current, memory, title ?? memory.name, hook ?? memory.description);
      if (current === null) return { text: `# Memory\n\n${line}\n`, line, at: 2, added: true };

      const parsed = parseIndex(current);
      if (parsed.entries.some((entry) => entry.file === file)) {
        throw new Error(`MEMORY.md already has an entry for ${file}`);
      }
      const result = insertIndexEntry(current, sectionInsertIndex(parsed, section), line);
      return { text: result.text, line, at: result.index, added: true };
    },
  });
}

function resolveTargets(memories) {
  const byName = new Map();
  const byStem = new Map();
  for (const memory of memories) {
    if (!byName.has(memory.name)) byName.set(memory.name, memory.file);
    if (!byStem.has(memory.stem)) byStem.set(memory.stem, memory.file);
  }
  return (target) => byName.get(target) || byStem.get(target) || null;
}

function loadAll(dir) {
  return listMemoryFiles(dir).map((file) => loadMemory(dir, file)).filter(Boolean);
}

function mergePlan(dir, into, from) {
  if (into === from) throw new Error('A memory cannot be merged into itself');
  const target = requireIndexable(dir, into);
  const source = requireIndexable(dir, from);

  const memories = loadAll(dir);
  const resolve = resolveTargets(memories);
  const pointsAtSource = (link) => resolve(link) === source.file;

  const inbound = [];
  const selfLinks = [];
  for (const memory of memories) {
    if (memory.file === source.file) continue;
    const targets = memory.outbound.filter(pointsAtSource);
    if (!targets.length) continue;
    if (memory.file === target.file) selfLinks.push(...targets);
    else inbound.push({ file: memory.file, name: memory.name, targets });
  }

  const indexText = readIndex(dir);
  const parsed = indexText === null ? null : parseIndex(indexText);
  const sourceEntries = parsed ? parsed.entries.filter((entry) => entry.file === from) : [];
  const inlineRefs = parsed
    ? parsed.inlineLinks.filter((link) => link.file === from).map((link) => ({ index: link.index, text: link.text }))
    : [];

  return { target, source, inbound, selfLinks, indexText, sourceEntries, inlineRefs };
}

export function mergePreview(dir, { into, from }) {
  const plan = mergePlan(dir, into, from);
  return {
    into,
    from,
    intoName: plan.target.name,
    fromName: plan.source.name,
    heading: plan.source.name,
    bodyLines: plan.source.body.trim() ? plan.source.body.trim().split('\n').length : 0,
    inbound: plan.inbound,
    selfLinks: plan.selfLinks,
    indexLines: plan.sourceEntries.map((entry) => ({ index: entry.index, text: entry.text })),
    inlineRefs: plan.inlineRefs,
    hasIndex: plan.indexText !== null,
  };
}

export function mergeMemories(dir, { into, from, heading = null }) {
  const plan = mergePlan(dir, into, from);
  const { target, source } = plan;

  const title = String(heading ?? '').trim() || source.name;
  if (/[\r\n]/.test(title)) throw new Error('A heading has to stay on one line');

  const body = source.body.trim();
  const joined = `${target.raw.replace(/\s*$/, '')}\n\n## ${title}\n\n${body}\n`;
  const merged = plan.selfLinks.reduce((text, link) => unwrapWikilink(text, link).text, joined);

  const rewrites = [{ file: target.file, text: merged }];
  for (const entry of plan.inbound) {
    const memory = loadMemory(dir, entry.file);
    if (!memory) continue;
    const text = entry.targets.reduce((current, link) => retargetWikilink(current, link, target.name).text, memory.raw);
    if (text !== memory.raw) rewrites.push({ file: entry.file, text });
  }

  const indexBefore = plan.indexText;
  const indexAfter = indexBefore === null ? null : removeIndexEntries(indexBefore, [from]);

  const trashPath = trashDir(dir);
  const stamp = timestamp();
  const backups = [];

  for (const rewrite of rewrites) {
    const memory = loadMemory(dir, rewrite.file);
    backups.push({
      file: rewrite.file,
      backupFile: backupInto(trashPath, `${stamp}_${rewrite.file}.before-merge.md`, memory.raw),
    });
  }
  if (indexBefore !== null) {
    backups.push({
      file: 'MEMORY.md',
      backupFile: backupInto(trashPath, `${stamp}_MEMORY.md.before-merge.md`, indexBefore),
    });
  }

  const trashedFile = `${stamp}_${from}`;
  const done = [];
  try {
    for (const rewrite of rewrites) {
      writeFileAtomic(dir, rewrite.file, rewrite.text);
      done.push(rewrite.file);
    }
    if (indexAfter && indexAfter.text !== indexBefore) writeIndexAtomic(dir, indexAfter.text);
    fs.renameSync(path.join(dir, source.file), path.join(trashPath, trashedFile));
  } catch (err) {
    for (const backup of backups) {
      try {
        writeFileAtomic(dir, backup.file, fs.readFileSync(path.join(trashPath, backup.backupFile), 'utf8'));
      } catch { /* best effort */ }
    }
    for (const backup of backups) {
      try { fs.unlinkSync(path.join(trashPath, backup.backupFile)); } catch { /* best effort */ }
    }
    throw err;
  }

  const record = {
    version: 2,
    kind: 'merge',
    id: `${stamp}_merge_${from}`,
    label: `${source.name} into ${target.name}`,
    deletedAt: new Date().toISOString(),
    into: target.file,
    from: source.file,
    heading: title,
    backups,
    files: [{ file: source.file, trashedFile, name: source.name, description: source.description }],
    removedLines: indexAfter ? indexAfter.removed : [],
    indexSha256Before: indexBefore === null ? null : sha256(indexBefore),
    indexSha256After: indexAfter === null ? null : sha256(indexAfter.text),
  };
  fs.writeFileSync(path.join(trashPath, `${record.id}.restore.json`), JSON.stringify(record, null, 2));

  return {
    merged: true,
    record,
    rewritten: rewrites.map((rewrite) => rewrite.file),
    retargeted: plan.inbound.length,
    unwrapped: plan.selfLinks.length,
  };
}
