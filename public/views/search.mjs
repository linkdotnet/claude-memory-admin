import * as ui from '/ui.mjs';
import { el, node } from '/dom.mjs';
import { api, toast } from '/api.mjs';
import { state } from '/state.mjs';
import { paint } from '/bus.mjs';
import { highlight } from '/parts.mjs';
import { openStore } from '/store.mjs';

let searchTimer = null;

export function scheduleSearch(value) {
  state.query = value;
  clearTimeout(searchTimer);
  if (!value.trim()) {
    state.search = null;
    paint('view');
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
  paint('view');
}

export function renderSearch() {
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
  paint('tabs', 'tab');
}

export function clearSearch() {
  state.query = '';
  state.search = null;
  el('search').value = '';
  paint('view');
}
