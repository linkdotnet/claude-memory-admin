export const state = {
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
  aux: { instructions: null, settings: null, sessions: null, sessionDay: null },
  pathCheck: null,
};

const RANK = { ok: 0, warn: 1, bad: 2 };
export const worst = (...severities) => severities.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok');
export const worstSeverity = (items) => (!items.length ? 'ok' : items.some((item) => item.severity === 'bad') ? 'bad' : 'warn');
