export const SEGMENT_STORAGE = {
  memory: 'navMemorySegment',
  environment: 'navEnvironmentSegment',
};

const SEGMENTS = {
  memory: ['list', 'index', 'graph'],
  environment: ['instructions', 'settings', 'sessions'],
};

const storedSegment = (tab) => {
  const value = localStorage.getItem(SEGMENT_STORAGE[tab]);
  return SEGMENTS[tab].includes(value) ? value : SEGMENTS[tab][0];
};

const LIST_SORTS = ['section', 'oldest', 'largest', 'unlinked', 'name'];
const storedListSort = () => {
  const value = localStorage.getItem('memoryListSort');
  return LIST_SORTS.includes(value) ? value : 'section';
};

export const state = {
  stores: [],
  storeId: null,
  store: null,
  tab: 'memory',
  segment: {
    memory: storedSegment('memory'),
    environment: storedSegment('environment'),
  },
  selected: null,
  showAll: false,
  collapsed: localStorage.getItem('sidebarCollapsed') === '1',
  theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  spread: Number(localStorage.getItem('graphSpread')) || 1.6,
  query: '',
  search: null,
  listSort: storedListSort(),
  listSelection: new Set(),
  selecting: false,
  indexView: localStorage.getItem('memoryIndexView') === 'source' ? 'source' : 'rendered',
  aux: { instructions: null, settings: null, sessions: null, sessionDay: null },
  pathCheck: null,
};

const RANK = { ok: 0, warn: 1, bad: 2 };
export const worst = (...severities) => severities.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok');
export const worstSeverity = (items) => (!items.length ? 'ok' : items.some((item) => item.severity === 'bad') ? 'bad' : 'warn');
