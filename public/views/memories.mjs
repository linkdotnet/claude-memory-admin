import * as ui from '/ui.mjs';
import { el, node } from '/dom.mjs';
import { renderMarkdown } from '/markdown.mjs';
import { state } from '/state.mjs';
import { selectMemory, loadSessionsForProvenance } from '/store.mjs';
import { goTo, sessionDate } from '/parts.mjs';
import { openDeleteDialog } from '/dialogs/delete.mjs';
import { renderMemoryList } from '/views/memory-list.mjs';

export function memoryLookup(project) {
  const byName = new Map();
  for (const memory of project.memories) {
    byName.set(memory.name, memory.file);
    byName.set(memory.stem, memory.file);
  }
  return byName;
}

export function openTarget(file) {
  return file ? { open: () => selectMemory(file) } : null;
}

export function renderBody(container, memory, project) {
  const byName = memoryLookup(project);
  renderMarkdown(container, memory.body, {
    resolveWikilink: (target) => openTarget(byName.get(target)),
  });
}

export function renderMemories(container) {
  const project = state.store;
  if (!project.memories.length) {
    container.append(node('p', { class: ui.note, text: 'This project has no memory files yet.' }));
    return;
  }

  const left = node('div');
  renderMemoryList(left);

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
    if (key !== 'type' && key !== 'modified' && key !== 'originSessionId') rows.push([key, value]);
  }
  for (const [key, value] of rows) {
    meta.append(node('dt', { class: ui.metaKey, text: key }), node('dd', { class: ui.metaValue, text: String(value) }));
  }
  card.append(meta);

  const origin = provenanceLine(memory);
  if (origin) card.append(origin);

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

function provenanceLine(memory) {
  const origin = memory.origin;
  if (!origin) return null;

  const known = state.aux.sessions?.sessions.find((session) => session.id === origin.sessionId);
  const label = origin.present ? (known?.title || origin.sessionId) : origin.sessionId;

  const row = node('div', { class: ui.provenanceRow }, [node('span', { text: 'written in' })]);

  if (origin.present) {
    row.append(node('button', {
      class: ui.provenanceLink(true),
      text: label,
      title: 'Open Environment \u203a Sessions',
      onclick: () => goTo('environment', 'sessions'),
    }));
    if (known?.gitBranch) row.append(node('span', { text: `on ${known.gitBranch}` }));
    if (origin.modified) row.append(node('span', { text: sessionDate(origin.modified).slice(0, 10) }));
    if (!known) loadSessionsForProvenance();
  } else {
    row.append(node('span', {
      class: ui.provenanceLink(false),
      text: label,
      title: 'This transcript is no longer on disk',
    }));
    row.append(node('span', { text: '- transcript swept, so why this memory exists can no longer be traced' }));
  }
  return row;
}
