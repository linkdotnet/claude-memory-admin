import * as ui from '/ui.mjs';
import { el, node } from '/dom.mjs';
import { state, worstSeverity } from '/state.mjs';
import { paint } from '/bus.mjs';
import { openRememberPathDialog, forgetProjectPath } from '/dialogs/remember-path.mjs';

const TABS = [
  { id: 'memories', label: 'Memories' },
  { id: 'index', label: 'MEMORY.md' },
  { id: 'graph', label: 'Graph' },
  { id: 'prune', label: 'Prune' },
  { id: 'context', label: 'Context' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'health', label: 'Health' },
  { id: 'settings', label: 'Settings' },
  { id: 'trash', label: 'Trash' },
];

export function renderTabs() {
  const container = el('tabs');
  container.textContent = '';
  const global = state.store.kind === 'global';
  const hasProjectDir = state.store.kind === 'auto'
    ? state.store.resolvedBy !== 'unresolved'
    : Boolean(state.store.projectPath);

  for (const tab of TABS) {
    if (global && tab.id !== 'context') continue;
    if (!global && tab.id === 'context' && !hasProjectDir) continue;
    if (tab.id === 'sessions' && !state.store.sessions?.count) continue;
    let badge = null;
    let tone = 'neutral';
    if (tab.id === 'memories') badge = String(state.store.memories.length);
    if (tab.id === 'trash' && state.store.trash.length) badge = String(state.store.trash.length);
    if (tab.id === 'health' && state.store.health.issueCount) {
      badge = String(state.store.health.issueCount);
      tone = state.store.health.severity;
    }
    if (tab.id === 'prune' && state.store.stats.index.level !== 'ok') {
      badge = '!';
      tone = state.store.stats.index.level === 'over' ? 'bad' : 'warn';
    }
    if (tab.id === 'sessions' && state.store.sessions) {
      badge = String(state.store.sessions.count);
      if (state.store.sessions.expiringCount) tone = 'warn';
    }
    if (tab.id === 'context' && state.aux.instructions?.problems.length) {
      badge = String(state.aux.instructions.problems.length);
      tone = worstSeverity(state.aux.instructions.problems);
    }
    if (tab.id === 'settings' && state.aux.settings?.problems.length) {
      badge = String(state.aux.settings.problems.length);
      tone = worstSeverity(state.aux.settings.problems);
    }

    container.append(node('button', {
      class: ui.tab(state.tab === tab.id),
      onclick: () => { state.tab = tab.id; paint('tabs', 'tab'); },
    }, [
      document.createTextNode(tab.label),
      badge ? node('span', { class: ui.tabBadge(tone), text: badge }) : null,
    ]));
  }
}

export function renderStoreHeader() {
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

  const evidence = store.sessions?.evidenceExpiresInDays;
  if (!store.sessions?.remembered
      && (store.resolvedBy === 'transcript' || store.resolvedBy === 'repo-root')
      && typeof evidence === 'number' && evidence <= 14) {
    sub.append(node('span', { class: ui.subWarn }, [
      document.createTextNode(evidence === 0
        ? 'the last transcript proving this path is due to be swept - the store keeps its memories and loses its name  '
        : `the last transcript proving this path is swept in ${evidence} days, and nothing else records it  `),
      node('button', { class: ui.linkButton, text: 'Remember path\u2026', onclick: openRememberPathDialog }),
    ]));
  }

  const auto = store.autoMemory;
  if (auto && auto.known && !auto.enabled) {
    sub.append(node('span', { class: ui.subWarn, text: auto.scope === 'env'
      ? 'auto memory is off (CLAUDE_CODE_DISABLE_AUTO_MEMORY) - this store will not grow'
      : `auto memory is off (${auto.setBy}) - this store will not grow` }));
  }
}
