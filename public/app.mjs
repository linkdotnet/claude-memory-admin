import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import { renderGraph } from '/graph.mjs';

marked.setOptions({ gfm: true, breaks: false });

const state = {
  stores: [],
  storeId: null,
  store: null,
  tab: 'memories',
  selected: null,
  showAll: false,
  collapsed: localStorage.getItem('sidebarCollapsed') === '1',
  spread: Number(localStorage.getItem('graphSpread')) || 1.6,
  query: '',
  search: null,
  pruneSort: 'oldest',
  pruneSelection: new Set(),
};

const el = (id) => document.getElementById(id);

/* ---------------------------------------------------------------- helpers */

async function api(path, options) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const data = await response.json().catch(() => ({ error: 'Bad response from server' }));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function toast(message, { error = false, action } = {}) {
  const node = document.createElement('div');
  node.className = `toast${error ? ' err' : ''}`;
  node.append(document.createTextNode(message));
  if (action) {
    const button = document.createElement('button');
    button.textContent = action.label;
    button.onclick = () => { node.remove(); action.run(); };
    node.append(button);
  }
  el('toast-root').append(node);
  setTimeout(() => node.remove(), action ? 12000 : 4500);
}

function node(tag, props = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key.startsWith('on')) element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== null && value !== undefined) element.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child) element.append(child);
  }
  return element;
}

/**
 * Render a memory body. Wikilinks are swapped for placeholders before markdown
 * runs, then rehydrated as buttons afterwards, so they survive sanitising and
 * can carry click handlers.
 */
function renderBody(container, memory, project) {
  const byName = new Map();
  for (const other of project.memories) {
    byName.set(other.name, other.file);
    byName.set(other.stem, other.file);
  }

  const tokens = [];
  const withPlaceholders = memory.body.replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, target, alias) => {
    const key = `%%WIKI${tokens.length}%%`;
    tokens.push({ target: target.trim(), alias: (alias || '').trim() });
    return key;
  });

  const html = DOMPurify.sanitize(marked.parse(withPlaceholders));
  container.innerHTML = html;

  if (!tokens.length) return;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walker.nextNode()) texts.push(walker.currentNode);

  for (const textNode of texts) {
    if (!/%%WIKI\d+%%/.test(textNode.nodeValue)) continue;
    const fragment = document.createDocumentFragment();
    const parts = textNode.nodeValue.split(/(%%WIKI\d+%%)/);
    for (const part of parts) {
      const match = part.match(/^%%WIKI(\d+)%%$/);
      if (!match) {
        if (part) fragment.append(document.createTextNode(part));
        continue;
      }
      const token = tokens[Number(match[1])];
      const targetFile = byName.get(token.target);
      const button = node('button', {
        class: `wikilink${targetFile ? '' : ' dangling'}`,
        text: token.alias || token.target,
        title: targetFile ? `Go to ${token.target}` : `No memory named "${token.target}"`,
      });
      if (targetFile) button.onclick = () => selectMemory(targetFile);
      fragment.append(button);
    }
    textNode.replaceWith(fragment);
  }
}

/* --------------------------------------------------------------- sidebar */

/** The second line under a store's name: where it lives, in its own terms. */
function storeSubtitle(store) {
  if (store.kind === 'auto') return store.path;
  const scope = store.kind === 'agent-user' ? 'user'
    : store.kind === 'agent-project' ? 'project' : 'local';
  return `${scope} · ${store.sublabel}`;
}

function storeButton(store) {
  const health = store.memoryCount === 0 ? 'none' : 'ok';
  const off = store.autoMemory && store.autoMemory.known && !store.autoMemory.enabled;
  return node('button', {
    class: `project${store.id === state.storeId ? ' active' : ''}${store.hasMemoryDir ? '' : ' dim'}`,
    onclick: () => openStore(store.id),
    title: store.kind === 'auto' && store.resolvedBy === 'unresolved'
      ? 'Real path could not be resolved - showing the raw folder name'
      : store.dir,
  }, [
    node('span', { class: 'project-row' }, [
      node('span', { class: `dot ${health}` }),
      node('span', { class: 'project-name', text: store.label }),
      off ? node('span', { class: 'off-marker', text: 'off', title: 'Auto memory is disabled for this project' }) : null,
      node('span', { class: 'project-count', text: store.hasMemoryDir ? String(store.memoryCount) : '-' }),
    ]),
    node('span', { class: 'project-path', text: storeSubtitle(store) }),
  ]);
}

function renderStores() {
  const list = el('project-list');
  list.textContent = '';

  const visible = state.stores.filter((s) => state.showAll || s.hasMemoryDir);
  if (!visible.length) {
    list.append(node('p', { class: 'muted', text: 'No memory stores found.', style: 'padding:12px' }));
    return;
  }

  // Subagent memory is a different thing from a project's auto memory - a
  // different scope, written by a different agent - so it gets its own group
  // rather than being mixed into the project list.
  const groups = [
    ['Projects', visible.filter((s) => s.kind === 'auto')],
    ['Subagents', visible.filter((s) => s.kind !== 'auto')],
  ];

  for (const [title, stores] of groups) {
    if (!stores.length) continue;
    // With nothing to tell apart, a single heading is just noise.
    if (groups.every(([, group]) => group.length) ) {
      list.append(node('div', { class: 'sidebar-group', text: title }));
    }
    for (const store of stores) list.append(storeButton(store));
  }
}

/* ------------------------------------------------------------------ tabs */

const TABS = [
  { id: 'memories', label: 'Memories' },
  { id: 'index', label: 'MEMORY.md' },
  { id: 'graph', label: 'Graph' },
  { id: 'prune', label: 'Prune' },
  { id: 'context', label: 'Context' },
  { id: 'health', label: 'Health' },
  { id: 'trash', label: 'Trash' },
];

function renderTabs() {
  const container = el('tabs');
  container.textContent = '';
  const hasProjectDir = state.store.kind === 'auto'
    ? state.store.resolvedBy !== 'unresolved'
    : Boolean(state.store.projectPath);

  for (const tab of TABS) {
    if (tab.id === 'context' && !hasProjectDir) continue;
    let badge = null;
    if (tab.id === 'memories') badge = String(state.store.memories.length);
    if (tab.id === 'health' && state.store.health.issueCount) badge = String(state.store.health.issueCount);
    if (tab.id === 'trash' && state.store.trash.length) badge = String(state.store.trash.length);
    if (tab.id === 'prune' && state.store.stats.index.overTarget) badge = '!';

    container.append(node('button', {
      class: `tab${state.tab === tab.id ? ' active' : ''}`,
      onclick: () => { state.tab = tab.id; renderTabs(); renderTab(); },
    }, [
      document.createTextNode(tab.label),
      badge ? node('span', { class: `badge${tab.id === 'health' || tab.id === 'prune' ? ' warn' : ''}`, text: badge }) : null,
    ]));
  }
}

/* -------------------------------------------------------------- memories */

