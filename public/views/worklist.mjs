const COST_KINDS = new Set(['long-hook', 'hook-repeats-description', 'empty-section', 'index-continuation']);

function rankOf(kind, severity) {
  if (kind === 'past-cutoff') return 0;
  if (severity === 'bad') return 1;
  if (COST_KINDS.has(kind)) return 2;
  if (kind === 'overlap') return 4;
  return 3;
}

export function buildWorklist(store) {
  if (!store || !store.stats) return [];
  const items = [];
  const { index } = store.stats;

  for (const entry of index.cutoff?.droppedEntries ?? []) {
    items.push({ kind: 'past-cutoff', severity: 'bad', entry });
  }
  for (const hook of index.longHooks) {
    items.push({ kind: 'long-hook', severity: 'warn', hook });
  }
  for (const item of store.health.issues) {
    if (item.kind === 'long-hooks') continue;
    items.push(item);
  }
  for (const pair of store.duplicates) {
    items.push({ kind: 'overlap', severity: 'warn', pair });
  }

  return items
    .map((item) => ({ ...item, rank: rankOf(item.kind, item.severity) }))
    .sort((a, b) => a.rank - b.rank);
}
