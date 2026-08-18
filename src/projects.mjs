// Discovery of project directories under the Claude projects root, and the
// recovery of their real filesystem paths.
//
// Directory names are slugified cwds ("-Users-me-repos-Blog"), and the
// slugification is lossy: a literal dash in a folder name is indistinguishable
// from a path separator. So decoding the slug is a fallback, not the primary
// method. The reliable source is the session transcripts sitting next to the
// memory dir, whose JSONL lines carry the true `cwd`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_ROOT = path.join(os.homedir(), '.claude', 'projects');
const USER_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

function expandHome(value) {
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * Claude Code lets `autoMemoryDirectory` in settings.json move the memory store
 * somewhere else entirely. Honour it, or this tool would confidently show an
 * empty store to anyone who has set it.
 */
export function configuredMemoryDirectory() {
  try {
    const settings = JSON.parse(fs.readFileSync(USER_SETTINGS, 'utf8'));
    const configured = settings?.autoMemoryDirectory;
    if (typeof configured === 'string' && configured.trim()) return expandHome(configured.trim());
  } catch {
    // No settings file, or not readable/parseable: fall through to the default.
  }
  return null;
}

export function projectsRoot() {
  if (process.env.MEMORY_ROOT) return expandHome(process.env.MEMORY_ROOT);
  return configuredMemoryDirectory() || DEFAULT_ROOT;
}

/** Read the first chunk of a file without pulling a multi-megabyte transcript into memory. */
function readHead(file, bytes = 131072) {
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

/** Pull `cwd` out of the newest transcripts. Authoritative when present. */
function cwdFromTranscripts(dir) {
  const transcripts = findTranscripts(dir).sort((a, b) => b.mtime - a.mtime);
  for (const { file } of transcripts.slice(0, 3)) {
    let head;
    try {
      head = readHead(file);
    } catch {
      continue;
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
  }
  return null;
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
  const fromTranscript = cwdFromTranscripts(dir);
  if (fromTranscript) {
    return {
      path: fromTranscript,
      resolvedBy: 'transcript',
      exists: fs.existsSync(fromTranscript),
    };
  }
  const decoded = decodeSlug(slug);
  if (decoded.verified) {
    return { path: decoded.path, resolvedBy: 'slug', exists: true };
  }
  // Nothing confirmed the guess, so show the slug rather than a path that
  // looks authoritative and is probably wrong.
  return { path: slug, resolvedBy: 'unresolved', exists: false, guess: decoded.path };
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
        hasMemoryDir,
        hasIndex: hasMemoryDir && fs.existsSync(path.join(mem, 'MEMORY.md')),
        memoryCount: files.length,
      };
    })
    .sort((a, b) => b.memoryCount - a.memoryCount || a.label.localeCompare(b.label));
}
