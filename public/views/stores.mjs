import * as ui from '/ui.mjs';
import { el, node } from '/dom.mjs';
import { state } from '/state.mjs';
import { openStore } from '/store.mjs';

function storeSubtitle(store) {
  if (store.kind === 'global') return store.dir;
  if (store.kind === 'auto') return store.path;
  const scope = store.kind === 'agent-user' ? 'user'
    : store.kind === 'agent-project' ? 'project' : 'local';
  return `${scope} · ${store.sublabel}`;
}

function agentMarker(store) {
  if (!String(store.kind).startsWith('agent-') || !store.linkage) return null;
  if (store.inert) {
    return { text: 'inert', title: `Auto memory is off${store.inertBy ? ` (${store.inertBy})` : ''}, so the memory: field has no effect and this store is frozen.` };
  }
  if (store.linked) return null;
  if (store.declaredScope) {
    return {
      text: 'moved',
      title: `${store.agentName} now declares memory: ${store.declaredScope}, so the live store is elsewhere and this one is stale.`,
    };
  }
  return {
    text: 'orphan',
    title: store.defined
      ? `${store.agentName} exists but declares no memory: field any more, so nothing loads this store.`
      : `No agent named ${store.agentName} was found in any scope, so nothing loads this store.`,
  };
}

function issueTitle(store) {
  const parts = [];
  if (store.issueCount) parts.push(`${store.issueCount} to fix in Cleanup`);
  const environment = (store.context || 0) + (store.settings || 0);
  if (environment) parts.push(`${environment} in Environment`);
  if (store.kind === 'auto' && store.resolvedBy === 'unresolved') {
    parts.push('Real path could not be resolved - showing the raw folder name');
  }
  return parts.length ? `${store.dir}\n${parts.join(', ')}` : store.dir;
}

function activeTitle(active) {
  const waiting = active.filter((s) => s.status === 'waiting').length;
  const label = active.length === 1 ? '1 session' : `${active.length} sessions`;
  return waiting ? `${label} - ${waiting} waiting for input` : `${label} ${active.length === 1 ? 'is' : 'are'} busy`;
}

function storeButton(store) {
  const global = store.kind === 'global';
  const health = !global && !store.hasMemoryDir ? 'none' : store.severity || 'ok';
  const off = store.autoMemory && store.autoMemory.known && !store.autoMemory.enabled;
  const marker = agentMarker(store);
  const active = state.activeSessions.filter((s) => s.storeId === store.id);
  return node('button', {
    class: ui.storeItem({ active: store.id === state.storeId, empty: !global && !store.hasMemoryDir }),
    onclick: () => openStore(store.id),
    title: issueTitle(store),
  }, [
    node('span', { class: ui.storeRow }, [
      node('span', { class: ui.dot(health) }),
      node('span', { class: ui.storeName, text: store.label }),
      active.length ? node('span', { class: ui.dot('ok'), title: activeTitle(active) }) : null,
      off ? node('span', { class: ui.offMarker, text: 'off', title: 'Auto memory is disabled for this project' }) : null,
      marker ? node('span', { class: ui.offMarker, text: marker.text, title: marker.title }) : null,
      global ? null : node('span', { class: ui.storeCount, text: store.hasMemoryDir ? String(store.memoryCount) : '-' }),
    ]),
    node('span', { class: ui.storePath, text: storeSubtitle(store) }),
  ]);
}

export function renderStores() {
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
