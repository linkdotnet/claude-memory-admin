import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { api } from '/api.mjs';
import { state } from '/state.mjs';
import { isAt } from '/parts.mjs';

const SETTINGS_PROBLEMS = {
  unparseable: (p) => [
    `Not valid JSON: ${p.scope} settings`,
    `${p.file} — Claude Code cannot read this file either, so every value in it is being ignored. ${p.detail}`,
  ],
  unreadable: (p) => [
    `Cannot be read: ${p.scope} settings`,
    `${p.file} — ${p.detail}`,
  ],
  'not-object': (p) => [
    `Not a settings object: ${p.scope} settings`,
    `${p.file} — ${p.detail}`,
  ],
  'invalid-auto-memory-directory': (p) => [
    'autoMemoryDirectory cannot be used',
    `${p.file} — ${p.detail}. Claude Code accepts only an absolute or ~/-prefixed path.`,
  ],
};

const show = (value) => (value === undefined ? 'unset' : JSON.stringify(value));

export async function renderSettings(container) {
  let data = state.aux.settings;
  if (!data) {
    container.append(node('p', { class: ui.note, text: 'Reading settings files…' }));
    try {
      data = await api(`/api/stores/${encodeURIComponent(state.storeId)}/settings`);
    } catch (err) {
      container.textContent = '';
      return container.append(node('p', { class: ui.note, text: err.message }));
    }
    if (!isAt('environment', 'settings')) return;
  }
  container.textContent = '';

  container.append(node('p', { class: ui.noteTight, text: 'What Claude Code would read for this store, in precedence order: managed policy first, then project and local settings, then your user file. This tab is read-only — it reports what is configured, it never changes it.' }));

  if (!data.projectDir) {
    container.append(node('p', { class: ui.subWarn, text: 'This store has no resolved project directory, so its project and local settings layers could not be consulted. Values below come from managed policy and your user file only.' }));
  }

  if (data.problems.length) {
    container.append(node('div', { class: ui.sectionLabel, text: `Problems · ${data.problems.length}` }));
    for (const problem of data.problems) {
      const describe = SETTINGS_PROBLEMS[problem.kind];
      const [title, detail] = describe ? describe(problem) : [problem.kind, problem.file || ''];
      container.append(node('div', { class: ui.issue(problem.severity === 'bad') }, [
        node('div', { class: ui.issueBody }, [
          node('div', { class: ui.issueTitle, text: title }),
          node('div', { class: ui.issueDetail, text: detail }),
        ]),
      ]));
    }
  }

  if (data.env.overrides) {
    container.append(node('div', { class: ui.sectionLabel, text: 'Environment override' }));
    container.append(node('div', { class: ui.issue(false) }, [
      node('div', { class: ui.issueBody }, [
        node('div', { class: ui.issueTitle, text: `${data.env.name}=${data.env.value}` }),
        node('div', { class: ui.issueDetail, text: `Set in this shell, so it outranks every settings file and forces ${data.env.overrides} off. The store will not grow while it is set.` }),
      ]),
    ]));
  }

  for (const entry of data.keys) {
    const card = node('div', { class: ui.card });
    const head = node('div', { class: ui.settingsKeyHead }, [
      node('span', { class: ui.settingsKeyName, text: entry.key }),
      node('span', {
        class: ui.settingsEffective,
        text: entry.effective ? show(entry.effective.value) : `${show(entry.fallback)} (default)`,
      }),
    ]);
    if (entry.effective) {
      head.append(node('span', { class: ui.scopeBadge(entry.effective.scope), text: entry.effective.scope }));
    }
    card.append(head);
    card.append(node('p', { class: ui.noteTight, text: entry.detail }));

    if (entry.normalized !== undefined && entry.effective && entry.normalized !== entry.effective.value) {
      card.append(node('div', { class: ui.issue(false) }, [
        node('div', { class: ui.issueBody }, [
          node('div', { class: ui.issueTitle, text: `Configured ${show(entry.effective.value)}, but ${show(entry.normalized)} applies` }),
          node('div', { class: ui.issueDetail, text: 'Claude Code ignores a value it cannot use and falls back to the default.' }),
        ]),
      ]));
    }

    if (!entry.values.length) {
      card.append(node('p', { class: ui.note, text: 'No settings file sets this, so the built-in default applies.' }));
    } else {
      for (const value of entry.values) {
        card.append(node('div', { class: ui.settingsLayerRow }, [
          node('span', { class: ui.scopeBadge(value.scope), text: value.scope }),
          node('span', { class: ui.settingsLayerValue(value.wins), text: show(value.value) }),
          node('span', { class: ui.settingsLayerFile, text: value.file }),
          value.wins ? node('span', { class: ui.badge('ok'), text: 'wins' }) : null,
        ]));
      }
    }
    container.append(card);
  }

  container.append(node('div', { class: ui.sectionLabel, text: `Files consulted · ${data.layers.length}` }));
  const files = node('div', { class: ui.card });
  for (const layer of data.layers) {
    files.append(node('div', { class: ui.settingsLayerRow }, [
      node('span', { class: ui.scopeBadge(layer.scope), text: layer.scope }),
      node('span', { class: ui.settingsLayerValue(layer.status === 'ok'), text: layer.status }),
      node('span', { class: ui.settingsLayerFile, text: layer.file }),
    ]));
  }
  container.append(files);
}
