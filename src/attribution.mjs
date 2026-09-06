// The `attribution` block in ~/.claude/settings.json: the trailer Claude Code
// adds to commits, the line it adds to PR descriptions, and the session URL it
// appends to cloud/Remote Control commits. The second panel this tool writes to
// a settings file, alongside the Cost panel in cost.mjs.
//
// Unlike Cost's keys, `commit` and `pr` take arbitrary text rather than one of
// a handful of options, so there is no fixed option list here: a value is either
// unset (default text), `false` (hidden), or any string (a replacement).
// `sessionUrl` only ever takes `false` - there is no custom text for it.

import { setPath } from './cost.mjs';
import { writeFileAtomic } from './mutate.mjs';
import fs from 'node:fs';
import path from 'node:path';

import {
  SETTINGS_SEVERITY,
  USER_SETTINGS,
  readJsonDetailed,
  readPath,
  settingsCandidates,
} from './settings.mjs';

export const ATTRIBUTION_KEYS = [
  {
    key: 'commit',
    path: ['attribution', 'commit'],
    label: 'attribution.commit',
    title: 'Commit trailer',
    detail: 'The co-authored-by trailer Claude Code adds to commits it makes. Hide it, or replace it with your own text.',
    kind: 'text-or-hide',
  },
  {
    key: 'pr',
    path: ['attribution', 'pr'],
    label: 'attribution.pr',
    title: 'Pull request line',
    detail: 'The attribution line Claude Code adds to pull request descriptions it writes. Hide it, or replace it with your own text.',
    kind: 'text-or-hide',
  },
  {
    key: 'sessionUrl',
    path: ['attribution', 'sessionUrl'],
    label: 'attribution.sessionUrl',
    title: 'Session link',
    detail: 'The claude.ai session link Claude Code appends to commits made from the cloud or Remote Control. It cannot be replaced, only omitted.',
    kind: 'hide-only',
  },
];

/**
 * What a value means once it is checked: a string or `false` to write, or null
 * to remove the key. Anything the key does not accept throws rather than being
 * coerced, because a coerced value would be written to the user's settings file.
 */
export function normaliseAttributionValue(descriptor, value) {
  if (value === null || value === undefined) return null;

  if (descriptor.kind === 'hide-only') {
    if (value === false) return false;
    throw new Error(`${descriptor.label} only accepts false (to hide it) or unset.`);
  }

  if (value === false) return false;
  if (typeof value !== 'string') {
    throw new Error(`${descriptor.label} takes a string or false, not ${Array.isArray(value) ? 'a list' : typeof value}.`);
  }
  return value;
}

/**
 * Every layer's value for all three keys, strongest first, in the same shape
 * the Cost report uses so the two render identically.
 */
export function attributionReport(options = {}) {
  const { userFile = USER_SETTINGS, ...target } = options;

  const reads = settingsCandidates({ ...target, userFile }).map((candidate) => ({
    ...candidate,
    ...readJsonDetailed(candidate.file),
  }));
  const layers = reads.map(({ scope, file, status, error }) => ({ scope, file, status, error }));

  const keys = ATTRIBUTION_KEYS.map((descriptor) => {
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

    return {
      key: descriptor.key,
      label: descriptor.label,
      title: descriptor.title,
      detail: descriptor.detail,
      kind: descriptor.kind,
      values,
      effective: winner ? { value: winner.value, scope: winner.scope, file: winner.file } : null,
      shadowedByStronger: Boolean(winner && winner.scope !== 'user'),
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
    userFile,
    writable: !userRead || userRead.status === 'ok' || userRead.status === 'absent',
  };
}

/**
 * Write one key to the user settings file, atomically, and answer with the value
 * that landed. A file that exists but does not parse is refused outright.
 */
export function writeAttributionSetting(key, value, options = {}) {
  const { file = USER_SETTINGS } = options;

  const descriptor = ATTRIBUTION_KEYS.find((entry) => entry.key === key);
  if (!descriptor) throw new Error(`"${key}" is not a setting this tool writes.`);

  const next = normaliseAttributionValue(descriptor, value);

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
