import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { state } from '/state.mjs';
import { paint } from '/bus.mjs';
import { formatAge } from '/parts.mjs';
import { selectMemory } from '/store.mjs';
import { openBulkDeleteDialog } from '/dialogs/bulk-delete.mjs';

const SORTS = {
  section: { label: 'by section', compare: null },
  oldest: { label: 'oldest first', compare: (a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1) },
  largest: { label: 'largest first', compare: (a, b) => b.bytes - a.bytes },
  unlinked: { label: 'least linked', compare: (a, b) => a.inbound.length - b.inbound.length || (b.ageDays ?? 0) - (a.ageDays ?? 0) },
  name: { label: 'by name', compare: (a, b) => a.name.localeCompare(b.name) },
};

function memoryButton(memory) {
  const active = state.selected === memory.file;
  return node('button', {
    class: ui.memoryItem(active),
    'data-memory': memory.file,
    'data-active': active ? '' : null,
    onclick: () => selectMemory(memory.file),
  }, [
    node('span', { class: ui.memoryTop }, [
      node('span', { class: ui.memoryName, text: memory.name }),
      node('span', { class: ui.typeBadge(memory.type), text: memory.type }),
      memory.status !== 'indexed'
        ? node('span', { class: ui.badge('warn'), text: memory.status })
        : null,
    ]),
    memory.description ? node('span', { class: ui.memoryDesc, text: memory.description }) : null,
    node('span', { class: ui.memoryFacts }, [
      node('span', { class: ui.memoryFact((memory.ageDays ?? 0) > 180), text: formatAge(memory.ageDays) }),
      node('span', { text: `${(memory.bytes / 1024).toFixed(1)}K` }),
      node('span', { class: ui.memoryFact(!memory.inbound.length), text: `${memory.inbound.length} in` }),
    ]),
  ]);
}

function memoryRow(memory, onToggle) {
  const row = node('div', { class: ui.listItemRow });
  if (state.selecting) {
    const box = node('input', { type: 'checkbox', class: ui.checkbox, 'aria-label': `Select ${memory.name}` });
    box.checked = state.listSelection.has(memory.file);
    box.addEventListener('change', () => {
      if (box.checked) state.listSelection.add(memory.file);
      else state.listSelection.delete(memory.file);
      onToggle();
    });
    row.append(box);
  }
  row.append(memoryButton(memory));
  return row;
}

function setSort(value) {
  state.listSort = value;
  localStorage.setItem('memoryListSort', value);
  paint('tab');
}

function toolbar() {
  const bar = node('div', { class: ui.listBar });
  const sort = node('select', { class: ui.select, 'aria-label': 'Sort memories' });
  for (const [key, config] of Object.entries(SORTS)) {
    sort.append(node('option', { value: key, text: config.label }));
  }
  sort.value = state.listSort;
  sort.onchange = () => setSort(sort.value);

  const count = node('span', { class: ui.note });
  const deleteButton = node('button', { class: ui.buttonDangerSmall });
  const selectButton = node('button', {
    class: ui.buttonSmall,
    text: state.selecting ? 'Done' : 'Select',
    onclick: () => {
      state.selecting = !state.selecting;
      if (!state.selecting) state.listSelection.clear();
      paint('tab');
    },
  });

  bar.append(sort, node('span', { class: ui.listSpacer }), count, selectButton);
  if (state.selecting) bar.append(deleteButton);
  deleteButton.onclick = () => openBulkDeleteDialog([...state.listSelection]);

  const update = () => {
    const size = state.listSelection.size;
    count.textContent = size ? `${size} selected` : '';
    deleteButton.textContent = `Delete ${size || ''}`.trim();
    deleteButton.disabled = size === 0;
  };
  update();
  return { bar, update };
}

export function renderMemoryList(container) {
  const project = state.store;
  const { bar, update } = toolbar();
  container.append(bar);

  const compare = SORTS[state.listSort].compare;
  if (!compare) {
    const groups = new Map();
    for (const memory of project.memories) {
      const key = memory.section || (memory.status === 'indexed' ? 'Index' : 'Not in the index');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(memory);
    }
    for (const [section, memories] of groups) {
      container.append(node('div', { class: ui.sectionLabel, text: `${section} · ${memories.length}` }));
      for (const memory of memories) container.append(memoryRow(memory, update));
    }
    return;
  }

  for (const memory of [...project.memories].sort(compare)) {
    container.append(memoryRow(memory, update));
  }
}
