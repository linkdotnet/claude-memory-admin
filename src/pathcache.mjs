// An opt-in record of project paths the user has confirmed.
//
// Claude Code sweeps session transcripts after cleanupPeriodDays but explicitly
// never touches the memory directory, so the evidence this tool uses to name a
// store expires while the store itself does not. A project whose transcripts
// have aged out shows its raw slug forever, and no amount of re-reading brings
// the name back.
//
// Nothing here runs on its own. The file is created only when the user asks for
// a path to be remembered, and it holds slugs and directory paths - never memory
// content. That keeps the default behaviour a pure read of the store, and keeps
// this the only writer outside a memory/ directory.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CACHE_DIR = process.env.MEMORY_PATH_CACHE_DIR || path.join(os.homedir(), '.claude-memory-admin');
export const CACHE_FILE = path.join(CACHE_DIR, 'paths.json');

/** Remembered paths by slug, or an empty map. Never throws: a bad file is ignored. */
export function readPathCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The remembered path for one slug, only if it still exists on disk. */
export function rememberedPath(slug) {
  const entry = readPathCache()[slug];
  const dir = entry && typeof entry.path === 'string' ? entry.path : null;
  if (!dir) return null;
  try {
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    // Remembered, then moved or deleted. Say nothing rather than assert a path
    // that is no longer there.
    return null;
  }
}

function writeCache(data) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = `${CACHE_FILE}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, CACHE_FILE);
}

/**
 * Record a path for a slug. Only an existing directory is accepted: the point is
 * to preserve a fact that was verifiable once, not to let a typo become the
 * label a project carries from now on.
 */
export function rememberPath(slug, dir) {
  if (typeof slug !== 'string' || !slug) throw new Error('Invalid project');
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
    throw new Error('Path must be absolute');
  }
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new Error(`${dir} does not exist`);
  }
  if (!stat.isDirectory()) throw new Error(`${dir} is not a directory`);

  const cache = readPathCache();
  cache[slug] = { path: dir, rememberedAt: new Date().toISOString() };
  writeCache(cache);
  return { slug, path: dir };
}

/** Drop a remembered path. Removing the last one removes the file entirely. */
export function forgetPath(slug) {
  const cache = readPathCache();
  if (!(slug in cache)) return { slug, forgotten: false };
  delete cache[slug];
  if (Object.keys(cache).length === 0) {
    try { fs.unlinkSync(CACHE_FILE); } catch { /* already gone */ }
  } else {
    writeCache(cache);
  }
  return { slug, forgotten: true };
}
