import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { openDialog } from '/dialog.mjs';
import { state } from '/state.mjs';
import { toast } from '/api.mjs';
import { indexEntryAt, sectionsAbove, runIndexEdit } from '/views/index.mjs';

export async function openMoveDialog(entry) {
  const current = indexEntryAt(entry.index);
  if (!current) return toast('MEMORY.md has changed - reload and try again', { error: true });

  const { cutoff } = state.store.stats.index;
  const sections = sectionsAbove(cutoff ? cutoff.rawLine : null);
  const picker = node('select', { class: ui.select });
  picker.append(node('option', { value: '', text: 'Top of MEMORY.md' }));
  for (const section of sections) picker.append(node('option', { value: section, text: `Start of "${section}"` }));

  const go = await openDialog({
    title: 'Move this entry above the cutoff',
    body: [
      node('p', { class: ui.noteTight, text: `"${current.title}" sits at line ${current.index + 1}, past the cutoff at line ${cutoff ? cutoff.rawLine + 1 : '-'}, so Claude never loads it. Moving it up puts it back inside the loaded part of the index - which pushes whatever is now last past the cutoff instead.` }),
      node('div', { class: ui.willBlock }, [
        node('div', { class: ui.willTitle, text: 'Will move' }),
        node('div', { class: ui.willItem('keep'), text: current.text }),
      ]),
      node('label', { class: ui.willTitle, text: 'Move to' }),
      picker,
    ],
    actions: [
      { label: 'Cancel' },
      { label: 'Move', tone: 'primary', value: true },
    ],
  });
  if (!go) return;

  await runIndexEdit(
    'index/move',
    picker.value
      ? { lineIndex: current.index, expectedText: current.text, section: picker.value }
      : { lineIndex: current.index, expectedText: current.text, top: true },
    () => 'Entry moved',
  );
}
