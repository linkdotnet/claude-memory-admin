import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { openDialog } from '/dialog.mjs';
import { state } from '/state.mjs';
import { restoreFromTrash } from '/store.mjs';

const INDEX_EDIT_LABELS = {
  hook: 'MEMORY.md hook shortened',
  move: 'MEMORY.md entry moved',
  add: 'MEMORY.md entry added',
};

function describe(record) {
  const when = String(record.deletedAt).replace('T', ' ').replace(/\..*$/, '');
  if (record.kind === 'wikilink') return `unlinked in ${record.sourceFile} · ${when}`;
  if (record.kind === 'index-edit') return `${INDEX_EDIT_LABELS[record.op] || 'MEMORY.md edited'} · ${when}`;
  if (record.kind === 'merge') return `merged into ${record.into} · ${when} · ${record.backups?.length || 0} file(s) rewritten`;
  return `${record.files.length} file(s)${record.indexTrashedFile ? ' + MEMORY.md' : ''} · ${when} · ${record.removedLines?.length || 0} index line(s) removed`;
}

export function openTrashDialog() {
  const trash = state.store.trash;
  const body = [];

  if (!trash.length) {
    body.push(node('p', { class: ui.note, text: 'Nothing to undo. Deleted memories and index edits land here and can be restored.' }));
  } else {
    body.push(node('p', { class: ui.noteTight, text: 'One undo per operation, however many files it touched. Everything lives in memory/.trash/ until you restore it.' }));
    for (const record of trash) {
      const detail = describe(record);
      body.push(node('div', { class: ui.issue(!record.present) }, [
        node('div', { class: ui.issueBody }, [
          node('div', { class: ui.issueTitle, text: record.label || record.id }),
          node('div', { class: ui.issueDetail, text: record.present ? detail : `${detail}, backup missing, cannot restore` }),
        ]),
        record.present
          ? node('button', {
            class: ui.buttonPrimarySmall,
            text: 'Restore',
            onclick: () => restoreFromTrash(record.id, { close: true }),
          })
          : null,
      ]));
    }
  }

  return openDialog({
    title: 'Undo',
    subtitle: trash.length ? `${trash.length} restorable operation${trash.length === 1 ? '' : 's'}` : null,
    body,
    actions: [{ label: 'Close' }],
  });
}
