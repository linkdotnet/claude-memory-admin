import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { openDialog } from '/dialog.mjs';
import { api, toast } from '/api.mjs';
import { state } from '/state.mjs';
import { openStore, restoreFromTrash } from '/store.mjs';

export async function openMergeDialog(into, from) {
  let preview;
  try {
    preview = await api(`/api/stores/${encodeURIComponent(state.storeId)}/merge-preview`, {
      method: 'POST',
      body: JSON.stringify({ into, from }),
    });
  } catch (err) {
    return toast(err.message, { error: true });
  }

  const heading = node('input', { type: 'text', class: ui.pathInput, spellcheck: 'false' });
  heading.value = preview.heading;

  const body = [];
  body.push(node('p', { class: ui.noteTight, text: `Everything in "${preview.fromName}" moves into "${preview.intoName}" under a new heading, and "${preview.fromName}" goes to the trash. This rewrites prose, which nothing else in this app does - the whole operation is one undo.` }));

  const changes = node('div', { class: ui.willBlock }, [node('div', { class: ui.willTitle, text: 'Will change' })]);
  changes.append(node('div', { class: ui.willItem('keep'), text: `${preview.into}  +  ${preview.bodyLines} line(s) from ${preview.from}` }));
  for (const entry of preview.inbound) {
    changes.append(node('div', { class: ui.willItem('keep'), text: `${entry.file}  ${entry.targets.map((t) => `[[${t}]]`).join(' ')}  →  [[${preview.intoName}]]` }));
  }
  for (const link of preview.selfLinks) {
    changes.append(node('div', { class: ui.willItem('keep'), text: `${preview.into}  [[${link}]]  →  plain text, to avoid a self-link` }));
  }
  body.push(changes);

  const removals = node('div', { class: ui.willBlock }, [node('div', { class: ui.willTitle, text: 'Will be removed' })]);
  removals.append(node('div', { class: ui.willItem('remove'), text: `memory/${preview.from}  →  memory/.trash/` }));
  for (const line of preview.indexLines) {
    removals.append(node('div', { class: ui.willItem('remove'), text: `MEMORY.md line ${line.index + 1}:  ${line.text}` }));
  }
  if (!preview.indexLines.length) {
    removals.append(node('div', { class: ui.willItem(), text: 'MEMORY.md has no index bullet for the source - nothing to remove there.' }));
  }
  body.push(removals);

  if (preview.inlineRefs.length) {
    const kept = node('div', { class: ui.willBlock }, [
      node('div', { class: ui.willTitle, text: 'Left untouched - mentioned inside prose, so you may want to fix these by hand' }),
    ]);
    for (const ref of preview.inlineRefs) {
      kept.append(node('div', { class: ui.willItem('keep'), text: `MEMORY.md line ${ref.index + 1}:  ${ref.text}` }));
    }
    body.push(kept);
  }

  body.push(node('label', { class: ui.willTitle, text: 'Heading for the merged section' }), heading);

  const go = await openDialog({
    title: `Merge "${preview.fromName}" into "${preview.intoName}"?`,
    body,
    actions: [
      { label: 'Cancel' },
      { label: 'Merge', tone: 'primary', value: true },
    ],
    focus: heading,
  });
  if (!go) return;

  try {
    const result = await api(`/api/stores/${encodeURIComponent(state.storeId)}/merge`, {
      method: 'POST',
      body: JSON.stringify({ into, from, heading: heading.value }),
    });
    if (state.selected === from) state.selected = into;
    await openStore(state.storeId, { keepTab: true });
    toast(`Merged into ${preview.intoName}`, {
      action: { label: 'Undo', run: () => restoreFromTrash(result.record.id) },
    });
  } catch (err) {
    toast(err.message, { error: true });
  }
}
