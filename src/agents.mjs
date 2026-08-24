// Subagent definitions: agents/*.md, in the user scope and in each repository.
//
// Not to be confused with agent-memory (src/stores.mjs), which is what those
// agents *remember*. This module is about what they *are*: a markdown file whose
// frontmatter names the agent and, optionally, pins the model and effort it runs
// at, and declares with `memory:` whether it keeps a memory directory at all.
// That last field is the link between the two: a store exists because some file
// here asked for it, and a store no file asks for any more is a store nothing
// loads. Pinning a summariser to Haiku while a reviewer stays on Opus is the
// finer-grained version of the CLAUDE_CODE_SUBAGENT_MODEL switch in src/cost.mjs,
// which - worth remembering when both are set - outranks everything here.
//
// Only `model` and `effort` are writable. The prompt body, the tool lists and
// every other field are read and shown but never rewritten: a body is prose
// somebody wrote on purpose, and this tool has no view on it.

import fs from 'node:fs';
import path from 'node:path';

import { canonicalPath, configPath } from './config.mjs';
import { parseFrontmatter } from './parse.mjs';
import { writeFileAtomic } from './mutate.mjs';

export const AGENTS_DIR = configPath('agents');
export const PROJECT_AGENTS_DIR = path.join('.claude', 'agents');

/** The scopes `memory:` accepts, and the store kind each one produces. */
export const MEMORY_SCOPES = {
  user: 'agent-user',
  project: 'agent-project',
  local: 'agent-local',
};

const MODEL_ID = /^claude-[A-Za-z0-9._[\]-]+$/;

export const AGENT_FIELDS = {
  model: {
    unset: 'inherit',
    allowModelId: true,
    options: [
      { value: null, label: 'inherit', note: 'the session model' },
      { value: 'haiku', label: 'haiku' },
      { value: 'sonnet', label: 'sonnet' },
      { value: 'opus', label: 'opus' },
      { value: 'fable', label: 'fable' },
    ],
  },
  effort: {
    unset: 'default',
    allowModelId: false,
    options: [
      { value: null, label: 'default', note: 'the session effort' },
      { value: 'low', label: 'low' },
      { value: 'medium', label: 'medium' },
      { value: 'high', label: 'high' },
      { value: 'xhigh', label: 'xhigh' },
      { value: 'max', label: 'max' },
    ],
  },
};

export const AGENT_PROBLEM_SEVERITY = {
  'no-frontmatter': 'bad',
  'missing-name': 'warn',
  'missing-description': 'warn',
  'name-mismatch': 'warn',
  'unknown-model': 'warn',
  'unknown-effort': 'warn',
  'unknown-memory-scope': 'warn',
};

function known(field, value) {
  const spec = AGENT_FIELDS[field];
  if (spec.options.some((option) => option.value === value)) return true;
  return spec.allowModelId && MODEL_ID.test(value);
}

/**
 * A filename this module is willing to touch, resolved inside the agents
 * directory. The same shape as safeMemoryPath in src/mutate.mjs: a bare .md
 * basename, no dotfiles, and a realpath check so a symlink cannot point the
 * write somewhere else.
 */
export function safeAgentPath(dir, file) {
  if (typeof file !== 'string' || !file || file.includes('\0')) {
    throw new Error('Invalid filename');
  }
  if (file !== path.basename(file) || file.startsWith('.') || !file.endsWith('.md')) {
    throw new Error(`Refusing to touch "${file}": must be a plain .md filename`);
  }

  const full = path.join(dir, file);
  const rel = path.relative(dir, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path escapes the agents directory');
  }
  if (fs.existsSync(full)) {
    const realDir = fs.realpathSync(dir);
    const realFull = fs.realpathSync(full);
    if (path.relative(realDir, realFull).startsWith('..')) {
      throw new Error('Path escapes the agents directory');
    }
  }
  return full;
}

