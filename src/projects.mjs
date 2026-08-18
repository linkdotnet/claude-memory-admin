// Discovery of project directories under the Claude projects root, and the
// recovery of their real filesystem paths.
//
// Directory names are slugified cwds ("-Users-me-repos-Blog"), and the
// slugification is lossy: a literal dash in a folder name is indistinguishable
// from a path separator. So decoding the slug is a fallback, not the primary
// method. The reliable source is the session transcripts sitting next to the
// memory dir, whose JSONL lines carry the true `cwd`.
//
// One memory directory can serve several working directories: Claude Code keys
// the store on the git repository, so every worktree and subdirectory of a repo
// shares it. Reading a single `cwd` therefore names the store after whichever
// directory happened to run last, which is why every distinct cwd is collected
// and the repository root preferred as the store's identity.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rememberedPath } from './pathcache.mjs';
import { autoMemoryState, expandHome, resolveMemoryDirectory } from './settings.mjs';

export const DEFAULT_ROOT = path.join(os.homedir(), '.claude', 'projects');

/**
 * Which store to read, and what decided it. The source travels with the path so
 * the UI can say where a non-default store came from; a tool that silently reads
 * somewhere other than the default is worse than one that reads nothing.
 */
export function resolveRoot() {
  if (process.env.MEMORY_ROOT) {
    return { path: expandHome(process.env.MEMORY_ROOT), source: 'flag', file: null, invalid: null };
  }
  const configured = resolveMemoryDirectory({ projectDir: process.cwd() });
  if (configured?.path) {
    return { path: configured.path, source: configured.scope, file: configured.file, invalid: null };
  }
  if (configured?.invalid) {
    // Set, but to something Claude Code would not accept either. Fall back, and
    // carry the reason so it can be reported rather than swallowed.
    return {
      path: DEFAULT_ROOT,
      source: 'default',
      file: configured.file,
      invalid: `autoMemoryDirectory "${configured.raw}" is ${configured.invalid}`,
    };
  }
  return { path: DEFAULT_ROOT, source: 'default', file: null, invalid: null };
}

export function projectsRoot() {
  return resolveRoot().path;
}

/**
 * Read the head of a file without pulling a multi-megabyte transcript into
 * memory. The `cwd` field shows up within the first few lines in practice, so
 * the small read almost always suffices and the large one is a fallback.
 */
function readHead(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function findTranscripts(dir, depth = 2) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        out.push({ file: full, mtime: fs.statSync(full).mtimeMs });
      } catch { /* raced with a delete */ }
    } else if (entry.isDirectory() && depth > 0 && entry.name !== 'memory') {
      out.push(...findTranscripts(full, depth - 1));
    }
  }
  return out;
}

/** The first `cwd` in one transcript, escalating the read only if the small one missed. */
function cwdInTranscript(file) {
  for (const size of [16384, 131072]) {
    let head;
    try {
      head = readHead(file, size);
    } catch {
      return null;
    }
    for (const line of head.split('\n')) {
      if (!line.includes('"cwd"')) continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed?.cwd === 'string' && parsed.cwd.startsWith('/')) return parsed.cwd;
      } catch {
        // Truncated final line of the chunk, or a non-object line. Skip it.
      }
    }
    if (head.length < size) return null; // Read the whole file already.
  }
  return null;
}

/**
 * Distinct `cwd` values across the newest transcripts, newest first.
 *
 * The cap keeps this cheap on projects with hundreds of sessions. It biases
 * towards recent directories, which is the right bias: a worktree deleted a year
 * ago is not worth naming the store after.
 */
export function cwdsFromTranscripts(dir, { limit = 12 } = {}) {
  const transcripts = findTranscripts(dir).sort((a, b) => b.mtime - a.mtime);
  const seen = new Set();
  for (const { file } of transcripts.slice(0, limit)) {
    const cwd = cwdInTranscript(file);
    if (cwd) seen.add(cwd);
  }
  return [...seen];
}

/** Longest path prefix shared by every input, or null when they share only "/". */
function commonAncestor(paths) {
  if (paths.length === 0) return null;
  let parts = paths[0].split('/');
  for (const other of paths.slice(1)) {
    const segments = other.split('/');
    let i = 0;
    while (i < parts.length && i < segments.length && parts[i] === segments[i]) i += 1;
    parts = parts.slice(0, i);
  }
  const joined = parts.join('/');
  return joined.length > 1 ? joined : null;
}

