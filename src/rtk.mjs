import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BINARY = 'rtk';
const TIMEOUT_MS = 15000;
const MAX_BUFFER = 4 * 1024 * 1024;
const DISCOVER_DAYS = 30;
const DISCOVER_LIMIT = 10;
const MISSED_LIMIT = 12;
const TREND_DAYS = 30;

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const text = (value) => (typeof value === 'string' ? value : '');
const pct = (part, whole) => (whole > 0 ? (part / whole) * 100 : 0);

function candidateNames(env) {
  if (process.platform !== 'win32') return [BINARY];
  const exts = text(env.PATHEXT || '.EXE').split(';').filter(Boolean);
  return exts.map((ext) => BINARY + ext.toLowerCase());
}

export function findRtk(env = process.env) {
  const dirs = text(env.PATH).split(path.delimiter).filter(Boolean);
  const names = candidateNames(env);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, fs.constants.X_OK);
        return { id: BINARY, found: true, path: candidate };
      } catch {
        continue;
      }
    }
  }
  return { id: BINARY, found: false, path: null };
}

function runRtk(args, { cwd, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const options = { cwd, timeout, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: 'utf8' };
    execFile(BINARY, args, options, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (err.code === 'ENOENT') return reject(new Error('rtk is not on this process PATH'));
      if (err.killed) return reject(new Error(`rtk ${args[0]} was still running after ${timeout}ms and was stopped`));
      const detail = text(stderr || stdout).trim().split('\n')[0];
      return reject(new Error(detail ? `rtk ${args[0]} failed: ${detail}` : `rtk ${args[0]} exited ${err.code}`));
    });
  });
}

function parseJson(raw, label) {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object') throw new Error('not an object');
    return value;
  } catch {
    throw new Error(`rtk ${label} did not answer with JSON`);
  }
}

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

function usableDir(dir) {
  if (!dir) return null;
  try {
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

export async function rtkReport(projectDir, { run = runRtk, home = os.homedir() } = {}) {
  const errors = [];
  const step = async (label, work) => {
    try {
      return await work();
    } catch (err) {
      errors.push({ step: label, message: err.message });
      return null;
    }
  };

  const dir = usableDir(projectDir);

  const [version, machine, project, discover] = await Promise.all([
    step('version', async () => text(await run(['--version'], { cwd: home })).trim().replace(/^rtk\s+/, '')),
    step('gain', async () => parseJson(await run(['gain', '-a', '--format', 'json'], { cwd: home }), 'gain')),
    dir ? step('gain --project', async () => parseJson(await run(['gain', '-p', '--format', 'json'], { cwd: dir }), 'gain --project')) : null,
    dir ? step('discover', async () => parseJson(
      await run(['discover', '--format', 'json', '-s', String(DISCOVER_DAYS), '-l', String(DISCOVER_LIMIT)], { cwd: dir }),
      'discover',
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
