import path from 'node:path';
import { parseFrontmatter } from './parse.mjs';

export const VALID_TYPES = ['user', 'feedback', 'project', 'reference'];
export const EMPTY_BODY_CHARS = 40;
export const EMPTY_INSTRUCTION_CHARS = 10;
export const HOOK_ECHO_OVERLAP = 0.9;
export const EVIDENCE_WARNING_DAYS = 14;
export const EVIDENCE_CRITICAL_DAYS = 7;

const TRANSCRIPT_RESOLVED = new Set(['transcript', 'repo-root']);

const VALID_TYPE_SET = new Set(VALID_TYPES);

const significantChars = (text) => String(text || '').replace(/\s+/g, '').length;

const wordSet = (text) => new Set(String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

function overlap(left, right) {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const id = key(item);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(item);
  }
  return groups;
}

export function checkDuplicateNames(memories) {
  return [...groupBy(memories, (memory) => memory.name)]
    .filter(([, group]) => group.length > 1)
    .map(([name, group]) => ({
      kind: 'duplicate-name',
      severity: 'bad',
      name,
      files: group.map((memory) => memory.file),
      reachable: group[0].file,
    }));
}

export function checkMissingDescription(memories) {
  return memories
    .filter((memory) => memory.hasFrontmatter && !memory.description.trim())
    .map((memory) => ({ kind: 'missing-description', severity: 'warn', file: memory.file, name: memory.name }));
}

export function checkUnknownType(memories) {
  return memories
    .filter((memory) => memory.hasFrontmatter && !VALID_TYPE_SET.has(memory.type))
    .map((memory) => ({ kind: 'unknown-type', severity: 'warn', file: memory.file, type: memory.type }));
}

export function checkEmptyBody(memories) {
  return memories
    .filter((memory) => significantChars(memory.body) < EMPTY_BODY_CHARS)
    .map((memory) => ({
      kind: 'empty-body',
      severity: 'warn',
      file: memory.file,
      name: memory.name,
      chars: significantChars(memory.body),
    }));
}

export function checkHookRepeatsDescription(memories) {
  return memories
    .filter((memory) => memory.entry && memory.entry.hook && memory.description)
    .filter((memory) => overlap(wordSet(memory.entry.hook), wordSet(memory.description)) >= HOOK_ECHO_OVERLAP)
    .map((memory) => ({
      kind: 'hook-repeats-description',
      severity: 'warn',
      file: memory.file,
      index: memory.entry.index,
      text: memory.entry.text,
      hookLength: memory.entry.hook.length,
    }));
}

export function checkDuplicateIndexEntry(index) {
  if (!index) return [];
  return [...groupBy(index.entries, (entry) => entry.file)]
    .filter(([, group]) => group.length > 1)
    .map(([file, group]) => {
      const last = group[group.length - 1];
      return {
        kind: 'duplicate-index-entry',
        severity: 'bad',
        file,
        lines: group.map((entry) => entry.index),
        removable: { index: last.index, text: last.text },
      };
    });
}

export function checkEmptySection(index) {
  if (!index) return [];
  const lines = index.parsedLines;
  const empty = [];

  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i];
    if (heading.kind !== 'heading') continue;

    let hasEntry = false;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.kind === 'heading' && line.level <= heading.level) break;
      if (line.kind === 'index') { hasEntry = true; break; }
    }
    if (!hasEntry) empty.push({ kind: 'empty-section', severity: 'warn', section: heading.section, index: heading.index });
  }
  return empty;
}

export function checkIndexContinuation(index) {
  if (!index) return [];

  const spilling = [];
  for (const entry of index.entries) {
    let extra = 0;
    for (let i = entry.index + 1; i < index.lines.length; i++) {
      const line = index.lines[i];
      if (!line.trim() || !/^[ \t]/.test(line)) break;
      extra += 1;
    }
    if (extra) spilling.push({ file: entry.file, title: entry.title, index: entry.index, extraLines: extra });
  }
  if (!spilling.length) return [];

  return [{
    kind: 'index-continuation',
    severity: 'warn',
    count: spilling.length,
    extraLines: spilling.reduce((sum, entry) => sum + entry.extraLines, 0),
    entries: spilling,
  }];
}

