import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  canonicalPath,
  configDir,
  configSource,
  expandHome,
  fixedProjectDirName,
  isAbsolutePath,
  toPosix,
} from '../src/config.mjs';

const HOME = '/home/dev';

test('the config directory defaults to .claude under the home directory', () => {
  const found = configSource({ env: {}, home: HOME, platform: 'linux' });
  assert.equal(found.path, path.join(HOME, '.claude'));
  assert.equal(found.source, 'default');
  assert.equal(found.invalid, null);
});

test('CLAUDE_CONFIG_DIR moves the whole config directory', () => {
  const found = configSource({ env: { CLAUDE_CONFIG_DIR: '/opt/claude' }, home: HOME, platform: 'linux' });
  assert.equal(found.path, '/opt/claude');
  assert.equal(found.source, 'env');
});

test('a ~/ prefixed CLAUDE_CONFIG_DIR is expanded', () => {
  const found = configSource({ env: { CLAUDE_CONFIG_DIR: '~/work/claude' }, home: HOME, platform: 'linux' });
  assert.equal(found.path, path.join(HOME, 'work', 'claude'));
  assert.equal(found.source, 'env');
});

test('a relative CLAUDE_CONFIG_DIR is reported rather than silently used', () => {
  const found = configSource({ env: { CLAUDE_CONFIG_DIR: 'claude' }, home: HOME, platform: 'linux' });
  assert.equal(found.path, path.join(HOME, '.claude'));
  assert.equal(found.source, 'default');
  assert.match(found.invalid, /not an absolute/);
});

test('configDir answers with the resolved path', () => {
  assert.equal(typeof configDir(), 'string');
});

test('a Windows path needs a drive or a share, not just a leading slash', () => {
  assert.equal(isAbsolutePath('C:\\Users\\dev', 'win32'), true);
  assert.equal(isAbsolutePath('c:/Users/dev', 'win32'), true);
  assert.equal(isAbsolutePath('\\\\server\\share', 'win32'), true);
  // path.isAbsolute answers true for this under win32, and it names nothing.
  assert.equal(isAbsolutePath('/Users/dev', 'win32'), false);
  assert.equal(isAbsolutePath('/Users/dev', 'linux'), true);
  assert.equal(isAbsolutePath('Users/dev', 'linux'), false);
});

test('expandHome handles both separators after the tilde', () => {
  assert.equal(expandHome('~/a/b', { home: HOME }), path.join(HOME, 'a', 'b'));
  assert.equal(expandHome('~\\a\\b', { home: HOME }), path.join(HOME, 'a\\b'));
  assert.equal(expandHome('/absolute', { home: HOME }), '/absolute');
});

test('toPosix gives glob syntax the one separator it knows', () => {
  assert.equal(toPosix('C:\\repo\\CLAUDE.md'), 'C:/repo/CLAUDE.md');
  assert.equal(toPosix('/repo/CLAUDE.md'), '/repo/CLAUDE.md');
});

test('paths compare case-insensitively only where the filesystem does', () => {
  assert.equal(canonicalPath('/Repo/Src', 'win32'), canonicalPath('/repo/src', 'win32'));
  assert.equal(canonicalPath('/Repo/Src', 'darwin'), canonicalPath('/repo/src', 'darwin'));
  assert.notEqual(canonicalPath('/Repo/Src', 'linux'), canonicalPath('/repo/src', 'linux'));
});

test('CLAUDE_CODE_PROJECT_DIR_NAME is only honoured beside CLAUDE_CONFIG_DIR', () => {
  assert.equal(fixedProjectDirName({ env: { CLAUDE_CODE_PROJECT_DIR_NAME: 'shared' } }), null);
  assert.equal(
    fixedProjectDirName({ env: { CLAUDE_CONFIG_DIR: '/opt/claude', CLAUDE_CODE_PROJECT_DIR_NAME: 'shared' } }),
    'shared',
  );
});

test('a project directory name that is a path or a dotfile is refused', () => {
  const env = { CLAUDE_CONFIG_DIR: '/opt/claude' };
  assert.equal(fixedProjectDirName({ env: { ...env, CLAUDE_CODE_PROJECT_DIR_NAME: '../escape' } }), null);
  assert.equal(fixedProjectDirName({ env: { ...env, CLAUDE_CODE_PROJECT_DIR_NAME: '.hidden' } }), null);
  assert.equal(fixedProjectDirName({ env: { ...env, CLAUDE_CODE_PROJECT_DIR_NAME: '' } }), null);
});