function describeAgent(dir, file, { scope = 'user', writable = true, projectPath = null } = {}) {
  const full = path.join(dir, file);
  const stem = path.basename(file).replace(/\.md$/, '');

  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch (err) {
    return {
      file,
      scope,
      writable: false,
      projectPath,
      name: stem,
      description: '',
      tools: '',
      model: null,
      effort: null,
      memory: null,
      bytes: 0,
      problems: [{ kind: 'no-frontmatter', severity: 'bad', detail: err.message }],
    };
  }

  const { data, hasFrontmatter } = parseFrontmatter(text);
  const scalar = (key) => (typeof data[key] === 'string' ? data[key].trim() : '');
  const name = scalar('name') || stem;
  const model = scalar('model') || null;
  const effort = scalar('effort') || null;
  const memory = scalar('memory') || null;

  const problems = [];
  const flag = (kind, detail) => problems.push({ kind, severity: AGENT_PROBLEM_SEVERITY[kind], detail });

  if (!hasFrontmatter) {
    flag('no-frontmatter', 'The file has no --- frontmatter block, so Claude Code does not read it as an agent definition.');
  } else {
    if (!scalar('name')) flag('missing-name', `No name: field, so the agent is addressed as "${stem}" after its file.`);
    if (!scalar('description')) flag('missing-description', 'No description: field. Claude decides when to delegate from that description, so an agent without one is never chosen on its own.');
    if (scalar('name') && scalar('name') !== stem) flag('name-mismatch', `Named "${scalar('name')}" in a file called "${file}".`);
    if (model && !known('model', model)) flag('unknown-model', `model: ${model} is neither an alias nor a claude- model name.`);
    if (effort && !known('effort', effort)) flag('unknown-effort', `effort: ${effort} is not one of low, medium, high, xhigh or max.`);
    if (memory && !Object.prototype.hasOwnProperty.call(MEMORY_SCOPES, memory)) {
      flag('unknown-memory-scope', `memory: ${memory} is not one of user, project or local, so this agent keeps no memory directory.`);
    }
  }

  return {
    file,
    scope,
    // Only a plain .md at the top of the user directory is rewritable: writes go
    // through safeAgentPath, which takes a bare basename, and nothing here has
    // any business editing a file inside somebody's repository.
    writable: writable && file === path.basename(file),
    projectPath,
    name,
    description: scalar('description'),
    tools: scalar('tools'),
    model,
    effort,
    memory: memory && Object.prototype.hasOwnProperty.call(MEMORY_SCOPES, memory) ? memory : null,
    memoryRaw: memory,
    bytes: Buffer.byteLength(text, 'utf8'),
    problems,
  };
}

/**
 * Every .md under an agents directory, including the subfolders people use to
 * group them. Claude Code scans both agent roots recursively and identifies an
 * agent by its `name` rather than by where the file sits, so a scan that stopped
 * at the top level would miss agents that are running.
 */
function agentFiles(dir, prefix = '', depth = 0) {
  if (depth > 4) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...agentFiles(path.join(dir, entry.name), rel, depth + 1));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(rel);
  }
  return files;
}

/**
 * Every user-scope agent definition. A directory that is not there is the
 * ordinary state of a machine whose owner has never written one, not a failure,
 * so it answers with an empty list.
 */
