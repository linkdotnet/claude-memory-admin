import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  autoMemoryState,
  lookupPath,
  readPath,
  cleanupPeriodDays,
  managedSettingsFiles,
  resolveMemoryDirectory,
  settingsDiagnostics,
  settingsLayers,
  settingsReport,
} from '../src/settings.mjs';

// These tests exercise the layers a test can control: project, local and the
// environment, all of which outrank the user file, so a developer's own
// ~/.claude/settings.json cannot change the outcome. Managed policy outranks
// even those, so the rare machine that has one sits the tests out rather than
// failing on a difference that is not a bug.
const managed = managedSettingsFiles().some((file) => fs.existsSync(file));

function withProject(settings, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-admin-settings-'));
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

test('local project settings outrank shared project settings', { skip: managed }, () => {
  withProject({
    'settings.json': { autoMemoryDirectory: '~/shared-store' },
    'settings.local.json': { autoMemoryDirectory: '~/local-store' },
  }, (dir) => {
    const resolved = resolveMemoryDirectory({ projectDir: dir });
    assert.equal(resolved.scope, 'local');
    assert.equal(resolved.path, path.join(os.homedir(), 'local-store'));
  });
});

test('a project setting is honoured even though the user file is the usual place', { skip: managed }, () => {
  withProject({ 'settings.json': { autoMemoryDirectory: '/tmp/project-store' } }, (dir) => {
    const resolved = resolveMemoryDirectory({ projectDir: dir });
    assert.equal(resolved.scope, 'project');
    assert.equal(resolved.path, '/tmp/project-store');
  });
});

test('a relative autoMemoryDirectory is reported, not silently ignored', { skip: managed }, () => {
  // Claude Code accepts only an absolute or ~/-prefixed path. Falling back to the
  // default without saying so would show a store the user did not configure.
  withProject({ 'settings.local.json': { autoMemoryDirectory: 'relative/store' } }, (dir) => {
    const resolved = resolveMemoryDirectory({ projectDir: dir });
    assert.equal(resolved.path, null);
    assert.equal(resolved.raw, 'relative/store');
    assert.ok(resolved.invalid);
  });
});

test('auto memory disabled in project settings is reported with its source', { skip: managed }, () => {
  withProject({ 'settings.json': { autoMemoryEnabled: false } }, (dir) => {
    const state = autoMemoryState({ projectDir: dir });
    assert.equal(state.enabled, false);
    assert.equal(state.scope, 'project');
    assert.ok(state.setBy.endsWith(path.join('.claude', 'settings.json')));
  });
});

test('the environment variable overrides every settings file', { skip: managed }, () => {
  const previous = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  try {
    withProject({ 'settings.local.json': { autoMemoryEnabled: true } }, (dir) => {
      const state = autoMemoryState({ projectDir: dir });
      assert.equal(state.enabled, false);
      assert.equal(state.scope, 'env');
    });
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
    else process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = previous;
  }
});

test('without a resolved project path the default is labelled an assumption', () => {
  const state = autoMemoryState({ projectDir: null });
  // The project and local layers were never consulted, so "on" is a guess.
  assert.equal(state.known, false);
});

test('a malformed settings file is skipped rather than throwing', { skip: managed }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-admin-settings-'));
  try {
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), '{ not json');
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ cleanupPeriodDays: 7 }));
    assert.ok(!settingsLayers({ projectDir: dir }).some((l) => l.scope === 'project'));
    assert.equal(cleanupPeriodDays({ projectDir: dir }), 7);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function withFiles(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-admin-settings-'));
  try {
    fs.mkdirSync(path.join(dir, '.claude'));
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, '.claude', name), body);
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const find = (list, scope) => list.find((entry) => entry.scope === scope);

test('a settings file that does not parse is reported, not just skipped', { skip: managed }, () => {
  withFiles({ 'settings.json': '{ not json' }, (dir) => {
    const layer = find(settingsDiagnostics({ projectDir: dir }), 'project');
    assert.equal(layer.status, 'unparseable');
    assert.ok(layer.error);

    assert.ok(!settingsLayers({ projectDir: dir }).some((l) => l.scope === 'project'));

    const problem = settingsReport({ projectDir: dir }).problems.find((p) => p.kind === 'unparseable');
    assert.ok(problem, 'the report should surface the broken file');
    assert.equal(problem.scope, 'project');
  });
});

