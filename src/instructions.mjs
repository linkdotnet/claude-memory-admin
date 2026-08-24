// What Claude Code actually loads as instructions when a session starts in a
// directory: the CLAUDE.md chain, the files those import, and `.claude/rules/`.
//
// This is the other half of the startup context. MEMORY.md has a hard limit and
// this side does not, but the two are spent from the same budget, and the rules
// that decide which files load are fiddly enough that people are routinely
// surprised. Everything here is READ ONLY.
//
// The resolution is a re-derivation of documented behaviour, not a report from
// Claude Code itself. Where a rule is subtle - imports inside code spans do not
// count, a `paths:` glob with an unbalanced bracket matches nothing - the
// subtlety is implemented rather than smoothed over, because smoothing over it
// would hide exactly the problem this is meant to surface.

import fs from 'node:fs';
import path from 'node:path';
import { canonicalPath, configDir, DEFAULT_CONFIG_DIR_NAME, expandHome, toPosix } from './config.mjs';
import { parseFrontmatter } from './parse.mjs';
import { estimateTokens } from './stats.mjs';
import { lookup, settingsLayers } from './settings.mjs';
import { instructionChecks } from './checks.mjs';

/** Claude Code's own guidance for a CLAUDE.md. Guidance, not a cutoff. */
export const CLAUDE_MD_TARGET_LINES = 200;

/** An import chain deeper than this is not followed. */
export const MAX_IMPORT_DEPTH = 4;

/** A rule's whole `paths:` list shares this budget of expanded patterns. */
export const BRACE_PATTERN_BUDGET = 1000;

export const INSTRUCTION_SEVERITY = {
  missing: 'bad',
  'invalid-glob': 'bad',
  'glob-budget': 'bad',
  cycle: 'warn',
  'too-deep': 'warn',
  external: 'warn',
  'long-claude-md': 'warn',
  'agents-md-not-imported': 'warn',
  'unreferenced-user-file': 'warn',
  'duplicate-load': 'warn',
  'empty-instruction-file': 'warn',
};

export function summarise(problems) {
  const list = problems || [];
  return {
    count: list.length,
    severity: list.some((problem) => INSTRUCTION_SEVERITY[problem.kind] === 'bad')
      ? 'bad'
      : list.length ? 'warn' : 'ok',
  };
}

function stampSeverity(resolved) {
  for (const problem of resolved.problems) {
    problem.severity = INSTRUCTION_SEVERITY[problem.kind] || 'warn';
  }
  resolved.problems.sort((a, b) => (a.severity === 'bad' ? 0 : 1) - (b.severity === 'bad' ? 0 : 1));
  return resolved;
}

