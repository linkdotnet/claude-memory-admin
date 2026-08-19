import { renderGraph } from '/graph.mjs';
import { renderMarkdown } from '/markdown.mjs';
import * as ui from '/ui.mjs';

const state = {
  stores: [],
  storeId: null,
  store: null,
  tab: 'memories',
  selected: null,
  showAll: false,
  collapsed: localStorage.getItem('sidebarCollapsed') === '1',
  theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  spread: Number(localStorage.getItem('graphSpread')) || 1.6,
  query: '',
  search: null,
  pruneSort: 'oldest',
  pruneSelection: new Set(),
  indexView: localStorage.getItem('memoryIndexView') === 'source' ? 'source' : 'rendered',
};

const el = (id) => document.getElementById(id);

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
  node.className = ui.toast(error);
  node.append(document.createTextNode(message));
  if (action) {
    const button = document.createElement('button');
    button.className = ui.toastAction;
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

function memoryLookup(project) {
  const byName = new Map();
  for (const memory of project.memories) {
    byName.set(memory.name, memory.file);
    byName.set(memory.stem, memory.file);
  }
  return byName;
}

function openTarget(file) {
  return file ? { open: () => selectMemory(file) } : null;
}

function renderBody(container, memory, project) {
  const byName = memoryLookup(project);
  renderMarkdown(container, memory.body, {
    resolveWikilink: (target) => openTarget(byName.get(target)),
  });
}

function storeSubtitle(store) {
  if (store.kind === 'global') return store.dir;
  if (store.kind === 'auto') return store.path;
  const scope = store.kind === 'agent-user' ? 'user'
    : store.kind === 'agent-project' ? 'project' : 'local';
  return `${scope} · ${store.sublabel}`;
}

function storeButton(store) {
  const global = store.kind === 'global';
  const health = global ? 'ok' : store.memoryCount === 0 ? 'none' : 'ok';
  const off = store.autoMemory && store.autoMemory.known && !store.autoMemory.enabled;
  return node('button', {
    class: ui.storeItem({ active: store.id === state.storeId, empty: !global && !store.hasMemoryDir }),
    onclick: () => openStore(store.id),
    title: store.kind === 'auto' && store.resolvedBy === 'unresolved'
      ? 'Real path could not be resolved - showing the raw folder name'
      : store.dir,
  }, [
    node('span', { class: ui.storeRow }, [
      node('span', { class: ui.dot(health) }),
      node('span', { class: ui.storeName, text: store.label }),
      off ? node('span', { class: ui.offMarker, text: 'off', title: 'Auto memory is disabled for this project' }) : null,
      global ? null : node('span', { class: ui.storeCount, text: store.hasMemoryDir ? String(store.memoryCount) : '-' }),
    ]),
    node('span', { class: ui.storePath, text: storeSubtitle(store) }),
  ]);
}

function renderStores() {
  const list = el('project-list');
  list.textContent = '';

  const visible = state.stores.filter((s) => s.kind === 'global' || state.showAll || s.hasMemoryDir);
  if (!visible.length) {
    list.append(node('p', { class: ui.note, text: 'No memory stores found.' }));
    return;
  }

  const groups = [
    ['Global', visible.filter((s) => s.kind === 'global')],
    ['Projects', visible.filter((s) => s.kind === 'auto')],
    ['Subagents', visible.filter((s) => s.kind !== 'auto' && s.kind !== 'global')],
  ];

  const filled = groups.filter(([, stores]) => stores.length);
  for (const [title, stores] of filled) {
    if (filled.length > 1) list.append(node('div', { class: ui.sidebarGroup, text: title }));
    for (const store of stores) list.append(storeButton(store));
  }
}

const TABS = [
  { id: 'memories', label: 'Memories' },
  { id: 'index', label: 'MEMORY.md' },
  { id: 'graph', label: 'Graph' },
  { id: 'prune', label: 'Prune' },
  { id: 'context', label: 'Context' },
  { id: 'health', label: 'Health' },
  { id: 'settings', label: 'Settings' },
  { id: 'trash', label: 'Trash' },
];

function renderTabs() {
  const container = el('tabs');
  container.textContent = '';
  const global = state.store.kind === 'global';
  const hasProjectDir = state.store.kind === 'auto'
    ? state.store.resolvedBy !== 'unresolved'
    : Boolean(state.store.projectPath);

  for (const tab of TABS) {
    if (global && tab.id !== 'context') continue;
    if (!global && tab.id === 'context' && !hasProjectDir) continue;
    let badge = null;
    if (tab.id === 'memories') badge = String(state.store.memories.length);
    if (tab.id === 'health' && state.store.health.issueCount) badge = String(state.store.health.issueCount);
    if (tab.id === 'trash' && state.store.trash.length) badge = String(state.store.trash.length);
    if (tab.id === 'prune' && state.store.stats.index.overTarget) badge = '!';

    container.append(node('button', {
      class: ui.tab(state.tab === tab.id),
      onclick: () => { state.tab = tab.id; renderTabs(); renderTab(); },
    }, [
      document.createTextNode(tab.label),
      badge ? node('span', { class: ui.tabBadge(tab.id === 'health' || tab.id === 'prune'), text: badge }) : null,
    ]));
  }
}

function memoryButton(memory) {
  const active = state.selected === memory.file;
  return node('button', {
    class: ui.memoryItem(active),
    'data-memory': memory.file,
    'data-active': active ? '' : null,
    onclick: () => selectMemory(memory.file),
  }, [
    node('span', { class: ui.memoryTop }, [
      node('span', { class: ui.memoryName, text: memory.name }),
      node('span', { class: ui.typeBadge(memory.type), text: memory.type }),
      memory.status !== 'indexed'
        ? node('span', { class: ui.badge('warn'), text: memory.status })
        : null,
    ]),
    memory.description ? node('span', { class: ui.memoryDesc, text: memory.description }) : null,
  ]);
}

function renderMemories(container) {
  const project = state.store;
  if (!project.memories.length) {
    container.append(node('p', { class: ui.note, text: 'This project has no memory files yet.' }));
    return;
  }

  const left = node('div');
  const groups = new Map();
  for (const memory of project.memories) {
    const key = memory.section || (memory.status === 'indexed' ? 'Index' : 'Not in the index');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(memory);
  }
  for (const [section, memories] of groups) {
    left.append(node('div', { class: ui.sectionLabel, text: `${section} · ${memories.length}` }));
    for (const memory of memories) left.append(memoryButton(memory));
  }

  const right = node('div', { id: 'detail', class: ui.detailPane });
  container.append(node('div', { class: ui.split }, [left, right]));
  renderDetail();
}

function renderDetail() {
  const host = el('detail');
  if (!host) return;
  host.textContent = '';

  const memory = state.store.memories.find((m) => m.file === state.selected);
  if (!memory) {
    host.append(node('p', { class: ui.note, text: 'Select a memory to read it.' }));
    return;
  }

  const card = node('div', { class: ui.card });
  card.append(node('div', { class: ui.detailHead }, [
    node('h3', { class: ui.detailTitle, text: memory.name }),
    node('span', { class: ui.typeBadge(memory.type), text: memory.type }),
    node('button', {
      class: ui.buttonDangerSmall,
      text: 'Delete',
      onclick: () => openDeleteDialog(memory.file),
    }),
  ]));

  if (memory.description) card.append(node('p', { class: ui.detailDesc, text: memory.description }));

  const meta = node('dl', { class: ui.metaList });
  const rows = [
    ['file', memory.file],
    ['status', memory.status],
    ['modified', memory.modified
      ? `${memory.modified.replace('T', ' ').replace(/\..*$/, '')}${memory.modifiedFrom === 'mtime' ? '  (file mtime)' : ''}`
      : '-'],
    ['size', `${(memory.bytes / 1024).toFixed(1)} KB`],
  ];
  if (!memory.nameMatchesFile) rows.push(['name', `${memory.name}  (differs from filename)`]);
  for (const [key, value] of Object.entries(memory.metadata)) {
    if (key !== 'type' && key !== 'modified') rows.push([key, value]);
  }
  for (const [key, value] of rows) {
    meta.append(node('dt', { class: ui.metaKey, text: key }), node('dd', { class: ui.metaValue, text: String(value) }));
  }
  card.append(meta);

  const body = node('div', { class: ui.prose });
  card.append(body);
  renderBody(body, memory, state.store);

  const outbound = memory.outboundResolved || [];
  if (outbound.length || memory.inbound.length) {
    const links = node('div', { class: ui.linkSection });
    if (outbound.length) {
      links.append(node('div', { class: ui.sectionLabel, text: 'Links out' }));
      const chips = node('div', { class: ui.linkRow });
      for (const link of outbound) {
        chips.append(node('button', {
          class: ui.chip(Boolean(link.file)),
          text: link.file ? link.target : `${link.target} (missing)`,
          onclick: link.file ? () => selectMemory(link.file) : null,
        }));
      }
      links.append(chips);
    }
    if (memory.inbound.length) {
      links.append(node('div', { class: ui.sectionLabel, text: 'Linked from' }));
      const chips = node('div', { class: ui.linkRow });
      for (const link of memory.inbound) {
        const source = state.store.memories.find((m) => m.file === link.from);
        chips.append(node('button', {
          class: ui.chip(true),
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

const INDEX_VIEWS = [
  { id: 'rendered', label: 'Rendered' },
  { id: 'source', label: 'Source' },
];

function setIndexView(view) {
  state.indexView = view;
  localStorage.setItem('memoryIndexView', view);
  renderTab();
}

function indexViewPicker() {
  return node('div', { class: ui.segmentGroup, role: 'tablist' }, INDEX_VIEWS.map((view) => node('button', {
    class: ui.segment(state.indexView === view.id),
    text: view.label,
    role: 'tab',
    'aria-selected': String(state.indexView === view.id),
    onclick: () => setIndexView(view.id),
  })));
}

function cutMarker(cutoff) {
  return node('div', { class: ui.cutLine }, [
    node('span', { class: ui.cutLabel, text: `not loaded past here — ${cutoff.droppedLines} lines dropped on ${cutoff.by}` }),
  ]);
}

function renderIndex(container) {
  const project = state.store;
  if (!project.hasIndex) {
    container.append(node('p', { class: ui.note, text: 'This project has no MEMORY.md.' }));
    return;
  }

  const card = node('div', { class: ui.card });
  card.append(node('div', { class: ui.cardHeadRow }, [
    node('p', { class: ui.note, text: `${project.index.entries.length} index entries · ${project.index.lines.length} lines` }),
    indexViewPicker(),
  ]));

  if (state.indexView === 'source') renderIndexSource(card, project);
  else renderIndexRendered(card, project);

  container.append(card);
}

function renderIndexRendered(card, project) {
  const { cutoff } = project.stats.index;
  const files = new Set(project.memories.map((memory) => memory.file));
  const byName = memoryLookup(project);
  const options = {
    resolveWikilink: (target) => openTarget(byName.get(target)),
    resolveHref: (href) => openTarget(files.has(href) ? href : null),
  };

  const lines = project.index.raw.split('\n');
  const loaded = node('div', { class: ui.prose });
  renderMarkdown(loaded, cutoff ? lines.slice(0, cutoff.rawLine).join('\n') : project.index.raw, options);
  card.append(loaded);

  if (!cutoff) return;
  card.append(cutMarker(cutoff));
  const dropped = node('div', { class: ui.proseDim });
  renderMarkdown(dropped, lines.slice(cutoff.rawLine).join('\n'), options);
  card.append(dropped);
}

function renderIndexSource(card, project) {
  const missing = new Set(project.health.danglingIndex.map((d) => d.index));
  const { cutoff } = project.stats.index;

  for (const line of project.index.lines) {
    if (cutoff && line.index === cutoff.rawLine) card.append(cutMarker(cutoff));

    const dangling = missing.has(line.index);
    const dropped = Boolean(cutoff) && line.index >= cutoff.rawLine;
    const clickable = line.kind === 'index' && !dangling;
    const content = node('span', {
      class: ui.indexLineText({ kind: line.kind, clickable, dropped }),
      text: line.text || ' ',
    });
    if (clickable) content.onclick = () => selectMemory(line.file);

    card.append(node('div', { class: ui.indexLine({ dangling, dropped }) }, [
      node('span', { class: ui.indexLineNumber, text: String(line.index + 1) }),
      content,
    ]));
  }
}

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
  'unreferenced-user-file': (p) => ['Nothing in the chain reaches this file', `${p.file} sits next to CLAUDE.md and loads nothing. Import it with @${p.file.split('/').pop()}, or delete it.`],
};

async function renderContext(container) {
  container.append(node('p', { class: ui.note, text: 'Reading instruction files…' }));
  let data;
  try {
    data = await api(`/api/stores/${encodeURIComponent(state.storeId)}/instructions`);
  } catch (err) {
    container.textContent = '';
    return container.append(node('p', { class: ui.note, text: err.message }));
  }
  if (state.tab !== 'context') return;
  container.textContent = '';

  const global = state.store.kind === 'global';
  if (!data.projectDir && !global) {
    return container.append(node('p', { class: ui.note, text: 'This store is not tied to a project directory, so there are no instruction files to resolve.' }));
  }

  const { totals } = data;
  container.append(node('div', { class: ui.meter }, [
    node('div', { class: ui.meterTop }, [
      node('span', { class: ui.meterValue, text: `~${totals.alwaysTokens.toLocaleString()}` }),
      node('span', { class: ui.meterUnit, text: 'estimated tokens of instructions, every session' }),
    ]),
    node('div', { class: ui.meterFacts }, [
      node('span', {}, [node('b', { class: ui.meterFactValue, text: String(totals.files) }), document.createTextNode(' files resolved')]),
      node('span', {}, [node('b', { class: ui.meterFactValue, text: String(totals.alwaysLines) }), document.createTextNode(' lines always loaded')]),
      node('span', {}, [node('b', { class: ui.meterFactValue, text: `${(totals.alwaysBytes / 1024).toFixed(1)} KB` }), document.createTextNode(' always loaded')]),
      node('span', {}, [node('b', { class: ui.meterFactValue, text: String(totals.conditionalFiles) }), document.createTextNode(' path-scoped rules, loaded only on a match')]),
    ]),
    node('p', { class: ui.meterNote, text: 'Unlike MEMORY.md, none of this is truncated: CLAUDE.md files load in full however long they are. The 200-line figure is Claude Code’s guidance, not a cutoff, because long files cost context every session and are followed less reliably.' }),
  ]));

  if (data.problems.length) {
    container.append(node('div', { class: ui.sectionLabel, text: `Problems · ${data.problems.length}` }));
    for (const problem of data.problems) {
      const describe = CONTEXT_PROBLEMS[problem.kind];
      const [title, detail] = describe ? describe(problem) : [problem.kind, problem.file || ''];
      const bad = problem.kind === 'missing' || problem.kind === 'invalid-glob' || problem.kind === 'glob-budget';
      container.append(node('div', { class: ui.issue(bad) }, [
        node('div', { class: ui.issueBody }, [
          node('div', { class: ui.issueTitle, text: title }),
          node('div', { class: ui.issueDetail, text: detail }),
        ]),
      ]));
    }
  }

  container.append(node('div', { class: ui.sectionLabel, text: `Loaded in this order · ${data.files.length}` }));
  const card = node('div', { class: ui.card });
  for (const file of data.files) {
    const tags = [node('span', { class: ui.scopeBadge(file.scope), text: file.scope })];
    if (file.kind === 'import') tags.push(node('span', { class: ui.badge(), text: `import · depth ${file.depth}` }));
    if (file.kind === 'rule') tags.push(node('span', { class: ui.badge(), text: 'rule' }));
    if (file.kind === 'managed-settings') tags.push(node('span', { class: ui.badge(), text: 'claudeMd setting' }));
    if (file.conditional) tags.push(node('span', { class: ui.badge('warn'), text: 'only on a path match' }));

    const body = node('div', { class: ui.contextBody, hidden: true });
    const bodyProse = node('div', { class: ui.prose });
    body.append(bodyProse);
    const caret = node('span', { class: ui.contextCaret, text: '\u25b8' });
    let rendered = false;

    card.append(node('button', {
      class: ui.contextRowButton,
      'aria-expanded': 'false',
      onclick: (event) => {
        const open = body.hidden;
        body.hidden = !open;
        caret.textContent = open ? '\u25be' : '\u25b8';
        event.currentTarget.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open && !rendered) {
          rendered = true;
          renderMarkdown(bodyProse, file.text);
        }
      },
    }, [
      node('div', { class: ui.contextMain }, [
        node('div', { class: ui.contextTags }, tags),
        node('div', { class: ui.contextFile }, [caret, document.createTextNode(file.file)]),
      ]),
      node('div', { class: ui.contextSize, text: `${file.lines} L · ~${file.tokens.toLocaleString()} tok` }),
    ]));
    card.append(body);
  }
  container.append(card);

  if (data.excluded.length) {
    container.append(node('div', { class: ui.sectionLabel, text: `Excluded by claudeMdExcludes · ${data.excluded.length}` }));
    for (const file of data.excluded) {
      container.append(node('div', { class: ui.issue(false) }, [
        node('div', { class: ui.issueBody }, [node('div', { class: ui.issueDetail, text: file })]),
      ]));
    }
  }

  container.append(node('p', { class: ui.meterNote, text: 'This is re-derived from the documented resolution rules, not a report from Claude Code. Run /context in a session to see what it actually loaded.' }));
}

function issue(title, detail, { bad = false, action, secondary } = {}) {
  return node('div', { class: ui.issue(bad) }, [
    node('div', { class: ui.issueBody }, [
      node('div', { class: ui.issueTitle, text: title }),
      node('div', { class: ui.issueDetail, text: detail }),
    ]),
    secondary ? node('button', { class: ui.buttonSmall, text: secondary.label, onclick: secondary.run }) : null,
    action ? node('button', { class: ui.buttonSmall, text: action.label, onclick: action.run }) : null,
  ]);
}

function renderHealth(container) {
  const { health, memories } = state.store;
  if (!health.issues.length) {
    container.append(node('div', { class: ui.card }, [
      node('p', { class: ui.okLine, text: '\u2713 No consistency problems found.' }),
      node('p', { class: ui.noteTight, text: 'Every memory file is referenced by MEMORY.md, every pointer resolves, and every [[wikilink]] finds its target.' }),
    ]));
    return;
  }

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
      {
        bad,
        secondary: { label: 'Open', run: () => selectMemory(item.file) },
        action: { label: 'Add to MEMORY.md', run: () => openAddEntryDialog(item.file) },
      },
    );
  }

  if (item.kind === 'referenced-only') {
    const memory = memories.find((m) => m.file === item.file);
    return issue(
      `Linked mid-sentence, not indexed: ${item.file}`,
      `"${memory?.name || item.file}" is mentioned inside prose in MEMORY.md but has no index bullet of its own.`,
      {
        bad,
        secondary: { label: 'Open', run: () => selectMemory(item.file) },
        action: { label: 'Add to MEMORY.md', run: () => openAddEntryDialog(item.file) },
      },
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

const SETTINGS_PROBLEMS = {
  unparseable: (p) => [
    `Not valid JSON: ${p.scope} settings`,
    `${p.file} — Claude Code cannot read this file either, so every value in it is being ignored. ${p.detail}`,
  ],
  unreadable: (p) => [
    `Cannot be read: ${p.scope} settings`,
    `${p.file} — ${p.detail}`,
  ],
  'not-object': (p) => [
    `Not a settings object: ${p.scope} settings`,
    `${p.file} — ${p.detail}`,
  ],
  'invalid-auto-memory-directory': (p) => [
    'autoMemoryDirectory cannot be used',
    `${p.file} — ${p.detail}. Claude Code accepts only an absolute or ~/-prefixed path.`,
  ],
};

const show = (value) => (value === undefined ? 'unset' : JSON.stringify(value));

async function renderSettings(container) {
  container.append(node('p', { class: ui.note, text: 'Reading settings files…' }));
  let data;
  try {
    data = await api(`/api/stores/${encodeURIComponent(state.storeId)}/settings`);
  } catch (err) {
    container.textContent = '';
    return container.append(node('p', { class: ui.note, text: err.message }));
  }
  if (state.tab !== 'settings') return;
  container.textContent = '';

  container.append(node('p', { class: ui.noteTight, text: 'What Claude Code would read for this store, in precedence order: managed policy first, then project and local settings, then your user file. This tab is read-only — it reports what is configured, it never changes it.' }));

  if (!data.projectDir) {
    container.append(node('p', { class: ui.subWarn, text: 'This store has no resolved project directory, so its project and local settings layers could not be consulted. Values below come from managed policy and your user file only.' }));
  }

  if (data.problems.length) {
    container.append(node('div', { class: ui.sectionLabel, text: `Problems · ${data.problems.length}` }));
    for (const problem of data.problems) {
      const describe = SETTINGS_PROBLEMS[problem.kind];
      const [title, detail] = describe ? describe(problem) : [problem.kind, problem.file || ''];
      container.append(node('div', { class: ui.issue(true) }, [
        node('div', { class: ui.issueBody }, [
          node('div', { class: ui.issueTitle, text: title }),
          node('div', { class: ui.issueDetail, text: detail }),
        ]),
      ]));
    }
  }

  if (data.env.overrides) {
    container.append(node('div', { class: ui.sectionLabel, text: 'Environment override' }));
    container.append(node('div', { class: ui.issue(false) }, [
      node('div', { class: ui.issueBody }, [
        node('div', { class: ui.issueTitle, text: `${data.env.name}=${data.env.value}` }),
        node('div', { class: ui.issueDetail, text: `Set in this shell, so it outranks every settings file and forces ${data.env.overrides} off. The store will not grow while it is set.` }),
      ]),
    ]));
  }

  for (const entry of data.keys) {
    const card = node('div', { class: ui.card });
    const head = node('div', { class: ui.settingsKeyHead }, [
      node('span', { class: ui.settingsKeyName, text: entry.key }),
      node('span', {
        class: ui.settingsEffective,
        text: entry.effective ? show(entry.effective.value) : `${show(entry.fallback)} (default)`,
      }),
    ]);
    if (entry.effective) {
      head.append(node('span', { class: ui.scopeBadge(entry.effective.scope), text: entry.effective.scope }));
    }
    card.append(head);
    card.append(node('p', { class: ui.noteTight, text: entry.detail }));

    if (entry.normalized !== undefined && entry.effective && entry.normalized !== entry.effective.value) {
      card.append(node('div', { class: ui.issue(false) }, [
        node('div', { class: ui.issueBody }, [
          node('div', { class: ui.issueTitle, text: `Configured ${show(entry.effective.value)}, but ${show(entry.normalized)} applies` }),
          node('div', { class: ui.issueDetail, text: 'Claude Code ignores a value it cannot use and falls back to the default.' }),
        ]),
      ]));
    }

    if (!entry.values.length) {
      card.append(node('p', { class: ui.note, text: 'No settings file sets this, so the built-in default applies.' }));
    } else {
      for (const value of entry.values) {
        card.append(node('div', { class: ui.settingsLayerRow }, [
          node('span', { class: ui.scopeBadge(value.scope), text: value.scope }),
          node('span', { class: ui.settingsLayerValue(value.wins), text: show(value.value) }),
          node('span', { class: ui.settingsLayerFile, text: value.file }),
          value.wins ? node('span', { class: ui.badge('ok'), text: 'wins' }) : null,
        ]));
      }
    }
    container.append(card);
  }

  container.append(node('div', { class: ui.sectionLabel, text: `Files consulted · ${data.layers.length}` }));
  const files = node('div', { class: ui.card });
  for (const layer of data.layers) {
    files.append(node('div', { class: ui.settingsLayerRow }, [
      node('span', { class: ui.scopeBadge(layer.scope), text: layer.scope }),
      node('span', { class: ui.settingsLayerValue(layer.status === 'ok'), text: layer.status }),
      node('span', { class: ui.settingsLayerFile, text: layer.file }),
    ]));
  }
  container.append(files);
}

const byteLength = (text) => new TextEncoder().encode(text).length;

function indexEntryAt(lineIndex) {
  return state.store.index?.entries.find((entry) => entry.index === lineIndex) || null;
}

function sectionsAbove(limit) {
  const seen = [];
  for (const line of state.store.index?.lines || []) {
    if (line.kind !== 'heading') continue;
    if (limit !== null && line.index >= limit) continue;
    if (line.section && !seen.includes(line.section)) seen.push(line.section);
  }
  return seen;
}

async function runIndexEdit(action, body, message) {
  try {
    const result = await api(`/api/stores/${encodeURIComponent(state.storeId)}/${action}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    await openStore(state.storeId, { keepTab: true });
    toast(message(result), { action: { label: 'Undo', run: () => restoreFromTrash(result.record.id) } });
    return result;
  } catch (err) {
    toast(err.message, { error: true });
    return null;
  }
}

function openHookEditor(row, lineIndex) {
  const entry = indexEntryAt(lineIndex);
  if (!entry) return toast('MEMORY.md has changed - reload and try again', { error: true });

  const stats = state.store.stats.index;
  const editor = node('div', { class: ui.hookEditor });
  const field = node('textarea', { class: ui.textArea, spellcheck: 'false' });
  field.value = entry.hook;

  const counter = node('span');
  const projection = node('span');
  const readout = node('div', { class: ui.charCount }, [counter, projection]);

  const save = node('button', { class: ui.buttonPrimarySmall, text: 'Save' });
  const cancel = node('button', { class: ui.buttonSmall, text: 'Cancel', onclick: () => renderTab() });

  function update() {
    const next = field.value.trim();
    const delta = byteLength(next) - byteLength(entry.hook);
    const projected = Math.max(stats.linePercent, ((stats.bytes + delta) / stats.byteLimit) * 100);

    counter.textContent = `${next.length} characters, was ${entry.hook.length}`;
    projection.textContent = `index ${Math.round(stats.worstPercent)}% → ${Math.round(projected)}%`;
    readout.className = next.length > 200 ? ui.charCountOver : ui.charCount;
    save.disabled = next === entry.hook;
  }

  field.addEventListener('input', update);
  save.onclick = () => runIndexEdit(
    'index/hook',
    { lineIndex, expectedText: entry.text, hook: field.value },
    () => 'Hook shortened',
  );

  editor.append(
    node('div', { class: ui.willTitle, text: 'Hook' }),
    field,
    readout,
    node('div', { class: ui.hookEditorFoot }, [cancel, save]),
  );
  row.textContent = '';
  row.append(editor);
  update();
  field.focus();
  field.select();
}

function openMoveDialog(entry) {
  const current = indexEntryAt(entry.index);
  if (!current) return toast('MEMORY.md has changed - reload and try again', { error: true });

  const { cutoff } = state.store.stats.index;
  const sections = sectionsAbove(cutoff ? cutoff.rawLine : null);
  const picker = node('select', { class: ui.select });
  picker.append(node('option', { value: '', text: 'Top of MEMORY.md' }));
  for (const section of sections) picker.append(node('option', { value: section, text: `Start of "${section}"` }));

  const body = node('div', { class: ui.modalBody }, [
    node('p', { class: ui.noteTight, text: `"${current.title}" sits at line ${current.index + 1}, past the cutoff at line ${cutoff ? cutoff.rawLine + 1 : '-'}, so Claude never loads it. Moving it up puts it back inside the loaded part of the index - which pushes whatever is now last past the cutoff instead.` }),
    node('div', { class: ui.willBlock }, [
      node('div', { class: ui.willTitle, text: 'Will move' }),
      node('div', { class: ui.willItem('keep'), text: current.text }),
    ]),
    node('label', { class: ui.willTitle, text: 'Move to' }),
    picker,
  ]);

  const modal = node('div', { class: ui.modal }, [
    node('header', { class: ui.modalHead }, [node('h3', { class: ui.modalTitle, text: 'Move this entry above the cutoff' })]),
    body,
    node('footer', { class: ui.modalFoot }, [
      node('button', { class: ui.button(), text: 'Cancel', onclick: closeModal }),
      node('button', {
        class: ui.button({ tone: 'primary' }),
        text: 'Move',
        onclick: async () => {
          closeModal();
          await runIndexEdit(
            'index/move',
            picker.value
              ? { lineIndex: current.index, expectedText: current.text, section: picker.value }
              : { lineIndex: current.index, expectedText: current.text, top: true },
            () => 'Entry moved',
          );
        },
      }),
    ]),
  ]);

  const backdrop = node('div', { class: ui.modalBackdrop, onclick: (event) => { if (event.target === backdrop) closeModal(); } }, [modal]);
  el('modal-root').append(backdrop);
}

async function openAddEntryDialog(file) {
  let preview;
  try {
    preview = await api(`/api/stores/${encodeURIComponent(state.storeId)}/index/add-preview`, {
      method: 'POST',
      body: JSON.stringify({ file }),
    });
  } catch (err) {
    return toast(err.message, { error: true });
  }

  const title = node('input', { type: 'text', class: ui.pathInput, spellcheck: 'false' });
  title.value = preview.name;
  const hook = node('textarea', { class: ui.textArea, spellcheck: 'false' });
  hook.value = preview.description;

  const picker = node('select', { class: ui.select });
  for (const section of preview.sections) picker.append(node('option', { value: section, text: section }));
  picker.append(node('option', { value: '', text: 'End of MEMORY.md' }));
  if (preview.sections.length) picker.value = preview.sections[preview.sections.length - 1];

  const line = node('div', { class: ui.willItem('keep') });
  const update = () => {
    const label = title.value.trim().replace(/[[\]]/g, '') || preview.name;
    const text = hook.value.trim();
    line.textContent = text ? `- [${label}](${file}) — ${text}` : `- [${label}](${file})`;
  };
  title.addEventListener('input', update);
  hook.addEventListener('input', update);
  update();

  const body = node('div', { class: ui.modalBody }, [
    node('p', { class: ui.noteTight, text: preview.hasIndex
      ? 'MEMORY.md is loaded at the start of every session, so a memory with no bullet here is one Claude never sees. This adds one line and nothing else.'
      : 'This project has no MEMORY.md yet. Adding this entry creates one.' }),
    node('label', { class: ui.willTitle, text: 'Title' }),
    title,
    node('label', { class: ui.willTitle, text: 'Hook' }),
    hook,
    node('label', { class: ui.willTitle, text: 'Section' }),
    picker,
    node('div', { class: ui.willBlock }, [
      node('div', { class: ui.willTitle, text: 'Will be added' }),
      line,
    ]),
  ]);

  const modal = node('div', { class: ui.modal }, [
    node('header', { class: ui.modalHead }, [node('h3', { class: ui.modalTitle, text: `Add ${file} to MEMORY.md` })]),
    body,
    node('footer', { class: ui.modalFoot }, [
      node('button', { class: ui.button(), text: 'Cancel', onclick: closeModal }),
      node('button', {
        class: ui.button({ tone: 'primary' }),
        text: 'Add entry',
        onclick: async () => {
          closeModal();
          await runIndexEdit(
            'index/add',
            { file, section: picker.value || null, title: title.value, hook: hook.value },
            () => 'Added to MEMORY.md',
          );
        },
      }),
    ]),
  ]);

  const backdrop = node('div', { class: ui.modalBackdrop, onclick: (event) => { if (event.target === backdrop) closeModal(); } }, [modal]);
  el('modal-root').append(backdrop);
  title.focus();
  title.select();
}

async function openMergeDialog(into, from) {
  let preview;
  try {
    preview = await api(`/api/stores/${encodeURIComponent(state.storeId)}/merge-preview`, {
      method: 'POST',
      body: JSON.stringify({ into, from }),
    });
  } catch (err) {
    return toast(err.message, { error: true });
  }

  const heading = node('input', { type: 'text', class: ui.pathInput, spellcheck: 'false' });
  heading.value = preview.heading;

  const body = node('div', { class: ui.modalBody });
  body.append(node('p', { class: ui.noteTight, text: `Everything in "${preview.fromName}" moves into "${preview.intoName}" under a new heading, and "${preview.fromName}" goes to the trash. This rewrites prose, which nothing else in this app does - the whole operation is one undo.` }));

  const changes = node('div', { class: ui.willBlock }, [node('div', { class: ui.willTitle, text: 'Will change' })]);
  changes.append(node('div', { class: ui.willItem('keep'), text: `${preview.into}  +  ${preview.bodyLines} line(s) from ${preview.from}` }));
  for (const entry of preview.inbound) {
    changes.append(node('div', { class: ui.willItem('keep'), text: `${entry.file}  ${entry.targets.map((t) => `[[${t}]]`).join(' ')}  →  [[${preview.intoName}]]` }));
  }
  for (const link of preview.selfLinks) {
    changes.append(node('div', { class: ui.willItem('keep'), text: `${preview.into}  [[${link}]]  →  plain text, to avoid a self-link` }));
  }
  body.append(changes);

  const removals = node('div', { class: ui.willBlock }, [node('div', { class: ui.willTitle, text: 'Will be removed' })]);
  removals.append(node('div', { class: ui.willItem('remove'), text: `memory/${preview.from}  →  memory/.trash/` }));
  for (const line of preview.indexLines) {
    removals.append(node('div', { class: ui.willItem('remove'), text: `MEMORY.md line ${line.index + 1}:  ${line.text}` }));
  }
  if (!preview.indexLines.length) {
    removals.append(node('div', { class: ui.willItem(), text: 'MEMORY.md has no index bullet for the source - nothing to remove there.' }));
  }
  body.append(removals);

  if (preview.inlineRefs.length) {
    const kept = node('div', { class: ui.willBlock }, [
      node('div', { class: ui.willTitle, text: 'Left untouched - mentioned inside prose, so you may want to fix these by hand' }),
    ]);
    for (const ref of preview.inlineRefs) {
      kept.append(node('div', { class: ui.willItem('keep'), text: `MEMORY.md line ${ref.index + 1}:  ${ref.text}` }));
    }
    body.append(kept);
  }

  body.append(node('label', { class: ui.willTitle, text: 'Heading for the merged section' }), heading);

  const modal = node('div', { class: ui.modal }, [
    node('header', { class: ui.modalHead }, [
      node('h3', { class: ui.modalTitle, text: `Merge "${preview.fromName}" into "${preview.intoName}"?` }),
    ]),
    body,
    node('footer', { class: ui.modalFoot }, [
      node('button', { class: ui.button(), text: 'Cancel', onclick: closeModal }),
      node('button', {
        class: ui.button({ tone: 'primary' }),
        text: 'Merge',
        onclick: async () => {
          closeModal();
          try {
            const result = await api(`/api/stores/${encodeURIComponent(state.storeId)}/merge`, {
              method: 'POST',
              body: JSON.stringify({ into, from, heading: heading.value }),
            });
            if (state.selected === from) state.selected = into;
            await openStore(state.storeId, { keepTab: true });
            toast(`Merged into ${preview.intoName}`, {
              action: { label: 'Undo', run: () => restoreFromTrash(result.record.id) },
            });
          } catch (err) {
            toast(err.message, { error: true });
          }
        },
      }),
    ]),
  ]);

  const backdrop = node('div', { class: ui.modalBackdrop, onclick: (event) => { if (event.target === backdrop) closeModal(); } }, [modal]);
  el('modal-root').append(backdrop);
  heading.focus();
  heading.select();
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

const INDEX_EDIT_LABELS = {
  hook: 'MEMORY.md hook shortened',
  move: 'MEMORY.md entry moved',
  add: 'MEMORY.md entry added',
};

function renderTrash(container) {
  const trash = state.store.trash;
  if (!trash.length) {
    container.append(node('p', { class: ui.note, text: 'Nothing in the trash. Deleted memories land here and can be restored.' }));
    return;
  }
  for (const record of trash) {
    const when = String(record.deletedAt).replace('T', ' ').replace(/\..*$/, '');
    const detail = record.kind === 'wikilink'
      ? `unlinked in ${record.sourceFile} · ${when}`
      : record.kind === 'index-edit'
        ? `${INDEX_EDIT_LABELS[record.op] || 'MEMORY.md edited'} · ${when}`
        : record.kind === 'merge'
          ? `merged into ${record.into} · ${when} · ${record.backups?.length || 0} file(s) rewritten`
          : `${record.files.length} file(s)${record.indexTrashedFile ? ' + MEMORY.md' : ''} · ${when} · ${record.removedLines?.length || 0} index line(s) removed`;
    container.append(node('div', { class: ui.issue(!record.present) }, [
      node('div', { class: ui.issueBody }, [
        node('div', { class: ui.issueTitle, text: record.label || record.id }),
        node('div', { class: ui.issueDetail, text: record.present ? detail : `${detail}, backup missing, cannot restore` }),
      ]),
      record.present
        ? node('button', { class: ui.buttonPrimarySmall, text: 'Restore', onclick: () => restoreFromTrash(record.id) })
        : null,
    ]));
  }
}

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

  const body = node('div', { class: ui.modalBody });

  const removals = node('div', { class: ui.willBlock }, [node('div', { class: ui.willTitle, text: 'Will be removed' })]);
  removals.append(node('div', { class: ui.willItem('remove'), text: `memory/${preview.file}  →  memory/.trash/` }));
  for (const line of [...preview.indexLines, ...preview.continuations]) {
    removals.append(node('div', { class: ui.willItem('remove'), text: `MEMORY.md line ${line.index + 1}:  ${line.text}` }));
  }
  if (!preview.indexLines.length && preview.hasIndex) {
    removals.append(node('div', { class: ui.willItem(), text: 'MEMORY.md has no index bullet for this file - nothing to unlink there.' }));
  }
  body.append(removals);

  if (preview.inlineRefs.length) {
    const kept = node('div', { class: ui.willBlock }, [node('div', { class: ui.willTitle, text: 'Left untouched - mentioned inside prose, so you may want to fix these by hand' })]);
    for (const ref of preview.inlineRefs) {
      kept.append(node('div', { class: ui.willItem('keep'), text: `MEMORY.md line ${ref.index + 1}:  ${ref.text}` }));
    }
    body.append(kept);
  }

  const cascade = new Set();
  if (preview.inboundWikilinks.length) {
    const block = node('div', { class: ui.willBlock });
    const selectAll = node('button', { class: ui.linkButton, text: 'select all' });
    block.append(node('div', { class: ui.cascadeHead }, [
      node('div', { class: ui.willTitle, text: `${preview.inboundWikilinks.length} memory(s) link here and will break` }),
      selectAll,
    ]));

    const list = node('div', { class: ui.cascadeList });
    const rows = [];
    for (const link of preview.inboundWikilinks) {
      const box = node('input', { type: 'checkbox', class: ui.checkbox });
      const row = node('label', { class: ui.cascadeRow(false) }, [
        box,
        node('span', { class: ui.cascadeText }, [
          node('span', { class: ui.cascadeName, text: link.fromName || link.from }),
          node('span', { class: ui.cascadeDetail, text: link.indexLine
            ? `${link.from} · MEMORY.md line ${link.indexLine.index + 1}`
            : `${link.from} · not in the index` }),
        ]),
      ]);
      box.addEventListener('change', () => {
        row.className = ui.cascadeRow(box.checked);
        if (box.checked) cascade.add(link.from);
        else cascade.delete(link.from);
        updateButton();
      });
      rows.push({ box, row });
      list.append(row);
    }
    block.append(list);
    block.append(node('p', { class: ui.noteTight, text: 'Tick any you also want deleted - they go to the trash together and restore as one step.' }));
    body.append(block);

    selectAll.onclick = (event) => {
      event.preventDefault();
      const turnOn = rows.some((r) => !r.box.checked);
      for (const { box } of rows) {
        if (box.checked !== turnOn) { box.checked = turnOn; box.dispatchEvent(new Event('change')); }
      }
      selectAll.textContent = turnOn ? 'select none' : 'select all';
    };
  }

  body.append(node('p', { class: ui.noteTight, text: 'The file moves to memory/.trash/ with a restore record, so this can be undone.' }));

  const confirmButton = node('button', {
    class: ui.button({ tone: 'danger' }),
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
  });

  const modal = node('div', { class: ui.modal }, [
    node('header', { class: ui.modalHead }, [
      node('h3', { class: ui.modalTitle, text: `Delete "${preview.name || preview.file}"?` }),
      node('p', { class: ui.note, text: preview.description || '' }),
    ]),
    body,
    node('footer', { class: ui.modalFoot }, [
      node('button', { class: ui.button(), text: 'Cancel', onclick: closeModal }),
      confirmButton,
    ]),
  ]);

  const backdrop = node('div', { class: ui.modalBackdrop, onclick: (event) => { if (event.target === backdrop) closeModal(); } }, [modal]);
  el('modal-root').append(backdrop);
  updateButton();

  function updateButton() {
    confirmButton.textContent = cascade.size ? `Delete ${cascade.size + 1} memories` : 'Delete';
  }
}

function openRememberPathDialog() {
  const store = state.store;
  const input = node('input', {
    type: 'text',
    class: ui.pathInput,
    value: store.guess || '',
    placeholder: '/Users/you/repos/the-project',
    spellcheck: 'false',
  });

  const body = node('div', { class: ui.modalBody }, [
    node('p', { class: ui.note, text: `The folder on disk is "${store.slug}", and its name is a lossy encoding of a path. No session transcript remains to recover the real one from, so tell it once and it will be used from now on.` }),
    input,
    node('p', { class: ui.noteTight, text: 'Saved to ~/.claude-memory-admin/paths.json. That file records slugs and folder paths only, never memory content, and is the one thing this app writes outside a memory/ directory.' }),
  ]);

  const modal = node('div', { class: ui.modal }, [
    node('header', { class: ui.modalHead }, [node('h3', { class: ui.modalTitle, text: 'Remember this project\u2019s path' })]),
    body,
    node('footer', { class: ui.modalFoot }, [
      node('button', { class: ui.button(), text: 'Cancel', onclick: closeModal }),
      node('button', {
        class: ui.button({ tone: 'primary' }),
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

  const backdrop = node('div', { class: ui.modalBackdrop, onclick: (event) => { if (event.target === backdrop) closeModal(); } }, [modal]);
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

  const body = node('div', { class: ui.modalBody });
  const removals = node('div', { class: ui.willBlock }, [node('div', { class: ui.willTitle, text: 'Will be removed' })]);
  if (preview.hasIndex) {
    removals.append(node('div', { class: ui.willItem('remove'), text: `MEMORY.md  (${preview.indexLines} lines)  →  memory/.trash/` }));
  }
  for (const entry of preview.files) {
    removals.append(node('div', { class: ui.willItem('remove'), text: `${entry.file}  →  memory/.trash/` }));
  }
  body.append(removals);

  body.append(node('div', { class: ui.willBlock }, [
    node('div', { class: ui.willTitle, text: 'Will be kept' }),
    node('div', { class: ui.willItem('keep'), text: state.store.kind === 'auto'
      ? 'Session transcripts (*.jsonl) and the project folder itself'
      : 'The agent-memory folder itself, and every other agent\u2019s memory' }),
  ]));

  body.append(node('p', { class: ui.noteTight, text: 'Everything moves to .trash/ inside the store as one restore point, so it can be put back in a single step from the Trash tab.' }));

  if (state.store.kind === 'agent-project') {
    body.append(node('p', { class: ui.subWarn, text: 'This store is checked into the repository. Deleting from it changes tracked files, and will show up in git status.' }));
  }

  const modal = node('div', { class: ui.modal }, [
    node('header', { class: ui.modalHead }, [
      node('h3', { class: ui.modalTitle, text: `Delete all memory for ${state.store.label}?` }),
      node('p', { class: ui.note, text: `${preview.files.length} memories${preview.hasIndex ? ' + MEMORY.md' : ''}` }),
    ]),
    body,
    node('footer', { class: ui.modalFoot }, [
      node('button', { class: ui.button(), text: 'Cancel', onclick: closeModal }),
      node('button', {
        class: ui.button({ tone: 'danger' }),
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

  const backdrop = node('div', { class: ui.modalBackdrop, onclick: (event) => { if (event.target === backdrop) closeModal(); } }, [modal]);
  el('modal-root').append(backdrop);
}

function highlight(text, terms) {
  const wrapper = node('span');
  if (!terms.length) { wrapper.textContent = text; return wrapper; }
  const pattern = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig');
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) wrapper.append(document.createTextNode(text.slice(last, match.index)));
    wrapper.append(node('mark', { class: ui.resultMark, text: match[0] }));
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
  const level = index.level;

  const note = index.level === 'over'
    ? 'Over the limit. Everything past the cutoff is dropped when the session loads it, so those entries are effectively invisible to Claude right now.'
    : index.level === 'near'
      ? 'Approaching the limit. Once MEMORY.md passes it, everything after the cutoff stops being loaded at all.'
      : 'Comfortably inside the limit. MEMORY.md is loaded at the start of every session.';

  if (index.cutoff) {
    const dropped = index.cutoff.droppedEntries;
    const box = node('div', { class: ui.cutSummary });
    box.append(node('div', { class: ui.cutSummaryHead, text: dropped.length
      ? `${dropped.length} ${dropped.length === 1 ? 'memory is' : 'memories are'} past the cutoff and not loaded`
      : `${index.cutoff.droppedLines} lines are past the cutoff and not loaded` }));
    box.append(node('p', { class: ui.note, text: `MEMORY.md stops loading at line ${index.cutoff.rawLine + 1}, bounded by ${index.cutoff.by}. Claude cannot see anything below it.` }));
    for (const entry of dropped.slice(0, 20)) {
      box.append(node('div', { class: ui.issue(true) }, [
        node('div', { class: ui.issueBody }, [
          node('div', { class: ui.issueTitle, text: entry.title || entry.file }),
          node('div', { class: ui.issueDetail, text: `MEMORY.md line ${entry.index + 1} · ${entry.file}` }),
        ]),
        node('button', { class: ui.buttonSmall, text: 'Open', onclick: () => selectMemory(entry.file) }),
        node('button', { class: ui.buttonPrimarySmall, text: 'Move up', onclick: () => openMoveDialog(entry) }),
      ]));
    }
    if (dropped.length > 20) {
      box.append(node('p', { class: ui.note, text: `${dropped.length - 20} more not listed.` }));
    }
    container.append(box);
  }

  container.append(node('div', { class: ui.meter }, [
    node('div', { class: ui.meterTop }, [
      node('span', { class: ui.meterValue, text: `${Math.round(index.worstPercent)}%` }),
      node('span', { class: ui.meterUnit, text: `of the MEMORY.md load limit, currently bounded by ${index.limitedBy}` }),
    ]),
    node('div', { class: ui.meterBar }, [
      node('div', { class: ui.meterFill(level), style: `width:${percent.toFixed(1)}%` }),
    ]),
    node('p', { class: ui.meterNote, text: note }),
    node('div', { class: ui.meterFacts }, [
      node('span', {}, [node('b', { class: ui.meterFactValue, text: `${index.lines} / ${index.lineLimit}` }), document.createTextNode(' lines')]),
      node('span', {}, [node('b', { class: ui.meterFactValue, text: `${(index.bytes / 1024).toFixed(1)} / ${index.byteLimit / 1024} KB` }), document.createTextNode(' loaded size')]),
      node('span', {}, [node('b', { class: ui.meterFactValue, text: String(index.entryCount) }), document.createTextNode(' index entries')]),
      node('span', {}, [node('b', { class: ui.meterFactValue, text: `~${index.tokens.toLocaleString()}` }), document.createTextNode(' tokens, every session')]),
    ]),
    node('p', { class: ui.meterNote, text: 'Claude Code loads the first 200 lines or 25KB of MEMORY.md, whichever comes first, and drops the rest. Topic files are only read when Claude follows a link, so detail belongs in them and MEMORY.md should stay one line per entry.' }),
  ]));
}

function renderPrune(container) {
  const project = state.store;
  renderBudget(container);

  if (!project.memories.length) {
    container.append(node('p', { class: ui.note, text: 'Nothing to prune - this project has no memories.' }));
    return;
  }

  const selected = state.pruneSelection;
  const bar = node('div', { class: ui.pruneBar });
  const sort = node('select', { class: ui.select });
  for (const [key, config] of Object.entries(PRUNE_SORTS)) {
    sort.append(node('option', { value: key, text: config.label, selected: key === state.pruneSort ? '' : null }));
  }
  sort.value = state.pruneSort;
  sort.onchange = () => { state.pruneSort = sort.value; renderTab(); };

  const count = node('span', { class: ui.note });
  const deleteButton = node('button', { class: ui.buttonDangerSmall });
  const clearButton = node('button', { class: ui.buttonSmall, text: 'Clear selection' });

  bar.append(node('span', { class: ui.sectionLabel, text: 'Prune' }), sort, node('span', { class: ui.pruneSpacer }), count, clearButton, deleteButton);
  container.append(bar);

  const list = node('div');
  const ordered = [...project.memories].sort(PRUNE_SORTS[state.pruneSort].compare);
  const rows = [];
  for (const memory of ordered) {
    const box = node('input', { type: 'checkbox', class: ui.checkbox });
    box.checked = selected.has(memory.file);
    const row = node('label', { class: ui.pruneRow(box.checked) }, [
      box,
      node('span', { class: ui.pruneMain }, [
        node('span', { class: ui.pruneName, text: memory.name }),
        node('span', { class: ui.pruneDesc, text: memory.description || memory.file }),
      ]),
      node('span', { class: ui.pruneFacts }, [
        node('span', { class: ui.pruneFact((memory.ageDays ?? 0) > 180), text: formatAge(memory.ageDays) }),
        node('span', { text: `${(memory.bytes / 1024).toFixed(1)}K` }),
        node('span', { class: ui.pruneFact(!memory.inbound.length), text: `${memory.inbound.length} in` }),
        node('span', { class: ui.pruneFact(memory.status !== 'indexed'), text: memory.status }),
      ]),
    ]);
    box.addEventListener('change', () => {
      if (box.checked) selected.add(memory.file); else selected.delete(memory.file);
      row.className = ui.pruneRow(box.checked);
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
  }
  clearButton.onclick = () => {
    selected.clear();
    renderTab();
  };
  deleteButton.onclick = () => openBulkDeleteDialog([...selected]);
  updateBar();

  const { longHooks } = project.stats.index;
  if (longHooks.length) {
    container.append(node('div', { class: ui.sectionLabel, text: `Long index hooks · ${longHooks.length}` }));
    container.append(node('p', { class: ui.noteTight, text: 'The hook is the text after the dash in MEMORY.md. It is loaded every session, so a 400-character hook costs more than the memory it points at. Shortening these is the cheapest win.' }));
    for (const hook of longHooks.slice(0, 12)) {
      const row = node('div', { class: ui.issue(false) });
      const editButton = node('button', { class: ui.buttonPrimarySmall, text: 'Edit hook' });
      row.append(
        node('div', { class: ui.issueBody }, [
          node('div', { class: ui.issueTitle, text: `${hook.hookLength} chars: ${hook.title}` }),
          node('div', { class: ui.issueDetail, text: `MEMORY.md line ${hook.index + 1} · ${hook.file}` }),
        ]),
        node('button', { class: ui.buttonSmall, text: 'Open', onclick: () => selectMemory(hook.file) }),
        editButton,
      );
      editButton.onclick = () => openHookEditor(row, hook.index);
      container.append(row);
    }
  }

  if (project.duplicates.length) {
    container.append(node('div', { class: ui.sectionLabel, text: `Possible overlap · ${project.duplicates.length}` }));
    container.append(node('p', { class: ui.noteTight, text: 'Ranked by how much rare vocabulary these pairs share. This is a hint, not a verdict - open both and decide whether one covers the other.' }));
    for (const pair of project.duplicates) {
      container.append(node('div', { class: ui.dupe }, [
        node('div', { class: ui.dupeHead }, [
          node('span', { class: ui.dupeScore, text: `${pair.score}%` }),
          node('span', { text: `shared: ${pair.shared.join(', ')}` }),
        ]),
        node('div', { class: ui.dupePair }, [
          ...[pair.a, pair.b].map((side) => node('div', {
            class: ui.dupeSide,
            onclick: () => selectMemory(side.file),
          }, [
            node('div', { class: ui.dupeSideName, text: side.name }),
            node('div', { class: ui.dupeSideDesc, text: side.description || side.file }),
          ])),
        ]),
        node('div', { class: ui.dupeActions }, [
          node('button', {
            class: ui.buttonSmall,
            text: `Merge into ${pair.a.name}`,
            onclick: () => openMergeDialog(pair.a.file, pair.b.file),
          }),
          node('button', {
            class: ui.buttonSmall,
            text: `Merge into ${pair.b.name}`,
            onclick: () => openMergeDialog(pair.b.file, pair.a.file),
          }),
        ]),
      ]));
    }
  }
}

async function openBulkDeleteDialog(files) {
  if (!files.length) return;
  const memories = files.map((file) => state.store.memories.find((m) => m.file === file)).filter(Boolean);

  const body = node('div', { class: ui.modalBody });
  const removals = node('div', { class: ui.willBlock }, [node('div', { class: ui.willTitle, text: `${memories.length} memories will be trashed` })]);
  for (const memory of memories) {
    removals.append(node('div', { class: ui.willItem('remove'), text: `${memory.file}${memory.entry ? `  ·  MEMORY.md line ${memory.entry.index + 1}` : '  ·  not in the index'}` }));
  }
  body.append(removals);

  const doomed = new Set(files);
  const breaking = [];
  for (const memory of memories) {
    for (const link of memory.inbound) {
      if (!doomed.has(link.from)) breaking.push({ from: link.from, target: link.target });
    }
  }
  if (breaking.length) {
    const block = node('div', { class: ui.willBlock }, [node('div', { class: ui.willTitle, text: `${breaking.length} link(s) from memories you are keeping will break` })]);
    for (const link of breaking) block.append(node('div', { class: ui.willItem('keep'), text: `${link.from}  →  [[${link.target}]]` }));
    body.append(block);
  }

  body.append(node('p', { class: ui.noteTight, text: 'All of them go to memory/.trash/ as one restore point.' }));

  const modal = node('div', { class: ui.modal }, [
    node('header', { class: ui.modalHead }, [node('h3', { class: ui.modalTitle, text: `Delete ${memories.length} memories?` })]),
    body,
    node('footer', { class: ui.modalFoot }, [
      node('button', { class: ui.button(), text: 'Cancel', onclick: closeModal }),
      node('button', {
        class: ui.button({ tone: 'danger' }),
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
  const backdrop = node('div', { class: ui.modalBackdrop, onclick: (event) => { if (event.target === backdrop) closeModal(); } }, [modal]);
  el('modal-root').append(backdrop);
}

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
    host.append(node('p', { class: ui.note, text: 'Nothing matched. Every word has to appear somewhere in a memory, so try fewer words.' }));
    return;
  }

  for (const group of data.stores) {
    const block = node('div', { class: ui.resultGroup });
    block.append(node('div', { class: ui.sectionLabel, text: group.sublabel
      ? `${group.label} · ${group.sublabel} · ${group.results.length}`
      : `${group.label} · ${group.results.length}` }));

    for (const result of group.results) {
      const button = node('button', {
        class: ui.result,
        onclick: () => openFromSearch(group.id, result.file),
      });
      const top = node('div', { class: ui.resultTop });
      const name = node('span', { class: ui.resultName });
      name.append(highlight(result.name, data.terms));
      top.append(name, node('span', { class: ui.typeBadge(result.type), text: result.type }));
      if (result.status !== 'indexed') top.append(node('span', { class: ui.badge('warn'), text: result.status }));
      button.append(top);

      if (result.snippet) {
        const snippet = node('div', { class: ui.resultSnippet });
        snippet.append(highlight(result.snippet.text, data.terms));
        button.append(snippet);
      }
      button.append(node('div', { class: ui.resultWhere, text: `${result.file} · matched in ${result.fields.join(', ')}` }));
      block.append(button);
    }

    for (const hit of group.indexHits) {
      const button = node('button', {
        class: ui.result,
        onclick: () => openFromSearch(group.id, hit.file, 'index'),
      });
      button.append(node('div', { class: ui.resultWhere, text: `MEMORY.md line ${hit.index + 1}` }));
      const line = node('div', { class: ui.resultSnippet });
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

function renderTab() {
  const container = el('tab-content');
  container.textContent = '';
  if (state.tab === 'memories') renderMemories(container);
  else if (state.tab === 'prune') renderPrune(container);
  else if (state.tab === 'context') renderContext(container);
  else if (state.tab === 'index') renderIndex(container);
  else if (state.tab === 'health') renderHealth(container);
  else if (state.tab === 'settings') renderSettings(container);
  else if (state.tab === 'trash') renderTrash(container);
  else if (state.tab === 'graph') {
    const wrap = node('div', { id: 'graph-wrap', class: ui.graphWrap });
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
  document.querySelector('[data-memory][data-active]')?.scrollIntoView({ block: 'nearest' });
}

async function reloadStores() {
  const data = await api('/api/stores');
  state.stores = data.stores;
  renderStores();
  return data;
}

function renderStoreHeader() {
  const store = state.store;
  el('project-title').textContent = store.label;
  el('delete-project').hidden = store.kind === 'global';

  const sub = el('project-sub');
  sub.textContent = '';

  if (store.kind === 'global') {
    sub.append(node('span', { text: store.dir }));
    sub.append(node('span', { class: ui.subNote, text: 'instructions every session loads, before any project is chosen' }));
    return;
  }

  if (store.kind !== 'auto') {
    const scope = store.kind === 'agent-user' ? 'user'
      : store.kind === 'agent-project' ? 'project' : 'local';
    sub.append(node('span', { text: store.dir }));
    sub.append(node('span', { class: ui.subNote, text: `subagent memory, ${scope} scope` }));
    if (store.kind === 'agent-project') {
      sub.append(node('span', { class: ui.subWarn, text: 'checked into the repository - changes here show up in git status' }));
    }
    return;
  }

  sub.append(node('span', { text: store.resolvedBy === 'unresolved'
    ? `${store.path}  (real path unresolved)`
    : store.path }));

  const others = (store.workingDirs || []).filter((d) => d !== store.path);
  if (others.length) {
    sub.append(node('span', { class: ui.subNote, text: `also used from ${others.join(', ')}` }));
  }
  if (store.resolvedBy === 'unresolved') {
    sub.append(node('button', { class: ui.linkButton, text: 'Remember path\u2026', onclick: openRememberPathDialog }));
  } else if (store.resolvedBy === 'remembered') {
    sub.append(node('span', { class: ui.subNote }, [
      document.createTextNode('path remembered, not recovered from a transcript  '),
      node('button', { class: ui.linkButton, text: 'Forget', onclick: forgetProjectPath }),
    ]));
  }

  const auto = store.autoMemory;
  if (auto && auto.known && !auto.enabled) {
    sub.append(node('span', { class: ui.subWarn, text: auto.scope === 'env'
      ? 'auto memory is off (CLAUDE_CODE_DISABLE_AUTO_MEMORY) - this store will not grow'
      : `auto memory is off (${auto.setBy}) - this store will not grow` }));
  }
}

async function openStore(id, { keepTab = false } = {}) {
  if (id !== state.storeId) state.pruneSelection.clear();
  state.storeId = id;
  if (!keepTab) {
    const opening = state.stores.find((store) => store.id === id);
    state.tab = opening && opening.kind === 'global' ? 'context' : 'memories';
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

  const listed = state.stores.find((store) => store.id === id);
  if (listed) listed.memoryCount = state.store.memories.length;
  renderStores();

  renderView();
  renderTabs();
  renderTab();
}

function applyCollapsed() {
  el('app').className = state.collapsed ? ui.shellCollapsed : ui.shell;
  el('sidebar').className = state.collapsed ? ui.sidebarHidden : ui.sidebar;
  el('expand').hidden = !state.collapsed;
  localStorage.setItem('sidebarCollapsed', state.collapsed ? '1' : '0');
}

function paintTheme() {
  document.documentElement.dataset.theme = state.theme;
  const dark = state.theme === 'dark';
  const button = el('theme-toggle');
  button.textContent = dark ? '\u2600' : '\u263E';
  button.title = dark ? 'Switch to the light theme  ( t )' : 'Switch to the dark theme  ( t )';
  button.setAttribute('aria-label', dark ? 'Switch to the light theme' : 'Switch to the dark theme');
  button.setAttribute('aria-pressed', String(dark));
}

function setTheme(value) {
  state.theme = value;
  localStorage.setItem('theme', value);
  paintTheme();
}

function toggleTheme() {
  setTheme(state.theme === 'dark' ? 'light' : 'dark');
}

function setCollapsed(value) {
  state.collapsed = value;
  applyCollapsed();
  if (state.tab === 'graph' && state.store) requestAnimationFrame(renderTab);
}

function applyStyles() {
  for (const element of document.querySelectorAll('[data-ui]')) {
    element.className = ui[element.dataset.ui] ?? '';
  }
}

async function init() {
  applyStyles();
  el('show-all').addEventListener('change', (event) => {
    state.showAll = event.target.checked;
    renderStores();
  });

  el('search').addEventListener('input', (event) => scheduleSearch(event.target.value));
  el('search-clear').addEventListener('click', clearSearch);
  el('collapse').addEventListener('click', () => setCollapsed(true));
  el('expand').addEventListener('click', () => setCollapsed(false));
  el('delete-project').addEventListener('click', openStoreDeleteDialog);
  el('theme-toggle').addEventListener('click', toggleTheme);
  const scheme = matchMedia('(prefers-color-scheme: dark)');
  scheme.addEventListener('change', (event) => {
    if (localStorage.getItem('theme')) return;
    state.theme = event.matches ? 'dark' : 'light';
    paintTheme();
  });
  document.addEventListener('keydown', (event) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
    if (event.key === '/' && !typing) {
      event.preventDefault();
      if (state.collapsed) setCollapsed(false);
      el('search').focus();
      el('search').select();
      return;
    }
    if (event.key === 't' && !typing) {
      event.preventDefault();
      toggleTheme();
      return;
    }
    if (event.key === 'Escape') {
      if (el('modal-root').firstChild) closeModal();
      else if (state.search !== null) clearSearch();
      else if (!state.collapsed) setCollapsed(true);
    }
  });
  applyCollapsed();
  paintTheme();

  try {
    const data = await reloadStores();
    el('root-path').textContent = data.root;
    if (data.rootSource && data.rootSource !== 'default') {
      el('root-path').title = data.rootFile
        ? `autoMemoryDirectory set in ${data.rootFile}`
        : 'store chosen with --root';
      el('root-path').append(node('span', { class: ui.rootSource, text: data.rootSource }));
    }
    if (data.rootWarning) toast(data.rootWarning, { error: true });
    const first = state.stores.find((store) => store.memoryCount > 0);
    if (first) openStore(first.id);
  } catch (err) {
    toast(err.message, { error: true });
  }
}

init();
