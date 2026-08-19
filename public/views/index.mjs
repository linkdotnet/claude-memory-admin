import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { renderMarkdown } from '/markdown.mjs';
import { api, toast } from '/api.mjs';
import { state } from '/state.mjs';
import { paint } from '/bus.mjs';
import { openStore, selectMemory, restoreFromTrash } from '/store.mjs';
import { cutMarker } from '/parts.mjs';
import { memoryLookup, openTarget } from '/views/memories.mjs';

const INDEX_VIEWS = [
  { id: 'rendered', label: 'Rendered' },
  { id: 'source', label: 'Source' },
];

function setIndexView(view) {
  state.indexView = view;
  localStorage.setItem('memoryIndexView', view);
  paint('tab');
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

export function renderIndex(container) {
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

export function indexEntryAt(lineIndex) {
  return state.store.index?.entries.find((entry) => entry.index === lineIndex) || null;
}

export function sectionsAbove(limit) {
  const seen = [];
  for (const line of state.store.index?.lines || []) {
    if (line.kind !== 'heading') continue;
    if (limit !== null && line.index >= limit) continue;
    if (line.section && !seen.includes(line.section)) seen.push(line.section);
  }
  return seen;
}

export async function runIndexEdit(action, body, message) {
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