export function checkDuplicateLoad(files) {
  const loadable = files.filter((item) => item.kind !== 'managed-settings');
  return [...groupBy(loadable, (item) => path.resolve(item.file))]
    .filter(([, group]) => group.length > 1)
    .map(([, group]) => ({
      kind: 'duplicate-load',
      severity: 'warn',
      file: group[0].file,
      scope: group[0].scope,
      count: group.length,
      via: group.map((item) => item.importedBy || item.file),
      wastedTokens: (group[0].tokens || 0) * (group.length - 1),
    }));
}

export function checkEmptyInstructionFile(files) {
  const seen = new Set();
  const empty = [];

  for (const item of files) {
    if (item.kind === 'managed-settings') continue;
    const resolved = path.resolve(item.file);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (significantChars(parseFrontmatter(item.text).body) >= EMPTY_INSTRUCTION_CHARS) continue;
    empty.push({ kind: 'empty-instruction-file', severity: 'warn', file: item.file, scope: item.scope });
  }
  return empty;
}

export function checkProvenanceExpired(memories, resolveOrigin) {
  if (typeof resolveOrigin !== 'function') return [];
  return memories
    .map((memory) => ({ memory, sessionId: memory.metadata?.originSessionId }))
    .filter(({ sessionId }) => typeof sessionId === 'string' && sessionId)
    .filter(({ sessionId }) => !resolveOrigin(sessionId))
    .map(({ memory, sessionId }) => ({
      kind: 'provenance-expired',
      severity: 'warn',
      file: memory.file,
      name: memory.name,
      sessionId,
    }));
}

export function checkPathEvidenceExpiring(store, retention, { remembered = false } = {}) {
  if (!store || store.kind !== 'auto' || remembered) return [];
  if (!TRANSCRIPT_RESOLVED.has(store.resolvedBy)) return [];

  const days = retention?.evidenceExpiresInDays;
  if (typeof days !== 'number' || days > EVIDENCE_WARNING_DAYS) return [];

  return [{
    kind: 'path-evidence-expiring',
    severity: days <= EVIDENCE_CRITICAL_DAYS ? 'bad' : 'warn',
    path: store.path,
    days,
    retentionDays: retention.days,
    sessionCount: retention.count,
  }];
}

export function checkNoMemoryDespiteSessions(store, memories, retention) {
  if (!store || store.kind !== 'auto' || memories.length) return [];
  if (!store.autoMemory?.enabled || !store.autoMemory?.known) return [];
  if (!retention || !retention.count) return [];

  return [{
    kind: 'no-memory-despite-sessions',
    severity: 'warn',
    sessionCount: retention.count,
    retentionDays: retention.days,
  }];
}

export function sessionChecks(store, memories, retention, { remembered = false, resolveOrigin = null } = {}) {
  if (!retention) return [];
  return [
    ...checkProvenanceExpired(memories, resolveOrigin),
    ...checkPathEvidenceExpiring(store, retention, { remembered }),
    ...checkNoMemoryDespiteSessions(store, memories, retention),
  ];
}

export function memoryChecks(memories, index) {
  return [
    ...checkDuplicateNames(memories),
    ...checkDuplicateIndexEntry(index),
    ...checkMissingDescription(memories),
    ...checkUnknownType(memories),
    ...checkEmptyBody(memories),
    ...checkHookRepeatsDescription(memories),
    ...checkEmptySection(index),
    ...checkIndexContinuation(index),
  ];
}

export function instructionChecks(files) {
  return [...checkDuplicateLoad(files), ...checkEmptyInstructionFile(files)];
}
