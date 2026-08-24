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
import path from 'node:path';
import { listAllAgents, MEMORY_SCOPES } from './agents.mjs';
import { canonicalPath, configDir, configPath, DEFAULT_CONFIG_DIR_NAME } from './config.mjs';
import { listProjects, memoryDir, projectsRoot, shortLabel } from './projects.mjs';
import { autoMemoryState } from './settings.mjs';

export const AGENT_USER_DIR = configPath('agent-memory');
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
  // Keyed on the canonical form: Windows and a default macOS volume are
  // case-insensitive, so two spellings of one repository are one repository and
  // would otherwise contribute the same agent store twice.
  const seen = new Set();
  for (const projectPath of projectPaths) {
    if (!projectPath || !path.isAbsolute(projectPath)) continue;
    const key = canonicalPath(projectPath);
    if (seen.has(key)) continue;
    seen.add(key);
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

/**
 * Join each subagent store to the definition that asks for it.
 *
 * A store directory on its own says nothing about whether a session still loads
 * it: the `memory:` field in an agent file is what creates one, and that field
 * can be changed to another scope or removed entirely without the directory it
 * created ever going away. So the store is annotated with what the definitions
 * actually say, and the cleanup checks in src/checks.mjs read those annotations
 * rather than re-deriving them.
 *
 * The one rule that outranks all of it: subagent memory is part of auto memory,
 * so when auto memory is off the `memory:` field has no effect at all - the
 * agent launches with no memory instructions and no file tools, and every store
 * on the machine is frozen where it stands.
 */
export function linkAgentStores(stores, agents, { autoMemory = null } = {}) {
  const byName = new Map();
  for (const agent of agents || []) {
    const key = agent.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(agent);
  }

  return stores.map((store) => {
    if (!store.kind.startsWith('agent-')) return store;

    const candidates = (byName.get(store.agentName.toLowerCase()) || []).filter((agent) => {
      // A project-scope definition only speaks for stores in its own repository.
      if (agent.scope !== 'project' || !store.projectPath) return true;
      return canonicalPath(agent.projectPath) === canonicalPath(store.projectPath);
    });

    const declaring = candidates.find((agent) => MEMORY_SCOPES[agent.memory] === store.kind) || null;
    const other = declaring ? null : candidates.find((agent) => agent.memory) || null;
    const inert = autoMemory ? autoMemory.enabled === false : false;

    return {
      ...store,
      // Marks that the join actually ran. A store that was never linked knows
      // nothing about its definitions, and "nothing is declared" and "nobody
      // asked" have to stay distinguishable or the checks below report an
      // orphan every time a caller builds a store on its own.
      linkage: true,
      declaredBy: declaring ? declaring.file : other ? other.file : null,
      declaredScope: declaring ? declaring.memory : other ? other.memory : null,
      declaringScope: declaring ? declaring.scope : other ? other.scope : null,
      defined: candidates.length > 0,
      linked: Boolean(declaring),
      inert,
      inertBy: inert ? autoMemory.setBy : null,
    };
  });
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
function globalStore(dir) {
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
 * The config directory is a parameter because the global entry is about where
 * Claude Code keeps its own files rather than about the memory root, which
 * --root can point somewhere else entirely. `home` is the older spelling of the
 * same idea and still accepted, since a home directory names exactly one config
 * directory when CLAUDE_CONFIG_DIR is not set.
 */
export function listStores(root = projectsRoot(), { home = null, dir = null, agents = null } = {}) {
  const global = dir || (home ? path.join(home, DEFAULT_CONFIG_DIR_NAME) : configDir());
  const projects = listProjects(root);
  const projectPaths = projects
    .filter((project) => project.pathExists)
    .flatMap((project) => [project.path, ...(project.workingDirs || [])]);

  const agentStores = listAgentStores({ projectPaths });
  const definitions = agents || listAllAgents({ projectPaths });

  return [
    globalStore(global),
    ...projects.map((project) => autoStore(project, root)),
    ...linkAgentStores(agentStores, definitions, { autoMemory: autoMemoryState() }),
  ];
}

/** Resolve an id against the discovered list, so only real stores are ever addressed. */
export function findStore(root, id) {
  return listStores(root).find((store) => store.id === id) || null;
}
