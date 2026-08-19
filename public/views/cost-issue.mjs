import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { issue } from '/parts.mjs';
import { selectMemory } from '/store.mjs';
import { openMergeDialog } from '/dialogs/merge.mjs';
import { openMoveDialog } from '/dialogs/move.mjs';
import { openHookEditor } from '/dialogs/hook-editor.mjs';

export function renderCostIssue(item) {
  if (item.kind === 'past-cutoff') {
    const { entry } = item;
    return issue(
      `Past the cutoff, not loaded: ${entry.title || entry.file}`,
      `MEMORY.md line ${entry.index + 1} · ${entry.file} - the file is on disk, but Claude never sees this entry.`,
      {
        bad: true,
        secondary: { label: 'Open', run: () => selectMemory(entry.file) },
        action: { label: 'Move up', run: () => openMoveDialog(entry) },
      },
    );
  }

  if (item.kind === 'long-hook') {
    const { hook } = item;
    const row = issue(
      `${hook.hookLength}-character hook: ${hook.title}`,
      `MEMORY.md line ${hook.index + 1} · ${hook.file} - the hook loads every session, so shortening it is the cheapest win available.`,
      { secondary: { label: 'Open', run: () => selectMemory(hook.file) } },
    );
    row.append(node('button', {
      class: ui.buttonPrimarySmall,
      text: 'Edit hook',
      onclick: () => openHookEditor(row, hook.index),
    }));
    return row;
  }

  if (item.kind === 'overlap') {
    const { pair } = item;
    return node('div', { class: ui.dupe }, [
      node('div', { class: ui.dupeHead }, [
        node('span', { class: ui.dupeScore, text: `${pair.score}%` }),
        node('span', { text: `shared: ${pair.shared.join(', ')}` }),
      ]),
      node('div', { class: ui.dupePair }, [pair.a, pair.b].map((side) => node('div', {
        class: ui.dupeSide,
        onclick: () => selectMemory(side.file),
      }, [
        node('div', { class: ui.dupeSideName, text: side.name }),
        node('div', { class: ui.dupeSideDesc, text: side.description || side.file }),
      ]))),
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
    ]);
  }

  return null;
}

export const COST_KINDS = new Set(['past-cutoff', 'long-hook', 'overlap']);
