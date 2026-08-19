import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { openDialog } from '/dialog.mjs';
import { api, toast } from '/api.mjs';
import { state } from '/state.mjs';
import { runIndexEdit } from '/views/index.mjs';

export async function openAddEntryDialog(file) {
  let preview;
  try {
    preview = await api(`/api/stores/${encodeURIComponent(state.storeId)}/index/add-preview`, {
      method: 'POST',
      body: JSON.stringify({ file }),
    });
  } catch (err) {
    return toast(err.message, { error: true });
  }

  const titleInput = node('input', { type: 'text', class: ui.pathInput, spellcheck: 'false' });
  titleInput.value = preview.name;
  const hook = node('textarea', { class: ui.textArea, spellcheck: 'false' });
  hook.value = preview.description;

  const picker = node('select', { class: ui.select });
  for (const section of preview.sections) picker.append(node('option', { value: section, text: section }));
  picker.append(node('option', { value: '', text: 'End of MEMORY.md' }));
  if (preview.sections.length) picker.value = preview.sections[preview.sections.length - 1];

  const line = node('div', { class: ui.willItem('keep') });
  const update = () => {
    const label = titleInput.value.trim().replace(/[[\]]/g, '') || preview.name;
    const text = hook.value.trim();
    line.textContent = text ? `- [${label}](${file}) — ${text}` : `- [${label}](${file})`;
  };
  titleInput.addEventListener('input', update);
  hook.addEventListener('input', update);
  update();

  const go = await openDialog({
    title: `Add ${file} to MEMORY.md`,
    body: [
      node('p', { class: ui.noteTight, text: preview.hasIndex
        ? 'MEMORY.md is loaded at the start of every session, so a memory with no bullet here is one Claude never sees. This adds one line and nothing else.'
        : 'This project has no MEMORY.md yet. Adding this entry creates one.' }),
      node('label', { class: ui.willTitle, text: 'Title' }),
      titleInput,
      node('label', { class: ui.willTitle, text: 'Hook' }),
      hook,
      node('label', { class: ui.willTitle, text: 'Section' }),
      picker,
      node('div', { class: ui.willBlock }, [
        node('div', { class: ui.willTitle, text: 'Will be added' }),
        line,
      ]),
    ],
    actions: [
      { label: 'Cancel' },
      { label: 'Add entry', tone: 'primary', value: true },
    ],
    focus: titleInput,
  });
  if (!go) return;

  await runIndexEdit(
    'index/add',
    { file, section: picker.value || null, title: titleInput.value, hook: hook.value },
    () => 'Added to MEMORY.md',
  );
}
