import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { state } from '/state.mjs';
import { paint } from '/bus.mjs';
import { formatAge } from '/parts.mjs';
import { selectMemory } from '/store.mjs';
import { openBulkDeleteDialog } from '/dialogs/bulk-delete.mjs';
import { openMergeDialog } from '/dialogs/merge.mjs';
import { openMoveDialog } from '/dialogs/move.mjs';
import { openHookEditor } from '/dialogs/hook-editor.mjs';

const PRUNE_SORTS = {
  oldest: { label: 'oldest first', compare: (a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1) },
  largest: { label: 'largest first', compare: (a, b) => b.bytes - a.bytes },
  unlinked: { label: 'least linked', compare: (a, b) => a.inbound.length - b.inbound.length || (b.ageDays ?? 0) - (a.ageDays ?? 0) },
  name: { label: 'by name', compare: (a, b) => a.name.localeCompare(b.name) },
};

function renderBudget(container) {
  const { index } = state.store.stats;
  const percent = Math.min(100, index.worstPercent);
  const level = index.level;

  const note = index.level === 'over'
    ? 'Over the limit. Everything past the cutoff is dropped when the session loads it, so those entries are effectively invisible to Claude right now.'
    : index.level === 'near'
      ? 'Approaching the limit. Once MEMORY.md passes it, everything after the cutoff stops being loaded at all.'
      : 'Comfortably inside the limit. MEMORY.md is loaded at the start of every session.';

  if (index.cutoff) {
    const dropped = index.cutoff.droppedEntries;
    const box = node('div', { class: ui.cutSummary });
    box.append(node('div', { class: ui.cutSummaryHead, text: dropped.length
      ? `${dropped.length} ${dropped.length === 1 ? 'memory is' : 'memories are'} past the cutoff and not loaded`
      : `${index.cutoff.droppedLines} lines are past the cutoff and not loaded` }));
    box.append(node('p', { class: ui.note, text: `MEMORY.md stops loading at line ${index.cutoff.rawLine + 1}, bounded by ${index.cutoff.by}. Claude cannot see anything below it.` }));
    for (const entry of dropped.slice(0, 20)) {
      box.append(node('div', { class: ui.issue(true) }, [
        node('div', { class: ui.issueBody }, [
          node('div', { class: ui.issueTitle, text: entry.title || entry.file }),
          node('div', { class: ui.issueDetail, text: `MEMORY.md line ${entry.index + 1} · ${entry.file}` }),
        ]),
        node('button', { class: ui.buttonSmall, text: 'Open', onclick: () => selectMemory(entry.file) }),
        node('button', { class: ui.buttonPrimarySmall, text: 'Move up', onclick: () => openMoveDialog(entry) }),
      ]));
    }
    if (dropped.length > 20) {
      box.append(node('p', { class: ui.note, text: `${dropped.length - 20} more not listed.` }));
    }
    container.append(box);
  }

  container.append(node('div', { class: ui.meter }, [
    node('div', { class: ui.meterTop }, [
      node('span', { class: ui.meterValue, text: `${Math.round(index.worstPercent)}%` }),
      node('span', { class: ui.meterUnit, text: `of the MEMORY.md load limit, currently bounded by ${index.limitedBy}` }),
    ]),
    node('div', { class: ui.meterBar }, [
      node('div', { class: ui.meterFill(level), style: `width:${percent.toFixed(1)}%` }),
    ]),
    node('p', { class: ui.meterNote, text: note }),
    node('div', { class: ui.meterFacts }, [
      node('span', {}, [node('b', { class: ui.meterFactValue, text: `${index.lines} / ${index.lineLimit}` }), document.createTextNode(' lines')]),
      node('span', {}, [node('b', { class: ui.meterFactValue, text: `${(index.bytes / 1024).toFixed(1)} / ${index.byteLimit / 1024} KB` }), document.createTextNode(' loaded size')]),
      node('span', {}, [node('b', { class: ui.meterFactValue, text: String(index.entryCount) }), document.createTextNode(' index entries')]),
      node('span', {}, [node('b', { class: ui.meterFactValue, text: `~${index.tokens.toLocaleString()}` }), document.createTextNode(' tokens, every session')]),
    ]),
    node('p', { class: ui.meterNote, text: 'Claude Code loads the first 200 lines or 25KB of MEMORY.md, whichever comes first, and drops the rest. Topic files are only read when Claude follows a link, so detail belongs in them and MEMORY.md should stay one line per entry.' }),
  ]));
}

