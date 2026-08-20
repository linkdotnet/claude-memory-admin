import os from 'node:os';

import { collector, findBinary, num, parseJson, pct, runBinary, text, usableDir } from './toolrun.mjs';

const BINARY = 'rtk';
const DISCOVER_DAYS = 30;
const DISCOVER_LIMIT = 10;
const MISSED_LIMIT = 12;
const TREND_DAYS = 30;

export const findRtk = (env = process.env) => ({ id: BINARY, ...findBinary(BINARY, env) });

const runRtk = (args, options) => runBinary(BINARY, args, options);

function summaryOf(raw) {
  const summary = raw && typeof raw.summary === 'object' && raw.summary ? raw.summary : {};
  return {
    commands: num(summary.total_commands),
    input: num(summary.total_input),
    output: num(summary.total_output),
    saved: num(summary.total_saved),
    savedPct: num(summary.avg_savings_pct),
    totalMs: num(summary.total_time_ms),
    avgMs: num(summary.avg_time_ms),
  };
}

function daysOf(raw) {
  const list = raw && Array.isArray(raw.daily) ? raw.daily : [];
  return list
    .filter((day) => day && typeof day === 'object')
    .map((day) => ({
      date: text(day.date),
      commands: num(day.commands),
      input: num(day.input_tokens),
      saved: num(day.saved_tokens),
      savedPct: num(day.savings_pct),
    }))
    .filter((day) => day.date);
}

function windowOf(days, count) {
  const recent = days.slice(-count);
  const totals = recent.reduce((sum, day) => ({
    commands: sum.commands + day.commands,
    input: sum.input + day.input,
    saved: sum.saved + day.saved,
  }), { commands: 0, input: 0, saved: 0 });
  return {
    days: count,
    active: recent.length,
    commands: totals.commands,
    saved: totals.saved,
    savedPct: pct(totals.saved, totals.input),
  };
}

function discoverOf(raw) {
  const commands = num(raw.total_commands);
  const alreadyRtk = num(raw.already_rtk);
  const supported = Array.isArray(raw.supported) ? raw.supported : [];
  const missed = supported
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      command: text(item.command),
      count: num(item.count),
      equivalent: text(item.rtk_equivalent),
      category: text(item.category),
      savedTokens: num(item.estimated_savings_tokens),
      savedPct: num(item.estimated_savings_pct),
    }))
    .filter((item) => item.command)
    .sort((a, b) => b.savedTokens - a.savedTokens);

  return {
    sessionsScanned: num(raw.sessions_scanned),
    commands,
    alreadyRtk,
    adoptionPct: pct(alreadyRtk, commands),
    sinceDays: num(raw.since_days) || DISCOVER_DAYS,
    missedTotal: missed.length,
    missed: missed.slice(0, MISSED_LIMIT),
  };
}

export async function rtkReport(target = {}, { run = runRtk, home = os.homedir() } = {}) {
  const { errors, step } = collector();
  const dir = usableDir(target.projectDir);

  const [version, machine, project, discover] = await Promise.all([
    step('version', async () => text(await run(['--version'], { cwd: home })).trim().replace(/^rtk\s+/, '')),
    step('gain', async () => parseJson(await run(['gain', '-a', '--format', 'json'], { cwd: home }), 'rtk gain')),
    dir ? step('gain --project', async () => parseJson(await run(['gain', '-p', '--format', 'json'], { cwd: dir }), 'rtk gain --project')) : null,
    dir ? step('discover', async () => parseJson(
      await run(['discover', '--format', 'json', '-s', String(DISCOVER_DAYS), '-l', String(DISCOVER_LIMIT)], { cwd: dir }),
      'rtk discover',
    )) : null,
  ]);

  const days = daysOf(machine);

  return {
    tool: BINARY,
    version: version || null,
    projectDir: dir,
    machine: machine ? { ...summaryOf(machine), days, window: windowOf(days, TREND_DAYS) } : null,
    project: project ? summaryOf(project) : null,
    discover: discover ? discoverOf(discover) : null,
    errors,
  };
}
