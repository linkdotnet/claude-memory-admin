import * as ui from '/ui.mjs';
import { el, node } from '/dom.mjs';
import { state, worstSeverity } from '/state.mjs';
import { paint } from '/bus.mjs';
import { buildWorklist } from '/views/worklist.mjs';
import { openRememberPathDialog, forgetProjectPath } from '/dialogs/remember-path.mjs';

const NAVIGATION = [
  {
    id: 'memory',
    label: 'Memory',
    segments: [
      { id: 'list', label: 'List' },
      { id: 'index', label: 'MEMORY.md' },
      { id: 'graph', label: 'Graph' },
    ],
  },
  { id: 'cleanup', label: 'Cleanup', segments: [] },
  {
    id: 'environment',
    label: 'Environment',
    segments: [
      { id: 'instructions', label: 'Instructions' },
      { id: 'settings', label: 'Settings' },
      { id: 'cost', label: 'Cost' },
      { id: 'sessions', label: 'Sessions' },
      { id: 'tools', label: 'Tools' },
    ],
  },
];

const hasProjectDir = (store) => (store.kind === 'auto'
  ? store.resolvedBy !== 'unresolved'
  : Boolean(store.projectPath));

function segmentVisible(tab, segment, store) {
  const global = store.kind === 'global';
  if (tab === 'memory') {
    if (global) return false;
    return segment === 'index' ? Boolean(store.hasIndex) : true;
  }
  if (segment === 'instructions') return global || hasProjectDir(store);
  if (segment === 'cost') return global;
  if (segment === 'tools') return state.tools.length > 0;
  if (global) return false;
  if (segment === 'sessions') return Boolean(store.sessions?.count);
  return true;
}

export const costProblems = () => {
  const data = state.aux.cost;
  if (!data) return [];
  return [
    ...(data.settings?.problems || []),
    ...(data.agents || []).flatMap((agent) => agent.problems || []),
  ];
};

function segmentBadge(id) {
  if (id === 'cost') {
    const problems = costProblems();
    return problems.length ? { badge: String(problems.length), tone: worstSeverity(problems) } : {};
  }
  if (id === 'instructions') {
    const problems = state.aux.instructions?.problems || [];
    return problems.length ? { badge: String(problems.length), tone: worstSeverity(problems) } : {};
  }
  if (id === 'settings') {
    const problems = state.aux.settings?.problems || [];
    return problems.length ? { badge: String(problems.length), tone: worstSeverity(problems) } : {};
  }
  if (id === 'sessions') {
    const sessions = state.store.sessions;
    if (!sessions) return {};
    const live = state.activeSessions.some((s) => s.storeId === state.store.id);
    const badge = live ? `● ${sessions.count}` : String(sessions.count);
    return { badge, tone: live ? 'ok' : sessions.expiringCount ? 'warn' : 'neutral' };
  }
  return {};
}

export function segmentsFor(tab) {
  const entry = NAVIGATION.find((item) => item.id === tab);
  if (!entry || !state.store) return [];
  return entry.segments
    .filter((segment) => segmentVisible(tab, segment.id, state.store))
    .map((segment) => ({ ...segment, ...segmentBadge(segment.id) }));
}

function tabVisible(tab, store) {
  if (tab === 'cleanup') return store.kind !== 'global';
  return segmentsFor(tab).length > 0;
}

function tabBadge(tab, store) {
  if (tab === 'memory') return { badge: String(store.memories.length), tone: 'neutral' };

  if (tab === 'cleanup') {
    const count = buildWorklist(store).length;
    if (!count) return {};
    const level = store.stats ? store.stats.index.level : 'ok';
    const bad = level === 'over' || store.health.severity === 'bad';
    return { badge: String(count), tone: bad ? 'bad' : 'warn' };
  }

  const problems = [
    ...(state.aux.instructions?.problems || []),
    ...(state.aux.settings?.problems || []),
    ...costProblems(),
  ];
  return problems.length ? { badge: String(problems.length), tone: worstSeverity(problems) } : {};
}

function undoControl() {
  const count = state.store.trash?.length || 0;
  const button = el('undo');
  button.hidden = state.store.kind === 'global' || !count;
  button.textContent = '';
  button.append(
    document.createTextNode('\u21ba Undo'),
    node('span', { class: ui.tabBadge('neutral'), text: String(count) }),
  );
}

export function renderTabs() {
  const container = el('tabs');
  container.textContent = '';
  undoControl();

  for (const entry of NAVIGATION) {
    if (!tabVisible(entry.id, state.store)) continue;
    const { badge, tone } = tabBadge(entry.id, state.store);

    container.append(node('button', {
      class: ui.tab(state.tab === entry.id),
      onclick: () => { state.tab = entry.id; paint('tabs', 'tab'); },
    }, [
      document.createTextNode(entry.label),
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
