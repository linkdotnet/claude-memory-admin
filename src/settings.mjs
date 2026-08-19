// Layered reads of Claude Code's settings files.
//
// Several keys this tool cares about - autoMemoryDirectory, autoMemoryEnabled -
// can be set in any settings scope, and the scope that wins is not the one you
// would guess: managed policy beats everything, and the user file everyone
// actually edits is the weakest of the five. Reading only ~/.claude/settings.json
// silently shows the wrong store to anyone who set the key anywhere else.
//
// Precedence, strongest first:
//   managed policy  ->  --settings  ->  .claude/settings.local.json
//               ->  .claude/settings.json  ->  ~/.claude/settings.json

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const USER_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

/** Default when nothing sets cleanupPeriodDays; transcripts older than this are swept. */
export const DEFAULT_CLEANUP_PERIOD_DAYS = 30;

export const SETTINGS_SEVERITY = {
  unparseable: 'bad',
  unreadable: 'bad',
  'not-object': 'bad',
  'invalid-auto-memory-directory': 'bad',
};

export function summariseSettings(problems) {
  const list = problems || [];
  return {
    count: list.length,
    severity: list.some((problem) => problem.severity === 'bad') ? 'bad' : list.length ? 'warn' : 'ok',
  };
}

function managedDir() {
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (process.platform === 'win32') return 'C:\\Program Files\\ClaudeCode';
  return '/etc/claude-code';
}

/**
 * Managed policy settings: the main file plus the managed-settings.d drop-in
 * directory, which organisations use to compose policy from several files.
 */
export function managedSettingsFiles() {
  const dir = managedDir();
  const files = [path.join(dir, 'managed-settings.json')];
  let dropIns;
  try {
    dropIns = fs.readdirSync(path.join(dir, 'managed-settings.d'));
  } catch {
    dropIns = [];
  }
  for (const name of dropIns.filter((n) => n.endsWith('.json')).sort()) {
    files.push(path.join(dir, 'managed-settings.d', name));
  }
  return files;
}

function readJsonDetailed(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const status = err.code === 'ENOENT' || err.code === 'ENOTDIR' ? 'absent' : 'unreadable';
    return { status, data: null, error: status === 'absent' ? null : err.message };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { status: 'unparseable', data: null, error: err.message };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'not-object', data: null, error: 'the file is valid JSON but not an object' };
  }
  return { status: 'ok', data: parsed, error: null };
}

function settingsCandidates({ projectDir = null, settingsFile = null } = {}) {
  const candidates = [];
  for (const file of managedSettingsFiles()) candidates.push({ scope: 'managed', file });
  if (settingsFile) candidates.push({ scope: 'settings-flag', file: settingsFile });
  if (projectDir) {
    candidates.push({ scope: 'local', file: path.join(projectDir, '.claude', 'settings.local.json') });
    candidates.push({ scope: 'project', file: path.join(projectDir, '.claude', 'settings.json') });
  }
  candidates.push({ scope: 'user', file: USER_SETTINGS });
  return candidates;
}

/**
 * Every settings file that exists and parses, strongest first, each tagged with
 * the scope it came from so the UI can name the file a value came from rather
 * than leaving the user to guess which of five files is in charge.
 *
 * `projectDir` is the directory a session would run in. This tool browses every
 * project at once and is not itself a session, so callers pass either the launch
 * cwd (for the store location, which is decided before any project is chosen) or
 * a specific project's resolved path (for that project's auto memory state).
 */
export function settingsLayers(options = {}) {
  const layers = [];
  for (const candidate of settingsCandidates(options)) {
    const read = readJsonDetailed(candidate.file);
    if (read.status === 'ok') layers.push({ ...candidate, data: read.data });
  }
  return layers;
}

/** First layer that defines `key`, or null. Layers are already in precedence order. */
export function lookup(layers, key) {
  for (const layer of layers) {
    if (Object.prototype.hasOwnProperty.call(layer.data, key)) {
      return { value: layer.data[key], scope: layer.scope, file: layer.file };
    }
  }
  return null;
}

