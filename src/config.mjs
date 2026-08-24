// Where Claude Code keeps its files, and the path primitives that answer it the
// same way on all three platforms.
//
// Everything under ~/.claude - the projects root, the agent definitions, the
// agent memory directories, the user settings file, the output styles - moves as
// one when CLAUDE_CONFIG_DIR is set. Hardcoding the home-relative path in each
// module meant a machine with a custom config dir opened this tool to an empty
// list rather than to its memory, so all of them resolve through configDir()
// instead.
//
// The platform is a parameter on every function here rather than a read of
// process.platform inside it. Only one of the three platforms is ever available
// to develop on, and behaviour that cannot be exercised from a test is behaviour
// nobody checks: the defaults keep the call sites unchanged and the parameter is
// what lets test/config.test.mjs assert the Windows rules from anywhere.

import os from 'node:os';
import path from 'node:path';

/**
 * Expand a leading `~/`. Claude Code documents that form for autoMemoryDirectory
 * and it is what people type on every platform, Windows included, so it is
 * handled before any separator rule is applied.
 */
export function expandHome(value, { home = os.homedir() } = {}) {
  if (typeof value !== 'string') return value;
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2));
  return value;
}

/**
 * Whether a path is absolute in the sense Claude Code requires: rooted, and on
 * Windows rooted at a drive or a UNC share.
 *
 * path.isAbsolute is not enough on its own. Under win32 it answers true for
 * "/foo", which has no drive and so names nothing that can be opened. Accepting
 * it would turn a typo into a silent read of the wrong place, which is the one
 * failure every caller here exists to prevent.
 */
export function isAbsolutePath(value, platform = process.platform) {
  if (typeof value !== 'string' || !value) return false;
  if (platform === 'win32') {
    return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value) || /^\/\/[^/]/.test(value);
  }
  return value.startsWith('/');
}

/** A path with forward slashes, which is the only separator glob syntax knows. */
export function toPosix(value) {
  return typeof value === 'string' ? value.replace(/\\/g, '/') : value;
}

/**
 * A path in the form to compare two paths by, never the form to display or store.
 *
 * Windows and a default macOS volume are both case-insensitive, so two spellings
 * of one directory are one directory, and a dedup set keyed on the raw string
 * misses the duplicate. Lowercasing is only sound for the comparison: the store
 * ids in src/stores.mjs are derived from the path as found on disk and have to
 * stay that way, or every id on the machine changes.
 */
export function canonicalPath(value, platform = process.platform) {
  if (typeof value !== 'string' || !value) return value;
  const resolved = toPosix(path.resolve(value));
  return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

export const DEFAULT_CONFIG_DIR_NAME = '.claude';

/**
 * The config directory and what decided it, in the shape src/projects.mjs
 * already uses for the memory root: a tool that silently reads somewhere other
 * than the default is worse than one that reads nothing, so the source travels
 * with the path.
 *
 * A CLAUDE_CONFIG_DIR that is not absolute is reported and not used. Claude Code
 * would not accept it either, so falling back to the default is the honest
 * answer - but silently is not, hence `invalid`.
 */
export function configSource({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const fallback = path.join(home, DEFAULT_CONFIG_DIR_NAME);
  const raw = typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
  if (!raw) return { path: fallback, source: 'default', raw: null, invalid: null };

  const expanded = expandHome(raw, { home });
  if (!isAbsolutePath(expanded, platform)) {
    return {
      path: fallback,
      source: 'default',
      raw,
      invalid: `CLAUDE_CONFIG_DIR "${raw}" is not an absolute or ~/ path`,
    };
  }
  return { path: expanded, source: 'env', raw, invalid: null };
}

export function configDir(options = {}) {
  return configSource(options).path;
}

/** A path inside the config directory, such as configPath('agents'). */
export function configPath(...segments) {
  return path.join(configDir(), ...segments);
}

/**
 * CLAUDE_CODE_PROJECT_DIR_NAME, which fixes the <project> directory name so that
 * every repository launched with this config dir shares one store instead of
 * getting a slug of its own.
 *
 * Claude Code documents it as being set beside CLAUDE_CONFIG_DIR, and it is only
 * honoured here on that condition: on its own it would silently redirect a
 * default installation to a directory Claude Code is not using.
 */
export function fixedProjectDirName({ env = process.env } = {}) {
  if (typeof env.CLAUDE_CONFIG_DIR !== 'string' || !env.CLAUDE_CONFIG_DIR.trim()) return null;
  const name = typeof env.CLAUDE_CODE_PROJECT_DIR_NAME === 'string' ? env.CLAUDE_CODE_PROJECT_DIR_NAME.trim() : '';
  if (!name || name !== path.basename(name) || name.startsWith('.')) return null;
  return name;
}
