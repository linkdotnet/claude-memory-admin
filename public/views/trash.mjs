import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { state } from '/state.mjs';
import { restoreFromTrash } from '/store.mjs';

const INDEX_EDIT_LABELS = {
  hook: 'MEMORY.md hook shortened',
  move: 'MEMORY.md entry moved',
  add: 'MEMORY.md entry added',
};

export function renderTrash(container) {
  const trash = state.store.trash;
  if (!trash.length) {
    container.append(node('p', { class: ui.note, text: 'Nothing in the trash. Deleted memories land here and can be restored.' }));
    return;
  }
  for (const record of trash) {
    const when = String(record.deletedAt).replace('T', ' ').replace(/\..*$/, '');
    const detail = record.kind === 'wikilink'
      ? `unlinked in ${record.sourceFile} · ${when}`
      : record.kind === 'index-edit'
        ? `${INDEX_EDIT_LABELS[record.op] || 'MEMORY.md edited'} · ${when}`
        : record.kind === 'merge'
          ? `merged into ${record.into} · ${when} · ${record.backups?.length || 0} file(s) rewritten`
          : `${record.files.length} file(s)${record.indexTrashedFile ? ' + MEMORY.md' : ''} · ${when} · ${record.removedLines?.length || 0} index line(s) removed`;
    container.append(node('div', { class: ui.issue(!record.present) }, [
      node('div', { class: ui.issueBody }, [
        node('div', { class: ui.issueTitle, text: record.label || record.id }),
        node('div', { class: ui.issueDetail, text: record.present ? detail : `${detail}, backup missing, cannot restore` }),
      ]),
      record.present
        ? node('button', { class: ui.buttonPrimarySmall, text: 'Restore', onclick: () => restoreFromTrash(record.id) })
        : null,
    ]));
  }
}
