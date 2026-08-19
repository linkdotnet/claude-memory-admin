// Builds the full view model for one memory store: its index, its memory files,
// the wikilink graph between them, and the consistency problems worth surfacing.
//
// A store is addressed by its directory, not by a root and a slug. Auto memory
// and subagent memory sit in unrelated places on disk but hold the same shape, so
// everything below is written against the shape and knows nothing about which
// kind it was handed.
//
// The whole store is a few hundred kilobytes, so this runs per request. No
// cache, no watcher, no invalidation bugs.

import fs from 'node:fs';
import path from 'node:path';
import { parseIndex, parseFrontmatter, extractWikilinks } from './parse.mjs';
import { listMemoryFiles, memoryDir, resolveProjectPath, shortLabel } from './projects.mjs';
import { autoMemoryState } from './settings.mjs';
import { ageInDays, estimateTokens, findDuplicates, indexStats } from './stats.mjs';
import { memoryChecks, sessionChecks } from './checks.mjs';
import { listSessions, originSession, retention, transcriptDir } from './sessions.mjs';
import { rememberedPath } from './pathcache.mjs';

export const TRASH_DIR = '.trash';

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Parse one memory file into its metadata, body and outbound wikilinks. */
export function loadMemory(dir, file) {
  const raw = readIfExists(path.join(dir, file));
  if (raw === null) return null;

  const { data, body, hasFrontmatter } = parseFrontmatter(raw);

  // Two frontmatter shapes exist in the wild: most files nest everything under
  // `metadata:`, but some write `type:`/`originSessionId:` at the root instead.
  // Root-level extras are merged in first so a nested block still wins.
  const nested = (data.metadata && typeof data.metadata === 'object') ? data.metadata : {};
  const rootExtras = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'name' || key === 'description' || key === 'metadata') continue;
    if (value && typeof value === 'object') continue;
    rootExtras[key] = value;
  }
  const metadata = { ...rootExtras, ...nested };
  const stem = file.replace(/\.md$/, '');
  const name = typeof data.name === 'string' && data.name ? data.name : stem;

  let stat = null;
  try {
    stat = fs.statSync(path.join(dir, file));
  } catch { /* raced with a delete */ }

  // Claude Code stamps `modified` only on files that already begin with
  // frontmatter, and never adds frontmatter to a file that has none, so for those
  // files the mtime fallback is permanent. mtime is also reset by any copy, rsync
  // or restore - including this tool's own trash round-trip - so which of the two
  // a date came from is the difference between evidence and a guess.
  const stamped = typeof metadata.modified === 'string' && metadata.modified ? metadata.modified : null;

  return {
    file,
    stem,
    name,
    description: typeof data.description === 'string' ? data.description : '',
    type: metadata.type || 'unknown',
    metadata,
    hasFrontmatter,
    // `name` and the filename usually agree but not always, so both are kept
    // and the mismatch is reported under health.
    nameMatchesFile: name === stem,
    body,
    raw,
    bytes: stat ? stat.size : raw.length,
    modified: stamped || (stat ? new Date(stat.mtimeMs).toISOString() : null),
    modifiedFrom: stamped ? 'frontmatter' : (stat ? 'mtime' : null),
    tokens: estimateTokens(raw),
    outbound: extractWikilinks(body).map((w) => w.target),
  };
}

/**
 * Resolve a wikilink target to a memory file. Targets normally match a `name`,
 * but fall back to the filename stem, which is what the mismatching files need.
 */
function buildResolver(memories) {
  const byName = new Map();
  const byStem = new Map();
  for (const memory of memories) {
    if (!byName.has(memory.name)) byName.set(memory.name, memory.file);
    if (!byStem.has(memory.stem)) byStem.set(memory.stem, memory.file);
  }
  return (target) => byName.get(target) || byStem.get(target) || null;
}

function provenance(memory, resolveOrigin) {
  const sessionId = memory.metadata?.originSessionId;
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const session = resolveOrigin ? resolveOrigin(sessionId) : null;
  return { sessionId, present: Boolean(session), modified: session ? session.modified : null };
}

