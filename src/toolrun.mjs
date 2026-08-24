import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TIMEOUT_MS = 15000;
const MAX_BUFFER = 4 * 1024 * 1024;

export const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
export const text = (value) => (typeof value === 'string' ? value : '');
export const pct = (part, whole) => (whole > 0 ? (part / whole) * 100 : 0);

function candidateNames(binary, env, platform) {
  if (platform !== 'win32') return [binary];
  return text(env.PATHEXT || '.EXE').split(';').filter(Boolean).map((ext) => binary + ext.toLowerCase());
}

export function findBinary(binary, env = process.env, platform = process.platform) {
  // PATH is split on this process's delimiter, not the target platform's, since
  // the PATH being searched is the one this process actually has.
  const dirs = text(env.PATH).split(path.delimiter).filter(Boolean);
  const names = candidateNames(binary, env, platform);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        // Windows has no execute bit, and Node answers X_OK there from the
        // file's existence alone. Asking for it is meaningless rather than
        // harmless: it is the check that would reject a perfectly good .cmd.
        if (platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
        return { found: true, path: candidate };
      } catch {
        continue;
      }
    }
  }
  return { found: false, path: null };
}

/**
 * How to actually start a program on Windows.
 *
 * npm installs `rtk` and `ccusage` as `rtk.cmd`, and a batch file is not a
 * program: execFile refuses to run one outright, and would not find it by bare
 * name in the first place, since only the shell applies PATHEXT. So the resolved
 * file is handed to cmd.exe the way Node's own shell support does - `/d /s /c`
 * with one pre-quoted command string and verbatim arguments - and the arguments
 * are quoted here rather than trusted to survive a second round of parsing.
 */
export function windowsInvocation(binary, args, env = process.env) {
  const found = findBinary(binary, env, 'win32');
  const target = found.found ? found.path : binary;
  if (!/\.(cmd|bat)$/i.test(target)) return { file: target, args, options: {} };

  const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;
  const command = [target, ...args].map(quote).join(' ');
  return {
    file: env.COMSPEC || 'cmd.exe',
    args: ['/d', '/s', '/c', command],
    options: { windowsVerbatimArguments: true },
  };
}

export function runBinary(binary, args, { cwd, timeout = TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const invocation = process.platform === 'win32'
      ? windowsInvocation(binary, args, env)
      : { file: binary, args, options: {} };

    const options = {
      cwd,
      timeout,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      encoding: 'utf8',
      ...invocation.options,
    };
    execFile(invocation.file, invocation.args, options, (err, stdout, stderr) => {
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
