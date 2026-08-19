import { renderGraph } from '/graph.mjs';
import { isDialogOpen } from '/dialog.mjs';
import { el, node } from '/dom.mjs';
import * as ui from '/ui.mjs';
import { state } from '/state.mjs';
import { toast } from '/api.mjs';
import { register, paint } from '/bus.mjs';
import { openStore, reloadStores, selectMemory } from '/store.mjs';
import { renderStores } from '/views/stores.mjs';
import { renderTabs, renderStoreHeader } from '/views/header.mjs';
import { renderMemories } from '/views/memories.mjs';
import { renderIndex } from '/views/index.mjs';
import { renderContext } from '/views/context.mjs';
import { renderHealth } from '/views/health.mjs';
import { renderSessions } from '/views/sessions.mjs';
import { renderSettings } from '/views/settings.mjs';
import { renderTrash } from '/views/trash.mjs';
import { renderPrune } from '/views/prune.mjs';
import { renderSearch, scheduleSearch, clearSearch } from '/views/search.mjs';
import { openStoreDeleteDialog } from '/dialogs/store-delete.mjs';

const TAB_VIEWS = {
  memories: renderMemories,
  prune: renderPrune,
  context: renderContext,
  sessions: renderSessions,
  index: renderIndex,
  health: renderHealth,
  settings: renderSettings,
  trash: renderTrash,
};

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
  const view = TAB_VIEWS[state.tab];
  if (view) return view(container);
  if (state.tab !== 'graph') return;

  const wrap = node('div', { id: 'graph-wrap', class: ui.graphWrap });
  container.append(wrap);
  renderGraph(wrap, state.store.graph, {
    selected: state.selected,
    spread: state.spread,
    onSelect: (file) => selectMemory(file),
    onSpreadChange: (value) => {
      state.spread = value;
      localStorage.setItem('graphSpread', String(value));
      paint('tab');
    },
  });
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
  button.textContent = dark ? '☀' : '☾';
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
  if (state.tab === 'graph' && state.store) requestAnimationFrame(() => paint('tab'));
}

function applyStyles() {
  for (const element of document.querySelectorAll('[data-ui]')) {
    element.className = ui[element.dataset.ui] ?? '';
  }
}

function registerRegions() {
  register('stores', renderStores);
  register('header', renderStoreHeader);
  register('tabs', renderTabs);
  register('tab', renderTab);
  register('view', renderView);
}

async function init() {
  registerRegions();
  applyStyles();
  el('show-all').addEventListener('change', (event) => {
    state.showAll = event.target.checked;
    paint('stores');
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
    if (isDialogOpen()) return;
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
      if (state.search !== null) clearSearch();
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