test('a settings file that is valid JSON but not an object is reported', { skip: managed }, () => {
  withFiles({ 'settings.json': '["nope"]' }, (dir) => {
    assert.equal(find(settingsDiagnostics({ projectDir: dir }), 'project').status, 'not-object');
  });
});

test('an absent settings file is not a problem', { skip: managed }, () => {
  withFiles({}, (dir) => {
    const report = settingsReport({ projectDir: dir });
    assert.equal(find(report.layers, 'project').status, 'absent');
    assert.deepEqual(report.problems.filter((p) => p.scope === 'project'), []);
  });
});

test('the report marks the winning layer and keeps the shadowed ones', { skip: managed }, () => {
  withFiles({
    'settings.json': JSON.stringify({ autoMemoryEnabled: true }),
    'settings.local.json': JSON.stringify({ autoMemoryEnabled: false }),
  }, (dir) => {
    const key = settingsReport({ projectDir: dir }).keys.find((entry) => entry.key === 'autoMemoryEnabled');
    assert.equal(key.effective.value, false);
    assert.equal(key.effective.scope, 'local');

    assert.equal(key.values.length, 2);
    assert.equal(key.values[0].scope, 'local');
    assert.equal(key.values[0].wins, true);
    assert.equal(key.values[1].scope, 'project');
    assert.equal(key.values[1].wins, false);
  });
});

test('a key nothing sets reports its fallback and no effective layer', { skip: managed }, () => {
  withFiles({}, (dir) => {
    const key = settingsReport({ projectDir: dir }).keys.find((entry) => entry.key === 'claudeMdExcludes');
    assert.equal(key.effective, null);
    assert.deepEqual(key.fallback, []);
    assert.deepEqual(key.values, []);
  });
});

test('cleanupPeriodDays reports both the configured value and the one in force', { skip: managed }, () => {
  withFiles({ 'settings.json': JSON.stringify({ cleanupPeriodDays: 0 }) }, (dir) => {
    const key = settingsReport({ projectDir: dir }).keys.find((entry) => entry.key === 'cleanupPeriodDays');
    assert.equal(key.effective.value, 0);
    assert.equal(key.normalized, cleanupPeriodDays({ projectDir: dir }));
    assert.equal(key.normalized, 30);
  });
});

test('the report names the environment override', { skip: managed }, () => {
  const previous = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  try {
    withFiles({ 'settings.json': JSON.stringify({ autoMemoryEnabled: true }) }, (dir) => {
      const report = settingsReport({ projectDir: dir });
      assert.equal(report.env.value, '1');
      assert.equal(report.env.overrides, 'autoMemoryEnabled');
    });
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
    else process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = previous;
  }
});

test('an unusable autoMemoryDirectory reaches the report as a problem', { skip: managed }, () => {
  withFiles({ 'settings.json': JSON.stringify({ autoMemoryDirectory: 'relative/store' }) }, (dir) => {
    const problem = settingsReport({ projectDir: dir }).problems
      .find((p) => p.kind === 'invalid-auto-memory-directory');
    assert.ok(problem);
    assert.match(problem.detail, /relative\/store/);
  });
});


// env is routinely a string, or absent, in a hand-edited settings file. Reading
// it as an object either way would throw where the documented behaviour is just
// that the layer does not set the key.
test('a nested key is read only through layers that really nest', () => {
  const layers = [
    { scope: 'local', file: 'a', data: { env: 'nonsense' } },
    { scope: 'project', file: 'b', data: { env: null } },
    { scope: 'user', file: 'c', data: { env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' } } },
  ];

  assert.deepEqual(lookupPath(layers, ['env', 'CLAUDE_CODE_SUBAGENT_MODEL']), {
    value: 'haiku',
    scope: 'user',
    file: 'c',
  });
  assert.equal(lookupPath(layers, ['env', 'NOT_SET']), null);
  assert.equal(lookupPath([], ['env', 'X']), null);
});

test('a key set to a falsy value still counts as set', () => {
  const layers = [{ scope: 'user', file: 'c', data: { env: { X: '' } } }];
  assert.equal(lookupPath(layers, ['env', 'X']).value, '');
});

test('reading a path never walks into an array or an inherited property', () => {
  assert.equal(readPath({ env: ['a'] }, ['env', '0']), undefined);
  assert.equal(readPath({}, ['toString']), undefined);
  assert.equal(readPath({ a: { b: 1 } }, ['a', 'b']), 1);
});
