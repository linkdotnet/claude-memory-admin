// The two settings keys that decide what a session costs, and the only two keys
// this tool ever writes.
//
// Everything else in the app reports; this module changes ~/.claude/settings.json.
// That is a deliberate exception, so the surface is kept as narrow as it can be:
// a closed list of keys, a closed list of values per key, the user scope only,
// and a hard refusal to rewrite a settings file that did not parse - overwriting
// one would silently drop every setting this tool could not read.
//
// The two keys:
//
//   env.CLAUDE_CODE_SUBAGENT_MODEL  the model every subagent, agent-team member
//                                   and workflow agent runs on. It outranks both
//                                   the model asked for at the call site and the
//                                   `model:` line in an agent file.
//   outputStyle                     how Claude writes back in the main
//                                   conversation. Subagents run their own system
//                                   prompt and are untouched by it.

import fs from 'node:fs';
import path from 'node:path';

import { configPath } from './config.mjs';
import { parseFrontmatter } from './parse.mjs';
import { writeFileAtomic } from './mutate.mjs';
import {
  SETTINGS_SEVERITY,
  USER_SETTINGS,
  readJsonDetailed,
  readPath,
  settingsCandidates,
} from './settings.mjs';

export const OUTPUT_STYLES_DIR = configPath('output-styles');

// A full model name is documented as acceptable wherever an alias is, and this
// tool has no business deciding which ones exist. The shape is checked so a
// typo does not land in a settings file unnoticed; the value is not resolved.
const MODEL_ID = /^claude-[A-Za-z0-9._[\]-]+$/;

export const COST_KEYS = [
  {
    key: 'subagentModel',
    path: ['env', 'CLAUDE_CODE_SUBAGENT_MODEL'],
    label: 'CLAUDE_CODE_SUBAGENT_MODEL',
    title: 'Subagent model',
    detail: 'The model every subagent, agent-team member and workflow agent runs on. It overrides the model asked for at the call site and the model: line in an agent file both, so it is the one switch that moves all of them at once. Search and summary work rarely needs more than Haiku.',
    envVar: 'CLAUDE_CODE_SUBAGENT_MODEL',
    unset: 'inherit',
    allowModelId: true,
    custom: null,
    options: [
      { value: null, label: 'inherit', note: 'unset - each agent resolves its own model' },
      { value: 'haiku', label: 'haiku', note: 'cheapest' },
      { value: 'sonnet', label: 'sonnet' },
      { value: 'opus', label: 'opus' },
      { value: 'fable', label: 'fable', note: 'dearest' },
    ],
  },
  {
    key: 'outputStyle',
    path: ['outputStyle'],
    label: 'outputStyle',
    title: 'Output style',
    detail: 'How Claude writes back. Concise leads with the result and drops the narration, which cuts output tokens on every turn; Explanatory and Learning add to them by design. This is part of the system prompt, so a change lands on /clear or the next session, and it reaches the main conversation only.',
    envVar: null,
    unset: 'Default',
    allowModelId: false,
    custom: 'outputStyles',
    options: [
      { value: null, label: 'Default', note: 'unset' },
      { value: 'Concise', label: 'Concise', note: 'fewest output tokens' },
      { value: 'Proactive', label: 'Proactive' },
      { value: 'Explanatory', label: 'Explanatory', note: 'longer answers' },
      { value: 'Learning', label: 'Learning', note: 'longer answers' },
    ],
  },
];

/**
 * Custom output styles in the user scope. The file name is the style name unless
 * the frontmatter overrides it, which is the rule Claude Code applies, and a
 * directory that is not there is the normal case rather than a failure.
 */
export function listOutputStyles({ dir = OUTPUT_STYLES_DIR } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => {
      const file = path.join(dir, entry.name);
      let named = '';
      try {
        named = String(parseFrontmatter(fs.readFileSync(file, 'utf8')).data.name || '').trim();
      } catch { /* an unreadable style still has a name: its file */ }
      return { name: named || entry.name.replace(/\.md$/, ''), file };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The descriptor's own options, plus any custom output styles found on disk. */
function optionsFor(descriptor, outputStyles) {
  const options = descriptor.options.map((option) => ({ ...option }));
  if (descriptor.custom === 'outputStyles') {
    for (const style of outputStyles) {
      if (!options.some((option) => option.value === style.name)) {
        options.push({ value: style.name, label: style.name, note: 'custom' });
      }
    }
  }
  return options;
}

/**
 * What a value means once it is checked: a string to write, or null to remove
 * the key. Anything the key does not accept throws rather than being coerced,
 * because a coerced value would be written to the user's settings file.
 */
export function normaliseCostValue(descriptor, value, outputStyles = []) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new Error(`${descriptor.label} takes a string, not ${Array.isArray(value) ? 'a list' : typeof value}.`);
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed === descriptor.unset) return null;

  const allowed = optionsFor(descriptor, outputStyles)
    .map((option) => option.value)
    .filter((option) => option !== null);
  if (allowed.includes(trimmed)) return trimmed;
  if (descriptor.allowModelId && MODEL_ID.test(trimmed)) return trimmed;

  throw new Error(`"${trimmed}" is not a value ${descriptor.label} accepts.`);
}

