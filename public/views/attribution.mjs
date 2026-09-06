import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { api, toast } from '/api.mjs';
import { state } from '/state.mjs';
import { paint } from '/bus.mjs';
import { isAt, issue } from '/parts.mjs';

const SETTINGS_PROBLEMS = {
  unparseable: 'Not valid JSON',
  unreadable: 'Cannot be read',
  'not-object': 'Not a settings object',
};

const show = (value) => (value === undefined || value === null ? 'unset' : JSON.stringify(value));

const userValue = (entry) => entry.values.find((value) => value.scope === 'user')?.value ?? null;

async function saveSetting(key, value) {
  const id = state.storeId;
  try {
    const data = await api(`/api/stores/${encodeURIComponent(id)}/attribution/setting`, {
      method: 'POST',
      body: JSON.stringify({ key, value }),
    });
    if (state.storeId !== id) return;
    state.aux.attribution = { ...state.aux.attribution, settings: data.settings };
    toast(value === null ? 'Removed from your settings' : `Saved ${key} = ${JSON.stringify(value)}`);
  } catch (err) {
    toast(err.message, { error: true });
  }
  paint('tabs', 'tab');
}

function layerRows(entry) {
  if (!entry.values.length) {
    return [node('p', { class: ui.note, text: 'No settings file sets this, so the built-in default applies.' })];
  }
  return entry.values.map((value) => node('div', { class: ui.settingsLayerRow }, [
    node('span', { class: ui.scopeBadge(value.scope), text: value.scope }),
    node('span', { class: ui.settingsLayerValue(value.wins), text: show(value.value) }),
    node('span', { class: ui.settingsLayerFile, text: value.file }),
    value.wins ? node('span', { class: ui.badge('ok'), text: 'wins' }) : null,
  ]));
}

function hideOnlyControl(entry, writable) {
  const control = node('select', { class: ui.select }, [
    node('option', { value: 'default', text: 'included (default)' }),
    node('option', { value: 'hidden', text: 'omitted' }),
  ]);
  control.value = userValue(entry) === false ? 'hidden' : 'default';
  control.disabled = !writable;
  control.addEventListener('change', () => {
    control.disabled = true;
    saveSetting(entry.key, control.value === 'hidden' ? false : null);
  });
  return node('div', { class: ui.costControls }, [
    node('span', { class: ui.costControlLabel, text: 'your setting' }),
    control,
  ]);
}

function textOrHideControl(entry, writable) {
  const current = userValue(entry);
  const mode = current === false ? 'hidden' : typeof current === 'string' ? 'custom' : 'default';

  const select = node('select', { class: ui.select }, [
    node('option', { value: 'default', text: 'default text' }),
    node('option', { value: 'hidden', text: 'hidden' }),
    node('option', { value: 'custom', text: 'custom text…' }),
  ]);
  select.value = mode;
  select.disabled = !writable;

  const text = node('input', {
    type: 'text',
    class: ui.pathInput,
    spellcheck: 'false',
    placeholder: 'replacement text',
  });
  text.value = typeof current === 'string' ? current : '';
  text.hidden = mode !== 'custom';
  text.disabled = !writable;

  const commitText = () => {
    text.disabled = true;
    saveSetting(entry.key, text.value);
  };
  text.addEventListener('blur', commitText);
  text.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') text.blur();
  });

  select.addEventListener('change', () => {
    if (select.value === 'custom') {
      text.hidden = false;
      text.focus();
      return;
    }
    text.hidden = true;
    select.disabled = true;
    saveSetting(entry.key, select.value === 'hidden' ? false : null);
  });

  return node('div', { class: ui.costControls }, [
    node('span', { class: ui.costControlLabel, text: 'your setting' }),
    select,
    text,
  ]);
}

function settingCard(entry, writable) {
  const card = node('div', { class: ui.card });

  card.append(node('div', { class: ui.settingsKeyHead }, [
    node('span', { class: ui.settingsKeyName, text: entry.label }),
    node('span', {
      class: ui.settingsEffective,
      text: entry.effective ? show(entry.effective.value) : 'unset (default)',
    }),
    entry.effective ? node('span', { class: ui.scopeBadge(entry.effective.scope), text: entry.effective.scope }) : null,
  ]));
  card.append(node('p', { class: ui.noteTight, text: entry.detail }));

  card.append(entry.kind === 'hide-only' ? hideOnlyControl(entry, writable) : textOrHideControl(entry, writable));

  if (entry.shadowedByStronger) {
    card.append(issue(
      `Shadowed by ${entry.effective.scope} settings`,
      `${entry.effective.file} already sets this, and it outranks your user file. Saving below writes the value but nothing will change until that layer stops setting it.`,
    ));
  }

  for (const row of layerRows(entry)) card.append(row);
  return card;
}

export async function renderAttribution(container) {
  let data = state.aux.attribution;
  if (!data) {
    container.append(node('p', { class: ui.note, text: 'Reading settings…' }));
    const id = state.storeId;
    try {
      data = await api(`/api/stores/${encodeURIComponent(id)}/attribution`);
    } catch (err) {
      container.textContent = '';
      return container.append(node('p', { class: ui.note, text: err.message }));
    }
    if (state.storeId !== id || !isAt('environment', 'attribution')) return;
    state.aux.attribution = data;
  }
  container.textContent = '';

  container.append(node('p', {
    class: ui.noteTight,
    text: `What Claude Code adds to commits and pull requests, and whether you can turn it off. Changes land in ${data.settings.userFile}, the same file the Cost panel writes.`,
  }));

  for (const problem of data.settings.problems) {
    container.append(issue(
      `${SETTINGS_PROBLEMS[problem.kind] || problem.kind}: ${problem.scope} settings`,
      `${problem.file}: ${problem.detail}`,
      { bad: problem.severity === 'bad' },
    ));
  }

  if (!data.settings.writable) {
    container.append(issue(
      'Nothing here can be saved',
      `${data.settings.userFile} does not parse, and rewriting it would drop every setting this tool cannot read. Fix the file by hand and reload.`,
      { bad: true },
    ));
  }

  for (const entry of data.settings.keys) {
    container.append(settingCard(entry, data.settings.writable));
  }
}
