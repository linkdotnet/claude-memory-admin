import os from 'node:os';

import { collector, findBinary, num, parseJson, pct, runBinary, text } from './toolrun.mjs';

const BINARY = 'ccusage';
const WINDOW_DAYS = 30;
const SESSION_LIMIT = 8;
const MODEL_LIMIT = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

export const findCcusage = (env = process.env) => ({ id: BINARY, ...findBinary(BINARY, env) });

const runCcusage = (args, options) => runBinary(BINARY, args, options);

const ZERO = { sessions: 0, cost: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function rowOf(session) {
  const models = Array.isArray(session.modelBreakdowns) ? session.modelBreakdowns : [];
  return {
    id: text(session.sessionId),
    slug: text(session.projectPath),
    cost: num(session.totalCost),
    tokens: num(session.totalTokens),
    input: num(session.inputTokens),
    output: num(session.outputTokens),
    cacheRead: num(session.cacheReadTokens),
    cacheWrite: num(session.cacheCreationTokens),
    last: text(session.lastActivity),
    models: models
      .filter((model) => model && typeof model === 'object')
      .map((model) => ({ name: text(model.modelName), cost: num(model.cost), tokens: num(model.outputTokens) }))
      .filter((model) => model.name),
  };
}

const totalsOf = (rows) => rows.reduce((sum, row) => ({
  sessions: sum.sessions + 1,
  cost: sum.cost + row.cost,
  tokens: sum.tokens + row.tokens,
  input: sum.input + row.input,
  output: sum.output + row.output,
  cacheRead: sum.cacheRead + row.cacheRead,
  cacheWrite: sum.cacheWrite + row.cacheWrite,
}), ZERO);

function modelMix(rows) {
  const byName = new Map();
  for (const row of rows) {
    for (const model of row.models) {
      const seen = byName.get(model.name) || { name: model.name, cost: 0, tokens: 0 };
      seen.cost += model.cost;
      seen.tokens += model.tokens;
      byName.set(model.name, seen);
    }
  }
  return [...byName.values()].sort((a, b) => b.cost - a.cost).slice(0, MODEL_LIMIT);
}

function windowOf(rows, now) {
  const cutoff = now - (WINDOW_DAYS * DAY_MS);
  const recent = rows.filter((row) => {
    const stamp = Date.parse(row.last);
    return Number.isFinite(stamp) && stamp >= cutoff;
  });
  return { days: WINDOW_DAYS, ...totalsOf(recent) };
}

function machineOf(raw, rows) {
  const totals = raw && typeof raw.totals === 'object' && raw.totals ? raw.totals : {};
  return {
    sessions: rows.length,
    cost: num(totals.totalCost),
    tokens: num(totals.totalTokens),
    input: num(totals.inputTokens),
    output: num(totals.outputTokens),
    cacheRead: num(totals.cacheReadTokens),
    cacheWrite: num(totals.cacheCreationTokens),
  };
}

export async function ccusageReport(target = {}, { run = runCcusage, home = os.homedir(), now = Date.now() } = {}) {
  const { errors, step } = collector();

  const [version, raw] = await Promise.all([
    step('version', async () => text(await run(['--version'], { cwd: home })).trim().replace(/^ccusage\s+/, '')),
    step('claude session', async () => parseJson(
      await run(['claude', 'session', '--json', '--offline'], { cwd: home }),
      'ccusage claude session',
    )),
  ]);

  if (!raw) {
    return { tool: BINARY, version: version || null, slug: target.slug || null, machine: null, project: null, errors };
  }

  const rows = (Array.isArray(raw.sessions) ? raw.sessions : [])
    .filter((session) => session && typeof session === 'object')
    .map(rowOf)
    .filter((row) => row.id);

  const machine = machineOf(raw, rows);
  const mine = target.slug ? rows.filter((row) => row.slug === target.slug) : null;
  const mineTotals = mine ? totalsOf(mine) : null;

  return {
    tool: BINARY,
    version: version || null,
    slug: target.slug || null,
    machine: { ...machine, window: windowOf(rows, now) },
    project: mine ? {
      ...mineTotals,
      share: pct(mineTotals.cost, machine.cost),
      window: windowOf(mine, now),
      models: modelMix(mine),
      top: [...mine]
        .sort((a, b) => b.cost - a.cost)
        .slice(0, SESSION_LIMIT)
        .map(({ id, cost, tokens, last }) => ({ id, cost, tokens, last })),
    } : null,
    errors,
  };
}
