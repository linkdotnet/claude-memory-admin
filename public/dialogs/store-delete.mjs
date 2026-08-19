import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { openDialog } from '/dialog.mjs';
import { api, toast } from '/api.mjs';
import { state } from '/state.mjs';
import { openStore, restoreFromTrash } from '/store.mjs';

export async function openStoreDeleteDialog() {
  let preview;
  try {
    preview = await api(`/api/stores/${encodeURIComponent(state.storeId)}/project/delete-preview`, { method: 'POST' });
  } catch (err) {
    return toast(err.message, { error: true });
  }

  if (!preview.files.length && !preview.hasIndex) {
    return toast('This store has no memory to delete');
  }

  const body = [];
  const removals = node('div', { class: ui.willBlock }, [node('div', { class: ui.willTitle, text: 'Will be removed' })]);
  if (preview.hasIndex) {
    removals.append(node('div', { class: ui.willItem('remove'), text: `MEMORY.md  (${preview.indexLines} lines)  →  memory/.trash/` }));
  }
  for (const entry of preview.files) {
    removals.append(node('div', { class: ui.willItem('remove'), text: `${entry.file}  →  memory/.trash/` }));
  }
  body.push(removals);

  body.push(node('div', { class: ui.willBlock }, [
    node('div', { class: ui.willTitle, text: 'Will be kept' }),
    node('div', { class: ui.willItem('keep'), text: state.store.kind === 'auto'
      ? 'Session transcripts (*.jsonl) and the project folder itself'
      : 'The agent-memory folder itself, and every other agent\u2019s memory' }),
  ]));

  body.push(node('p', { class: ui.noteTight, text: 'Everything moves to .trash/ inside the store as one restore point, so it can be put back in a single step from the Trash tab.' }));

  if (state.store.kind === 'agent-project') {
    body.push(node('p', { class: ui.subWarn, text: 'This store is checked into the repository. Deleting from it changes tracked files, and will show up in git status.' }));
  }

  const go = await openDialog({
    title: `Delete all memory for ${state.store.label}?`,
    subtitle: `${preview.files.length} memories${preview.hasIndex ? ' + MEMORY.md' : ''}`,
    body,
    actions: [
      { label: 'Cancel' },
      { label: `Delete ${preview.files.length + (preview.hasIndex ? 1 : 0)} files`, tone: 'danger', value: true },
    ],
  });
  if (!go) return;

  try {
    const result = await api(`/api/stores/${encodeURIComponent(state.storeId)}/project/delete`, { method: 'POST' });
    state.selected = null;
    await openStore(state.storeId, { keepTab: true });
    toast(`Cleared ${state.store.label}`, {
      action: { label: 'Undo', run: () => restoreFromTrash(result.record.id) },
    });
  } catch (err) {
    toast(err.message, { error: true });
  }
}
