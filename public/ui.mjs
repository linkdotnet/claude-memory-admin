const cx = (...parts) => parts.filter(Boolean).join(' ');

const pick = (map, key, fallback) => map[key] ?? map[fallback];

const controlPad = {
  sm: 'min-h-control-h-sm px-control-x-sm py-control-y-sm',
  md: 'min-h-control-h-md px-control-x-md py-control-y-md',
  lg: 'min-h-control-h-lg px-control-x-lg py-control-y-lg',
};

export const shell = 'grid h-screen grid-cols-[280px_1fr] bg-canvas';
export const shellCollapsed = 'grid h-screen grid-cols-1 bg-canvas';

export const sidebar = 'flex flex-col overflow-hidden border-r border-line bg-surface';
export const sidebarHidden = 'hidden';
export const sidebarHead = 'border-b border-line p-4';
export const sidebarTitle = 'font-mono text-sm font-semibold tracking-tightest text-fg';
export const sidebarRoot = 'mt-1 mb-2.5 font-mono text-2xs break-all text-fg-muted';
export const sidebarList = 'flex-1 overflow-y-auto p-2';
export const sidebarGroup = 'px-2 pt-3 pb-1 font-mono text-2xs font-semibold uppercase tracking-widest text-fg-subtle';
export const sidebarFoot = 'border-t border-line p-4';
export const sidebarCredit = 'flex flex-col gap-1.5 text-2xs text-fg-subtle no-underline transition-colors hover:text-fg';
export const sidebarLogo = 'w-24 opacity-60 transition-opacity dark:invert';
export const sidebarFootRow = 'flex items-end justify-between gap-3';
export const themeToggle = cx('inline-flex flex-none cursor-pointer items-center justify-center rounded-md border border-line bg-surface font-sans text-base leading-none text-fg-muted transition-colors hover:border-line-strong hover:text-fg', 'min-w-control-h-sm', controlPad.sm);

export const toggleLabel = 'flex cursor-pointer items-center gap-1.5 text-xs text-fg-muted';
export const checkbox = 'accent-accent';

export const searchInput = cx('w-full rounded-md border border-line bg-surface-sunken font-mono text-xs text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none', controlPad.lg);

const storeItemBase = 'mb-0.5 block w-full cursor-pointer rounded-md border border-transparent px-2.5 py-2 text-left transition-colors';
const storeItemState = {
  active: 'border-accent-line bg-accent-surface',
  idle: 'hover:bg-surface-sunken',
  empty: 'opacity-50 hover:bg-surface-sunken',
};
export const storeItem = ({ active = false, empty = false } = {}) =>
  cx(storeItemBase, active ? storeItemState.active : empty ? storeItemState.empty : storeItemState.idle);

export const storeRow = 'flex items-baseline gap-2';
export const storeName = 'flex-1 truncate text-sm font-medium text-fg';
export const storeCount = 'font-mono text-2xs text-fg-subtle';
export const storePath = 'block truncate font-mono text-2xs text-fg-subtle';

