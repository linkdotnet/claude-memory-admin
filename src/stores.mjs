// Discovery of every memory store on the machine, of both kinds Claude Code
// keeps.
//
// Auto memory is one store per project under the projects root. Subagents with a
// `memory:` field in their frontmatter get their own directories as well, in one
// of three scopes, and those hold exactly the same thing: a MEMORY.md index, a
// topic file per memory, the same 200-line/25KB load limit and the same
// instruction to keep the index short. So they are the same object here, and
// everything downstream - parsing, the meter, the graph, health, prune, trash -
// works on them without knowing which kind it has.
//
// The project-scoped agent directories live inside repositories, which this tool
// only knows about because it already recovers each project's real path from the
// session transcripts. Nothing here guesses at a path that was not confirmed
// somewhere else first.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listProjects, memoryDir, projectsRoot, shortLabel } from './projects.mjs';

export const AGENT_USER_DIR = path.join(os.homedir(), '.claude', 'agent-memory');
export const AGENT_PROJECT_DIR = path.join('.claude', 'agent-memory');
export const AGENT_LOCAL_DIR = path.join('.claude', 'agent-memory-local');

export const STORE_KINDS = {
  global: { label: 'Global', scope: 'user' },
  auto: { label: 'Project', scope: null },
  'agent-user': { label: 'Subagent', scope: 'user' },
  'agent-project': { label: 'Subagent', scope: 'project' },
  'agent-local': { label: 'Subagent', scope: 'local' },
};

/**
 * A store id is opaque and URL-safe, and is only ever handed back to us from a
 * list we produced. Encoding the kind and the location keeps it stable across
 * restarts without a registry file to keep in sync.
 */
function storeId(kind, key) {
  return `${kind}:${Buffer.from(key, 'utf8').toString('base64url')}`;
}

function agentDirs(parent) {
  let entries;
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('.'))
    .sort();
}

/** Files in a store directory, excluding the index and the trash folder. */
function countMemories(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'MEMORY.md')
      .length;
  } catch {
    return 0;
  }
}

function agentStore(kind, agentName, dir, projectPath = null) {
  return {
    id: storeId(kind, dir),
    kind,
    dir,
    agentName,
    projectPath,
    label: agentName,
    // Which repository a project- or local-scoped agent store belongs to; the
    // same agent can have a different memory in every checkout.
    sublabel: projectPath ? shortLabel(projectPath) : 'all projects',
    memoryCount: countMemories(dir),
    hasMemoryDir: true,
    hasIndex: fs.existsSync(path.join(dir, 'MEMORY.md')),
  };
}

/**
 * Subagent memory directories, across all three scopes. Both roots are
 * parameters rather than constants so this is a total function of where it is
 * told to look, which is also what makes it testable without a real home dir.
 */
export function listAgentStores({ userDir = AGENT_USER_DIR, projectPaths = [] } = {}) {
  const stores = [];

  for (const name of agentDirs(userDir)) {
    stores.push(agentStore('agent-user', name, path.join(userDir, name)));
  }

  // A repository can be reached through more than one project entry (a worktree
  // and its root), so the same directory must not be listed twice.
  const seen = new Set();
  for (const projectPath of projectPaths) {
    if (!projectPath || !path.isAbsolute(projectPath) || seen.has(projectPath)) continue;
    seen.add(projectPath);
    for (const [kind, relative] of [['agent-project', AGENT_PROJECT_DIR], ['agent-local', AGENT_LOCAL_DIR]]) {
      const parent = path.join(projectPath, relative);
      for (const name of agentDirs(parent)) {
        stores.push(agentStore(kind, name, path.join(parent, name), projectPath));
      }
    }
  }

  return stores.sort((a, b) => b.memoryCount - a.memoryCount
    || a.label.localeCompare(b.label)
    || a.sublabel.localeCompare(b.sublabel));
}

/** An auto-memory project, in the shape the rest of the app expects of a store. */
function autoStore(project, root) {
  return {
    ...project,
    id: storeId('auto', project.slug),
    kind: 'auto',
    dir: memoryDir(root, project.slug),
    sublabel: null,
  };
}

/**
 * The user scope, in the shape of a store so it can be selected like one.
 *
 * It holds no memory: ~/.claude is where the instructions live, not a MEMORY.md
 * index and topic files. It is listed anyway because it is the one thing every
 * session on the machine loads, and until now it had nowhere to be seen. Leaving
 * `hasMemoryDir` false is what keeps it out of full-text search, which skips
 * stores without one, and out of everything else that reads memory files.
 */
function globalStore(home) {
  const dir = path.join(home, '.claude');
  return {
    id: storeId('global', dir),
    kind: 'global',
    dir,
    path: dir,
    label: 'Global',
    sublabel: 'user scope',
    memoryCount: 0,
    hasMemoryDir: false,
    hasIndex: false,
    pathExists: fs.existsSync(dir),
  };
}

/**
 * Every store, the user scope first and auto memory after it. Agent stores are
 * found under the project paths auto memory already resolved, so a repository this
 * tool has never seen a session for contributes nothing.
 *
 * `home` is a parameter because the global entry is about the real home directory
 * rather than the memory root, which --root can point somewhere else entirely.
 */
export function listStores(root = projectsRoot(), { home = os.homedir() } = {}) {
  const projects = listProjects(root);
  const projectPaths = projects
    .filter((project) => project.pathExists)
    .flatMap((project) => [project.path, ...(project.workingDirs || [])]);

  return [
    globalStore(home),
    ...projects.map((project) => autoStore(project, root)),
    ...listAgentStores({ projectPaths }),
  ];
}

/** Resolve an id against the discovered list, so only real stores are ever addressed. */
export function findStore(root, id) {
  return listStores(root).find((store) => store.id === id) || null;
}
