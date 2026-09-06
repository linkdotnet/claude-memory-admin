// The `attribution` block this tool writes, and the guard rails around it.
//
// Everything runs against a temp settings file. The real ~/.claude/settings.json
// is never the target, and attributionReport is only asked about layers a test
// controls.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { managedSettingsFiles } from '../src/settings.mjs';
import {
  ATTRIBUTION_KEYS,
  attributionReport,
  normaliseAttributionValue,
  writeAttributionSetting,
} from '../src/attribution.mjs';

const managed = managedSettingsFiles().some((file) => fs.existsSync(file));

const descriptor = (key) => ATTRIBUTION_KEYS.find((entry) => entry.key === key);

// The developer's own ~/.claude/settings.json may set these very keys, so every
// report below is pointed at a user file that is not there. Without that the
// suite passes or fails depending on whose machine it runs on.
const NO_USER_FILE = path.join(os.tmpdir(), 'memory-admin-attribution-no-user-settings.json');

function withFile(initial, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-admin-attribution-'));
  const file = path.join(dir, 'settings.json');
  try {
    if (initial !== null) fs.writeFileSync(file, initial);
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function withProject(settings, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-admin-attribution-project-'));
  try {
    fs.mkdirSync(path.join(dir, '.claude'));
    for (const [name, data] of Object.entries(settings)) {
      fs.writeFileSync(path.join(dir, '.claude', name), JSON.stringify(data));
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('a settings file that is not there yet is created around the one key', () => {
  withFile(null, (file) => {
    writeAttributionSetting('commit', 'Co-authored-by: Me', { file });
    assert.deepEqual(read(file), { attribution: { commit: 'Co-authored-by: Me' } });
  });
});

test('an existing file keeps every other key, its order and its formatting', () => {
  withFile('{\n  "model": "opus[1m]",\n  "theme": "dark"\n}\n', (file) => {
    writeAttributionSetting('pr', false, { file });
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text, '{\n  "model": "opus[1m]",\n  "theme": "dark",\n  "attribution": {\n    "pr": false\n  }\n}\n');
  });
});

test('an existing attribution block is added to rather than replaced', () => {
  withFile(JSON.stringify({ attribution: { commit: 'custom' } }), (file) => {
    writeAttributionSetting('pr', false, { file });
    assert.deepEqual(read(file), { attribution: { commit: 'custom', pr: false } });
  });
});

test('clearing the last key in attribution removes the block with it', () => {
  withFile(JSON.stringify({ model: 'opus', attribution: { sessionUrl: false } }), (file) => {
    writeAttributionSetting('sessionUrl', null, { file });
    assert.deepEqual(read(file), { model: 'opus' });
  });
});

test('clearing a key beside others in attribution leaves the others alone', () => {
  withFile(JSON.stringify({ attribution: { commit: 'custom', pr: false } }), (file) => {
    writeAttributionSetting('commit', null, { file });
    assert.deepEqual(read(file), { attribution: { pr: false } });
  });
});

test('commit and pr accept false to hide, a string to replace, or null to clear', () => {
  withFile('{}', (file) => {
    writeAttributionSetting('commit', false, { file });
    assert.deepEqual(read(file), { attribution: { commit: false } });
    writeAttributionSetting('commit', 'text', { file });
    assert.deepEqual(read(file), { attribution: { commit: 'text' } });
    writeAttributionSetting('commit', null, { file });
    assert.deepEqual(read(file), {});
  });
});

test('sessionUrl only accepts false or unset', () => {
  withFile('{}', (file) => {
    writeAttributionSetting('sessionUrl', false, { file });
    assert.deepEqual(read(file), { attribution: { sessionUrl: false } });
    assert.throws(() => writeAttributionSetting('sessionUrl', true, { file }), /only accepts false/);
    assert.throws(() => writeAttributionSetting('sessionUrl', 'text', { file }), /only accepts false/);
    assert.deepEqual(read(file), { attribution: { sessionUrl: false } });
  });
});

test('a value that is not a string or false is refused for commit/pr', () => {
  withFile('{}', (file) => {
    assert.throws(() => writeAttributionSetting('commit', 5, { file }), /takes a string or false/);
    assert.throws(() => writeAttributionSetting('pr', ['x'], { file }), /takes a string or false/);
    assert.deepEqual(read(file), {});
  });
});

test('a key outside the allowlist is refused', () => {
  withFile('{}', (file) => {
    for (const key of ['model', 'includeCoAuthoredBy', 'hooks', '__proto__']) {
      assert.throws(() => writeAttributionSetting(key, 'x', { file }), /not a setting this tool writes/);
    }
    assert.deepEqual(read(file), {});
  });
});

test('a settings file that does not parse is refused rather than rewritten', () => {
  const broken = '{ "model": "opus", }';
  withFile(broken, (file) => {
    assert.throws(() => writeAttributionSetting('commit', false, { file }), /Refusing to write/);
    assert.equal(fs.readFileSync(file, 'utf8'), broken);
  });
});

test('a settings file that is valid JSON but not an object is refused too', () => {
  withFile('[1, 2, 3]', (file) => {
    assert.throws(() => writeAttributionSetting('commit', false, { file }), /Refusing to write/);
    assert.equal(fs.readFileSync(file, 'utf8'), '[1, 2, 3]');
  });
});

test('the unset sentinel means remove the key', () => {
  for (const key of ['commit', 'pr', 'sessionUrl']) {
    assert.equal(normaliseAttributionValue(descriptor(key), null), null);
    assert.equal(normaliseAttributionValue(descriptor(key), undefined), null);
  }
});

test('a stronger layer is reported as shadowing the file this panel writes', { skip: managed }, () => {
  withProject({ 'settings.json': { attribution: { commit: false, pr: 'custom' } } }, (dir) => {
    const report = attributionReport({ projectDir: dir, userFile: NO_USER_FILE });
    for (const entry of report.keys.filter((k) => k.key !== 'sessionUrl')) {
      assert.equal(entry.effective.scope, 'project');
      assert.equal(entry.shadowedByStronger, true);
      assert.equal(entry.values[0].wins, true);
    }
    assert.equal(report.keys.find((k) => k.key === 'commit').effective.value, false);
    assert.equal(report.keys.find((k) => k.key === 'pr').effective.value, 'custom');
  });
});

test('a value only the user file sets is not reported as shadowed', { skip: managed }, () => {
  withFile(JSON.stringify({ attribution: { sessionUrl: false } }), (file) => {
    const entry = attributionReport({ userFile: file }).keys.find((k) => k.key === 'sessionUrl');
    assert.equal(entry.effective.value, false);
    assert.equal(entry.effective.scope, 'user');
    assert.equal(entry.shadowedByStronger, false);
  });
});

test('an attribution value that is not an object is skipped rather than descended into', { skip: managed }, () => {
  withProject({ 'settings.json': { attribution: 'nonsense' } }, (dir) => {
    const report = attributionReport({ projectDir: dir, userFile: NO_USER_FILE });
    for (const entry of report.keys) assert.equal(entry.values.length, 0);
  });
});

test('a settings file that does not parse is reported and disables saving', { skip: managed }, () => {
  withFile('{ nope', (file) => {
    const report = attributionReport({ userFile: file });
    assert.equal(report.writable, false);
    assert.ok(report.problems.some((problem) => problem.kind === 'unparseable' && problem.file === file));
  });
});

test('a settings file that is simply absent still saves', { skip: managed }, () => {
  withFile(null, (file) => {
    assert.equal(attributionReport({ userFile: file }).writable, true);
  });
});