function memoryButton(memory) {
  return node('button', {
    class: `mem${state.selected === memory.file ? ' active' : ''}`,
    onclick: () => selectMemory(memory.file),
  }, [
    node('span', { class: 'mem-top' }, [
      node('span', { class: 'mem-name', text: memory.name }),
      node('span', { class: `badge type-${memory.type}`, text: memory.type }),
      memory.status !== 'indexed'
        ? node('span', { class: `badge status-${memory.status}`, text: memory.status })
        : null,
    ]),
    memory.description ? node('span', { class: 'mem-desc', text: memory.description }) : null,
  ]);
}

function renderMemories(container) {
  const project = state.store;
  if (!project.memories.length) {
    container.append(node('p', { class: 'muted', text: 'This project has no memory files yet.' }));
    return;
  }

  const left = node('div');
  // Group by the MEMORY.md heading each entry sits under, so the list mirrors
  // how the index is actually organised.
  const groups = new Map();
  for (const memory of project.memories) {
    const key = memory.section || (memory.status === 'indexed' ? 'Index' : 'Not in the index');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(memory);
  }
  for (const [section, memories] of groups) {
    left.append(node('div', { class: 'section-label', text: `${section} · ${memories.length}` }));
    for (const memory of memories) left.append(memoryButton(memory));
  }

  const right = node('div', { id: 'detail' });
  container.append(node('div', { class: 'split' }, [left, right]));
  renderDetail();
}

function renderDetail() {
  const host = el('detail');
  if (!host) return;
  host.textContent = '';

  const memory = state.store.memories.find((m) => m.file === state.selected);
  if (!memory) {
    host.append(node('p', { class: 'muted', text: 'Select a memory to read it.' }));
    return;
  }

  const card = node('div', { class: 'card' });
  card.append(node('div', { class: 'detail-head' }, [
    node('h3', { text: memory.name }),
    node('span', { class: `badge type-${memory.type}`, text: memory.type }),
    node('button', {
      class: 'btn danger small',
      text: 'Delete',
      onclick: () => openDeleteDialog(memory.file),
    }),
  ]));

  if (memory.description) card.append(node('p', { class: 'detail-desc', text: memory.description }));

  const meta = node('dl', { class: 'meta' });
  const rows = [
    ['file', memory.file],
    ['status', memory.status],
    ['modified', memory.modified
      // mtime is reset by any copy or restore, so a date that is only a file
      // timestamp is weaker evidence than one Claude Code actually stamped.
      ? `${memory.modified.replace('T', ' ').replace(/\..*$/, '')}${memory.modifiedFrom === 'mtime' ? '  (file mtime)' : ''}`
      : '-'],
    ['size', `${(memory.bytes / 1024).toFixed(1)} KB`],
  ];
  if (!memory.nameMatchesFile) rows.push(['name', `${memory.name}  (differs from filename)`]);
  for (const [key, value] of Object.entries(memory.metadata)) {
    if (key !== 'type' && key !== 'modified') rows.push([key, value]);
  }
  for (const [key, value] of rows) {
    meta.append(node('dt', { text: key }), node('dd', { text: String(value) }));
  }
  card.append(meta);

  const body = node('div', { class: 'body' });
  card.append(body);
  renderBody(body, memory, state.store);

  const outbound = memory.outboundResolved || [];
  if (outbound.length || memory.inbound.length) {
    const links = node('div', { style: 'margin-top:20px;border-top:1px solid var(--border);padding-top:14px' });
    if (outbound.length) {
      links.append(node('div', { class: 'section-label', text: 'Links out' }));
      const chips = node('div', { class: 'links' });
      for (const link of outbound) {
        chips.append(node('button', {
          class: `chip${link.file ? '' : ' dead'}`,
          text: link.file ? link.target : `${link.target} (missing)`,
          onclick: link.file ? () => selectMemory(link.file) : null,
        }));
      }
      links.append(chips);
    }
    if (memory.inbound.length) {
      links.append(node('div', { class: 'section-label', text: 'Linked from' }));
      const chips = node('div', { class: 'links' });
      for (const link of memory.inbound) {
        const source = state.store.memories.find((m) => m.file === link.from);
        chips.append(node('button', {
          class: 'chip',
          text: source ? source.name : link.from,
          onclick: () => selectMemory(link.from),
        }));
      }
      links.append(chips);
    }
    card.append(links);
  }

  host.append(card);
}

/* ----------------------------------------------------------- MEMORY.md */

function renderIndex(container) {
  const project = state.store;
  if (!project.hasIndex) {
    container.append(node('p', { class: 'muted', text: 'This project has no MEMORY.md.' }));
    return;
  }

  const missing = new Set(project.health.danglingIndex.map((d) => d.index));
  const { cutoff } = project.stats.index;
  const card = node('div', { class: 'card' });
  card.append(node('p', { class: 'muted', style: 'margin-top:0', text: `${project.index.entries.length} index entries · ${project.index.lines.length} lines` }));

  for (const line of project.index.lines) {
    // The cutoff is a raw line number, so it lands in the right place even
    // though frontmatter and comments are stripped before the limit is measured.
    if (cutoff && line.index === cutoff.rawLine) {
      card.append(node('div', { class: 'cut-line' }, [
        node('span', { class: 'cut-label', text: `not loaded past here — ${cutoff.droppedLines} lines dropped on ${cutoff.by}` }),
      ]));
    }
    const row = node('div', {
      class: `index-line kind-${line.kind}${missing.has(line.index) ? ' dangling' : ''}${cutoff && line.index >= cutoff.rawLine ? ' beyond-cut' : ''}`,
    }, [
      node('span', { class: 'ln', text: String(line.index + 1) }),
      node('span', { class: 'content', text: line.text || ' ' }),
    ]);
    if (line.kind === 'index' && !missing.has(line.index)) {
      row.querySelector('.content').onclick = () => selectMemory(line.file);
    }
    card.append(row);
  }
  container.append(card);
}


/* ------------------------------------------------------------- context */

const SCOPE_ORDER = ['managed', 'user', 'project', 'local'];

const CONTEXT_PROBLEMS = {
  missing: (p) => ['Import does not resolve', `${p.spec} from ${p.from} - nothing at ${p.file}`],
  'too-deep': (p) => ['Import chain is too deep', `${p.file} is a fifth hop; Claude Code follows four, so this never loads`],
  cycle: (p) => ['Circular import', `${p.from} imports ${p.file}, which was already loaded`],
  external: (p) => ['Import resolves outside the project', `${p.file} - Claude Code asks you to approve these once, and a declined one stays disabled silently`],
  'invalid-glob': (p) => [`Rule matches nothing: ${p.pattern}`, `${p.file} - ${p.reason}`],
  'glob-budget': (p) => ['Rule has too many brace expansions', `${p.file} expands to ${p.expansions} patterns, past the 1,000 budget, so it is used unexpanded and its literal braces match no file`],
  'long-claude-md': (p) => [`${p.lines} lines, over the 200-line guidance`, `${p.file} - long files cost context every session and reduce adherence`],
  'agents-md-not-imported': (p) => ['AGENTS.md is not loaded', `${p.file} exists, but Claude Code reads CLAUDE.md. Import it with @AGENTS.md, or symlink it.`],
};

