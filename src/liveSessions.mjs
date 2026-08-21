// The live-session registry Claude Code keeps at ~/.claude/sessions/<pid>.json,
// one file per running `claude` process. This is distinct from the transcript
// history in sessions.mjs: that reads what happened, this reads what is
// happening right now.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

/**
 * Every session whose process is still running, newest-updated first. A file
 * left behind by a process that has since exited is silently skipped rather
 * than reported as stale - the registry itself is not this app's to clean up.
 */
export function readLiveSessions({ dir = path.join(os.homedir(), '.claude', 'sessions') } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessions = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    let session;
    try {
      session = JSON.parse(fs.readFileSync(path.join(dir, entry.name), 'utf8'));
    } catch {
      continue;
    }
    if (!session || typeof session.pid !== 'number' || !isAlive(session.pid)) continue;
    sessions.push(session);
  }

  return sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
