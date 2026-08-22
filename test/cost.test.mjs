// The only two settings this tool writes, and the guard rails around writing
// them.
//
// Everything runs against a temp settings file. The real ~/.claude/settings.json
// is never the target, and costReport is only asked about layers a test controls.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { managedSettingsFiles } from '../src/settings.mjs';
import {
  COST_KEYS,
  costReport,
  listOutputStyles,
  normaliseCostValue,
  writeUserSetting,
} from '../src/cost.mjs';

const managed = managedSettingsFiles().some((file) => fs.existsSync(file));

const descriptor = (key) => COST_KEYS.find((entry) => entry.key === key);

// The developer's own ~/.claude/settings.json sets these very keys, so every
// report below is pointed at a user file that is not there. Without that the
// suite passes or fails depending on whose machine it runs on.
const NO_USER_FILE = path.join(os.tmpdir(), 'memory-admin-cost-no-user-settings.json');

function withFile(initial, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-admin-cost-'));
  const file = path.join(dir, 'settings.json');
  try {
    if (initial !== null) fs.writeFileSync(file, initial);
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function withProject(settings, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-admin-cost-project-'));
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

test('a settings file that is not there yet is created around the one key', () => {
  withFile(null, (file) => {
    writeUserSetting('outputStyle', 'Concise', { file });
    assert.deepEqual(read(file), { outputStyle: 'Concise' });
  });
});

test('an existing file keeps every other key, its order and its formatting', () => {
  withFile('{\n  "model": "opus[1m]",\n  "theme": "dark"\n}\n', (file) => {
    writeUserSetting('subagentModel', 'haiku', { file });
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text, '{\n  "model": "opus[1m]",\n  "theme": "dark",\n  "env": {\n    "CLAUDE_CODE_SUBAGENT_MODEL": "haiku"\n  }\n}\n');
  });
});

test('an existing env block is added to rather than replaced', () => {
  withFile(JSON.stringify({ env: { SOMETHING_ELSE: '1' } }), (file) => {
    writeUserSetting('subagentModel', 'sonnet', { file });
    assert.deepEqual(read(file), { env: { SOMETHING_ELSE: '1', CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' } });
  });
});

// "env": {} is harmless but reads as a setting that is still there, which is
// exactly the confusion this panel exists to remove.
test('clearing the last key in env removes the env block with it', () => {
  withFile(JSON.stringify({ model: 'opus', env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' } }), (file) => {
    writeUserSetting('subagentModel', 'inherit', { file });
    assert.deepEqual(read(file), { model: 'opus' });
  });
});

test('clearing a key beside others in env leaves the others alone', () => {
  withFile(JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku', OTHER: '1' } }), (file) => {
    writeUserSetting('subagentModel', null, { file });
    assert.deepEqual(read(file), { env: { OTHER: '1' } });
  });
});

test('Default clears the output style rather than writing the word', () => {
  withFile(JSON.stringify({ outputStyle: 'Concise' }), (file) => {
    writeUserSetting('outputStyle', 'Default', { file });
    assert.deepEqual(read(file), {});
  });
});

test('an env value that is a string rather than an object is replaced, not descended into', () => {
  withFile(JSON.stringify({ env: 'not an object' }), (file) => {
    writeUserSetting('subagentModel', 'haiku', { file });
    assert.deepEqual(read(file), { env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' } });
  });
});

test('a key outside the allowlist is refused', () => {
  withFile('{}', (file) => {
    for (const key of ['model', 'effortLevel', 'permissions', 'hooks', '__proto__']) {
      assert.throws(() => writeUserSetting(key, 'haiku', { file }), /not a setting this tool writes/);
    }
    assert.deepEqual(read(file), {});
  });
});

test('a value outside the option set is refused before anything is written', () => {
  withFile('{}', (file) => {
    assert.throws(() => writeUserSetting('subagentModel', 'gpt-9', { file }), /is not a value/);
    assert.throws(() => writeUserSetting('outputStyle', 'Terse', { file }), /is not a value/);
    assert.throws(() => writeUserSetting('outputStyle', ['Concise'], { file }), /takes a string/);
    assert.deepEqual(read(file), {});
  });
});

test('a full claude- model name is accepted for the subagent model', () => {
  withFile('{}', (file) => {
    writeUserSetting('subagentModel', 'claude-haiku-4-5-20251001', { file });
    assert.deepEqual(read(file), { env: { CLAUDE_CODE_SUBAGENT_MODEL: 'claude-haiku-4-5-20251001' } });
  });
});

// Rewriting a file we could not parse would drop every setting in it, silently.
test('a settings file that does not parse is refused rather than rewritten', () => {
  const broken = '{ "model": "opus", }';
  withFile(broken, (file) => {
    assert.throws(() => writeUserSetting('outputStyle', 'Concise', { file }), /Refusing to write/);
    assert.equal(fs.readFileSync(file, 'utf8'), broken);
  });
});

test('a settings file that is valid JSON but not an object is refused too', () => {
  withFile('[1, 2, 3]', (file) => {
    assert.throws(() => writeUserSetting('outputStyle', 'Concise', { file }), /Refusing to write/);
    assert.equal(fs.readFileSync(file, 'utf8'), '[1, 2, 3]');
  });
});

test('a custom output style on disk becomes an accepted value', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-admin-styles-'));
  try {
    fs.writeFileSync(path.join(dir, 'diagrams-first.md'), '---\nname: Diagrams first\ndescription: d\n---\n\nbody\n');
    fs.writeFileSync(path.join(dir, 'terse.md'), 'no frontmatter here\n');

    assert.deepEqual(listOutputStyles({ dir }).map((style) => style.name), ['Diagrams first', 'terse']);

    withFile('{}', (file) => {
      writeUserSetting('outputStyle', 'Diagrams first', { file, styleDir: dir });
      assert.deepEqual(read(file), { outputStyle: 'Diagrams first' });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an output styles directory that is not there is an empty list', () => {
  assert.deepEqual(listOutputStyles({ dir: path.join(os.tmpdir(), 'memory-admin-styles-absent-nope') }), []);
});

test('the unset sentinel and an empty string both mean remove the key', () => {
  for (const value of [null, undefined, '', '  ', 'inherit']) {
    assert.equal(normaliseCostValue(descriptor('subagentModel'), value), null);
  }
  for (const value of [null, '', 'Default']) {
    assert.equal(normaliseCostValue(descriptor('outputStyle'), value), null);
  }
});

test('a stronger layer is reported as shadowing the file this panel writes', { skip: managed }, () => {
  withProject({ 'settings.json': { outputStyle: 'Explanatory', env: { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' } } }, (dir) => {
    const report = costReport({ projectDir: dir, env: {}, userFile: NO_USER_FILE });
    for (const entry of report.keys) {
      assert.equal(entry.effective.scope, 'project');
      assert.equal(entry.shadowedByStronger, true);
      assert.equal(entry.values[0].wins, true);
    }
    assert.equal(report.keys.find((k) => k.key === 'subagentModel').effective.value, 'opus');
  });
});

test('a value only the user file sets is not reported as shadowed', { skip: managed }, () => {
  withFile(JSON.stringify({ outputStyle: 'Concise' }), (file) => {
    const entry = costReport({ env: {}, userFile: file }).keys.find((k) => k.key === 'outputStyle');
    assert.equal(entry.effective.value, 'Concise');
    assert.equal(entry.effective.scope, 'user');
    assert.equal(entry.shadowedByStronger, false);
  });
});

test('an env layer that is not an object is skipped rather than descended into', { skip: managed }, () => {
  withProject({ 'settings.json': { env: 'nonsense' } }, (dir) => {
    const report = costReport({ projectDir: dir, env: {}, userFile: NO_USER_FILE });
    assert.equal(report.keys.find((k) => k.key === 'subagentModel').values.length, 0);
  });
});

test('an environment variable is reported as outranking every file', { skip: managed }, () => {
  withProject({ 'settings.json': { env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' } } }, (dir) => {
    const report = costReport({ projectDir: dir, env: { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' }, userFile: NO_USER_FILE });
    const entry = report.keys.find((k) => k.key === 'subagentModel');
    assert.equal(entry.envValue, 'opus');
    assert.equal(entry.effective.value, 'haiku');
  });
});

// A value the picker cannot offer would be silently replaced the moment anyone
// touched the control.
test('a value the option list does not carry is pinned into it', { skip: managed }, () => {
  withProject({ 'settings.json': { env: { CLAUDE_CODE_SUBAGENT_MODEL: 'claude-haiku-4-5-20251001' } } }, (dir) => {
    const entry = costReport({ projectDir: dir, env: {}, userFile: NO_USER_FILE }).keys.find((k) => k.key === 'subagentModel');
    assert.ok(entry.options.some((option) => option.value === 'claude-haiku-4-5-20251001'));
  });
});

test('a settings file that does not parse is reported and disables saving', { skip: managed }, () => {
  withFile('{ nope', (file) => {
    const report = costReport({ env: {}, userFile: file });
    assert.equal(report.writable, false);
    assert.ok(report.problems.some((problem) => problem.kind === 'unparseable' && problem.file === file));
  });
});

test('a settings file that is simply absent still saves', { skip: managed }, () => {
  withFile(null, (file) => {
    assert.equal(costReport({ env: {}, userFile: file }).writable, true);
  });
});