function sessionContext(store) {
  const slugDir = transcriptDir(store);
  if (!slugDir) return { slugDir: null, retention: null, resolveOrigin: null, remembered: false };

  const projectDir = store.pathExists ? store.path : null;
  return {
    slugDir,
    retention: retention(listSessions(slugDir), { projectDir }),
    resolveOrigin: (sessionId) => originSession(slugDir, sessionId),
    remembered: Boolean(store.slug && rememberedPath(store.slug)),
  };
}

export function buildStore(store) {
  const { dir } = store;
  const hasMemoryDir = fs.existsSync(dir);
  const sessions = sessionContext(store);

  const indexRaw = readIfExists(path.join(dir, 'MEMORY.md'));
  const index = indexRaw === null ? null : parseIndex(indexRaw);
  const files = hasMemoryDir ? listMemoryFiles(dir) : [];
  const memories = files.map((file) => loadMemory(dir, file)).filter(Boolean);

  const indexedFiles = index ? index.indexedFiles : new Set();
  const referencedFiles = index ? index.referencedFiles : new Set();
  const resolve = buildResolver(memories);

  // Outbound edges first, then inbound derived from them, so the two can never
  // disagree.
  const inbound = new Map(memories.map((m) => [m.file, []]));
  const danglingWikilinks = [];
  const edges = [];

  for (const memory of memories) {
    memory.outboundResolved = [];
    for (const target of memory.outbound) {
      const targetFile = resolve(target);
      if (targetFile && targetFile !== memory.file) {
        memory.outboundResolved.push({ target, file: targetFile });
        edges.push({ from: memory.file, to: targetFile });
        inbound.get(targetFile).push({ from: memory.file, target });
      } else if (!targetFile) {
        memory.outboundResolved.push({ target, file: null });
        danglingWikilinks.push({ from: memory.file, fromName: memory.name, target });
      }
    }
  }

  for (const memory of memories) {
    memory.ageDays = ageInDays(memory.modified);
    memory.inbound = inbound.get(memory.file) || [];
    memory.entry = index ? index.entries.find((e) => e.file === memory.file) || null : null;
    memory.section = memory.entry ? memory.entry.section : null;
    memory.status = indexedFiles.has(memory.file)
      ? 'indexed'
      : referencedFiles.has(memory.file)
        ? 'referenced'
        : 'orphan';
    memory.origin = provenance(memory, sessions.resolveOrigin);
  }

  const existingFiles = new Set(files);
  const danglingIndex = index
    ? index.links
        .filter((l) => !existingFiles.has(l.file))
        .map((l) => ({ index: l.index, file: l.file, label: l.label, text: l.text }))
    : [];

  const health = {
    orphans: memories.filter((m) => m.status === 'orphan').map((m) => m.file),
    referencedOnly: memories.filter((m) => m.status === 'referenced').map((m) => m.file),
    danglingIndex,
    danglingWikilinks,
    nameMismatches: memories
      .filter((m) => !m.nameMatchesFile)
      .map((m) => ({ file: m.file, name: m.name })),
    missingFrontmatter: memories.filter((m) => !m.hasFrontmatter).map((m) => m.file),
    longHooks: index ? indexStats(indexRaw, index.entries).longHooks : [],
  };
  // Must count every category the Health tab renders, or the badge disagrees
  // with the list underneath it.
  // One flat list is the single source of truth for both the badge and the tab.
  // Keeping a separate count in sync with what the UI renders failed twice: a
  // category counted but not rendered shows a badge over an empty tab.
  health.issues = [
    ...health.danglingIndex.map((entry) => ({ kind: 'dangling-index', severity: 'bad', entry })),
    ...health.danglingWikilinks.map((link) => ({ kind: 'dangling-wikilink', severity: 'bad', link })),
    ...health.orphans.map((file) => ({ kind: 'orphan', severity: 'warn', file })),
    ...health.referencedOnly.map((file) => ({ kind: 'referenced-only', severity: 'warn', file })),
    ...health.nameMismatches.map((mismatch) => ({ kind: 'name-mismatch', severity: 'warn', mismatch })),
    ...health.missingFrontmatter.map((file) => ({ kind: 'missing-frontmatter', severity: 'warn', file })),
    ...(health.longHooks.length
      ? [{ kind: 'long-hooks', severity: 'warn', count: health.longHooks.length, longest: health.longHooks[0] }]
      : []),
    ...memoryChecks(memories, index),
    ...sessionChecks(store, memories, sessions.retention, {
      remembered: sessions.remembered,
      resolveOrigin: sessions.resolveOrigin,
    }),
  ];
  health.issues.sort((a, b) => (a.severity === 'bad' ? 0 : 1) - (b.severity === 'bad' ? 0 : 1));
  health.issueCount = health.issues.length;
  health.severity = health.issues.some((item) => item.severity === 'bad')
    ? 'bad'
    : health.issues.length ? 'warn' : 'ok';

  return {
    ...store,
    hasMemoryDir,
    hasIndex: index !== null,
    index: index
      ? { raw: indexRaw, lines: index.parsedLines, entries: index.entries, inlineLinks: index.inlineLinks }
      : null,
    memories: memories.map(({ raw, ...rest }) => rest),
    graph: {
      nodes: memories.map((m) => ({
        id: m.file,
        label: m.name,
        type: m.type,
        status: m.status,
        degree: m.inbound.length + m.outboundResolved.filter((o) => o.file).length,
      })),
      edges,
      dangling: danglingWikilinks,
    },
    health,
    stats: {
      index: indexStats(indexRaw, index ? index.entries : []),
      memoryBytes: memories.reduce((sum, m) => sum + m.bytes, 0),
      memoryTokens: memories.reduce((sum, m) => sum + m.tokens, 0),
    },
    duplicates: findDuplicates(memories),
    trash: listTrash(dir),
    sessions: sessions.retention
      ? {
          count: sessions.retention.count,
          bytes: sessions.retention.bytes,
          retentionDays: sessions.retention.days,
          evidenceExpiresInDays: sessions.retention.evidenceExpiresInDays,
          expiringCount: sessions.retention.expiringCount,
          remembered: sessions.remembered,
        }
      : null,
  };
}