export function renderPrune(container) {
  const project = state.store;
  renderBudget(container);

  if (!project.memories.length) {
    container.append(node('p', { class: ui.note, text: 'Nothing to prune - this project has no memories.' }));
    return;
  }

  const selected = state.pruneSelection;
  const bar = node('div', { class: ui.pruneBar });
  const sort = node('select', { class: ui.select });
  for (const [key, config] of Object.entries(PRUNE_SORTS)) {
    sort.append(node('option', { value: key, text: config.label, selected: key === state.pruneSort ? '' : null }));
  }
  sort.value = state.pruneSort;
  sort.onchange = () => { state.pruneSort = sort.value; paint('tab'); };

  const count = node('span', { class: ui.note });
  const deleteButton = node('button', { class: ui.buttonDangerSmall });
  const clearButton = node('button', { class: ui.buttonSmall, text: 'Clear selection' });

  bar.append(node('span', { class: ui.sectionLabel, text: 'Prune' }), sort, node('span', { class: ui.pruneSpacer }), count, clearButton, deleteButton);
  container.append(bar);

  const list = node('div');
  const ordered = [...project.memories].sort(PRUNE_SORTS[state.pruneSort].compare);
  const rows = [];
  for (const memory of ordered) {
    const box = node('input', { type: 'checkbox', class: ui.checkbox });
    box.checked = selected.has(memory.file);
    const row = node('label', { class: ui.pruneRow(box.checked) }, [
      box,
      node('span', { class: ui.pruneMain }, [
        node('span', { class: ui.pruneName, text: memory.name }),
        node('span', { class: ui.pruneDesc, text: memory.description || memory.file }),
      ]),
      node('span', { class: ui.pruneFacts }, [
        node('span', { class: ui.pruneFact((memory.ageDays ?? 0) > 180), text: formatAge(memory.ageDays) }),
        node('span', { text: `${(memory.bytes / 1024).toFixed(1)}K` }),
        node('span', { class: ui.pruneFact(!memory.inbound.length), text: `${memory.inbound.length} in` }),
        node('span', { class: ui.pruneFact(memory.status !== 'indexed'), text: memory.status }),
      ]),
    ]);
    box.addEventListener('change', () => {
      if (box.checked) selected.add(memory.file); else selected.delete(memory.file);
      row.className = ui.pruneRow(box.checked);
      updateBar();
    });
    rows.push({ box, memory });
    list.append(row);
  }
  container.append(list);

  function updateBar() {
    count.textContent = selected.size ? `${selected.size} selected` : '';
    deleteButton.textContent = `Delete ${selected.size || ''}`.trim();
    deleteButton.disabled = selected.size === 0;
  }
  clearButton.onclick = () => {
    selected.clear();
    paint('tab');
  };
  deleteButton.onclick = () => openBulkDeleteDialog([...selected]);
  updateBar();

  const { longHooks } = project.stats.index;
  if (longHooks.length) {
    container.append(node('div', { class: ui.sectionLabel, text: `Long index hooks · ${longHooks.length}` }));
    container.append(node('p', { class: ui.noteTight, text: 'The hook is the text after the dash in MEMORY.md. It is loaded every session, so a 400-character hook costs more than the memory it points at. Shortening these is the cheapest win.' }));
    for (const hook of longHooks.slice(0, 12)) {
      const row = node('div', { class: ui.issue(false) });
      const editButton = node('button', { class: ui.buttonPrimarySmall, text: 'Edit hook' });
      row.append(
        node('div', { class: ui.issueBody }, [
          node('div', { class: ui.issueTitle, text: `${hook.hookLength} chars: ${hook.title}` }),
          node('div', { class: ui.issueDetail, text: `MEMORY.md line ${hook.index + 1} · ${hook.file}` }),
        ]),
        node('button', { class: ui.buttonSmall, text: 'Open', onclick: () => selectMemory(hook.file) }),
        editButton,
      );
      editButton.onclick = () => openHookEditor(row, hook.index);
      container.append(row);
    }
  }

  if (project.duplicates.length) {
    container.append(node('div', { class: ui.sectionLabel, text: `Possible overlap · ${project.duplicates.length}` }));
    container.append(node('p', { class: ui.noteTight, text: 'Ranked by how much rare vocabulary these pairs share. This is a hint, not a verdict - open both and decide whether one covers the other.' }));
    for (const pair of project.duplicates) {
      container.append(node('div', { class: ui.dupe }, [
        node('div', { class: ui.dupeHead }, [
          node('span', { class: ui.dupeScore, text: `${pair.score}%` }),
          node('span', { text: `shared: ${pair.shared.join(', ')}` }),
        ]),
        node('div', { class: ui.dupePair }, [
          ...[pair.a, pair.b].map((side) => node('div', {
            class: ui.dupeSide,
            onclick: () => selectMemory(side.file),
          }, [
            node('div', { class: ui.dupeSideName, text: side.name }),
            node('div', { class: ui.dupeSideDesc, text: side.description || side.file }),
          ])),
        ]),
        node('div', { class: ui.dupeActions }, [
          node('button', {
            class: ui.buttonSmall,
            text: `Merge into ${pair.a.name}`,
            onclick: () => openMergeDialog(pair.a.file, pair.b.file),
          }),
          node('button', {
            class: ui.buttonSmall,
            text: `Merge into ${pair.b.name}`,
            onclick: () => openMergeDialog(pair.b.file, pair.a.file),
          }),
        ]),
      ]));
    }
  }
}
