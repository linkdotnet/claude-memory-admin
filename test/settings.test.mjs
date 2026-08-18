import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  autoMemoryState,
  cleanupPeriodDays,
  managedSettingsFiles,
  resolveMemoryDirectory,
  settingsLayers,
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
