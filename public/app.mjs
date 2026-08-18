import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import { renderGraph } from '/graph.mjs';

marked.setOptions({ gfm: true, breaks: false });

const state = {
  projects: [],
  slug: null,
  project: null,
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

function renderProjects() {
  const list = el('project-list');
  list.textContent = '';

  const visible = state.projects.filter((p) => state.showAll || p.hasMemoryDir);
  if (!visible.length) {
    list.append(node('p', { class: 'muted', text: 'No projects found.', style: 'padding:12px' }));
    return;
  }

  for (const project of visible) {
    const health = project.memoryCount === 0 ? 'none' : 'ok';
    const button = node('button', {
      class: `project${project.slug === state.slug ? ' active' : ''}${project.hasMemoryDir ? '' : ' dim'}`,
      onclick: () => openProject(project.slug),
      title: project.resolvedBy === 'unresolved'
        ? 'Real path could not be resolved - showing the raw folder name'
        : project.path,
    }, [
      node('span', { class: 'project-row' }, [
        node('span', { class: `dot ${health}` }),
        node('span', { class: 'project-name', text: project.label }),
        node('span', { class: 'project-count', text: project.hasMemoryDir ? String(project.memoryCount) : '-' }),
      ]),
      node('span', { class: 'project-path', text: project.path }),
    ]);
    list.append(button);
  }
}

/* ------------------------------------------------------------------ tabs */

const TABS = [
  { id: 'memories', label: 'Memories' },
  { id: 'index', label: 'MEMORY.md' },
  { id: 'graph', label: 'Graph' },
  { id: 'prune', label: 'Prune' },
  { id: 'health', label: 'Health' },
  { id: 'trash', label: 'Trash' },
];

function renderTabs() {
  const container = el('tabs');
  container.textContent = '';
  for (const tab of TABS) {
    let badge = null;
    if (tab.id === 'memories') badge = String(state.project.memories.length);
    if (tab.id === 'health' && state.project.health.issueCount) badge = String(state.project.health.issueCount);
    if (tab.id === 'trash' && state.project.trash.length) badge = String(state.project.trash.length);
    if (tab.id === 'prune' && state.project.stats.index.overTarget) badge = '!';

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
  const project = state.project;
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

  const memory = state.project.memories.find((m) => m.file === state.selected);
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
    ['modified', memory.modified ? memory.modified.replace('T', ' ').replace(/\..*$/, '') : '-'],
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
  renderBody(body, memory, state.project);

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
        const source = state.project.memories.find((m) => m.file === link.from);
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
  const project = state.project;
  if (!project.hasIndex) {
    container.append(node('p', { class: 'muted', text: 'This project has no MEMORY.md.' }));
    return;
  }

  const missing = new Set(project.health.danglingIndex.map((d) => d.index));
  const card = node('div', { class: 'card' });
  card.append(node('p', { class: 'muted', style: 'margin-top:0', text: `${project.index.entries.length} index entries · ${project.index.lines.length} lines` }));

  for (const line of project.index.lines) {
    const row = node('div', {
      class: `index-line kind-${line.kind}${missing.has(line.index) ? ' dangling' : ''}`,
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
  const { health, memories } = state.project;
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
              await api(`/api/projects/${encodeURIComponent(state.slug)}/index-line/delete`, {
                method: 'POST',
                body: JSON.stringify({ lineIndex: entry.index, expectedText: entry.text }),
              });
              toast('Pointer removed');
              await openProject(state.slug, { keepTab: true });
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
              const result = await api(`/api/projects/${encodeURIComponent(state.slug)}/wikilink/remove`, {
                method: 'POST',
                body: JSON.stringify({ file: link.from, target: link.target }),
              });
              await openProject(state.slug, { keepTab: true });
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
    const result = await api(`/api/projects/${encodeURIComponent(state.slug)}/restore`, {
      method: 'POST',
      body: JSON.stringify({ id }),
    });
    await openProject(state.slug, { keepTab: true });
    toast(result.indexRestored === 'appended'
      ? 'Restored, but MEMORY.md had changed - the index line was appended at the end'
      : 'Restored');
  } catch (err) {
    toast(err.message, { error: true });
  }
}

/* --------------------------------------------------------------- trash */

function renderTrash(container) {
  const trash = state.project.trash;
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
    preview = await api(`/api/projects/${encodeURIComponent(state.slug)}/delete-preview`, {
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
            const result = await api(`/api/projects/${encodeURIComponent(state.slug)}/delete`, {
              method: 'POST',
              body: JSON.stringify({ file, alsoDelete: [...cascade] }),
            });
            if (state.selected === file || cascade.has(state.selected)) state.selected = null;
            await openProject(state.slug, { keepTab: true });
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

async function openProjectDeleteDialog() {
  let preview;
  try {
    preview = await api(`/api/projects/${encodeURIComponent(state.slug)}/project/delete-preview`, { method: 'POST' });
  } catch (err) {
    return toast(err.message, { error: true });
  }

  if (!preview.files.length && !preview.hasIndex) {
    return toast('This project has no memory to delete');
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
    node('div', { class: 'will-item keep', text: 'Session transcripts (*.jsonl) and the project folder itself' }),
  ]));

  body.append(node('p', { class: 'muted', style: 'margin:0;font-size:12.5px', text: 'Everything moves to memory/.trash/ as one restore point, so the whole project can be put back in a single step from the Trash tab.' }));

  const modal = node('div', { class: 'modal' }, [
    node('header', {}, [
      node('h3', { text: `Delete all memory for ${state.project.label}?` }),
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
            const result = await api(`/api/projects/${encodeURIComponent(state.slug)}/project/delete`, { method: 'POST' });
            state.selected = null;
            await openProject(state.slug, { keepTab: true });
            toast(`Cleared ${state.project.label}`, {
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
  const { index } = state.project.stats;
  const percent = Math.min(100, index.worstPercent);
  const level = index.level === 'over' ? 'way-over' : index.level === 'near' ? 'over' : '';

  const note = index.level === 'over'
    ? 'Over the limit. Everything past the cutoff is dropped when the session loads it, so those entries are effectively invisible to Claude right now.'
    : index.level === 'near'
      ? 'Approaching the limit. Once MEMORY.md passes it, everything after the cutoff stops being loaded at all.'
      : 'Comfortably inside the limit. MEMORY.md is loaded at the start of every session.';

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
  const project = state.project;
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
  const memories = files.map((file) => state.project.memories.find((m) => m.file === file)).filter(Boolean);

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
            const result = await api(`/api/projects/${encodeURIComponent(state.slug)}/delete-many`, {
              method: 'POST',
              body: JSON.stringify({ files, label: `${memories.length} pruned memories` }),
            });
            state.pruneSelection.clear();
            if (doomed.has(state.selected)) state.selected = null;
            await openProject(state.slug, { keepTab: true });
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

  if (!data.total && !data.projects.length) {
    host.append(node('p', { class: 'muted', text: 'Nothing matched. Every word has to appear somewhere in a memory, so try fewer words.' }));
    return;
  }

  for (const group of data.projects) {
    const block = node('div', { class: 'result-group' });
    block.append(node('div', { class: 'section-label', text: `${group.label} · ${group.results.length}` }));

    for (const result of group.results) {
      const button = node('button', {
        class: 'result',
        onclick: () => openFromSearch(group.slug, result.file),
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
        onclick: () => openFromSearch(group.slug, hit.file, 'index'),
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

async function openFromSearch(slug, file, tab = 'memories') {
  clearSearch();
  if (slug !== state.slug) await openProject(slug);
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
  el('project-view').hidden = searching || !state.project;
  el('empty-state').hidden = searching || Boolean(state.project);
  if (searching) renderSearch();
}

/* ------------------------------------------------------------ rendering */

function renderTab() {
  const container = el('tab-content');
  container.textContent = '';
  if (state.tab === 'memories') renderMemories(container);
  else if (state.tab === 'prune') renderPrune(container);
  else if (state.tab === 'index') renderIndex(container);
  else if (state.tab === 'health') renderHealth(container);
  else if (state.tab === 'trash') renderTrash(container);
  else if (state.tab === 'graph') {
    const wrap = node('div', { id: 'graph-wrap' });
    container.append(wrap);
    renderGraph(wrap, state.project.graph, {
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

async function openProject(slug, { keepTab = false } = {}) {
  if (slug !== state.slug) state.pruneSelection.clear();
  state.slug = slug;
  if (!keepTab) {
    state.tab = 'memories';
    state.selected = null;
  }
  renderProjects();

  try {
    state.project = await api(`/api/projects/${encodeURIComponent(slug)}`);
  } catch (err) {
    return toast(err.message, { error: true });
  }

  if (state.selected && !state.project.memories.some((m) => m.file === state.selected)) {
    state.selected = null;
  }

  el('project-title').textContent = state.project.label;
  el('project-sub').textContent = state.project.resolvedBy === 'unresolved'
    ? `${state.project.path}  (real path unresolved)`
    : state.project.path;

  // Refresh the sidebar count in case a delete changed it.
  const listed = state.projects.find((p) => p.slug === slug);
  if (listed) listed.memoryCount = state.project.memories.length;
  renderProjects();

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
  if (state.tab === 'graph' && state.project) requestAnimationFrame(renderTab);
}

async function init() {
  el('show-all').addEventListener('change', (event) => {
    state.showAll = event.target.checked;
    renderProjects();
  });

  el('search').addEventListener('input', (event) => scheduleSearch(event.target.value));
  el('search-clear').addEventListener('click', clearSearch);
  el('collapse').addEventListener('click', () => setCollapsed(true));
  el('expand').addEventListener('click', () => setCollapsed(false));
  el('delete-project').addEventListener('click', openProjectDeleteDialog);
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
    const data = await api('/api/projects');
    state.projects = data.projects;
    el('root-path').textContent = data.root;
    renderProjects();
    const first = state.projects.find((p) => p.memoryCount > 0);
    if (first) openProject(first.slug);
  } catch (err) {
    toast(err.message, { error: true });
  }
}

init();