export function listAgents({ dir = AGENTS_DIR } = {}) {
  return agentFiles(dir)
    .map((file) => describeAgent(dir, file, { scope: 'user', writable: true }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Project-scope definitions, from <repo>/.claude/agents. These are read and
 * never written: they belong to a repository somebody else may share, and an
 * agent with `memory: project` is normally defined here rather than in the user
 * scope, so leaving them out would orphan the very stores this exists to explain.
 */
export function listProjectAgents(projectPath, { relative = PROJECT_AGENTS_DIR } = {}) {
  if (!projectPath || !path.isAbsolute(projectPath)) return [];
  const dir = path.join(projectPath, relative);
  return agentFiles(dir)
    .map((file) => describeAgent(dir, file, { scope: 'project', writable: false, projectPath }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Every definition on the machine this tool can see: user scope plus each repository. */
export function listAllAgents({ dir = AGENTS_DIR, projectPaths = [] } = {}) {
  const agents = listAgents({ dir });
  const seen = new Set();
  for (const projectPath of projectPaths) {
    const key = canonicalPath(projectPath || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    agents.push(...listProjectAgents(projectPath));
  }
  return agents;
}

/** Whether the directory itself exists, which is what tells an empty list from a missing one. */
export function agentsDirExists({ dir = AGENTS_DIR } = {}) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

const fieldLine = (field) => new RegExp(`^${field}[ \\t]*:`);

/**
 * Where a field that is not there yet should go: straight after the name or
 * description when that line carries its value inline, and otherwise at the end
 * of the block. Appending is always valid - a top-level key ends whatever nested
 * block preceded it - so the nicer placement is only taken when it is provably
 * safe, which rules out a folded or block scalar the insertion would land inside.
 */
function inlineScalarAt(block, key) {
  const index = block.findIndex((line) => fieldLine(key).test(line));
  if (index === -1) return -1;
  const rest = block[index].slice(block[index].indexOf(':') + 1).trim();
  if (!rest || rest.startsWith('|') || rest.startsWith('>')) return -1;
  return index;
}

function insertionIndex(block) {
  const description = block.findIndex((line) => fieldLine('description').test(line));
  const inline = inlineScalarAt(block, 'description');
  if (inline !== -1) return inline + 1;
  if (description !== -1) return block.length;

  const name = inlineScalarAt(block, 'name');
  return name === -1 ? block.length : name + 1;
}

/**
 * Rewrite one frontmatter field, leaving every other byte of the file alone:
 * the body, the other fields, their order, their spacing and any comments among
 * them. The same principle src/parse.mjs applies to MEMORY.md - edit the line
 * that changed, never re-emit the document from a parse of it.
 */
export function rewriteAgentField(text, field, value) {
  // Rejoin with whatever the file already used. A checkout on Windows is CRLF
  // throughout, and splitting on \n then rejoining with it would leave every
  // line this function did not touch ending \r\n and the one it did ending \n.
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    throw new Error('This file has no frontmatter block, so there is nothing to set.');
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) {
    throw new Error('This file has an unterminated frontmatter block.');
  }

  const block = lines.slice(1, end);
  const at = block.findIndex((line) => fieldLine(field).test(line));

  if (value === null) {
    if (at === -1) return text;
    block.splice(at, 1);
  } else if (at === -1) {
    block.splice(insertionIndex(block), 0, `${field}: ${value}`);
  } else {
    block[at] = `${field}: ${value}`;
  }

  return [lines[0], ...block, ...lines.slice(end)].join(eol);
}

function normaliseAgentValue(field, value) {
  const spec = AGENT_FIELDS[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`${field} takes a string, not ${typeof value}.`);

  const trimmed = value.trim();
  if (!trimmed || trimmed === spec.unset) return null;
  if (known(field, trimmed)) return trimmed;

  throw new Error(`"${trimmed}" is not a value ${field} accepts.`);
}

/**
 * Set or clear `model` or `effort` on one agent file, atomically, and answer with
 * the refreshed list so the caller renders what is on disk rather than what it
 * hoped it wrote.
 */
export function setAgentField(file, field, value, { dir = AGENTS_DIR } = {}) {
  if (!Object.prototype.hasOwnProperty.call(AGENT_FIELDS, field)) {
    throw new Error(`"${field}" is not a field this tool writes. Only model and effort are editable here.`);
  }

  const full = safeAgentPath(dir, file);
  if (!fs.existsSync(full)) throw new Error(`${file} is no longer there - reload and try again.`);

  const next = normaliseAgentValue(field, value);
  const original = fs.readFileSync(full, 'utf8');
  const rewritten = rewriteAgentField(original, field, next);

  if (rewritten !== original) writeFileAtomic(dir, file, rewritten);

  return listAgents({ dir });
}