const dotBase = 'inline-block size-1.5 flex-none rounded-full';
const dotTone = { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-danger', none: 'bg-line-strong' };
export const dot = (tone) => cx(dotBase, pick(dotTone, tone, 'none'));

export const offMarker = 'rounded-sm bg-warn-surface px-1 py-px font-mono text-2xs uppercase tracking-widest text-warn';
export const rootSource = 'ml-1.5 rounded-sm bg-accent-surface px-1 py-px font-mono text-2xs uppercase tracking-widest text-accent';

export const main = 'overflow-y-auto';
export const emptyState = 'px-10 py-[15vh] text-center text-fg-muted';
export const emptyTitle = 'mb-2 text-xl font-semibold tracking-tightest text-fg';

export const projectHead = 'sticky top-0 z-10 border-b border-line bg-canvas px-7 pt-5';
export const projectHeadRow = 'flex items-center gap-3';
export const projectTitle = 'flex-1 text-xl font-semibold tracking-tightest text-fg';
export const projectSub = 'mt-1 mb-3.5 font-mono text-2xs break-all text-fg-muted [&>span]:block';
export const subNote = 'mt-0.5 text-2xs text-fg-subtle';
export const subWarn = 'mt-0.5 text-2xs text-warn';

export const tabBar = 'flex gap-0.5';
const tabBase = cx('-mb-px cursor-pointer border-b-2 font-mono text-xs uppercase tracking-widest transition-colors', controlPad.md);
const tabState = {
  active: 'border-accent font-semibold text-fg',
  idle: 'border-transparent text-fg-muted hover:text-fg',
};
export const tab = (active) => cx(tabBase, active ? tabState.active : tabState.idle);

export const tabContent = 'px-7 pt-6 pb-16';

const badgeBase = 'flex-none rounded-sm px-1.5 py-px font-mono text-2xs lowercase';
const badgeTone = {
  neutral: 'bg-surface-sunken text-fg-muted',
  warn: 'bg-warn-surface text-warn',
  bad: 'bg-danger-surface text-danger',
  ok: 'bg-ok-surface text-ok',
  project: 'bg-type-project-surface text-type-project',
  feedback: 'bg-type-feedback-surface text-type-feedback',
  user: 'bg-type-user-surface text-type-user',
  reference: 'bg-type-reference-surface text-type-reference',
  managed: 'bg-scope-managed-surface text-scope-managed',
  scopeUser: 'bg-scope-user-surface text-scope-user',
  scopeProject: 'bg-scope-project-surface text-scope-project',
  scopeLocal: 'bg-scope-local-surface text-scope-local',
};
export const badge = (tone = 'neutral') => cx(badgeBase, pick(badgeTone, tone, 'neutral'));

const SCOPE_TONE = { managed: 'managed', user: 'scopeUser', project: 'scopeProject', local: 'scopeLocal' };
export const scopeBadge = (scope) => badge(SCOPE_TONE[scope] ?? 'neutral');
export const typeBadge = (type) => badge(badgeTone[type] ? type : 'neutral');
export const tabBadge = (tone = 'neutral') => cx('ml-1.5', badge(tone));

export const split = 'grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(280px,380px)_1fr]';
export const detailPane = 'xl:sticky xl:top-4 xl:max-h-[calc(100vh-9rem)] xl:overflow-y-auto';

export const sectionLabel = 'mt-5 mb-2 font-mono text-2xs font-semibold uppercase tracking-widest text-fg-subtle first:mt-0';
export const note = 'text-xs text-fg-muted';
export const noteTight = 'mt-0 mb-2.5 text-xs text-fg-muted';

const memoryItemBase = 'block min-w-0 flex-1 cursor-pointer rounded-md border bg-surface px-3 py-2.5 text-left transition-colors';
const memoryItemState = {
  active: 'border-accent bg-accent-surface',
  idle: 'border-line hover:border-accent-line',
};
export const memoryItem = (active) => cx(memoryItemBase, active ? memoryItemState.active : memoryItemState.idle);
export const memoryTop = 'mb-1 flex items-center gap-2';
export const memoryName = 'flex-1 truncate text-sm font-medium text-fg';
export const memoryDesc = 'line-clamp-2 text-xs text-fg-muted';
export const memoryFacts = 'mt-1.5 flex flex-wrap gap-3 font-mono text-2xs text-fg-muted';
export const memoryFact = (warn) => (warn ? 'text-warn' : 'text-fg-muted');
export const listItemRow = 'mb-1.5 flex items-start gap-2';

export const card = 'rounded-lg border border-line bg-surface p-5 shadow-card';
export const detailHead = 'mb-1 flex items-start gap-3';
export const detailTitle = 'flex-1 text-lg font-semibold tracking-tightest text-fg';
export const detailDesc = 'mt-0 mb-3.5 text-sm text-fg-muted';

export const metaList = 'mb-4 grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1 border-y border-line py-3 font-mono text-2xs';
export const metaKey = 'text-fg-subtle';
export const metaValue = 'm-0 break-all text-fg';

export const prose = 'prose text-base text-fg';
export const proseDim = 'prose text-base text-fg opacity-45';

const wikilinkBase = 'rounded-sm border border-transparent px-1 font-medium';
const wikilinkState = {
  live: 'cursor-pointer bg-accent-surface text-accent hover:border-accent-line',
  dead: 'cursor-help bg-danger-surface text-danger line-through',
};
export const wikilink = (live) => cx(wikilinkBase, live ? wikilinkState.live : wikilinkState.dead);
export const indexLink = (live) => (live ? 'cursor-pointer' : 'cursor-help text-danger line-through decoration-danger');

export const linkRow = 'mt-1.5 flex flex-wrap gap-1.5';
export const linkSection = 'mt-5 border-t border-line pt-3.5';
const chipBase = 'rounded-full border px-2.5 py-0.5 font-mono text-2xs transition-colors';
const chipState = {
  live: 'cursor-pointer border-line bg-surface-sunken text-fg hover:border-accent',
  dead: 'cursor-default border-danger-line bg-danger-surface text-danger',
};
export const chip = (live) => cx(chipBase, live ? chipState.live : chipState.dead);

const buttonBase = 'inline-flex cursor-pointer items-center gap-1.5 rounded-md border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45';
const buttonTone = {
  neutral: 'border-line bg-surface text-fg hover:border-line-strong hover:bg-surface-sunken',
  primary: 'border-accent bg-accent text-on-accent hover:bg-accent-hover hover:border-accent-hover',
  danger: 'border-danger-line bg-danger-surface text-danger hover:bg-danger hover:text-on-accent',
};
const buttonSize = {
  md: cx(controlPad.md, 'text-sm'),
  sm: cx(controlPad.sm, 'text-xs'),
};
export const button = ({ tone = 'neutral', size = 'md' } = {}) =>
  cx(buttonBase, pick(buttonTone, tone, 'neutral'), pick(buttonSize, size, 'md'));

export const linkButton = 'cursor-pointer border-none bg-transparent p-0 text-xs text-accent underline hover:text-accent-hover';
export const iconButton = cx('float-right ml-2 cursor-pointer rounded-sm border border-line font-mono text-2xs leading-none text-fg-muted transition-colors hover:border-line-strong hover:text-fg', controlPad.sm);
export const expandHandle = 'fixed top-3.5 left-0 z-20 cursor-pointer rounded-r-md border border-l-0 border-line bg-surface px-1.5 py-2 font-mono text-2xs text-fg-muted transition-colors hover:text-fg';

export const segmentGroup = 'inline-flex flex-none items-center gap-px rounded-md border border-line bg-surface-sunken p-0.5';
const segmentBase = cx('cursor-pointer rounded-sm font-mono text-2xs uppercase tracking-widest transition-colors', controlPad.sm);
const segmentState = { on: 'bg-accent text-on-accent', off: 'text-fg-muted hover:text-fg' };
export const segment = (active) => cx(segmentBase, active ? segmentState.on : segmentState.off);

export const cardHeadRow = 'mb-4 flex items-center justify-between gap-3 border-b border-line pb-3';

const indexLineBase = 'grid grid-cols-[3rem_1fr] gap-3 rounded-sm px-1.5 py-px font-mono text-xs';
const indexLineTone = {
  heading: 'font-bold text-accent',
  index: 'text-fg',
  text: 'text-fg-muted',
};
export const indexLine = ({ dangling = false, dropped = false } = {}) => cx(
  indexLineBase,
  dangling ? 'bg-danger-surface' : 'hover:bg-surface-sunken',
  dropped && 'opacity-45',
);
export const indexLineNumber = 'text-right text-fg-subtle select-none';
export const indexLineText = ({ kind = 'text', clickable = false, dropped = false } = {}) => cx(
  'whitespace-pre-wrap break-words',
  pick(indexLineTone, kind, 'text'),
  clickable && 'cursor-pointer hover:underline',
  dropped && 'line-through decoration-line-strong',
);

export const retentionTrack = 'relative mt-1 h-9 overflow-hidden rounded-md border border-line bg-surface-sunken';
export const retentionSweep = 'absolute inset-y-0 left-0 border-l border-dashed border-danger';
const retentionTickBase = 'absolute top-2 bottom-2 w-0.5 -translate-x-1/2 rounded-full';
const retentionTickTone = { soon: 'bg-warn', safe: 'bg-accent' };
export const retentionTick = (soon) => cx(retentionTickBase, soon ? retentionTickTone.soon : retentionTickTone.safe);
export const retentionScale = 'mt-1.5 flex justify-between font-mono text-2xs text-fg-subtle';

export const meterPanels = 'mt-4 grid gap-5 border-t border-line pt-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-14';
export const meterPanel = 'min-w-0';
export const meterPanelHead = 'mb-2 flex flex-wrap items-baseline justify-between gap-2';
export const meterPanelTitle = 'font-mono text-2xs font-semibold uppercase tracking-widest text-fg-subtle';
export const heatBody = 'flex items-start gap-1.5';
export const heatDayCol = 'grid grid-rows-7 gap-0.5 pt-4 font-mono text-2xs leading-3 text-fg-subtle';
export const heatDayLabel = 'h-3 leading-3';
export const heatMain = 'min-w-0 flex-1';
export const heatScroll = 'overflow-x-auto pb-1';
export const heatMonthRow = 'mb-1 grid grid-flow-col justify-start gap-0.5';
export const heatMonthCell = 'relative h-3 w-3';
export const heatMonthLabel = 'absolute top-0 left-0 font-mono text-2xs leading-3 whitespace-nowrap text-fg-subtle';
export const heatGrid = 'grid grid-flow-col grid-rows-7 justify-start gap-0.5';
export const heatBlank = 'size-3';

const heatTileBase = 'size-3 cursor-pointer rounded-xs transition-[outline-color]';
const heatTone = {
  0: 'bg-heat-0',
  1: 'bg-heat-1',
  2: 'bg-heat-2',
  3: 'bg-heat-3',
  4: 'bg-heat-4',
};
export const heatTile = (level, selected) => cx(
  heatTileBase,
  pick(heatTone, level, 0),
  selected ? 'outline-2 outline-offset-1 outline-fg' : 'outline-2 outline-offset-1 outline-transparent hover:outline-fg-subtle',
);

export const heatLegend = 'mt-2 flex items-center gap-1 font-mono text-2xs text-fg-subtle';
export const heatLegendSwatch = (level) => cx('size-3 rounded-xs', pick(heatTone, level, 0));

export const sectionLabelRow = 'mt-5 mb-2 flex flex-wrap items-center gap-3 first:mt-0';
export const sectionLabelInline = 'font-mono text-2xs font-semibold uppercase tracking-widest text-fg-subtle';
export const heatFilterClear = 'cursor-pointer rounded-md border border-line bg-surface px-1.5 py-0.5 font-mono text-2xs text-fg-muted transition-colors hover:border-line-strong hover:text-fg';

export const provenanceRow = 'mt-0.5 mb-3.5 flex flex-wrap items-baseline gap-1.5 text-xs text-fg-muted';
const provenanceLinkBase = 'cursor-pointer rounded-sm border border-transparent bg-transparent px-1 font-medium';
const provenanceLinkState = {
  live: 'bg-accent-surface text-accent hover:border-accent-line',
  dead: 'cursor-help bg-danger-surface text-danger line-through',
};
export const provenanceLink = (live) => cx(provenanceLinkBase, live ? provenanceLinkState.live : provenanceLinkState.dead);

export const cutLine = 'my-2.5 flex items-center gap-2.5 before:flex-1 before:border-t before:border-dashed before:border-danger after:flex-1 after:border-t after:border-dashed after:border-danger';
export const cutLabel = 'flex-none font-mono text-2xs whitespace-nowrap text-danger';

const issueBase = 'mb-2 flex items-start gap-3 rounded-md border border-l-2 border-line bg-surface px-3.5 py-2.5';
const issueTone = { warn: 'border-l-warn', bad: 'border-l-danger' };
export const issue = (bad) => cx(issueBase, bad ? issueTone.bad : issueTone.warn);
export const issueBody = 'min-w-0 flex-1';
export const issueTitle = 'text-sm font-medium text-fg';
export const issueDetail = 'font-mono text-2xs break-words text-fg-muted';

export const meter = 'mb-5 rounded-lg border border-line bg-surface px-5 py-4';
export const meterTop = 'mb-2.5 flex items-baseline gap-2.5';
export const meterValue = 'font-mono text-2xl font-semibold tracking-tightest text-fg';
export const meterUnit = 'flex-1 text-sm text-fg-muted';
export const meterBar = 'h-2 overflow-hidden rounded-full border border-line bg-surface-sunken';
const meterFillTone = { ok: 'bg-ok', near: 'bg-warn', over: 'bg-danger' };
export const meterFill = (level) => cx('h-full transition-[width]', pick(meterFillTone, level, 'ok'));
export const meterNote = 'mt-2.5 text-xs text-fg-muted';
export const meterFacts = 'mt-3 flex flex-wrap gap-4 border-t border-line pt-3 font-mono text-2xs text-fg-muted';
export const meterFactValue = 'font-semibold text-fg';

export const listBar = 'mb-2.5 flex flex-wrap items-center gap-2.5';
export const listSpacer = 'flex-1';
export const segmentBar = 'mb-5 flex flex-wrap items-center gap-3';
export const select = cx('cursor-pointer rounded-md border border-line bg-surface font-mono text-xs text-fg hover:border-line-strong focus:outline-none', controlPad.sm);

export const dupe = 'mb-2 rounded-lg border border-line bg-surface px-3.5 py-3';
export const dupeHead = 'mb-2 flex items-baseline gap-2 font-mono text-2xs text-fg-muted';
export const dupeScore = 'font-semibold text-warn';
export const dupePair = 'grid grid-cols-1 gap-2.5 md:grid-cols-2';
export const dupeSide = 'cursor-pointer rounded-md border border-line bg-surface-sunken px-3 py-2.5 transition-colors hover:border-accent';
export const dupeSideName = 'text-sm font-medium text-fg';
export const dupeActions = 'mt-2 flex flex-wrap justify-end gap-2';
export const dupeSideDesc = 'text-xs text-fg-muted';

export const contextMain = 'min-w-0';
export const contextTags = 'mb-1 flex flex-wrap gap-1.5';
export const contextFile = 'font-mono text-2xs break-words text-fg';
export const contextSize = 'font-mono text-2xs whitespace-nowrap text-fg-subtle';
export const contextRowButton = 'flex w-full cursor-pointer items-baseline justify-between gap-3.5 border-0 border-b border-line bg-transparent px-1 py-1.5 text-left transition-colors last:border-b-0 hover:bg-surface-sunken';
export const contextCaret = 'mr-1.5 inline-block font-mono text-2xs text-fg-subtle';
export const contextBody = 'mb-1.5 max-h-[28rem] overflow-y-auto rounded-md border border-line bg-surface-sunken px-3.5 py-2.5';

export const graphWrap = 'graph relative overflow-hidden rounded-lg border border-line bg-surface';
export const graphToolbar = 'absolute top-3 right-3.5 flex items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1.5';
export const graphButton = cx('min-w-6 cursor-pointer rounded-sm border border-line bg-transparent font-mono text-xs text-fg-muted transition-colors hover:border-line-strong hover:text-fg', controlPad.sm);
export const graphLabel = 'flex items-center gap-1.5 font-mono text-2xs text-fg-muted';
export const graphRange = 'w-20 accent-accent';
export const graphLegend = 'absolute bottom-3 left-3.5 flex flex-wrap gap-3 rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-2xs text-fg-muted';
export const graphLegendItem = 'flex items-center gap-1.5';
export const graphLegendSwatch = 'inline-block size-2 rounded-full';

export const dialog = 'backdrop:bg-scrim m-auto open:flex max-h-[82vh] w-[calc(100%-3rem)] max-w-2xl flex-col rounded-xl border border-line bg-surface shadow-pop';
export const dialogHead = 'px-6 pt-5';
export const dialogTitle = 'mb-1 text-lg font-semibold tracking-tightest text-fg';
export const dialogBody = 'overflow-y-auto px-6 py-3.5';
export const dialogFoot = 'flex justify-end gap-2 border-t border-line px-6 pt-3.5 pb-4.5';

export const willBlock = 'mb-3.5';
export const willTitle = 'mb-1.5 font-mono text-2xs font-semibold uppercase tracking-widest text-fg-subtle';
const willItemBase = 'mb-1 rounded-md border border-line bg-surface-sunken px-2.5 py-1.5 font-mono text-2xs break-words text-fg-muted';
const willItemTone = { remove: 'border-l-2 border-l-danger', keep: 'border-l-2 border-l-warn' };
export const willItem = (tone) => cx(willItemBase, willItemTone[tone]);

export const cascadeHead = 'mb-1.5 flex items-baseline justify-between gap-2.5';
export const cascadeList = 'overflow-hidden rounded-md border border-line';
const cascadeRowBase = 'flex cursor-pointer items-start gap-2.5 border-b border-line px-3 py-2 transition-colors last:border-b-0';
const cascadeRowState = { on: 'bg-danger-surface', off: 'hover:bg-surface-sunken' };
export const cascadeRow = (on) => cx(cascadeRowBase, on ? cascadeRowState.on : cascadeRowState.off);
export const cascadeText = 'min-w-0';
export const cascadeName = 'block text-sm font-medium text-fg';
export const cascadeDetail = 'block font-mono text-2xs break-words text-fg-muted';

export const pathInput = cx('my-1 mb-3 w-full rounded-md border border-line bg-surface-sunken font-mono text-xs text-fg focus:border-accent focus:outline-none', controlPad.lg);
export const textArea = cx('my-1 mb-1.5 block min-h-20 w-full resize-y rounded-md border border-line bg-surface-sunken font-mono text-xs leading-relaxed text-fg focus:border-accent focus:outline-none', controlPad.lg);
export const hookEditor = 'mb-1.5 w-full rounded-md border border-accent-line bg-surface-sunken px-3 py-2.5';
export const hookEditorFoot = 'flex justify-end gap-2';
export const charCount = 'mb-3 flex items-baseline justify-between gap-3 font-mono text-2xs text-fg-subtle';
export const charCountOver = 'mb-3 flex items-baseline justify-between gap-3 font-mono text-2xs text-warn';

export const settingsKeyHead = 'mb-1.5 flex flex-wrap items-baseline gap-2.5';
export const settingsKeyName = 'font-mono text-sm font-semibold text-fg';
export const settingsEffective = 'rounded-sm bg-accent-surface px-1.5 py-px font-mono text-2xs break-all text-accent';
export const settingsLayerRow = 'flex flex-wrap items-baseline gap-2.5 border-b border-line py-1.5 last:border-b-0';
export const settingsLayerFile = 'min-w-0 flex-1 font-mono text-2xs break-all text-fg-subtle';
const settingsLayerValueBase = 'font-mono text-2xs break-all';
const settingsLayerValueState = { wins: 'text-fg', shadowed: 'text-fg-subtle line-through decoration-line-strong' };
export const settingsLayerValue = (wins) => cx(settingsLayerValueBase, wins ? settingsLayerValueState.wins : settingsLayerValueState.shadowed);

export const toastRoot = 'fixed bottom-5 left-1/2 z-200 flex -translate-x-1/2 flex-col items-center gap-2';
const toastBase = 'flex items-center gap-3 rounded-full px-4 py-2 text-sm shadow-pop';
const toastTone = { info: 'bg-fg text-canvas', error: 'bg-danger text-on-accent' };
export const toast = (error) => cx(toastBase, error ? toastTone.error : toastTone.info);
export const toastAction = cx('cursor-pointer rounded-full border border-current bg-transparent text-xs', controlPad.sm);

export const searchHead = 'sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-canvas px-7 pt-5 pb-3.5';
export const searchTitle = 'flex-1 text-lg font-semibold tracking-tightest text-fg';
export const searchResults = 'px-7 pt-5 pb-16';
export const resultGroup = 'mb-6';
export const result = 'mb-1.5 block w-full cursor-pointer rounded-md border border-line bg-surface px-3.5 py-2.5 text-left transition-colors hover:border-accent';
export const resultTop = 'mb-1 flex items-center gap-2';
export const resultName = 'flex-1 text-sm font-medium text-fg';
export const resultSnippet = 'block text-xs text-fg-muted';
export const resultWhere = 'block font-mono text-2xs text-fg-subtle';
export const resultMark = 'rounded-sm bg-accent-surface px-px text-accent';

export const buttonSmall = button({ size: 'sm' });
export const buttonPrimarySmall = button({ tone: 'primary', size: 'sm' });
export const buttonDangerSmall = button({ tone: 'danger', size: 'sm' });
export const promptCaret = 'text-accent';
export const inlineCode = 'rounded-sm border border-line bg-surface-sunken px-1 font-mono text-xs text-accent';
export const okLine = 'm-0 text-base text-fg';
export const graphEmpty = 'p-10 text-center text-fg-muted';
export const graphNode = (highlighted) => (highlighted ? 'node hi' : 'node');
export const graphEdge = 'edge';
export const graphHit = 'hit';
