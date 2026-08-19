import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { state } from '/state.mjs';
import { toast } from '/api.mjs';
import { paint } from '/bus.mjs';
import { byteLength } from '/parts.mjs';
import { indexEntryAt, runIndexEdit } from '/views/index.mjs';

export function openHookEditor(row, lineIndex) {
  const entry = indexEntryAt(lineIndex);
  if (!entry) return toast('MEMORY.md has changed - reload and try again', { error: true });

  const stats = state.store.stats.index;
  const editor = node('div', { class: ui.hookEditor });
  const field = node('textarea', { class: ui.textArea, spellcheck: 'false' });
  field.value = entry.hook;

  const counter = node('span');
  const projection = node('span');
  const readout = node('div', { class: ui.charCount }, [counter, projection]);

  const save = node('button', { class: ui.buttonPrimarySmall, text: 'Save' });
  const cancel = node('button', { class: ui.buttonSmall, text: 'Cancel', onclick: () => paint('tab') });

  function update() {
    const next = field.value.trim();
    const delta = byteLength(next) - byteLength(entry.hook);
    const projected = Math.max(stats.linePercent, ((stats.bytes + delta) / stats.byteLimit) * 100);

    counter.textContent = `${next.length} characters, was ${entry.hook.length}`;
    projection.textContent = `index ${Math.round(stats.worstPercent)}% → ${Math.round(projected)}%`;
    readout.className = next.length > 200 ? ui.charCountOver : ui.charCount;
    save.disabled = next === entry.hook;
  }

  field.addEventListener('input', update);
  save.onclick = () => runIndexEdit(
    'index/hook',
    { lineIndex, expectedText: entry.text, hook: field.value },
    () => 'Hook shortened',
  );

  editor.append(
    node('div', { class: ui.willTitle, text: 'Hook' }),
    field,
    readout,
    node('div', { class: ui.hookEditorFoot }, [cancel, save]),
  );
  row.textContent = '';
  row.append(editor);
  update();
  field.focus();
  field.select();
}
