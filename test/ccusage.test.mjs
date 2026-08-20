import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ccusageReport, findCcusage } from '../src/ccusage.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(path.join(here, 'fixtures', 'ccusage', 'session.json'), 'utf8');

const HOME = os.tmpdir();
const NOW = Date.parse('2026-01-10T00:00:00.000Z');
const ALPHA = '-Users-demo-repos-alpha';

function fake(overrides = {}) {
  const calls = [];
  const run = async (args, options) => {
    calls.push({ args, cwd: options.cwd });
    const key = args[0] === '--version' ? 'version' : 'session';
    const answer = overrides[key];
    if (typeof answer === 'function') return answer(args, options);
    if (answer !== undefined) return answer;
    return key === 'version' ? 'ccusage 20.0.20\n' : FIXTURE;
  };
  return { run, calls };
}

const report = (slug, overrides) => {
  const { run, calls } = fake(overrides);
  return ccusageReport({ slug }, { run, home: HOME, now: NOW }).then((value) => ({ value, calls }));
};

test('ccusage is looked for on PATH like any other companion binary', () => {
  assert.equal(findCcusage({ PATH: '' }).found, false);
  assert.equal(findCcusage({ PATH: '' }).id, 'ccusage');
});

test('the ledger is asked for once, offline, and attributed by project slug', async () => {
  const { value, calls } = await report(ALPHA);

  assert.deepEqual(value.errors, []);
  assert.equal(value.version, '20.0.20');
  assert.equal(value.slug, ALPHA);

  const session = calls.find((call) => call.args[0] === 'claude');
  assert.deepEqual(session.args, ['claude', 'session', '--json', '--offline']);
  assert.equal(calls.every((call) => call.cwd === HOME), true);

  assert.equal(value.machine.sessions, 4);
  assert.equal(value.machine.cost, 14.25);
  assert.equal(value.machine.tokens, 123890);

  assert.equal(value.project.sessions, 3);
  assert.equal(value.project.cost, 10.25);
  assert.equal(value.project.tokens, 112900);
  assert.equal(Math.round(value.project.share), 72);
});

test('the thirty-day window drops sessions older than the cutoff', async () => {
  const { value } = await report(ALPHA);
  assert.equal(value.project.window.sessions, 2);
  assert.equal(value.project.window.cost, 10);
  assert.equal(value.machine.window.sessions, 3);
});

test('models are merged across sessions and ranked by spend', async () => {
  const { value } = await report(ALPHA);
  assert.deepEqual(value.project.models.map((model) => model.name), ['claude-opus-5', 'claude-haiku-4-5-20251001']);
  assert.equal(value.project.models[0].cost, 9.75);
  assert.equal(value.project.models[0].tokens, 5200);
});

test('the costliest sessions come back first, carrying ids the Sessions segment also lists', async () => {
  const { value } = await report(ALPHA);
  assert.deepEqual(value.project.top.map((session) => session.cost), [8, 2, 0.25]);
  assert.equal(value.project.top[0].id, 'aaaaaaaa-0000-0000-0000-000000000001');
  assert.deepEqual(Object.keys(value.project.top[0]).sort(), ['cost', 'id', 'last', 'tokens']);
});

test('a store that owns no slug is given the machine ledger and no project slice', async () => {
  const { value } = await report(null);
  assert.equal(value.slug, null);
  assert.equal(value.project, null);
  assert.equal(value.machine.sessions, 4);
});

test('a slug nothing was billed against reads as zero rather than as missing', async () => {
  const { value } = await report('-Users-demo-repos-nothing');
  assert.equal(value.project.sessions, 0);
  assert.equal(value.project.cost, 0);
  assert.equal(value.project.share, 0);
  assert.deepEqual(value.project.models, []);
  assert.deepEqual(value.project.top, []);
});

test('a ledger that cannot be read leaves the report empty instead of throwing', async () => {
  const { value } = await report(ALPHA, { session: 'ccusage: no usage data found\n' });
  assert.equal(value.machine, null);
  assert.equal(value.project, null);
  assert.deepEqual(value.errors, [{ step: 'claude session', message: 'ccusage claude session did not answer with JSON' }]);
});

test('rows missing the fields this app reads degrade to zeroes', async () => {
  const { value } = await report(ALPHA, {
    session: JSON.stringify({
      sessions: [
        { sessionId: 'x', projectPath: ALPHA },
        { projectPath: ALPHA, totalCost: 5 },
        { sessionId: 'y', projectPath: ALPHA, modelBreakdowns: [{ cost: 3 }], lastActivity: 'not a date' },
      ],
      totals: {},
    }),
  });
  assert.deepEqual(value.errors, []);
  assert.equal(value.machine.cost, 0);
  assert.equal(value.project.sessions, 2);
  assert.equal(value.project.cost, 0);
  assert.deepEqual(value.project.models, []);
  assert.equal(value.project.window.sessions, 0);
});
