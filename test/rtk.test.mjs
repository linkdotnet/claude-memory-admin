import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { findRtk, rtkReport } from '../src/rtk.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures', 'rtk');
const read = (name) => fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8');

const HOME = os.tmpdir();
const PROJECT = here;

function fakeRtk(overrides = {}) {
  const calls = [];
  const run = async (args, options) => {
    calls.push({ args, cwd: options.cwd });
    const key = args[0] === '--version' ? 'version'
      : args[0] === 'discover' ? 'discover'
        : args.includes('-p') ? 'project' : 'gain';
    const answer = overrides[key];
    if (typeof answer === 'function') return answer(args, options);
    if (answer !== undefined) return answer;
    return {
      version: 'rtk 0.45.0\n',
      gain: read('gain'),
      project: read('gain-project'),
      discover: read('discover'),
    }[key];
  };
  return { run, calls };
}

const report = (projectDir, overrides) => {
  const { run, calls } = fakeRtk(overrides);
  return rtkReport({ projectDir }, { run, home: HOME }).then((value) => ({ value, calls }));
};

// findBinary applies PATHEXT on Windows exactly as the shell does, so a bare
// name is not an executable there and the fixture has to be named the way the
// platform names one.
const EXE = process.platform === 'win32' ? 'rtk.exe' : 'rtk';

test('an executable on PATH is found, and a directory of the same name is not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtk-path-'));
  const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'rtk-decoy-'));
  fs.mkdirSync(path.join(decoy, EXE));
  const binary = path.join(dir, EXE);
  fs.writeFileSync(binary, '#!/bin/sh\n');
  fs.chmodSync(binary, 0o755);

  const found = findRtk({ PATH: [decoy, dir].join(path.delimiter) });
  assert.equal(found.found, true);
  assert.equal(found.path, binary);

  assert.deepEqual(findRtk({ PATH: decoy }), { id: 'rtk', found: false, path: null });
  assert.equal(findRtk({}).found, false);
});

test('a project store reads the machine ledger, its own slice and the missed commands', async () => {
  const { value, calls } = await report(PROJECT);

  assert.deepEqual(value.errors, []);
  assert.equal(value.version, '0.45.0');
  assert.equal(value.projectDir, PROJECT);

  assert.equal(value.machine.commands, 1200);
  assert.equal(value.machine.saved, 750000);
  assert.equal(value.machine.savedPct, 75);
  assert.equal(value.machine.days.length, 3);

  assert.equal(value.project.commands, 90);
  assert.equal(value.project.savedPct, 35);

  assert.equal(value.discover.sessionsScanned, 12);
  assert.equal(value.discover.adoptionPct, 25);
  assert.equal(value.discover.missed.length, 2);
  assert.equal(value.discover.missedTotal, 2);
  assert.deepEqual(value.discover.missed[0], {
    command: 'grep -n',
    count: 40,
    equivalent: 'rtk grep',
    category: 'Files',
    savedTokens: 9000,
    savedPct: 75,
  });

  const scoped = calls.filter((call) => call.cwd === PROJECT).map((call) => call.args[0]);
  assert.deepEqual(scoped.sort(), ['discover', 'gain']);
  assert.equal(calls.every((call) => call.cwd === PROJECT || call.cwd === HOME), true);
});

test('the trend window totals the days rather than averaging their percentages', async () => {
  const { value } = await report(PROJECT);
  assert.equal(value.machine.window.active, 3);
  assert.equal(value.machine.window.commands, 600);
  assert.equal(value.machine.window.saved, 130000);
  assert.equal(value.machine.window.savedPct, 65);
});

test('a store with no project directory asks rtk nothing about a project', async () => {
  const { value, calls } = await report(null);
  assert.equal(value.projectDir, null);
  assert.equal(value.project, null);
  assert.equal(value.discover, null);
  assert.deepEqual(value.errors, []);
  assert.equal(calls.every((call) => call.cwd === HOME), true);
});

test('a path that is not a directory is refused before rtk is asked to run in it', async () => {
  const { value, calls } = await report(path.join(here, 'rtk.test.mjs'));
  assert.equal(value.projectDir, null);
  assert.equal(value.project, null);
  assert.equal(calls.every((call) => call.cwd === HOME), true);
});

test('a missing binary is reported as an error per step, not thrown', async () => {
  const boom = () => { throw new Error('rtk is not on this process PATH'); };
  const { value } = await report(PROJECT, { version: boom, gain: boom, project: boom, discover: boom });
  assert.equal(value.machine, null);
  assert.equal(value.project, null);
  assert.equal(value.discover, null);
  assert.equal(value.version, null);
  assert.equal(value.errors.length, 4);
  assert.equal(value.errors.every((error) => error.message.includes('not on this process PATH')), true);
});

test('output that is not JSON fails only the step that produced it', async () => {
  const { value } = await report(PROJECT, { gain: 'RTK Token Savings\n====\n' });
  assert.equal(value.machine, null);
  assert.equal(value.project.commands, 90);
  assert.equal(value.discover.missed.length, 2);
  assert.deepEqual(value.errors, [{ step: 'gain', message: 'rtk gain did not answer with JSON' }]);
});

test('a payload missing the fields this app reads degrades to zeroes', async () => {
  const { value } = await report(PROJECT, {
    gain: '{"summary":{"total_commands":7},"daily":[{"commands":1},{"date":"2026-02-01"}]}',
    project: '{}',
    discover: '{"supported":[{"count":3},{"command":"ls -la"}]}',
  });
  assert.deepEqual(value.errors, []);
  assert.equal(value.machine.commands, 7);
  assert.equal(value.machine.saved, 0);
  assert.equal(value.machine.savedPct, 0);
  assert.deepEqual(value.machine.days, [{ date: '2026-02-01', commands: 0, input: 0, saved: 0, savedPct: 0 }]);
  assert.equal(value.machine.window.savedPct, 0);
  assert.equal(value.project.commands, 0);
  assert.equal(value.discover.adoptionPct, 0);
  assert.deepEqual(value.discover.missed, [{
    command: 'ls -la', count: 0, equivalent: '', category: '', savedTokens: 0, savedPct: 0,
  }]);
});

test('the missed list is ranked by what it would have saved, and says what it left out', async () => {
  const many = (count) => JSON.stringify({
    sessions_scanned: 3,
    total_commands: 100,
    already_rtk: 10,
    supported: Array.from({ length: count }, (_, i) => ({
      command: `cmd-${i}`,
      count: 1,
      rtk_equivalent: `rtk cmd-${i}`,
      category: 'Files',
      estimated_savings_tokens: i * 100,
      estimated_savings_pct: 50,
    })),
  });

  const { value } = await report(PROJECT, { discover: many(20) });
  assert.equal(value.discover.missedTotal, 20);
  assert.equal(value.discover.missed.length, 12);
  assert.equal(value.discover.missed[0].command, 'cmd-19');
  assert.deepEqual(
    value.discover.missed.map((item) => item.savedTokens),
    [...value.discover.missed.map((item) => item.savedTokens)].sort((a, b) => b - a),
  );
});