async function renderContext(container) {
  container.append(node('p', { class: 'muted', text: 'Reading instruction files…' }));
  let data;
  try {
    data = await api(`/api/stores/${encodeURIComponent(state.storeId)}/instructions`);
  } catch (err) {
    container.textContent = '';
    return container.append(node('p', { class: 'muted', text: err.message }));
  }
  // The tab may have been switched while the request was in flight.
  if (state.tab !== 'context') return;
  container.textContent = '';

  if (!data.projectDir) {
    return container.append(node('p', { class: 'muted', text: 'This store is not tied to a project directory, so there are no instruction files to resolve.' }));
  }

  const { totals } = data;
  container.append(node('div', { class: 'meter' }, [
    node('div', { class: 'meter-top' }, [
      node('span', { class: 'meter-value', text: `~${totals.alwaysTokens.toLocaleString()}` }),
      node('span', { class: 'meter-unit', text: 'estimated tokens of instructions, every session' }),
    ]),
    node('div', { class: 'meter-facts' }, [
      node('span', {}, [node('b', { text: String(totals.files) }), document.createTextNode(' files resolved')]),
      node('span', {}, [node('b', { text: String(totals.alwaysLines) }), document.createTextNode(' lines always loaded')]),
      node('span', {}, [node('b', { text: `${(totals.alwaysBytes / 1024).toFixed(1)} KB` }), document.createTextNode(' always loaded')]),
      node('span', {}, [node('b', { text: String(totals.conditionalFiles) }), document.createTextNode(' path-scoped rules, loaded only on a match')]),
    ]),
    node('p', { class: 'meter-note', text: 'Unlike MEMORY.md, none of this is truncated: CLAUDE.md files load in full however long they are. The 200-line figure is Claude Code’s guidance, not a cutoff, because long files cost context every session and are followed less reliably.' }),
  ]));

  if (data.problems.length) {
    container.append(node('div', { class: 'section-label', text: `Problems · ${data.problems.length}` }));
    for (const problem of data.problems) {
      const describe = CONTEXT_PROBLEMS[problem.kind];
      const [title, detail] = describe ? describe(problem) : [problem.kind, problem.file || ''];
      const bad = problem.kind === 'missing' || problem.kind === 'invalid-glob' || problem.kind === 'glob-budget';
      container.append(node('div', { class: `issue${bad ? ' bad' : ''}` }, [
        node('div', { class: 'issue-body' }, [
          node('div', { class: 'issue-title', text: title }),
          node('div', { class: 'issue-detail', text: detail }),
        ]),
      ]));
    }
  }

  container.append(node('div', { class: 'section-label', text: `Loaded in this order · ${data.files.length}` }));
  const card = node('div', { class: 'card' });
  for (const file of data.files) {
    const tags = [node('span', { class: `badge scope-${file.scope}`, text: file.scope })];
    if (file.kind === 'import') tags.push(node('span', { class: 'badge', text: `import · depth ${file.depth}` }));
    if (file.kind === 'rule') tags.push(node('span', { class: 'badge', text: 'rule' }));
    if (file.kind === 'managed-settings') tags.push(node('span', { class: 'badge', text: 'claudeMd setting' }));
    if (file.conditional) tags.push(node('span', { class: 'badge status-referenced', text: 'only on a path match' }));

    card.append(node('div', { class: 'ctx-row' }, [
      node('div', { class: 'ctx-main' }, [
        node('div', { class: 'ctx-tags' }, tags),
        node('div', { class: 'ctx-file', text: file.file }),
      ]),
      node('div', { class: 'ctx-size', text: `${file.lines} L · ~${file.tokens.toLocaleString()} tok` }),
    ]));
  }
  container.append(card);

  if (data.excluded.length) {
    container.append(node('div', { class: 'section-label', text: `Excluded by claudeMdExcludes · ${data.excluded.length}` }));
    for (const file of data.excluded) {
      container.append(node('div', { class: 'issue' }, [
        node('div', { class: 'issue-body' }, [node('div', { class: 'issue-detail', text: file })]),
      ]));
    }
  }

  container.append(node('p', { class: 'meter-note', text: 'This is re-derived from the documented resolution rules, not a report from Claude Code. Run /context in a session to see what it actually loaded.' }));
}

/* -------------------------------------------------------------- health */

function issue(title, detail, { bad = false, action, secondary } = {}) {
  return node('div', { class: `issue${bad ? ' bad' : ''}` }, [
    node('div', { class: 'issue-body' }, [
      node('div', { class: 'issue-title', text: title }),
      node('div', { class: 'issue-detail', text: detail }),
    ]),
    secondary ? node('button', { class: 'btn small', text: secondary.label, onclick: secondary.run }) : null,
    action ? node('button', { class: 'btn small', text: action.label, onclick: action.run }) : null,
  ]);
}

function renderHealth(container) {
  const { health, memories } = state.store;
  if (!health.issues.length) {
    container.append(node('div', { class: 'card' }, [
      node('p', { style: 'margin:0', text: '\u2713 No consistency problems found.' }),
      node('p', { class: 'muted', style: 'margin:6px 0 0;font-size:13px', text: 'Every memory file is referenced by MEMORY.md, every pointer resolves, and every [[wikilink]] finds its target.' }),
    ]));
    return;
  }

  // Rendered straight from health.issues so the tab and the badge always agree.
  for (const item of health.issues) {
    container.append(renderIssue(item, memories));
  }
}

function renderIssue(item, memories) {
  const bad = item.severity === 'bad';

  if (item.kind === 'dangling-index') {
    const { entry } = item;
    return issue(
      `MEMORY.md points at a file that does not exist: ${entry.file}`,
      `line ${entry.index + 1}: ${entry.text}`,
      {
        bad,
        action: {
          label: 'Remove pointer',
          run: async () => {
            if (!confirm(`Remove line ${entry.index + 1} from MEMORY.md?\n\n${entry.text}`)) return;
            try {
              await api(`/api/stores/${encodeURIComponent(state.storeId)}/index-line/delete`, {
                method: 'POST',
                body: JSON.stringify({ lineIndex: entry.index, expectedText: entry.text }),
              });
              toast('Pointer removed');
              await openStore(state.storeId, { keepTab: true });
            } catch (err) {
              toast(err.message, { error: true });
            }
          },
        },
      },
    );
  }

  if (item.kind === 'dangling-wikilink') {
    const { link } = item;
    return issue(
      `Broken [[${link.target}]]`,
      `referenced from ${link.from} - no memory has that name`,
      {
        bad,
        secondary: { label: 'Open source', run: () => selectMemory(link.from) },
        action: {
          label: 'Remove link',
          run: async () => {
            if (!confirm(`Remove [[${link.target}]] from ${link.from}?\n\nThe link markup goes, the words stay:\n  "see [[${link.target}]]"  ->  "see ${link.target}"\n\nA copy of the file is kept in the trash, so this can be undone.`)) return;
            try {
              const result = await api(`/api/stores/${encodeURIComponent(state.storeId)}/wikilink/remove`, {
                method: 'POST',
                body: JSON.stringify({ file: link.from, target: link.target }),
              });
              await openStore(state.storeId, { keepTab: true });
              toast(`Unlinked ${result.occurrences} reference(s)`, {
                action: { label: 'Undo', run: () => restoreFromTrash(result.record.id) },
              });
            } catch (err) {
              toast(err.message, { error: true });
            }
          },
        },
      },
    );
  }

  if (item.kind === 'orphan') {
    const memory = memories.find((m) => m.file === item.file);
    return issue(
      `Not referenced anywhere in MEMORY.md: ${item.file}`,
      `"${memory?.name || item.file}" exists on disk but nothing points to it, so Claude will not load it.`,
      { bad, action: { label: 'Open', run: () => selectMemory(item.file) } },
    );
  }

  if (item.kind === 'referenced-only') {
    const memory = memories.find((m) => m.file === item.file);
    return issue(
      `Linked mid-sentence, not indexed: ${item.file}`,
      `"${memory?.name || item.file}" is mentioned inside prose in MEMORY.md but has no index bullet of its own.`,
      { bad, action: { label: 'Open', run: () => selectMemory(item.file) } },
    );
  }

  if (item.kind === 'name-mismatch') {
    return issue(
      `Frontmatter name differs from filename: ${item.mismatch.file}`,
      `name: "${item.mismatch.name}" - [[wikilinks]] must use this name, not the filename.`,
      { bad, action: { label: 'Open', run: () => selectMemory(item.mismatch.file) } },
    );
  }

  if (item.kind === 'missing-frontmatter') {
    return issue(
      `No YAML frontmatter: ${item.file}`,
      'Type and description cannot be read from this file.',
      { bad, action: { label: 'Open', run: () => selectMemory(item.file) } },
    );
  }

  if (item.kind === 'long-hooks') {
    return issue(
      `${item.count} index hook${item.count === 1 ? '' : 's'} over 200 characters`,
      `longest is ${item.longest.hookLength} chars on "${item.longest.title}" - hooks load every session, so these are the cheapest thing to trim.`,
      {
        bad,
        action: {
          label: 'Open Prune',
          run: () => { state.tab = 'prune'; renderTabs(); renderTab(); },
        },
      },
    );
  }

  return issue(item.kind, JSON.stringify(item));
}

