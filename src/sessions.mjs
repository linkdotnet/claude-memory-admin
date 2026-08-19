import fs from 'node:fs';
import path from 'node:path';
import { HEAD_READS, readHead } from './projects.mjs';
import { cleanupPeriodDays } from './settings.mjs';
import { ageInDays } from './stats.mjs';

export const EXPIRY_WARNING_DAYS = 7;
export const PROMPT_TITLE_CHARS = 80;
export const PROMPT_PREVIEW_CHARS = 400;

const SESSION_ID = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/;
const SELF_DESCRIBING_KEYS = ['slug', 'gitBranch', 'model', 'version', 'cwd'];
const WRAPPED_BY_CLAUDE_CODE = /^<(local-command-[a-z]+|command-(message|name|args)|system-reminder)>/;

const isSubagentTranscript = (name) => name.startsWith('agent-');
const isSessionTranscript = (name) => name.endsWith('.jsonl') && !isSubagentTranscript(name);

export function listSessions(slugDir) {
  let entries;
  try {
    entries = fs.readdirSync(slugDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessions = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isSessionTranscript(entry.name)) continue;
    const file = path.join(slugDir, entry.name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    sessions.push({
      id: entry.name.replace(/\.jsonl$/, ''),
      file,
      bytes: stat.size,
      modified: new Date(stat.mtimeMs).toISOString(),
      modifiedMs: stat.mtimeMs,
    });
  }
  return sessions.sort((a, b) => b.modifiedMs - a.modifiedMs);
}

function promptText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const joined = content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ');
  return joined || null;
}

function absorbRecord(record, found) {
  if (!record || typeof record !== 'object') return;

  if (record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle) {
    found.aiTitle = record.aiTitle;
  }
  for (const key of SELF_DESCRIBING_KEYS) {
    const value = typeof record[key] === 'string' ? record[key] : record.message?.[key];
    if (found[key] === null && typeof value === 'string' && value) found[key] = value;
  }
  if (found.prompt === null && record.type === 'user' && !record.isSidechain) {
    const text = promptText(record.message?.content)?.trim();
    if (text && !WRAPPED_BY_CLAUDE_CODE.test(text)) found.prompt = text;
  }
}

function absorbChunk(head, found) {
  for (const line of head.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      absorbRecord(JSON.parse(line), found);
    } catch {
      continue;
    }
  }
}

function condense(text, chars) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > chars ? `${flat.slice(0, chars - 1)}…` : flat;
}

export function sessionSummary(file, { bytes = null } = {}) {
  const found = { aiTitle: null, slug: null, gitBranch: null, model: null, version: null, cwd: null, prompt: null };

  let size = bytes;
  if (size === null) {
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
  }

  for (const read of HEAD_READS) {
    let head;
    try {
      head = readHead(file, read);
    } catch {
      break;
    }
    absorbChunk(head, found);
    if (found.aiTitle || size <= read) break;
  }

  const titleFrom = found.aiTitle ? 'ai-title' : found.slug ? 'slug' : found.prompt ? 'prompt' : null;
  const title = found.aiTitle
    || found.slug
    || (found.prompt ? condense(found.prompt, PROMPT_TITLE_CHARS) : null);

  return {
    title,
    titleFrom,
    slug: found.slug,
    gitBranch: found.gitBranch,
    model: found.model,
    version: found.version,
    cwd: found.cwd,
    prompt: found.prompt ? condense(found.prompt, PROMPT_PREVIEW_CHARS) : null,
  };
}

export function retention(sessions, { projectDir = null, now = Date.now() } = {}) {
  const days = cleanupPeriodDays(projectDir ? { projectDir } : {});
  const dated = sessions.map((session) => {
    const ageDays = ageInDays(session.modified, now);
    return { ...session, ageDays, expiresInDays: ageDays === null ? null : Math.max(0, days - ageDays) };
  });
  const remaining = dated.map((session) => session.expiresInDays).filter((value) => value !== null);

  return {
    days,
    dateFrom: 'mtime',
    sessions: dated,
    count: dated.length,
    bytes: dated.reduce((sum, session) => sum + session.bytes, 0),
    evidenceExpiresInDays: remaining.length ? Math.max(...remaining) : null,
    expiringCount: remaining.filter((value) => value <= EXPIRY_WARNING_DAYS).length,
  };
}

export function originSession(slugDir, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return null;
  const file = path.join(slugDir, `${sessionId}.jsonl`);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  return { id: sessionId, file, bytes: stat.size, modified: new Date(stat.mtimeMs).toISOString() };
}

export function transcriptDir(store) {
  return store && store.kind === 'auto' && store.dir ? path.dirname(store.dir) : null;
}

export function sessionsWithSummaries(slugDir, { projectDir = null, now = Date.now() } = {}) {
  const report = retention(listSessions(slugDir), { projectDir, now });
  return {
    ...report,
    sessions: report.sessions.map((session) => ({
      ...session,
      ...sessionSummary(session.file, { bytes: session.bytes }),
    })),
  };
}
