import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { openDialog } from '/dialog.mjs';
import { api, toast } from '/api.mjs';
import { state } from '/state.mjs';
import { openStore, restoreFromTrash } from '/store.mjs';

export async function openBulkDeleteDialog(files) {
  if (!files.length) return;
  const memories = files.map((file) => state.store.memories.find((m) => m.file === file)).filter(Boolean);

  const body = [];
  const removals = node('div', { class: ui.willBlock }, [node('div', { class: ui.willTitle, text: `${memories.length} memories will be trashed` })]);
  for (const memory of memories) {
    removals.append(node('div', { class: ui.willItem('remove'), text: `${memory.file}${memory.entry ? `  ·  MEMORY.md line ${memory.entry.index + 1}` : '  ·  not in the index'}` }));
  }
  body.push(removals);

  const doomed = new Set(files);
  const breaking = [];
  for (const memory of memories) {
    for (const link of memory.inbound) {
      if (!doomed.has(link.from)) breaking.push({ from: link.from, target: link.target });
    }
  }
  if (breaking.length) {
    const block = node('div', { class: ui.willBlock }, [node('div', { class: ui.willTitle, text: `${breaking.length} link(s) from memories you are keeping will break` })]);
    for (const link of breaking) block.append(node('div', { class: ui.willItem('keep'), text: `${link.from}  →  [[${link.target}]]` }));
    body.push(block);
  }

  body.push(node('p', { class: ui.noteTight, text: 'All of them go to memory/.trash/ as one restore point.' }));

  const go = await openDialog({
    title: `Delete ${memories.length} memories?`,
    body,
    actions: [
      { label: 'Cancel' },
      { label: `Delete ${memories.length}`, tone: 'danger', value: true },
    ],
  });
  if (!go) return;

  try {
    const result = await api(`/api/stores/${encodeURIComponent(state.storeId)}/delete-many`, {
      method: 'POST',
      body: JSON.stringify({ files, label: `${memories.length} pruned memories` }),
    });
    state.listSelection.clear();
    state.selecting = false;
    if (doomed.has(state.selected)) state.selected = null;
    await openStore(state.storeId, { keepTab: true });
    toast(`Deleted ${memories.length} memories`, {
      action: { label: 'Undo', run: () => restoreFromTrash(result.record.id) },
    });
  } catch (err) {
    toast(err.message, { error: true });
  }
}