async function restoreFromTrash(id) {
  try {
    const result = await api(`/api/stores/${encodeURIComponent(state.storeId)}/restore`, {
      method: 'POST',
      body: JSON.stringify({ id }),
    });
    await openStore(state.storeId, { keepTab: true });
    toast(result.indexRestored === 'appended'
      ? 'Restored, but MEMORY.md had changed - the index line was appended at the end'
      : 'Restored');
  } catch (err) {
    toast(err.message, { error: true });
  }
}

/* --------------------------------------------------------------- trash */

function renderTrash(container) {
  const trash = state.store.trash;
  if (!trash.length) {
    container.append(node('p', { class: 'muted', text: 'Nothing in the trash. Deleted memories land here and can be restored.' }));
    return;
  }
  for (const record of trash) {
    const when = String(record.deletedAt).replace('T', ' ').replace(/\..*$/, '');
    const detail = record.kind === 'wikilink'
      ? `unlinked in ${record.sourceFile} · ${when}`
      : `${record.files.length} file(s)${record.indexTrashedFile ? ' + MEMORY.md' : ''} · ${when} · ${record.removedLines?.length || 0} index line(s) removed`;
    container.append(node('div', { class: `issue${record.present ? '' : ' bad'}` }, [
      node('div', { class: 'issue-body' }, [
        node('div', { class: 'issue-title', text: record.label || record.id }),
        node('div', { class: 'issue-detail', text: record.present ? detail : `${detail}, backup missing, cannot restore` }),
      ]),
      record.present
        ? node('button', { class: 'btn small primary', text: 'Restore', onclick: () => restoreFromTrash(record.id) })
        : null,
    ]));
  }
}

/* -------------------------------------------------------- delete dialog */

function closeModal() {
  el('modal-root').textContent = '';
}

async function openDeleteDialog(file) {
  let preview;
  try {
    preview = await api(`/api/stores/${encodeURIComponent(state.storeId)}/delete-preview`, {
      method: 'POST',
      body: JSON.stringify({ file }),
    });
  } catch (err) {
    return toast(err.message, { error: true });
  }

  const body = node('div', { class: 'modal-body' });

  const removals = node('div', { class: 'will' }, [node('div', { class: 'will-title', text: 'Will be removed' })]);
  removals.append(node('div', { class: 'will-item remove', text: `memory/${preview.file}  →  memory/.trash/` }));
  for (const line of [...preview.indexLines, ...preview.continuations]) {
    removals.append(node('div', { class: 'will-item remove', text: `MEMORY.md line ${line.index + 1}:  ${line.text}` }));
  }
  if (!preview.indexLines.length && preview.hasIndex) {
    removals.append(node('div', { class: 'will-item', text: 'MEMORY.md has no index bullet for this file - nothing to unlink there.' }));
  }
  body.append(removals);

  if (preview.inlineRefs.length) {
    const kept = node('div', { class: 'will' }, [node('div', { class: 'will-title', text: 'Left untouched - mentioned inside prose, so you may want to fix these by hand' })]);
    for (const ref of preview.inlineRefs) {
      kept.append(node('div', { class: 'will-item keep', text: `MEMORY.md line ${ref.index + 1}:  ${ref.text}` }));
    }
    body.append(kept);
  }

  // Memories that link here can be deleted in the same operation. Ticking one
  // is the common follow-up, so it lives in the dialog rather than forcing a
  // second pass through the list.
  const cascade = new Set();
  if (preview.inboundWikilinks.length) {
    const block = node('div', { class: 'will' });
    const head = node('div', { class: 'cascade-head' }, [
      node('div', { class: 'will-title', style: 'margin:0', text: `${preview.inboundWikilinks.length} memory(s) link here and will break` }),
      node('button', { class: 'link-btn', text: 'select all' }),
    ]);
    block.append(head);

    const list = node('div', { class: 'cascade' });
    const rows = [];
    for (const link of preview.inboundWikilinks) {
      const box = node('input', { type: 'checkbox' });
      const row = node('label', { class: 'cascade-row' }, [
        box,
        node('span', { class: 'cascade-text' }, [
          node('span', { class: 'cascade-name', text: link.fromName || link.from }),
          node('span', { class: 'cascade-detail', text: link.indexLine
            ? `${link.from} · MEMORY.md line ${link.indexLine.index + 1}`
            : `${link.from} · not in the index` }),
        ]),
      ]);
      box.addEventListener('change', () => {
        row.classList.toggle('on', box.checked);
        if (box.checked) cascade.add(link.from);
        else cascade.delete(link.from);
        updateButton();
      });
      rows.push({ box, row });
      list.append(row);
    }
    block.append(list);
    block.append(node('p', { class: 'muted', style: 'margin:6px 0 0;font-size:12px', text: 'Tick any you also want deleted - they go to the trash together and restore as one step.' }));
    body.append(block);

    head.querySelector('.link-btn').onclick = (event) => {
      event.preventDefault();
      const turnOn = rows.some((r) => !r.box.checked);
      for (const { box } of rows) {
        if (box.checked !== turnOn) { box.checked = turnOn; box.dispatchEvent(new Event('change')); }
      }
      event.target.textContent = turnOn ? 'select none' : 'select all';
    };
  }

  body.append(node('p', { class: 'muted', style: 'margin:0;font-size:12.5px', text: 'The file moves to memory/.trash/ with a restore record, so this can be undone.' }));

  const modal = node('div', { class: 'modal' }, [
    node('header', {}, [
      node('h3', { text: `Delete "${preview.name || preview.file}"?` }),
      node('p', { class: 'muted', style: 'margin:0;font-size:13px', text: preview.description || '' }),
    ]),
    body,
    node('footer', {}, [
      node('button', { class: 'btn', text: 'Cancel', onclick: closeModal }),
      node('button', {
        class: 'btn danger',
        text: 'Delete',
        onclick: async () => {
          closeModal();
          try {
            const result = await api(`/api/stores/${encodeURIComponent(state.storeId)}/delete`, {
              method: 'POST',
              body: JSON.stringify({ file, alsoDelete: [...cascade] }),
            });
            if (state.selected === file || cascade.has(state.selected)) state.selected = null;
            await openStore(state.storeId, { keepTab: true });
            const count = result.record.files.length;
            toast(count > 1 ? `Deleted ${count} memories` : `Deleted "${result.record.label || file}"`, {
              action: { label: 'Undo', run: () => restoreFromTrash(result.record.id) },
            });
          } catch (err) {
            toast(err.message, { error: true });
          }
        },
      }),
    ]),
  ]);

  const backdrop = node('div', { class: 'modal-backdrop', onclick: (event) => { if (event.target === backdrop) closeModal(); } }, [modal]);
  el('modal-root').append(backdrop);
  updateButton();

  function updateButton() {
    const button = modal.querySelector('footer .btn.danger');
    if (button) button.textContent = cascade.size ? `Delete ${cascade.size + 1} memories` : 'Delete';
  }
}

