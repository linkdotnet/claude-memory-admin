import fs from 'node:fs';
import path from 'node:path';

export const MAX_PATH_CHECKS = 200;
export const MAX_INDEXED_FILES = 60000;

export const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'bin', 'obj', 'dist', 'build', 'out', 'target', 'vendor',
  '.next', '.nuxt', '.svelte-kit', '.venv', 'venv', '__pycache__', '.gradle', '.idea',
  'Pods', 'DerivedData', 'coverage', '.turbo', '.cache', '.angular', '.parcel-cache',
]);

const CODE_SPAN = /`([^`\n]+)`/g;
const SOURCE_EXT = /\.(mjs|cjs|jsx?|tsx?|json|jsonc|md|mdx|css|scss|less|html|vue|svelte|py|rb|go|rs|java|kt|swift|cs|fs|php|sh|zsh|ya?ml|toml|xml|sql|proto|lock|gradle|csproj|sln)$/i;
const BARE_EXTENSION = /^\.[A-Za-z0-9]+$/;
const LINE_SUFFIX = /:\d+(?:[-:]\d+)?$/;
const GLOB_OR_SHELL = /[*?{}[\]()<>|$=!"'\\]/;

function candidate(raw) {
  let token = raw.trim();
  if (!token || /\s/.test(token)) return null;
  if (token.includes('://') || token.startsWith('@')) return null;
  if (GLOB_OR_SHELL.test(token)) return null;

  // A memory written on Windows quotes its paths with backslashes. The project
  // index below is keyed on forward slashes, so a token that is not normalised
  // matches nothing and every Windows-written path is reported as missing.
  token = token.replace(/\\/g, '/');
  token = token.replace(LINE_SUFFIX, '').replace(/[.,;:]+$/, '').replace(/\/+$/, '');
  if (/^[A-Za-z]:\//.test(token)) return null;
  if (token.startsWith('./')) token = token.slice(2);
  if (!token || token.startsWith('/') || token.startsWith('~')) return null;
  if (token.split('/').includes('..')) return null;
  if (token.includes('...') || token.length > 200) return null;
  if (BARE_EXTENSION.test(token)) return null;
  if (!SOURCE_EXT.test(token)) return null;
  if (token.split('/').some((segment) => SKIP_DIRS.has(segment))) return null;

  return token;
}

export function pathCandidates(body) {
  const found = new Set();
  for (const match of String(body || '').matchAll(CODE_SPAN)) {
    const token = candidate(match[1]);
    if (token) found.add(token);
  }
  return [...found];
}

export function indexProject(root, { skipDirs = SKIP_DIRS, limit = MAX_INDEXED_FILES } = {}) {
  const byLastSegment = new Map();
  let count = 0;
  let truncated = false;

  const walk = (dir, prefix) => {
    if (truncated) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= limit) {
        truncated = true;
        return;
      }
      if (skipDirs.has(entry.name)) continue;

      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      count += 1;
      if (!byLastSegment.has(entry.name)) byLastSegment.set(entry.name, []);
      byLastSegment.get(entry.name).push(relative);

      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
    }
  };

  walk(root, '');
  return { byLastSegment, count, truncated };
}

function resolvesInProject(index, token) {
  const matches = index.byLastSegment.get(token.split('/').pop());
  if (!matches) return false;
  if (!token.includes('/')) return true;
  return matches.some((relative) => relative === token || relative.endsWith(`/${token}`));
}

export function verifyPaths(projectDir, memories) {
  const root = path.resolve(projectDir);
  const index = indexProject(root);
  const missing = [];
  let checked = 0;
  let capped = false;

  for (const memory of memories) {
    for (const token of pathCandidates(memory.body)) {
      if (checked >= MAX_PATH_CHECKS) {
        capped = true;
        break;
      }
      checked += 1;
      if (!resolvesInProject(index, token)) {
        missing.push({ kind: 'stale-path', severity: 'warn', file: memory.file, name: memory.name, token });
      }
    }
    if (capped) break;
  }

  return { projectDir: root, checked, capped, indexed: index.count, truncated: index.truncated, missing };
}
