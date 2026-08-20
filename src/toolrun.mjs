import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TIMEOUT_MS = 15000;
const MAX_BUFFER = 4 * 1024 * 1024;

export const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
export const text = (value) => (typeof value === 'string' ? value : '');
export const pct = (part, whole) => (whole > 0 ? (part / whole) * 100 : 0);

function candidateNames(binary, env) {
  if (process.platform !== 'win32') return [binary];
  return text(env.PATHEXT || '.EXE').split(';').filter(Boolean).map((ext) => binary + ext.toLowerCase());
}

export function findBinary(binary, env = process.env) {
  const dirs = text(env.PATH).split(path.delimiter).filter(Boolean);
  const names = candidateNames(binary, env);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, fs.constants.X_OK);
        return { found: true, path: candidate };
      } catch {
        continue;
      }
    }
  }
  return { found: false, path: null };
}

export function runBinary(binary, args, { cwd, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const options = { cwd, timeout, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: 'utf8' };
    execFile(binary, args, options, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (err.code === 'ENOENT') return reject(new Error(`${binary} is not on this process PATH`));
      if (err.killed) return reject(new Error(`${binary} ${args[0]} was still running after ${timeout}ms and was stopped`));
      const detail = text(stderr || stdout).trim().split('\n')[0];
      return reject(new Error(detail ? `${binary} ${args[0]} failed: ${detail}` : `${binary} ${args[0]} exited ${err.code}`));
    });
  });
}

export function parseJson(raw, label) {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object') throw new Error('not an object');
    return value;
  } catch {
    throw new Error(`${label} did not answer with JSON`);
  }
}

export function usableDir(dir) {
  if (!dir) return null;
  try {
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

export function collector() {
  const errors = [];
  const step = async (label, work) => {
    try {
      return await work();
    } catch (err) {
      errors.push({ step: label, message: err.message });
      return null;
    }
  };
  return { errors, step };
}
