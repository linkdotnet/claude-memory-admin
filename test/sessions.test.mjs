import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  EXPIRY_WARNING_DAYS,
  HEAT_WEEKS_MAX,
  heatmap,
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

const NOON = Date.parse('2026-08-19T12:00:00.000Z');
const daysAgo = (count) => ({ modified: new Date(NOON - count * DAY).toISOString() });
const weekday = (date) => new Date(`${date}T00:00:00.000Z`).getUTCDay();

test('the activity grid runs Monday to Sunday and covers the whole retention window', () => {
  const heat = heatmap([daysAgo(0)], { days: 30, now: NOON });
  assert.equal(weekday(heat.start), 1, 'the first column starts on a Monday');
  assert.equal(weekday(heat.end), 0, 'the last column ends on a Sunday');
  assert.equal(heat.weeks.length, 5, 'thirty days of retention snap out to five whole weeks');
  for (const week of heat.weeks) assert.equal(week.length, 7);

  const oldest = heat.weeks[0][0].date;
  const windowStart = new Date(NOON - 29 * DAY).toISOString().slice(0, 10);
  assert.ok(oldest <= windowStart, 'the grid reaches at least as far back as the retention window');
});

test('a transcript that outlived the sweep widens the grid rather than falling off it', () => {
  const heat = heatmap([daysAgo(120)], { days: 30, now: NOON });
  assert.ok(heat.weeks.length > 5, 'the grid grew past the retention window to hold the old transcript');
  const dates = heat.weeks.flat().map((cell) => cell.date);
  assert.ok(dates.includes(daysAgo(120).modified.slice(0, 10)), 'the old transcript has a tile');
  assert.equal(heat.total, 1);
});

test('a day with more transcripts is shaded stronger than a day with one', () => {
  const heat = heatmap([daysAgo(0), daysAgo(0), daysAgo(3)], { days: 30, now: NOON });
  const cells = new Map(heat.weeks.flat().map((cell) => [cell.date, cell]));
  const busy = cells.get(daysAgo(0).modified.slice(0, 10));
  const quiet = cells.get(daysAgo(3).modified.slice(0, 10));

  assert.equal(busy.count, 2);
  assert.equal(quiet.count, 1);
  assert.ok(busy.level > quiet.level, 'two sessions outrank one');
  assert.equal(heat.max, 2);
  assert.equal(heat.total, 3);
});

test('a quiet day is level zero and a saturated store still tops out at four', () => {
  const many = Array.from({ length: 20 }, () => daysAgo(1));
  const heat = heatmap([...many, daysAgo(2)], { days: 30, now: NOON });
  const cells = new Map(heat.weeks.flat().map((cell) => [cell.date, cell]));

  assert.equal(cells.get(daysAgo(1).modified.slice(0, 10)).level, 4);
  assert.equal(cells.get(daysAgo(2).modified.slice(0, 10)).level, 1, 'one of twenty is the faintest lit shade');
  assert.equal(cells.get(daysAgo(4).modified.slice(0, 10)).level, 0, 'a day nothing touched stays unlit');
});

test('the days after today are marked future and carry no count', () => {
  const heat = heatmap([daysAgo(0)], { days: 30, now: NOON });
  const today = new Date(NOON).toISOString().slice(0, 10);

  for (const cell of heat.weeks.flat()) {
    assert.equal(cell.future, cell.date > today, `${cell.date} is misfiled`);
    if (cell.future) assert.equal(cell.count, 0, 'nothing can have happened after today');
  }
  assert.equal(heat.weeks.flat().find((cell) => cell.date === today).future, false);
});

test('a retention period long enough to outgrow the grid is capped, not unrolled', () => {
  const heat = heatmap([], { days: 4000, now: NOON });
  assert.equal(heat.weeks.length, HEAT_WEEKS_MAX);
  assert.equal(weekday(heat.start), 1);
  assert.equal(weekday(heat.end), 0);
});

test('the tile a session lands on is the date its row already prints', () => {
  withTranscripts({ 'a.jsonl': { text: line({ type: 'user', message: { content: 'hi' } }) } }, (dir) => {
    const report = sessionsWithSummaries(dir);
    const lit = report.heat.weeks.flat().filter((cell) => cell.count > 0);
    assert.equal(lit.length, 1);
    assert.equal(lit[0].date, report.sessions[0].modified.slice(0, 10));
  });
});