/**
 * The auto-memory store for one project. Everything the project model carries
 * beyond the store itself - its real path, the directories that feed it, whether
 * Claude is still writing to it - is resolved here and handed to buildStore.
 */
export function buildProject(root, slug) {
  const resolved = resolveProjectPath(path.join(root, slug), slug);
  return buildStore({
    slug,
    kind: 'auto',
    dir: memoryDir(root, slug),
    path: resolved.path,
    pathExists: resolved.exists,
    label: shortLabel(resolved.path),
    resolvedBy: resolved.resolvedBy,
    // The decode that could not be confirmed, offered as a starting point when
    // the user is asked to name the path themselves.
    guess: resolved.guess || null,
    workingDirs: resolved.workingDirs || [],
    // Off means this store will never grow again, which on disk looks exactly
    // like a project Claude has not learned anything about yet.
    autoMemory: autoMemoryState({ projectDir: resolved.exists ? resolved.path : null }),
  });
}

/** Restore records left behind by soft deletes, newest first. */
export function listTrash(dir) {
  const trashPath = path.join(dir, TRASH_DIR);
  let entries;
  try {
    entries = fs.readdirSync(trashPath);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith('.restore.json'))
    .map((name) => {
      const record = readIfExists(path.join(trashPath, name));
      if (!record) return null;
      try {
        const parsed = JSON.parse(record);
        // Records written before batching had a single trashedFile at the root.
        const entries = parsed.files?.length
          ? parsed.files
          : parsed.trashedFile
            ? [{ file: parsed.memoryFile, trashedFile: parsed.trashedFile }]
            : [];
        const backups = [
          ...entries.map((e) => e.trashedFile),
          parsed.indexTrashedFile,
          parsed.backupFile,
          parsed.indexBackupFile,
          ...(parsed.backups || []).map((b) => b.backupFile),
        ].filter(Boolean);
        return {
          ...parsed,
          kind: parsed.kind || 'memories',
          files: entries,
          label: parsed.label || parsed.name || parsed.memoryFile || parsed.id,
          recordFile: name,
          present: (backups.length > 0 || parsed.indexCreated === true)
            && backups.every((f) => fs.existsSync(path.join(trashPath, f))),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
}