/**
 * Name a store whose transcripts have aged out.
 *
 * Claude Code sweeps session transcripts on a retention period but keeps memory
 * forever, so the evidence that names a store expires while the store does not.
 * This is the only thing in the app that writes outside a memory directory, so
 * it happens only when asked for, and says so.
 */
function openRememberPathDialog() {
  const store = state.store;
  const input = node('input', {
    type: 'text',
    class: 'path-input',
    value: store.guess || '',
    placeholder: '/Users/you/repos/the-project',
    spellcheck: 'false',
  });

  const body = node('div', { class: 'modal-body' }, [
    node('p', { class: 'muted', style: 'margin-top:0', text: `The folder on disk is "${store.slug}", and its name is a lossy encoding of a path. No session transcript remains to recover the real one from, so tell it once and it will be used from now on.` }),
    input,
    node('p', { class: 'muted', style: 'margin-bottom:0;font-size:12.5px', text: 'Saved to ~/.claude-memory-admin/paths.json. That file records slugs and folder paths only, never memory content, and is the one thing this app writes outside a memory/ directory.' }),
  ]);

  const modal = node('div', { class: 'modal' }, [
    node('header', {}, [node('h3', { text: 'Remember this project\u2019s path' })]),
    body,
    node('footer', {}, [
      node('button', { class: 'btn', text: 'Cancel', onclick: closeModal }),
      node('button', {
        class: 'btn primary',
        text: 'Remember',
        onclick: async () => {
          const value = input.value.trim();
          if (!value) return;
          try {
            await api(`/api/stores/${encodeURIComponent(state.storeId)}/path/remember`, {
              method: 'POST',
              body: JSON.stringify({ path: value }),
            });
          } catch (err) {
            return toast(err.message, { error: true });
          }
          closeModal();
          await reloadStores();
          await openStore(state.storeId, { keepTab: true });
          toast(`Remembered ${value}`);
        },
      }),
    ]),
  ]);

  const backdrop = node('div', { class: 'modal-backdrop', onclick: (event) => { if (event.target === backdrop) closeModal(); } }, [modal]);
  el('modal-root').append(backdrop);
  input.focus();
  input.select();
}

async function forgetProjectPath() {
  try {
    await api(`/api/stores/${encodeURIComponent(state.storeId)}/path/forget`, { method: 'POST' });
  } catch (err) {
    return toast(err.message, { error: true });
  }
  await reloadStores();
  await openStore(state.storeId, { keepTab: true });
  toast('Forgot the remembered path');
}

async function openStoreDeleteDialog() {
  let preview;
  try {
    preview = await api(`/api/stores/${encodeURIComponent(state.storeId)}/project/delete-preview`, { method: 'POST' });
  } catch (err) {
    return toast(err.message, { error: true });
  }

  if (!preview.files.length && !preview.hasIndex) {
    return toast('This store has no memory to delete');
  }

  const body = node('div', { class: 'modal-body' });
  const removals = node('div', { class: 'will' }, [node('div', { class: 'will-title', text: 'Will be removed' })]);
  if (preview.hasIndex) {
    removals.append(node('div', { class: 'will-item remove', text: `MEMORY.md  (${preview.indexLines} lines)  →  memory/.trash/` }));
  }
  for (const entry of preview.files) {
    removals.append(node('div', { class: 'will-item remove', text: `${entry.file}  →  memory/.trash/` }));
  }
  body.append(removals);

  body.append(node('div', { class: 'will' }, [
    node('div', { class: 'will-title', text: 'Will be kept' }),
    node('div', { class: 'will-item keep', text: state.store.kind === 'auto'
      ? 'Session transcripts (*.jsonl) and the project folder itself'
      : 'The agent-memory folder itself, and every other agent\u2019s memory' }),
  ]));

  body.append(node('p', { class: 'muted', style: 'margin:0;font-size:12.5px', text: 'Everything moves to .trash/ inside the store as one restore point, so it can be put back in a single step from the Trash tab.' }));

  // A project-scoped agent store is committed, so this is a working-tree change.
  if (state.store.kind === 'agent-project') {
    body.append(node('p', { class: 'sub-warn', style: 'margin:8px 0 0', text: 'This store is checked into the repository. Deleting from it changes tracked files, and will show up in git status.' }));
  }

  const modal = node('div', { class: 'modal' }, [
    node('header', {}, [
      node('h3', { text: `Delete all memory for ${state.store.label}?` }),
      node('p', { class: 'muted', style: 'margin:0;font-size:13px', text: `${preview.files.length} memories${preview.hasIndex ? ' + MEMORY.md' : ''}` }),
    ]),
    body,
    node('footer', {}, [
      node('button', { class: 'btn', text: 'Cancel', onclick: closeModal }),
      node('button', {
        class: 'btn danger',
        text: `Delete ${preview.files.length + (preview.hasIndex ? 1 : 0)} files`,
        onclick: async () => {
          closeModal();
          try {
            const result = await api(`/api/stores/${encodeURIComponent(state.storeId)}/project/delete`, { method: 'POST' });
            state.selected = null;
            await openStore(state.storeId, { keepTab: true });
            toast(`Cleared ${state.store.label}`, {
              action: { label: 'Undo', run: () => restoreFromTrash(result.record.id) },
            });
          } catch (err) {
            toast(err.message, { error: true });
          }
        },
      }),
    ]),
  ]);

  const backdrop = node('div', { class: 'modal-backdrop', onclick: (event) => { if (event.target === backdrop) closeModal(); } }, [modal]);
  el('modal-root').append(backdrop);
}


