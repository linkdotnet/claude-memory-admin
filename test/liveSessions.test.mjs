import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readLiveSessions } from '../src/liveSessions.mjs';

function withRegistry(files, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-admin-live-sessions-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), contents);
    }
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const DEAD_PID = 2 ** 30; // implausibly high, never a real running process

test('an entry for the current process is returned', () => {
  withRegistry({
    [`${process.pid}.json`]: JSON.stringify({ pid: process.pid, sessionId: 'a', cwd: '/x', status: 'busy', updatedAt: 1 }),
  }, (dir) => {
    const sessions = readLiveSessions({ dir });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, 'a');
  });
});

test('an entry for a process that is no longer running is dropped', () => {
  withRegistry({
    [`${DEAD_PID}.json`]: JSON.stringify({ pid: DEAD_PID, sessionId: 'b', cwd: '/x', status: 'busy', updatedAt: 1 }),
  }, (dir) => {
    assert.deepEqual(readLiveSessions({ dir }), []);
  });
});

test('a malformed registry file is skipped, not thrown', () => {
  withRegistry({
    [`${process.pid}.json`]: '{ not json',
  }, (dir) => {
    assert.deepEqual(readLiveSessions({ dir }), []);
  });
});

test('a missing registry directory is an empty list, not an error', () => {
  assert.deepEqual(readLiveSessions({ dir: '/no/such/directory/at/all' }), []);
});

test('sessions come back newest-updated first', () => {
  withRegistry({
    '111.json': JSON.stringify({ pid: process.pid, sessionId: 'old', cwd: '/x', status: 'idle', updatedAt: 1 }),
    '222.json': JSON.stringify({ pid: process.pid, sessionId: 'new', cwd: '/x', status: 'idle', updatedAt: 2 }),
  }, (dir) => {
    const sessions = readLiveSessions({ dir });
    assert.deepEqual(sessions.map((s) => s.sessionId), ['new', 'old']);
  });
});
