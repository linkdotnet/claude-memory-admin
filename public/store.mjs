import { api, toast } from '/api.mjs';
import { state, worst, worstSeverity } from '/state.mjs';
import { paint } from '/bus.mjs';
import { closeDialog } from '/dialog.mjs';
import { goTo } from '/parts.mjs';

export async function openStore(id, { keepTab = false } = {}) {
  if (id !== state.storeId) {
    state.listSelection.clear();
    state.selecting = false;
  }
  state.storeId = id;
  state.aux = { instructions: null, settings: null, sessions: null, sessionDay: null, sessionFocus: null, tools: null };
  state.pathCheck = null;
  if (!keepTab) {
    const opening = state.stores.find((store) => store.id === id);
    state.tab = opening && opening.kind === 'global' ? 'environment' : 'memory';
    state.selected = null;
  }
  paint('stores');

  try {
    state.store = await api(`/api/stores/${encodeURIComponent(id)}`);
  } catch (err) {
    return toast(err.message, { error: true });
  }

  if (state.selected && !state.store.memories.some((m) => m.file === state.selected)) {
    state.selected = null;
  }

  paint('header');

  const listed = state.stores.find((store) => store.id === id);
  if (listed) {
    listed.memoryCount = state.store.memories.length;
    listed.issueCount = state.store.health.issueCount;
    listed.severity = worst(state.store.health.severity, listed.context ? 'warn' : 'ok', listed.settings ? 'warn' : 'ok');
  }
  paint('stores');

  paint('view');
  paint('tabs', 'tab');

  Promise.all([
    api(`/api/stores/${encodeURIComponent(id)}/instructions`).catch(() => null),
    api(`/api/stores/${encodeURIComponent(id)}/settings`).catch(() => null),
  ]).then(([instructions, settings]) => {
    if (state.storeId !== id) return;
    state.aux = { ...state.aux, instructions, settings };
    paint('tabs');
    if (!listed) return;
    listed.context = instructions ? instructions.problems.length : 0;
    listed.settings = settings ? settings.problems.length : 0;
    listed.severity = worst(
      state.store.health.severity,
      instructions ? worstSeverity(instructions.problems) : 'ok',
      settings ? worstSeverity(settings.problems) : 'ok',
    );
    paint('stores');
  });
}

export async function reloadStores() {
  const data = await api('/api/stores');
  state.stores = data.stores;
  state.tools = data.tools || [];
  state.version = data.version || null;
  paint('stores');
  sweepIssues();
  return data;
}

export async function sweepIssues() {
  let data;
  try {
    data = await api('/api/stores/issues');
  } catch {
    return;
  }
  const bySummary = new Map(data.stores.map((summary) => [summary.id, summary]));
  for (const store of state.stores) Object.assign(store, bySummary.get(store.id) || {});
  paint('stores');
}

export function selectMemory(file) {
  state.selected = file;
  if (state.tab !== 'memory' || state.segment.memory !== 'list') {
    goTo('memory', 'list');
  } else {
    paint('tab');
  }
  document.querySelector('[data-memory][data-active]')?.scrollIntoView({ block: 'nearest' });
}

export async function loadSessionsForProvenance() {
  if (state.aux.sessions || !state.store?.sessions?.count) return;
  const id = state.storeId;
  try {
    const data = await api(`/api/stores/${encodeURIComponent(id)}/sessions`);
    if (state.storeId !== id) return;
    state.aux.sessions = data;
    paint('tab');
  } catch {
    return;
  }
}

export async function restoreFromTrash(id, { close = false } = {}) {
  if (close) closeDialog();
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