function isGitRoot(dir) {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

/**
 * Which of several working directories names the store.
 *
 * Claude Code derives the store from the git repository, so when the cwds share
 * an ancestor that is a repository root, that root is the store's real identity
 * and every cwd is a worktree or subdirectory of it. When they do not - two
 * worktrees checked out in unrelated places share a repo but not a path prefix -
 * there is nothing to confirm, so the newest cwd is used exactly as before
 * rather than inventing a common parent that means nothing.
 */
export function storeIdentity(cwds) {
  if (cwds.length === 0) return null;
  if (cwds.length === 1) return { path: cwds[0], resolvedBy: 'transcript' };

  const ancestor = commonAncestor(cwds);
  if (ancestor && isGitRoot(ancestor)) {
    return { path: ancestor, resolvedBy: 'repo-root' };
  }
  return { path: cwds[0], resolvedBy: 'transcript' };
}

/**
 * Best-effort slug decode, used only when there is no transcript to read.
 * Candidates are verified against the filesystem so a wrong guess is reported
 * as unresolved rather than presented as fact.
 */
function decodeSlug(slug) {
  const body = slug.replace(/^-/, '');
  const candidates = [
    '/' + body.replace(/--/g, '/.').replace(/-/g, '/'),
    '/' + body.replace(/-/g, '/'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return { path: candidate, verified: true };
    } catch { /* unreadable path */ }
  }
  return { path: candidates[0], verified: false };
}

export function resolveProjectPath(dir, slug) {
  const cwds = cwdsFromTranscripts(dir);
  const identity = storeIdentity(cwds);
  if (identity) {
    return {
      path: identity.path,
      resolvedBy: identity.resolvedBy,
      exists: fs.existsSync(identity.path),
      workingDirs: cwds,
    };
  }
  // A path the user confirmed once outranks a decode, and is the only thing that
  // survives Claude Code sweeping the transcripts this store was named from.
  const remembered = rememberedPath(slug);
  if (remembered) {
    return { path: remembered, resolvedBy: 'remembered', exists: true, workingDirs: [] };
  }

  const decoded = decodeSlug(slug);
  if (decoded.verified) {
    return { path: decoded.path, resolvedBy: 'slug', exists: true, workingDirs: [] };
  }
  // Nothing confirmed the guess, so show the slug rather than a path that
  // looks authoritative and is probably wrong.
  return { path: slug, resolvedBy: 'unresolved', exists: false, guess: decoded.path, workingDirs: [] };
}

/** A short label for the sidebar: the last two path segments. */
export function shortLabel(fullPath) {
  const parts = fullPath.split('/').filter(Boolean);
  return parts.slice(-2).join('/') || fullPath;
}

export function memoryDir(root, slug) {
  return path.join(root, slug, 'memory');
}

/** List memory filenames, excluding the index itself and the trash folder. */
export function listMemoryFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'MEMORY.md')
    .map((e) => e.name)
    .sort();
}

/** Every project dir under the root, whether or not it has memory. */
export function listProjects(root = projectsRoot()) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((e) => e.isDirectory())
    .map((e) => {
      const slug = e.name;
      const dir = path.join(root, slug);
      const mem = memoryDir(root, slug);
      const hasMemoryDir = fs.existsSync(mem);
      const resolved = resolveProjectPath(dir, slug);
      const files = hasMemoryDir ? listMemoryFiles(mem) : [];
      return {
        slug,
        path: resolved.path,
        label: shortLabel(resolved.path),
        resolvedBy: resolved.resolvedBy,
        pathExists: resolved.exists,
        workingDirs: resolved.workingDirs,
        autoMemory: autoMemoryState({ projectDir: resolved.exists ? resolved.path : null }),
        hasMemoryDir,
        hasIndex: hasMemoryDir && fs.existsSync(path.join(mem, 'MEMORY.md')),
        memoryCount: files.length,
      };
    })
    .sort((a, b) => b.memoryCount - a.memoryCount || a.label.localeCompare(b.label));
}
