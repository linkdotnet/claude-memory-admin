// Slug decoding is the fallback used when no transcript names a project's real
// path, and the slug it decodes was written by whichever platform ran the
// session. These tests take the platform as a parameter so the Windows form is
// covered from a machine that is not Windows.

import assert from 'node:assert/strict';
import test from 'node:test';

import { shortLabel, slugCandidates } from '../src/projects.mjs';

test('a POSIX slug decodes to a rooted path', () => {
  assert.deepEqual(slugCandidates('-Users-me-repo', 'darwin'), ['/Users/me/repo', '/Users/me/repo']);
});

test('a doubled dash is the dot a hidden directory starts with', () => {
  const [dotted] = slugCandidates('-Users-me--config-app', 'linux');
  assert.equal(dotted, '/Users/me/.config/app');
});

test('a Windows slug keeps its drive', () => {
  assert.deepEqual(
    slugCandidates('C--Users-me-repo', 'win32'),
    ['C:\\Users\\me\\repo', 'C:\\Users\\me\\repo'],
  );
});

test('a Windows slug for a hidden directory decodes the dot', () => {
  const [dotted] = slugCandidates('D--work--cache-repo', 'win32');
  assert.equal(dotted, 'D:\\work\\.cache\\repo');
});

test('a POSIX slug read on Windows still decodes as POSIX', () => {
  // A store copied from another machine has no drive letter to find, and the
  // POSIX candidates are the only sensible reading of it.
  assert.deepEqual(slugCandidates('-Users-me-repo', 'win32'), ['/Users/me/repo', '/Users/me/repo']);
});

test('the sidebar label splits on either separator', () => {
  assert.equal(shortLabel('/Users/me/repos/blog'), 'repos/blog');
  assert.equal(shortLabel('C:\\Users\\me\\repos\\blog'), 'repos/blog');
  assert.equal(shortLabel('blog'), 'blog');
});
