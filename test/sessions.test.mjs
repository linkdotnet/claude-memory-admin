import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  EXPIRY_WARNING_DAYS,
  listSessions,
  originSession,
  retention,
  sessionSummary,
  sessionsWithSummaries,
  transcriptDir,
} from '../src/sessions.mjs';
import { FIXTURE_ROOT } from './helpers.mjs';

const ALPHA = path.join(FIXTURE_ROOT, '-Users-demo-repos-alpha');
const LIVE_SESSION = '9f1c0000-0000-4000-8000-000000000001';
const SWEPT_SESSION = '9f1c0000-0000-4000-8000-000000000002';

const DAY = 86400000;

function withTranscripts(files, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-admin-sessions-'));
  try {
    for (const [name, { text, ageDays = 0 }] of Object.entries(files)) {
      const full = path.join(dir, name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text);
      const when = new Date(Date.now() - ageDays * DAY);
      fs.utimesSync(full, when, when);
    }
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const line = (record) => `${JSON.stringify(record)}\n`;

test('a subagent transcript is not a session', () => {
  const sessions = listSessions(ALPHA);
  assert.equal(sessions.length, 1, 'the fixture has one session and one subagent transcript');
  assert.equal(sessions[0].id, LIVE_SESSION);

  const nested = path.join(ALPHA, LIVE_SESSION, 'subagents');
  assert.ok(fs.existsSync(nested), 'the subagent transcript the exclusion is about must exist');
});

test('the title Claude Code generated wins over the slug and the first prompt', () => {
  const summary = sessionSummary(path.join(ALPHA, `${LIVE_SESSION}.jsonl`));
  assert.equal(summary.title, 'Alpha project conventions');
  assert.equal(summary.titleFrom, 'ai-title');
  assert.equal(summary.slug, 'alpha-setup-quiet-harbour', 'the slug is still read, it just does not win');
  assert.equal(summary.gitBranch, 'main');
  assert.equal(summary.model, 'claude-opus-5', 'the model is nested under message, not at the root');
});

test('the title falls back to the slug, then the first prompt, then nothing', () => {
  const opening = { type: 'user', message: { role: 'user', content: 'Rename the reporting module' }, cwd: '/repo' };

  withTranscripts({
    'a.jsonl': { text: line({ ...opening, slug: 'quiet-harbour' }) },
    'b.jsonl': { text: line(opening) },
    'c.jsonl': { text: line({ type: 'mode', mode: 'normal' }) },
  }, (dir) => {
    const byId = new Map(sessionsWithSummaries(dir).sessions.map((s) => [s.id, s]));

    assert.equal(byId.get('a').titleFrom, 'slug');
    assert.equal(byId.get('a').title, 'quiet-harbour');
    assert.equal(byId.get('b').titleFrom, 'prompt');
    assert.equal(byId.get('b').title, 'Rename the reporting module');
    assert.equal(byId.get('c').titleFrom, null);
    assert.equal(byId.get('c').title, null, 'nothing is invented for a transcript that names itself nowhere');
  });
});

test('a first record too large for the head read leaves the title unclaimed rather than guessed', () => {
  const huge = { type: 'user', isSidechain: false, cwd: '/repo', message: { role: 'user', content: 'x'.repeat(300000) } };

  withTranscripts({
    'big.jsonl': { text: line(huge) + line({ type: 'ai-title', aiTitle: 'Past the window' }) },
  }, (dir) => {
    const [session] = sessionsWithSummaries(dir).sessions;
    assert.equal(session.title, null);
    assert.equal(session.titleFrom, null);
  });
});

test('a session is never read whole', () => {
  const opened = [];
  const realRead = fs.readSync;
  fs.readSync = (fd, buffer, offset, length, position) => {
    opened.push(length);
    return realRead(fd, buffer, offset, length, position);
  };

  try {
    withTranscripts({ 'huge.jsonl': { text: line({ type: 'mode' }) + 'z'.repeat(400000) } }, (dir) => {
      sessionsWithSummaries(dir);
    });
  } finally {
    fs.readSync = realRead;
  }

  assert.ok(opened.length > 0, 'the transcript was read at all');
  assert.ok(Math.max(...opened) <= 131072, `read ${Math.max(...opened)} bytes in one go`);
});

test('retention counts down from the period in force, and the newest transcript is the deadline', () => {
  withTranscripts({
    'old.jsonl': { text: line({ type: 'mode' }), ageDays: 28 },
    'newer.jsonl': { text: line({ type: 'mode' }), ageDays: 25 },
  }, (dir) => {
    const report = retention(listSessions(dir));

    assert.equal(report.days, 30, 'the documented default when nothing sets cleanupPeriodDays');
    assert.equal(report.count, 2);
    assert.equal(report.evidenceExpiresInDays, 5, 'the newest transcript outlives the rest');
    assert.equal(report.expiringCount, 2, 'both are inside the warning window');
    assert.equal(report.dateFrom, 'mtime', 'the UI has to be able to say where the date came from');
  });
});

test('a transcript already past the period reports zero days left, never a negative one', () => {
  withTranscripts({ 'stale.jsonl': { text: line({ type: 'mode' }), ageDays: 90 } }, (dir) => {
    const report = retention(listSessions(dir));
    assert.equal(report.evidenceExpiresInDays, 0);
    assert.ok(EXPIRY_WARNING_DAYS > 0);
  });
});

test('a store with no transcripts has no deadline to report', () => {
  withTranscripts({}, (dir) => {
    const report = retention(listSessions(dir));
    assert.equal(report.count, 0);
    assert.equal(report.evidenceExpiresInDays, null);
  });
});

test('a memory resolves to the transcript it came from, and admits when it cannot', () => {
  assert.ok(originSession(ALPHA, LIVE_SESSION));
  assert.equal(originSession(ALPHA, SWEPT_SESSION), null);
});

test('an id out of frontmatter can never address a file outside the store', () => {
  for (const hostile of ['../../../etc/passwd', '../-Users-demo-repos-messy/x', '', 'a/b', null, 42]) {
    assert.equal(originSession(ALPHA, hostile), null, `${hostile} was not refused`);
  }
});

test('only a project store has transcripts beside it', () => {
  assert.equal(transcriptDir({ kind: 'auto', dir: '/root/-slug/memory' }), '/root/-slug');
  assert.equal(transcriptDir({ kind: 'agent-user', dir: '/home/.claude/agent-memory/x' }), null);
  assert.equal(transcriptDir({ kind: 'global', dir: '/home/.claude' }), null);
});