export function expandHome(value) {
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * Where the auto memory store lives, per settings.
 *
 * The documented contract is "an absolute path or a `~/`-prefixed path". A value
 * that is neither is reported rather than quietly ignored: the alternative is
 * showing someone the default store while their setting points elsewhere, which
 * is the exact failure this function exists to prevent.
 *
 * Returns { path, scope, file } when set, { invalid, ... } when set but
 * unusable, or null when no layer sets it.
 */
export function resolveMemoryDirectory(options = {}) {
  const found = lookup(settingsLayers(options), 'autoMemoryDirectory');
  if (!found) return null;

  const raw = typeof found.value === 'string' ? found.value.trim() : '';
  if (!raw) return null;
  if (!raw.startsWith('/') && !raw.startsWith('~/') && !/^[A-Za-z]:[\\/]/.test(raw)) {
    return { ...found, raw, path: null, invalid: 'not an absolute or ~/ path' };
  }
  return { ...found, raw, path: expandHome(raw), invalid: null };
}

/**
 * Whether auto memory is on for a project, and what decided it.
 *
 * A project with auto memory off has a store that will never grow again, which
 * on disk is indistinguishable from a project Claude has simply not learned
 * anything about yet. Without a resolved project path there is no project or
 * local layer to read, so the answer is unknown rather than assumed.
 */
export function autoMemoryState({ projectDir = null } = {}) {
  const env = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
  if (env && env !== '0' && env !== 'false') {
    return { enabled: false, setBy: 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', scope: 'env', known: true };
  }

  const found = lookup(settingsLayers({ projectDir }), 'autoMemoryEnabled');
  if (found && typeof found.value === 'boolean') {
    return { enabled: found.value, setBy: found.file, scope: found.scope, known: true };
  }
  // Default is true, but without a project path the project and local layers
  // were never consulted, so "on" here is an assumption and is labelled one.
  return { enabled: true, setBy: null, scope: 'default', known: Boolean(projectDir) };
}

/** Retention period for session transcripts. Memory files are excluded from the sweep. */
export function cleanupPeriodDays(options = {}) {
  const found = lookup(settingsLayers(options), 'cleanupPeriodDays');
  const value = Number(found?.value);
  return Number.isFinite(value) && value >= 1 ? value : DEFAULT_CLEANUP_PERIOD_DAYS;
}

export const REPORTED_KEYS = [
  {
    key: 'autoMemoryEnabled',
    fallback: true,
    detail: 'Whether Claude Code still writes new memories for this project.',
  },
  {
    key: 'autoMemoryDirectory',
    fallback: null,
    detail: 'Where the memory store lives. Unset means ~/.claude/projects.',
  },
  {
    key: 'claudeMdExcludes',
    fallback: [],
    detail: 'Instruction files a session skips when it starts.',
  },
  {
    key: 'cleanupPeriodDays',
    fallback: DEFAULT_CLEANUP_PERIOD_DAYS,
    detail: 'How long session transcripts are kept. Memory files are never swept.',
  },
];

export function settingsDiagnostics(options = {}) {
  return settingsCandidates(options).map((candidate) => {
    const read = readJsonDetailed(candidate.file);
    return { scope: candidate.scope, file: candidate.file, status: read.status, error: read.error };
  });
}

export function settingsReport(options = {}) {
  const reads = settingsCandidates(options).map((candidate) => ({
    ...candidate,
    ...readJsonDetailed(candidate.file),
  }));
  const layers = reads.map(({ scope, file, status, error }) => ({ scope, file, status, error }));

  const keys = REPORTED_KEYS.map(({ key, fallback, detail }) => {
    const values = reads
      .filter((read) => read.status === 'ok' && Object.prototype.hasOwnProperty.call(read.data, key))
      .map((read) => ({ scope: read.scope, file: read.file, value: read.data[key], wins: false }));
    if (values.length) values[0].wins = true;
    const winner = values[0] || null;

    return {
      key,
      detail,
      fallback,
      effective: winner ? { value: winner.value, scope: winner.scope, file: winner.file } : null,
      values,
    };
  });

  const cleanup = keys.find((entry) => entry.key === 'cleanupPeriodDays');
  cleanup.normalized = cleanupPeriodDays(options);

  const raw = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
  const disabling = Boolean(raw && raw !== '0' && raw !== 'false');

  const problems = layers
    .filter((layer) => layer.status !== 'ok' && layer.status !== 'absent')
    .map((layer) => ({
      kind: layer.status,
      severity: SETTINGS_SEVERITY[layer.status] || 'warn',
      scope: layer.scope,
      file: layer.file,
      detail: layer.error,
    }));

  const directory = resolveMemoryDirectory(options);
  if (directory && directory.invalid) {
    problems.push({
      kind: 'invalid-auto-memory-directory',
      severity: SETTINGS_SEVERITY['invalid-auto-memory-directory'],
      scope: directory.scope,
      file: directory.file,
      detail: `"${directory.raw}" is ${directory.invalid}`,
    });
  }

  return {
    projectDir: options.projectDir ?? null,
    layers,
    keys,
    env: {
      name: 'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
      value: raw ?? null,
      overrides: disabling ? 'autoMemoryEnabled' : null,
    },
    problems,
  };
}
