import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The cache location is redirected before the module is imported, so these tests
// can never touch the developer's real ~/.claude-memory-admin.
const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-admin-cache-'));
process.env.MEMORY_PATH_CACHE_DIR = CACHE_DIR;

const { CACHE_FILE, forgetPath, readPathCache, rememberPath, rememberedPath } = await import('../src/pathcache.mjs');

test.after(() => fs.rmSync(CACHE_DIR, { recursive: true, force: true }));

test('nothing is written until a path is actually remembered', () => {
  assert.deepEqual(readPathCache(), {});
  assert.equal(rememberedPath('-Users-demo-repos-gone'), null);
  assert.equal(fs.existsSync(CACHE_FILE), false, 'reading must not create the file');
});

test('a remembered path is returned for that slug and no other', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-admin-target-'));
  try {
    rememberPath('-Users-demo-repos-gone', dir);
    assert.equal(rememberedPath('-Users-demo-repos-gone'), dir);
    assert.equal(rememberedPath('-Users-demo-repos-other'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a path that stops existing is not asserted any more', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-admin-target-'));
  rememberPath('-Users-demo-repos-moved', dir);
  assert.equal(rememberedPath('-Users-demo-repos-moved'), dir);
  fs.rmSync(dir, { recursive: true, force: true });
  // Still recorded, but no longer true, so it is not reported as the path.
  assert.equal(rememberedPath('-Users-demo-repos-moved'), null);
});

test('only an existing absolute directory is accepted', () => {
  assert.throws(() => rememberPath('-Users-demo-x', 'repos/relative'), /absolute/);
  assert.throws(() => rememberPath('-Users-demo-x', '/definitely/not/here'), /does not exist/);

  const file = path.join(CACHE_DIR, 'a-file');
  fs.writeFileSync(file, 'x');
  assert.throws(() => rememberPath('-Users-demo-x', file), /not a directory/);
});

test('forgetting the last entry removes the file entirely', () => {
  for (const slug of Object.keys(readPathCache())) forgetPath(slug);
  assert.deepEqual(readPathCache(), {});
  assert.equal(fs.existsSync(CACHE_FILE), false, 'an empty cache should leave nothing behind');
});