/* --------------------------------------------------------------- prune */

function highlight(text, terms) {
  const wrapper = node('span');
  if (!terms.length) { wrapper.textContent = text; return wrapper; }
  const pattern = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig');
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) wrapper.append(document.createTextNode(text.slice(last, match.index)));
    wrapper.append(node('mark', { text: match[0] }));
    last = match.index + match[0].length;
  }
  if (last < text.length) wrapper.append(document.createTextNode(text.slice(last)));
  return wrapper;
}

function formatAge(days) {
  if (days === null || days === undefined) return 'undated';
  if (days < 1) return 'today';
  if (days < 31) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

const PRUNE_SORTS = {
  oldest: { label: 'oldest first', compare: (a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1) },
  largest: { label: 'largest first', compare: (a, b) => b.bytes - a.bytes },
  unlinked: { label: 'least linked', compare: (a, b) => a.inbound.length - b.inbound.length || (b.ageDays ?? 0) - (a.ageDays ?? 0) },
  name: { label: 'by name', compare: (a, b) => a.name.localeCompare(b.name) },
};

function renderBudget(container) {
  const { index } = state.store.stats;
  const percent = Math.min(100, index.worstPercent);
  const level = index.level === 'over' ? 'way-over' : index.level === 'near' ? 'over' : '';

  const note = index.level === 'over'
    ? 'Over the limit. Everything past the cutoff is dropped when the session loads it, so those entries are effectively invisible to Claude right now.'
    : index.level === 'near'
      ? 'Approaching the limit. Once MEMORY.md passes it, everything after the cutoff stops being loaded at all.'
      : 'Comfortably inside the limit. MEMORY.md is loaded at the start of every session.';

  if (index.cutoff) {
    const dropped = index.cutoff.droppedEntries;
    const box = node('div', { class: 'cut-summary' });
    box.append(node('div', { class: 'cut-summary-head', text: dropped.length
      ? `${dropped.length} ${dropped.length === 1 ? 'memory is' : 'memories are'} past the cutoff and not loaded`
      : `${index.cutoff.droppedLines} lines are past the cutoff and not loaded` }));
    box.append(node('p', { class: 'muted', text: `MEMORY.md stops loading at line ${index.cutoff.rawLine + 1}, bounded by ${index.cutoff.by}. Claude cannot see anything below it.` }));
    for (const entry of dropped.slice(0, 20)) {
      box.append(node('div', { class: 'issue' }, [
        node('div', { class: 'issue-body' }, [
          node('div', { class: 'issue-title', text: entry.title || entry.file }),
          node('div', { class: 'issue-detail', text: `MEMORY.md line ${entry.index + 1} · ${entry.file}` }),
        ]),
        node('button', { class: 'btn small', text: 'Open', onclick: () => selectMemory(entry.file) }),
      ]));
    }
    if (dropped.length > 20) {
      box.append(node('p', { class: 'muted', text: `${dropped.length - 20} more not listed.` }));
    }
    container.append(box);
  }

  container.append(node('div', { class: 'meter' }, [
    node('div', { class: 'meter-top' }, [
      node('span', { class: 'meter-value', text: `${Math.round(index.worstPercent)}%` }),
      node('span', { class: 'meter-unit', text: `of the MEMORY.md load limit, currently bounded by ${index.limitedBy}` }),
    ]),
    node('div', { class: 'meter-bar' }, [
      node('div', { class: `meter-fill ${level}`, style: `width:${percent.toFixed(1)}%` }),
    ]),
    node('p', { class: 'meter-note', text: note }),
    node('div', { class: 'meter-facts' }, [
      node('span', {}, [node('b', { text: `${index.lines} / ${index.lineLimit}` }), document.createTextNode(' lines')]),
      node('span', {}, [node('b', { text: `${(index.bytes / 1024).toFixed(1)} / ${index.byteLimit / 1024} KB` }), document.createTextNode(' loaded size')]),
      node('span', {}, [node('b', { text: String(index.entryCount) }), document.createTextNode(' index entries')]),
      node('span', {}, [node('b', { text: `~${index.tokens.toLocaleString()}` }), document.createTextNode(' tokens, every session')]),
    ]),
    node('p', { class: 'meter-note', style: 'margin-top:10px', text: 'Claude Code loads the first 200 lines or 25KB of MEMORY.md, whichever comes first, and drops the rest. Topic files are only read when Claude follows a link, so detail belongs in them and MEMORY.md should stay one line per entry.' }),
  ]));
}

function renderPrune(container) {
  const project = state.store;
  renderBudget(container);

  if (!project.memories.length) {
    container.append(node('p', { class: 'muted', text: 'Nothing to prune - this project has no memories.' }));
    return;
  }

  // --- bulk selection list ---
  const selected = state.pruneSelection;
  const bar = node('div', { class: 'prune-bar' });
  const sort = node('select');
  for (const [key, config] of Object.entries(PRUNE_SORTS)) {
    sort.append(node('option', { value: key, text: config.label, selected: key === state.pruneSort ? '' : null }));
  }
  sort.value = state.pruneSort;
  sort.onchange = () => { state.pruneSort = sort.value; renderTab(); };

  const count = node('span', { class: 'muted', style: 'font-size:12.5px' });
  const deleteButton = node('button', { class: 'btn danger small' });
  const clearButton = node('button', { class: 'btn small', text: 'Clear selection' });

  bar.append(node('span', { class: 'section-label', style: 'margin:0', text: 'Prune' }), sort, node('span', { class: 'spacer' }), count, clearButton, deleteButton);
  container.append(bar);

  const list = node('div');
  const ordered = [...project.memories].sort(PRUNE_SORTS[state.pruneSort].compare);
  const rows = [];
  for (const memory of ordered) {
    const box = node('input', { type: 'checkbox' });
    box.checked = selected.has(memory.file);
    const row = node('label', { class: `prune-row${box.checked ? ' on' : ''}` }, [
      box,
      node('span', { class: 'prune-main' }, [
        node('span', { class: 'prune-name', text: memory.name }),
        node('span', { class: 'prune-desc', text: memory.description || memory.file }),
      ]),
      node('span', { class: 'prune-facts' }, [
        node('span', { class: (memory.ageDays ?? 0) > 180 ? 'warn' : '', text: formatAge(memory.ageDays) }),
        node('span', { text: `${(memory.bytes / 1024).toFixed(1)}K` }),
        node('span', { class: memory.inbound.length ? '' : 'warn', text: `${memory.inbound.length} in` }),
        node('span', { class: memory.status === 'indexed' ? '' : 'warn', text: memory.status }),
      ]),
    ]);
    box.addEventListener('change', () => {
      if (box.checked) selected.add(memory.file); else selected.delete(memory.file);
      row.classList.toggle('on', box.checked);
      updateBar();
    });
    rows.push({ box, memory });
    list.append(row);
  }
  container.append(list);

  function updateBar() {
    count.textContent = selected.size ? `${selected.size} selected` : '';
    deleteButton.textContent = `Delete ${selected.size || ''}`.trim();
    deleteButton.disabled = selected.size === 0;
    deleteButton.style.opacity = selected.size ? '1' : '.45';
  }
  clearButton.onclick = () => {
    selected.clear();
    renderTab();
  };
  deleteButton.onclick = () => openBulkDeleteDialog([...selected]);
  updateBar();

  // --- long hooks ---
  const { longHooks } = project.stats.index;
  if (longHooks.length) {
    container.append(node('div', { class: 'section-label', text: `Long index hooks · ${longHooks.length}` }));
    container.append(node('p', { class: 'muted', style: 'margin:0 0 10px;font-size:12.5px', text: 'The hook is the text after the dash in MEMORY.md. It is loaded every session, so a 400-character hook costs more than the memory it points at. Shortening these is the cheapest win.' }));
    for (const hook of longHooks.slice(0, 12)) {
      container.append(node('div', { class: 'issue' }, [
        node('div', { class: 'issue-body' }, [
          node('div', { class: 'issue-title', text: `${hook.hookLength} chars: ${hook.title}` }),
          node('div', { class: 'issue-detail', text: `MEMORY.md line ${hook.index + 1} · ${hook.file}` }),
        ]),
        node('button', { class: 'btn small', text: 'Open', onclick: () => selectMemory(hook.file) }),
      ]));
    }
  }

  // --- possible overlap ---
  if (project.duplicates.length) {
    container.append(node('div', { class: 'section-label', text: `Possible overlap · ${project.duplicates.length}` }));
    container.append(node('p', { class: 'muted', style: 'margin:0 0 10px;font-size:12.5px', text: 'Ranked by how much rare vocabulary these pairs share. This is a hint, not a verdict - open both and decide whether one covers the other.' }));
    for (const pair of project.duplicates) {
      container.append(node('div', { class: 'dupe' }, [
        node('div', { class: 'dupe-head' }, [
          node('span', { class: 'dupe-score', text: `${pair.score}%` }),
          node('span', { text: `shared: ${pair.shared.join(', ')}` }),
        ]),
        node('div', { class: 'dupe-pair' }, [
          ...[pair.a, pair.b].map((side) => node('div', {
            class: 'dupe-side',
            onclick: () => selectMemory(side.file),
          }, [
            node('div', { class: 'n', text: side.name }),
            node('div', { class: 'd', text: side.description || side.file }),
          ])),
        ]),
      ]));
    }
  }
}

async function openBulkDeleteDialog(files) {
  if (!files.length) return;
  const memories = files.map((file) => state.store.memories.find((m) => m.file === file)).filter(Boolean);

  const body = node('div', { class: 'modal-body' });
  const removals = node('div', { class: 'will' }, [node('div', { class: 'will-title', text: `${memories.length} memories will be trashed` })]);
  for (const memory of memories) {
    removals.append(node('div', { class: 'will-item remove', text: `${memory.file}${memory.entry ? `  ·  MEMORY.md line ${memory.entry.index + 1}` : '  ·  not in the index'}` }));
  }
  body.append(removals);

  // Links from memories that are NOT being deleted are the ones that break.
  const doomed = new Set(files);
  const breaking = [];
  for (const memory of memories) {
    for (const link of memory.inbound) {
      if (!doomed.has(link.from)) breaking.push({ from: link.from, target: link.target });
    }
  }
  if (breaking.length) {
    const block = node('div', { class: 'will' }, [node('div', { class: 'will-title', text: `${breaking.length} link(s) from memories you are keeping will break` })]);
    for (const link of breaking) block.append(node('div', { class: 'will-item keep', text: `${link.from}  →  [[${link.target}]]` }));
    body.append(block);
  }

  body.append(node('p', { class: 'muted', style: 'margin:0;font-size:12.5px', text: 'All of them go to memory/.trash/ as one restore point.' }));

  const modal = node('div', { class: 'modal' }, [
    node('header', {}, [node('h3', { text: `Delete ${memories.length} memories?` })]),
    body,
    node('footer', {}, [
      node('button', { class: 'btn', text: 'Cancel', onclick: closeModal }),
      node('button', {
        class: 'btn danger',
        text: `Delete ${memories.length}`,
        onclick: async () => {
          closeModal();
          try {
            const result = await api(`/api/stores/${encodeURIComponent(state.storeId)}/delete-many`, {
              method: 'POST',
              body: JSON.stringify({ files, label: `${memories.length} pruned memories` }),
            });
            state.pruneSelection.clear();
            if (doomed.has(state.selected)) state.selected = null;
            await openStore(state.storeId, { keepTab: true });
            toast(`Deleted ${memories.length} memories`, {
              action: { label: 'Undo', run: () => restoreFromTrash(result.record.id) },
            });
          } catch (err) {
            toast(err.message, { error: true });
          }
        },
      }),
    ]),
  ]);
  const backdrop = node('div', { class: 'modal-backdrop', onclick: (event) => { if (event.target === backdrop) closeModal(); } }, [modal]);
  el('modal-root').append(backdrop);
}

/* -------------------------------------------------------------- search */

let searchTimer = null;

function scheduleSearch(value) {
  state.query = value;
  clearTimeout(searchTimer);
  if (!value.trim()) {
    state.search = null;
    renderView();
    return;
  }
  searchTimer = setTimeout(runSearch, 180);
}

async function runSearch() {
  const query = state.query.trim();
  if (!query) return;
  try {
    state.search = await api(`/api/search?q=${encodeURIComponent(query)}`);
  } catch (err) {
    return toast(err.message, { error: true });
  }
  renderView();
}

function renderSearch() {
  const data = state.search;
  const host = el('search-results');
  host.textContent = '';
  el('search-title').textContent = data.total
    ? `${data.total} result${data.total === 1 ? '' : 's'} for "${state.query.trim()}"`
    : `No results for "${state.query.trim()}"`;

  if (!data.total && !data.stores.length) {
    host.append(node('p', { class: 'muted', text: 'Nothing matched. Every word has to appear somewhere in a memory, so try fewer words.' }));
    return;
  }

  for (const group of data.stores) {
    const block = node('div', { class: 'result-group' });
    block.append(node('div', { class: 'section-label', text: group.sublabel
      ? `${group.label} · ${group.sublabel} · ${group.results.length}`
      : `${group.label} · ${group.results.length}` }));

    for (const result of group.results) {
      const button = node('button', {
        class: 'result',
        onclick: () => openFromSearch(group.id, result.file),
      });
      const top = node('div', { class: 'result-top' });
      const name = node('span', { class: 'result-name' });
      name.append(highlight(result.name, data.terms));
      top.append(name, node('span', { class: `badge type-${result.type}`, text: result.type }));
      if (result.status !== 'indexed') top.append(node('span', { class: `badge status-${result.status}`, text: result.status }));
      button.append(top);

      if (result.snippet) {
        const snippet = node('div', { class: 'result-snippet' });
        snippet.append(highlight(result.snippet.text, data.terms));
        button.append(snippet);
      }
      button.append(node('div', { class: 'result-where', text: `${result.file} · matched in ${result.fields.join(', ')}` }));
      block.append(button);
    }

    for (const hit of group.indexHits) {
      const button = node('button', {
        class: 'result',
        onclick: () => openFromSearch(group.id, hit.file, 'index'),
      });
      button.append(node('div', { class: 'result-where', text: `MEMORY.md line ${hit.index + 1}` }));
      const line = node('div', { class: 'result-snippet' });
      line.append(highlight(hit.text.trim(), data.terms));
      button.append(line);
      block.append(button);
    }
    host.append(block);
  }
}

async function openFromSearch(id, file, tab = 'memories') {
  clearSearch();
  if (id !== state.storeId) await openStore(id);
  state.tab = tab;
  if (file) state.selected = file;
  renderTabs();
  renderTab();
}

function clearSearch() {
  state.query = '';
  state.search = null;
  el('search').value = '';
  renderView();
}

function renderView() {
  const searching = state.search !== null;
  el('search-view').hidden = !searching;
  el('project-view').hidden = searching || !state.store;
  el('empty-state').hidden = searching || Boolean(state.store);
  if (searching) renderSearch();
}

/* ------------------------------------------------------------ rendering */

function renderTab() {
  const container = el('tab-content');
  container.textContent = '';
  if (state.tab === 'memories') renderMemories(container);
  else if (state.tab === 'prune') renderPrune(container);
  else if (state.tab === 'context') renderContext(container);
  else if (state.tab === 'index') renderIndex(container);
  else if (state.tab === 'health') renderHealth(container);
  else if (state.tab === 'trash') renderTrash(container);
  else if (state.tab === 'graph') {
    const wrap = node('div', { id: 'graph-wrap' });
    container.append(wrap);
    renderGraph(wrap, state.store.graph, {
      selected: state.selected,
      spread: state.spread,
      onSelect: (file) => selectMemory(file),
      onSpreadChange: (value) => {
        state.spread = value;
        localStorage.setItem('graphSpread', String(value));
        renderTab();
      },
    });
  }
}

function selectMemory(file) {
  state.selected = file;
  if (state.tab !== 'memories') {
    state.tab = 'memories';
    renderTabs();
    renderTab();
  } else {
    renderTab();
  }
  document.querySelector('.mem.active')?.scrollIntoView({ block: 'nearest' });
}

/** Re-read the store list, e.g. after a path is remembered or forgotten. */
async function reloadStores() {
  const data = await api('/api/stores');
  state.stores = data.stores;
  renderStores();
  return data;
}

/** The name and provenance line above the tabs, which differs by store kind. */
function renderStoreHeader() {
  const store = state.store;
  el('project-title').textContent = store.label;

  const sub = el('project-sub');
  sub.textContent = '';

  if (store.kind !== 'auto') {
    const scope = store.kind === 'agent-user' ? 'user'
      : store.kind === 'agent-project' ? 'project' : 'local';
    sub.append(node('span', { text: store.dir }));
    sub.append(node('span', { class: 'sub-note', text: `subagent memory, ${scope} scope` }));
    // A project-scoped store is committed, so deleting from it edits the repo
    // rather than a private cache. Worth saying before, not after.
    if (store.kind === 'agent-project') {
      sub.append(node('span', { class: 'sub-warn', text: 'checked into the repository - changes here show up in git status' }));
    }
    return;
  }

  sub.append(node('span', { text: store.resolvedBy === 'unresolved'
    ? `${store.path}  (real path unresolved)`
    : store.path }));

  // One store serves every worktree and subdirectory of a repository, which is
  // not obvious from a single path and changes what a memory here applies to.
  const others = (store.workingDirs || []).filter((d) => d !== store.path);
  if (others.length) {
    sub.append(node('span', { class: 'sub-note', text: `also used from ${others.join(', ')}` }));
  }
  if (store.resolvedBy === 'unresolved') {
    sub.append(node('button', { class: 'btn small link-btn', text: 'Remember path\u2026', onclick: openRememberPathDialog }));
  } else if (store.resolvedBy === 'remembered') {
    sub.append(node('span', { class: 'sub-note' }, [
      document.createTextNode('path remembered, not recovered from a transcript  '),
      node('button', { class: 'btn small link-btn', text: 'Forget', onclick: forgetProjectPath }),
    ]));
  }

  const auto = store.autoMemory;
  if (auto && auto.known && !auto.enabled) {
    sub.append(node('span', { class: 'sub-warn', text: auto.scope === 'env'
      ? 'auto memory is off (CLAUDE_CODE_DISABLE_AUTO_MEMORY) - this store will not grow'
      : `auto memory is off (${auto.setBy}) - this store will not grow` }));
  }
}

async function openStore(id, { keepTab = false } = {}) {
  if (id !== state.storeId) state.pruneSelection.clear();
  state.storeId = id;
  if (!keepTab) {
    state.tab = 'memories';
    state.selected = null;
  }
  renderStores();

  try {
    state.store = await api(`/api/stores/${encodeURIComponent(id)}`);
  } catch (err) {
    return toast(err.message, { error: true });
  }

  if (state.selected && !state.store.memories.some((m) => m.file === state.selected)) {
    state.selected = null;
  }

  renderStoreHeader();

  // Refresh the sidebar count in case a delete changed it.
  const listed = state.stores.find((store) => store.id === id);
  if (listed) listed.memoryCount = state.store.memories.length;
  renderStores();

  renderView();
  renderTabs();
  renderTab();
}

function applyCollapsed() {
  el('app').classList.toggle('collapsed', state.collapsed);
  el('expand').hidden = !state.collapsed;
  localStorage.setItem('sidebarCollapsed', state.collapsed ? '1' : '0');
}

function setCollapsed(value) {
  state.collapsed = value;
  applyCollapsed();
  // The graph sizes itself to the container, so it has to be redrawn once the
  // pane has actually changed width.
  if (state.tab === 'graph' && state.store) requestAnimationFrame(renderTab);
}

async function init() {
  el('show-all').addEventListener('change', (event) => {
    state.showAll = event.target.checked;
    renderStores();
  });

  el('search').addEventListener('input', (event) => scheduleSearch(event.target.value));
  el('search-clear').addEventListener('click', clearSearch);
  el('collapse').addEventListener('click', () => setCollapsed(true));
  el('expand').addEventListener('click', () => setCollapsed(false));
  el('delete-project').addEventListener('click', openStoreDeleteDialog);
  document.addEventListener('keydown', (event) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
    if (event.key === '/' && !typing) {
      event.preventDefault();
      if (state.collapsed) setCollapsed(false);
      el('search').focus();
      el('search').select();
      return;
    }
    if (event.key === 'Escape') {
      if (el('modal-root').firstChild) closeModal();
      else if (state.search !== null) clearSearch();
      else if (!state.collapsed) setCollapsed(true);
    }
  });
  applyCollapsed();

  try {
    const data = await reloadStores();
    el('root-path').textContent = data.root;
    if (data.rootSource && data.rootSource !== 'default') {
      el('root-path').title = data.rootFile
        ? `autoMemoryDirectory set in ${data.rootFile}`
        : 'store chosen with --root';
      el('root-path').append(node('span', { class: 'root-source', text: data.rootSource }));
    }
    if (data.rootWarning) toast(data.rootWarning, { error: true });
    const first = state.stores.find((store) => store.memoryCount > 0);
    if (first) openStore(first.id);
  } catch (err) {
    toast(err.message, { error: true });
  }
}

init();
