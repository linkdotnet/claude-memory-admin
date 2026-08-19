import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { openDialog } from '/dialog.mjs';
import { api, toast } from '/api.mjs';
import { state } from '/state.mjs';
import { openStore, restoreFromTrash } from '/store.mjs';

export async function openDeleteDialog(file) {
  let preview;
  try {
    preview = await api(`/api/stores/${encodeURIComponent(state.storeId)}/delete-preview`, {
      method: 'POST',
      body: JSON.stringify({ file }),
    });
  } catch (err) {
    return toast(err.message, { error: true });
  }

  const body = [];

  const removals = node('div', { class: ui.willBlock }, [node('div', { class: ui.willTitle, text: 'Will be removed' })]);
  removals.append(node('div', { class: ui.willItem('remove'), text: `memory/${preview.file}  →  memory/.trash/` }));
  for (const line of [...preview.indexLines, ...preview.continuations]) {
    removals.append(node('div', { class: ui.willItem('remove'), text: `MEMORY.md line ${line.index + 1}:  ${line.text}` }));
  }
  if (!preview.indexLines.length && preview.hasIndex) {
    removals.append(node('div', { class: ui.willItem(), text: 'MEMORY.md has no index bullet for this file - nothing to unlink there.' }));
  }
  body.push(removals);

  if (preview.inlineRefs.length) {
    const kept = node('div', { class: ui.willBlock }, [node('div', { class: ui.willTitle, text: 'Left untouched - mentioned inside prose, so you may want to fix these by hand' })]);
    for (const ref of preview.inlineRefs) {
      kept.append(node('div', { class: ui.willItem('keep'), text: `MEMORY.md line ${ref.index + 1}:  ${ref.text}` }));
    }
    body.push(kept);
  }

  const cascade = new Set();
  if (preview.inboundWikilinks.length) {
    const block = node('div', { class: ui.willBlock });
    const selectAll = node('button', { class: ui.linkButton, text: 'select all' });
    block.append(node('div', { class: ui.cascadeHead }, [
      node('div', { class: ui.willTitle, text: `${preview.inboundWikilinks.length} memory(s) link here and will break` }),
      selectAll,
    ]));

    const list = node('div', { class: ui.cascadeList });
    const rows = [];
    for (const link of preview.inboundWikilinks) {
      const box = node('input', { type: 'checkbox', class: ui.checkbox });
      const row = node('label', { class: ui.cascadeRow(false) }, [
        box,
        node('span', { class: ui.cascadeText }, [
          node('span', { class: ui.cascadeName, text: link.fromName || link.from }),
          node('span', { class: ui.cascadeDetail, text: link.indexLine
            ? `${link.from} · MEMORY.md line ${link.indexLine.index + 1}`
            : `${link.from} · not in the index` }),
        ]),
      ]);
      box.addEventListener('change', () => {
        row.className = ui.cascadeRow(box.checked);
        if (box.checked) cascade.add(link.from);
        else cascade.delete(link.from);
        updateButton();
      });
      rows.push({ box, row });
      list.append(row);
    }
    block.append(list);
    block.append(node('p', { class: ui.noteTight, text: 'Tick any you also want deleted - they go to the trash together and restore as one step.' }));
    body.push(block);

    selectAll.onclick = (event) => {
      event.preventDefault();
      const turnOn = rows.some((r) => !r.box.checked);
      for (const { box } of rows) {
        if (box.checked !== turnOn) { box.checked = turnOn; box.dispatchEvent(new Event('change')); }
      }
      selectAll.textContent = turnOn ? 'select none' : 'select all';
    };
  }

  body.push(node('p', { class: ui.noteTight, text: 'The file moves to memory/.trash/ with a restore record, so this can be undone.' }));

  const remove = { label: 'Delete', tone: 'danger', value: true };
  const answer = openDialog({
    title: `Delete "${preview.name || preview.file}"?`,
    subtitle: preview.description || '',
    body,
    actions: [{ label: 'Cancel' }, remove],
  });
  updateButton();
  if (!await answer) return;

  try {
    const result = await api(`/api/stores/${encodeURIComponent(state.storeId)}/delete`, {
      method: 'POST',
      body: JSON.stringify({ file, alsoDelete: [...cascade] }),
    });
    if (state.selected === file || cascade.has(state.selected)) state.selected = null;
    await openStore(state.storeId, { keepTab: true });
    const count = result.record.files.length;
    toast(count > 1 ? `Deleted ${count} memories` : `Deleted "${result.record.label || file}"`, {
      action: { label: 'Undo', run: () => restoreFromTrash(result.record.id) },
    });
  } catch (err) {
    toast(err.message, { error: true });
  }

  function updateButton() {
    remove.el.textContent = cascade.size ? `Delete ${cascade.size + 1} memories` : 'Delete';
  }
}