/**
 * Set or remove a nested key, pruning a parent object the removal emptied. A
 * leftover `"env": {}` is harmless but reads as a setting that is still there,
 * which is exactly the confusion this panel exists to remove.
 */
function setPath(data, keyPath, value) {
  const [head, ...rest] = keyPath;

  if (!rest.length) {
    if (value === null) delete data[head];
    else data[head] = value;
    return;
  }

  const child = data[head];
  const usable = child && typeof child === 'object' && !Array.isArray(child);

  if (value === null) {
    if (!usable) return;
    setPath(child, rest, null);
    if (!Object.keys(child).length) delete data[head];
    return;
  }

  if (!usable) data[head] = {};
  setPath(data[head], rest, value);
}

/**
 * Every layer's value for both keys, strongest first, in the same shape the
 * Settings report uses so the two render identically.
 *
 * `shadowedByStronger` is the one thing this adds: the user file is the weakest
 * of the five, so a value set anywhere else means a write here changes nothing.
 * Saying so beforehand is cheaper than letting someone watch a setting not take.
 */
export function costReport(options = {}) {
  const {
    styleDir = OUTPUT_STYLES_DIR,
    env = process.env,
    userFile = USER_SETTINGS,
    ...target
  } = options;

  const reads = settingsCandidates({ ...target, userFile }).map((candidate) => ({
    ...candidate,
    ...readJsonDetailed(candidate.file),
  }));
  const layers = reads.map(({ scope, file, status, error }) => ({ scope, file, status, error }));
  const outputStyles = listOutputStyles({ dir: styleDir });

  const keys = COST_KEYS.map((descriptor) => {
    const values = reads
      .filter((read) => read.status === 'ok' && readPath(read.data, descriptor.path) !== undefined)
      .map((read) => ({
        scope: read.scope,
        file: read.file,
        value: readPath(read.data, descriptor.path),
        wins: false,
      }));
    if (values.length) values[0].wins = true;
    const winner = values[0] || null;

    const choices = optionsFor(descriptor, outputStyles);
    // A value the picker cannot offer would be silently replaced the moment
    // anyone touched the control, so it is pinned into the list instead.
    if (winner && typeof winner.value === 'string' && winner.value.trim()
        && !choices.some((option) => option.value === winner.value)) {
      choices.push({ value: winner.value, label: winner.value, note: 'set in your settings' });
    }

    const envValue = descriptor.envVar ? env[descriptor.envVar] ?? null : null;

    return {
      key: descriptor.key,
      label: descriptor.label,
      title: descriptor.title,
      detail: descriptor.detail,
      unset: descriptor.unset,
      options: choices,
      values,
      effective: winner ? { value: winner.value, scope: winner.scope, file: winner.file } : null,
      shadowedByStronger: Boolean(winner && winner.scope !== 'user'),
      envVar: descriptor.envVar,
      envValue,
    };
  });

  const userRead = reads.find((read) => read.file === userFile);
  const problems = layers
    .filter((layer) => layer.status !== 'ok' && layer.status !== 'absent')
    .map((layer) => ({
      kind: layer.status,
      severity: SETTINGS_SEVERITY[layer.status] || 'warn',
      scope: layer.scope,
      file: layer.file,
      detail: layer.error,
    }));

  return {
    keys,
    layers,
    problems,
    outputStyles,
    userFile,
    // False when the file this panel would write is there but unusable. The
    // controls are disabled rather than allowed to fail on save.
    writable: !userRead || userRead.status === 'ok' || userRead.status === 'absent',
  };
}

/**
 * Write one key to the user settings file, atomically, and answer with the value
 * that landed. A file that exists but does not parse is refused outright.
 */
export function writeUserSetting(key, value, options = {}) {
  const { file = USER_SETTINGS, styleDir = OUTPUT_STYLES_DIR } = options;

  const descriptor = COST_KEYS.find((entry) => entry.key === key);
  if (!descriptor) throw new Error(`"${key}" is not a setting this tool writes.`);

  const next = normaliseCostValue(descriptor, value, listOutputStyles({ dir: styleDir }));

  const read = readJsonDetailed(file);
  if (read.status !== 'ok' && read.status !== 'absent') {
    throw new Error(`Refusing to write ${file}: ${read.error || read.status}. Rewriting a file this tool cannot parse would drop the settings it cannot see, so fix the file by hand first.`);
  }

  const data = read.status === 'ok' ? read.data : {};
  setPath(data, descriptor.path, next);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(path.dirname(file), path.basename(file), `${JSON.stringify(data, null, 2)}\n`);

  return next;
}