function managedClaudeMd() {
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode/CLAUDE.md';
  if (process.platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\CLAUDE.md';
  return '/etc/claude-code/CLAUDE.md';
}

function readIfFile(file) {
  try {
    if (!fs.statSync(file).isFile()) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ imports */

/**
 * Blank out fenced code blocks and code spans, keeping the byte length so every
 * offset still lines up with the original.
 *
 * Import parsing skips both, which is the documented way to write `@README` in a
 * CLAUDE.md without importing it. Scanning the raw text instead would report
 * imports that never happen, and the file being wrong about its own examples is
 * worse than not checking.
 */
export function maskCode(text) {
  const blank = (match) => match.replace(/[^\n]/g, ' ');
  return text
    .replace(/^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1[ \t]*$/gm, blank)
    .replace(/`+[^`\n]*`+/g, blank);
}

// A bare @ that is part of an email address or an npm scope is not an import,
// so the character before it has to be a boundary.
const IMPORT = /(^|[\s(<'"])@((?:~\/|\.{0,2}\/)?[A-Za-z0-9._~\-][A-Za-z0-9._~\-/]*)/g;

/**
 * Drop the punctuation that ended the sentence rather than the path.
 *
 * A dot is legal in a filename and so is inside the match, which means an import
 * written at the end of a sentence - "conventions live in @extra.md." - swallows
 * the full stop and resolves to a file nobody has. The same goes for an ellipsis.
 * No path meaningfully ends in a dot, so a trailing run of them is prose.
 *
 * Nothing else can leak in: the only other punctuation the match accepts is
 * `-`, `_`, `~` and `/`, none of which ends an English sentence, and a trailing
 * slash is left alone because it says "directory", which is a real thing to have
 * written and a real thing for the import to fail on.
 */
function trimTrailingProse(spec) {
  return spec.replace(/\.+$/, '');
}

/** Every `@path` import in a file's text, with the offset it was found at. */
export function findImports(text) {
  const masked = maskCode(text);
  const found = [];
  for (const match of masked.matchAll(IMPORT)) {
    const end = match.index + match[0].length;
    // "@team@example.com" opens with something that looks exactly like an
    // import until the second @ arrives.
    if (masked[end] === '@') continue;
    const spec = trimTrailingProse(match[2]);
    // "@." and "@..." are punctuation with an @ in front, not a path.
    if (!spec) continue;
    found.push({ spec, index: match.index + match[1].length });
  }
  return found;
}

function resolveImport(spec, fromFile) {
  if (spec.startsWith('~/') || spec.startsWith('~\\')) return expandHome(spec);
  if (path.isAbsolute(spec)) return spec;
  // Relative to the file holding the import, not to the working directory.
  return path.resolve(path.dirname(fromFile), spec);
}

/**
 * Follow a file's imports, breadth-first, to the documented maximum depth.
 *
 * Returns every file reached and every import that did not work out. A cycle is
 * reported once and not followed, because a file importing itself back is a
 * mistake worth naming rather than a loop worth running.
 */
export function expandImports(rootFile, rootText, { projectDir = null } = {}) {
  const files = [];
  const problems = [];
  // Canonical keys: on a case-insensitive filesystem two spellings of one file
  // are one file, and a cycle spelled differently at each hop would otherwise
  // recurse until it hit the depth limit instead of being named as a cycle.
  const seen = new Set([canonicalPath(rootFile)]);
  let frontier = [{ file: rootFile, text: rootText, depth: 0 }];

  while (frontier.length) {
    const next = [];
    for (const current of frontier) {
      for (const { spec } of findImports(current.text)) {
        const resolved = resolveImport(spec, current.file);

        if (current.depth + 1 > MAX_IMPORT_DEPTH) {
          problems.push({ kind: 'too-deep', spec, from: current.file, file: resolved });
          continue;
        }
        if (seen.has(canonicalPath(resolved))) {
          problems.push({ kind: 'cycle', spec, from: current.file, file: resolved });
          continue;
        }

        const text = readIfFile(resolved);
        if (text === null) {
          problems.push({ kind: 'missing', spec, from: current.file, file: resolved });
          continue;
        }

        seen.add(canonicalPath(resolved));
        // An import resolving outside the project is the kind Claude Code asks
        // you to approve once; a declined one then stays silently disabled.
        const external = projectDir ? path.relative(projectDir, resolved).startsWith('..') : false;
        const entry = { file: resolved, text, depth: current.depth + 1, importedBy: current.file, external };
        files.push(entry);
        if (external) problems.push({ kind: 'external', spec, from: current.file, file: resolved });
        next.push(entry);
      }
    }
    frontier = next;
  }

  return { files, problems };
}

/* -------------------------------------------------------------------- globs */

/**
 * Check a `paths:` glob the way it will actually behave.
 *
 * Two documented failure modes make a rule silently inert, and both look
 * completely normal in the file:
 *   - a `[` that cannot be read as a bracket expression makes the pattern match
 *     nothing at all;
 *   - brace expansion past the budget makes the pattern get used unexpanded, so
 *     its literal braces match no file either.
 */
export function checkGlob(pattern) {
  let expansions = 1;
  for (const group of pattern.matchAll(/\{([^{}]*)\}/g)) {
    expansions *= group[1].split(',').length;
  }

  // Walk the pattern looking for a bracket expression that never closes.
  let open = -1;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '\\') { i += 1; continue; }
    if (pattern[i] === '[' && open === -1) open = i;
    else if (pattern[i] === ']' && open !== -1 && i > open + 1) open = -1;
  }

  if (open !== -1) {
    return { pattern, expansions, valid: false, reason: 'unclosed [ - glob syntax reads it as a bracket expression, so the pattern matches nothing' };
  }
  return { pattern, expansions, valid: true, reason: null };
}

/** Whether a rule's whole `paths:` list fits the shared expansion budget. */
export function checkGlobList(patterns) {
  const checks = patterns.map(checkGlob);
  // Patterns without braces do not count against the budget.
  const total = checks.reduce((sum, check) => sum + (check.expansions > 1 ? check.expansions : 0), 0);
  return {
    checks,
    expansions: total,
    overBudget: total > BRACE_PATTERN_BUDGET,
  };
}

/* -------------------------------------------------------------------- rules */

function listRuleFiles(dir, { depth = 8, seenReal = new Set() } = {}) {
  let real;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return [];
  }
  // Symlinked rule directories are supported, and circular ones must not hang.
  if (seenReal.has(real) || depth < 0) return [];
  seenReal.add(real);

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    let stat;
    try {
      stat = fs.statSync(full); // follows symlinks, which is the point
    } catch {
      continue;
    }
    if (stat.isDirectory()) out.push(...listRuleFiles(full, { depth: depth - 1, seenReal }));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function unquote(value) {
  const trimmed = value.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (trimmed.length >= 2 && ((first === '"' && last === '"') || (first === "'" && last === "'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * The `paths:` patterns of a rule, read straight from the frontmatter block.
 *
 * The frontmatter reader shared with memory files models scalars and one level
 * of nesting, which is everything memory frontmatter uses and not a YAML list.
 * Rather than widen a parser the whole app depends on, the one construct rules
 * need is read here.
 */
export function readPathsList(frontmatterRaw) {
  const patterns = [];
  let inPaths = false;

  for (const line of frontmatterRaw.split('\n')) {
    const key = line.match(/^([A-Za-z0-9_.\-]+):[ \t]*(.*)$/);
    if (key) {
      inPaths = key[1] === 'paths';
      if (!inPaths) continue;
      const value = key[2].trim();
      if (value.startsWith('[') && value.endsWith(']')) {
        for (const part of value.slice(1, -1).split(',')) {
          const pattern = unquote(part);
          if (pattern) patterns.push(pattern);
        }
        inPaths = false;
      } else if (value) {
        patterns.push(unquote(value));
        inPaths = false;
      }
      continue;
    }
    if (!inPaths) continue;
    const item = line.match(/^[ \t]*-[ \t]+(.*)$/);
    if (item) {
      const pattern = unquote(item[1]);
      if (pattern) patterns.push(pattern);
    }
  }
  return patterns;
}

function ruleEntry(file, scope) {
  const text = readIfFile(file);
  if (text === null) return null;
  const { raw } = parseFrontmatter(text);
  const patterns = readPathsList(raw);

  return {
    file,
    scope,
    kind: 'rule',
    text,
    conditional: patterns.length > 0,
    globs: patterns.length ? checkGlobList(patterns) : null,
  };
}

/* ------------------------------------------------------------------ loading */

function entry(file, scope, kind, { conditional = false } = {}) {
  const text = readIfFile(file);
  return text === null ? null : { file, scope, kind, text, conditional, globs: null };
}

/** Directories from the filesystem root down to `dir`, in load order. */
/**
 * Every directory from the filesystem root down to `dir`, root last.
 *
 * Walked with dirname rather than by splitting on the separator, because the
 * separator alone does not describe a root: a Windows path starts at `C:\` and
 * a UNC path at `\\server\share`, and splitting either of those produces
 * candidates that name nothing.
 */
function ancestors(dir) {
  const out = [];
  let current = path.resolve(dir);
  while (true) {
    out.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out.reverse();
}

export function globToRegExp(pattern, platform = process.platform) {
  // Only used for claudeMdExcludes, which matches absolute paths. Glob syntax
  // knows one separator, so a Windows path has to be compared in its forward
  // slash form or every pattern silently matches nothing - and on the two
  // case-insensitive platforms the comparison has to ignore case for the same
  // reason a path does.
  const flags = platform === 'win32' || platform === 'darwin' ? 'i' : '';
  pattern = toPosix(pattern);
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') { out += '.*'; i += 1; if (pattern[i + 1] === '/') i += 1; }
      else out += '[^/]*';
    } else if (char === '?') out += '[^/]';
    else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, flags);
}

/**
 * Managed policy and user scope: what loads whichever project a session starts in.
 *
 * `home` is a parameter rather than a read of the config directory so this is a total
 * function of where it is told to look, which is what makes it testable without a
 * real home directory.
 */
/**
 * The user-scope directory: normally the config directory, which
 * CLAUDE_CONFIG_DIR may have moved off the home directory entirely. A `home`
 * passed in names its own, which is what lets the tests point the user scope at
 * a fixture.
 */
function userDir(home) {
  return home ? path.join(home, DEFAULT_CONFIG_DIR_NAME) : configDir();
}

function userCandidates(home, layers) {
  const candidates = [entry(managedClaudeMd(), 'managed', 'claude-md')];

  const managedInline = lookup(layers, 'claudeMd');
  const inline = typeof managedInline?.value === 'string' && managedInline.value.trim()
    && (managedInline.scope === 'managed')
    ? { file: managedInline.file, scope: 'managed', kind: 'managed-settings', text: managedInline.value, conditional: false, globs: null }
    : null;
  if (inline) candidates.push(inline);

  const dir = userDir(home);
  candidates.push(entry(path.join(dir, 'CLAUDE.md'), 'user', 'claude-md'));
  for (const file of listRuleFiles(path.join(dir, 'rules'))) {
    candidates.push(ruleEntry(file, 'user'));
  }
  return candidates;
}

/** Root-to-cwd, CLAUDE.md then CLAUDE.local.md at each level, then the project's own .claude. */
function projectCandidates(projectDir) {
  const candidates = [];
  for (const dir of ancestors(projectDir)) {
    candidates.push(entry(path.join(dir, 'CLAUDE.md'), 'project', 'claude-md'));
    candidates.push(entry(path.join(dir, 'CLAUDE.local.md'), 'local', 'claude-md'));
  }
  candidates.push(entry(path.join(projectDir, '.claude', 'CLAUDE.md'), 'project', 'claude-md'));
  for (const file of listRuleFiles(path.join(projectDir, '.claude', 'rules'))) {
    candidates.push(ruleEntry(file, 'project'));
  }
  return candidates;
}

function readExcludes(layers) {
  const found = lookup(layers, 'claudeMdExcludes');
  return Array.isArray(found?.value) ? found.value.map(String) : [];
}

/**
 * Turn a candidate list into the resolved set: excludes applied, imports expanded,
 * every file measured and every problem named.
 *
 * Both entry points go through here, so the whole-session view and the user-scope
 * one cannot drift apart in what they count or what they consider broken.
 */
function finalize(candidates, { projectDir, excludes }) {
  const matchers = excludes.map((pattern) => globToRegExp(pattern));
  const excluded = [];
  const loaded = [];
  const problems = [];

  for (const candidate of candidates.filter(Boolean)) {
    // Managed policy cannot be excluded; that is the point of managed policy.
    if (candidate.scope !== 'managed' && matchers.some((re) => re.test(toPosix(candidate.file)))) {
      excluded.push(candidate.file);
      continue;
    }
    loaded.push(candidate);

    if (candidate.kind === 'managed-settings') continue;
    const expanded = expandImports(candidate.file, candidate.text, { projectDir });
    problems.push(...expanded.problems.map((p) => ({ ...p, scope: candidate.scope })));
    for (const imported of expanded.files) {
      loaded.push({
        file: imported.file,
        scope: candidate.scope,
        kind: 'import',
        text: imported.text,
        conditional: candidate.conditional,
        globs: null,
        importedBy: imported.importedBy,
        depth: imported.depth,
        external: imported.external,
      });
    }
  }

  for (const item of loaded) {
    item.lines = item.text.split('\n').length;
    item.bytes = Buffer.byteLength(item.text, 'utf8');
    item.tokens = estimateTokens(item.text);
    if (item.globs && !item.globs.checks.every((c) => c.valid)) {
      for (const check of item.globs.checks.filter((c) => !c.valid)) {
        problems.push({ kind: 'invalid-glob', file: item.file, scope: item.scope, pattern: check.pattern, reason: check.reason });
      }
    }
    if (item.globs?.overBudget) {
      problems.push({ kind: 'glob-budget', file: item.file, scope: item.scope, expansions: item.globs.expansions });
    }
    if (item.kind === 'claude-md' && item.lines > CLAUDE_MD_TARGET_LINES) {
      problems.push({ kind: 'long-claude-md', file: item.file, scope: item.scope, lines: item.lines });
    }
  }

  problems.push(...instructionChecks(loaded));

  const unconditional = loaded.filter((item) => !item.conditional);
  return {
    projectDir,
    files: loaded,
    excluded,
    problems,
    totals: {
      files: loaded.length,
      // Conditional rules only load when Claude reads a matching file, so they
      // are counted apart from what every session pays for.
      alwaysLines: unconditional.reduce((sum, item) => sum + item.lines, 0),
      alwaysBytes: unconditional.reduce((sum, item) => sum + item.bytes, 0),
      alwaysTokens: unconditional.reduce((sum, item) => sum + item.tokens, 0),
      conditionalFiles: loaded.length - unconditional.length,
      conditionalTokens: loaded.filter((i) => i.conditional).reduce((sum, item) => sum + item.tokens, 0),
    },
  };
}

/**
 * Markdown files sitting in ~/.claude that nothing in the chain reaches.
 *
 * A file next to CLAUDE.md looks load-bearing, and stops being so the moment the
 * import that pulled it in is deleted or its content is inlined - which leaves
 * nothing behind to say so. This is the same failure the unimported AGENTS.md
 * check exists for, one directory up.
 *
 * Only the top level is read. The directories below it - plans, skills, projects,
 * backups - are full of markdown that was never meant to be an instruction file,
 * and walking into them would bury the one finding that matters.
 */
export function unreferencedUserFiles(home, loadedFiles) {
  const dir = userDir(home);
  // Imports arrive already absolutised by resolveImport while candidates are
  // joined from `home`, so both sides are resolved before they are compared.
  const loaded = new Set(loadedFiles.map((item) => path.resolve(item.file)));

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((item) => item.isFile() && item.name.endsWith('.md'))
    .map((item) => path.resolve(dir, item.name))
    .filter((file) => !loaded.has(file))
    .sort()
    .map((file) => ({ kind: 'unreferenced-user-file', file, scope: 'user' }));
}

/**
 * Everything that would load for a session started in `projectDir`, in the order
 * Claude Code loads it: broadest scope first, so the most specific instruction is
 * the last thing read.
 */
export function resolveInstructions(projectDir) {
  const layers = settingsLayers({ projectDir });
  const candidates = [
    ...userCandidates(null, layers),
    ...projectCandidates(projectDir),
  ];
  const resolved = finalize(candidates, { projectDir, excludes: readExcludes(layers) });

  // AGENTS.md is read by other tools, not by Claude Code, so one sitting next to
  // an unrelated CLAUDE.md is a real and easy-to-miss divergence.
  const agentsFile = path.join(projectDir, 'AGENTS.md');
  if (fs.existsSync(agentsFile) && !resolved.files.some((item) => item.file === agentsFile)) {
    resolved.problems.push({ kind: 'agents-md-not-imported', file: agentsFile, scope: 'project' });
  }

  return stampSeverity(resolved);
}

/**
 * The user scope on its own: what every session on this machine pays for before a
 * project is even chosen.
 *
 * This is the half of the chain no project owns, so it has nowhere else to be
 * shown. Resolving it needs no project directory, which is what makes it visible
 * on a machine where no project path could be recovered from a transcript.
 *
 * With no project there is no boundary for an import to resolve outside of, so
 * nothing is marked external here - that check belongs to the whole-session view.
 */
export function resolveGlobalInstructions({ home = null, settingsFile = null } = {}) {
  const layers = settingsLayers(settingsFile ? { settingsFile } : {});
  const resolved = finalize(userCandidates(home, layers), { projectDir: null, excludes: readExcludes(layers) });
  resolved.problems.push(...unreferencedUserFiles(home, resolved.files));
  return stampSeverity(resolved);
}
