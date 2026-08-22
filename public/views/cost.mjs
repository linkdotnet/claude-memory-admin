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

const AGENT_PROBLEMS = {
  'no-frontmatter': 'No frontmatter block',
  'missing-name': 'No name',
  'missing-description': 'No description',
  'name-mismatch': 'Name and filename disagree',
  'unknown-model': 'Unrecognised model',
  'unknown-effort': 'Unrecognised effort',
};

const show = (value) => (value === undefined || value === null ? 'unset' : JSON.stringify(value));

const optionText = (option) => (option.note ? `${option.label} (${option.note})` : option.label);

const userValue = (entry) => entry.values.find((value) => value.scope === 'user')?.value ?? null;

function picker(options, current, onPick) {
  const control = node('select', { class: ui.select });
  const known = options.some((option) => option.value === current);
  const all = current && !known
    ? [...options, { value: current, label: current, note: 'set in the file' }]
    : options;

  for (const option of all) {
    control.append(node('option', {
      value: option.value === null ? '' : option.value,
      text: optionText(option),
    }));
  }
  control.value = current === null || current === undefined ? '' : current;

  control.addEventListener('change', () => {
    control.disabled = true;
    onPick(control.value === '' ? null : control.value);
  });
  return control;
}

function labelled(label, control) {
  return node('label', { class: ui.agentControl }, [
    node('span', { class: ui.costControlLabel, text: label }),
    control,
  ]);
}

async function saveSetting(key, value) {
  const id = state.storeId;
  try {
    const data = await api(`/api/stores/${encodeURIComponent(id)}/cost/setting`, {
      method: 'POST',
      body: JSON.stringify({ key, value }),
    });
    if (state.storeId !== id) return;
    state.aux.cost = { ...state.aux.cost, settings: data.settings };
    toast(value === null ? 'Removed from your settings' : `Saved ${key} = ${value}`);
  } catch (err) {
    toast(err.message, { error: true });
  }
  paint('tabs', 'tab');
}

async function saveAgent(file, field, value) {
  const id = state.storeId;
  try {
    const data = await api(`/api/stores/${encodeURIComponent(id)}/cost/agent`, {
      method: 'POST',
      body: JSON.stringify({ file, field, value }),
    });
    if (state.storeId !== id) return;
    state.aux.cost = { ...state.aux.cost, agents: data.agents, agentsDirExists: data.agentsDirExists };
    toast(value === null ? `Cleared ${field} in ${file}` : `${file}: ${field} = ${value}`);
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

  const control = picker(entry.options, userValue(entry), (value) => saveSetting(entry.key, value));
  control.disabled = !writable;
  card.append(node('div', { class: ui.costControls }, [
    node('span', { class: ui.costControlLabel, text: 'your setting' }),
    control,
  ]));

  if (entry.envValue && entry.envValue !== entry.effective?.value) {
    card.append(issue(
      `${entry.envVar}=${entry.envValue} is set in the environment`,
      `An environment variable outranks every settings file, so any session started from a shell that has it runs on ${entry.envValue} whatever is saved here. This is what the shell that launched this tool had; a session started elsewhere may see something different.`,
      { bad: true },
    ));
  }

  if (entry.shadowedByStronger) {
    card.append(issue(
      `Shadowed by ${entry.effective.scope} settings`,
      `${entry.effective.file} already sets this, and it outranks your user file. Saving below writes the value but nothing will change until that layer stops setting it.`,
    ));
  }

  for (const row of layerRows(entry)) card.append(row);
  return card;
}

function agentRow(agent, fields) {
  const row = node('div', { class: ui.agentRow });

  row.append(node('div', { class: ui.agentTop }, [
    node('span', { class: ui.agentName, text: agent.name }),
    node('span', { class: ui.agentFile, text: agent.file }),
  ]));

  if (agent.description) row.append(node('p', { class: ui.agentDesc, text: agent.description }));
  if (agent.tools) row.append(node('div', { class: ui.agentTools, text: `tools: ${agent.tools}` }));

  row.append(node('div', { class: ui.agentControls }, [
    labelled('model', picker(fields.model.options, agent.model, (value) => saveAgent(agent.file, 'model', value))),
    labelled('effort', picker(fields.effort.options, agent.effort, (value) => saveAgent(agent.file, 'effort', value))),
  ]));

  for (const problem of agent.problems) {
    row.append(issue(
      AGENT_PROBLEMS[problem.kind] || problem.kind,
      problem.detail,
      { bad: problem.severity === 'bad' },
    ));
  }
  return row;
}

function agentsCard(data) {
  const card = node('div', { class: ui.card });
  card.append(node('p', {
    class: ui.noteTight,
    text: 'One markdown file per agent. Only the model and the effort are edited here; the prompt, the tool lists and every other field are left exactly as they are. CLAUDE_CODE_SUBAGENT_MODEL above, whenever it is set, overrides all of these.',
  }));

  if (!data.agents.length) {
    card.append(node('div', {
      class: ui.costEmpty,
      text: data.agentsDirExists
        ? `${data.agentsDir} holds no agent files yet. An agent is a markdown file there with a name and a description in its frontmatter.`
        : `${data.agentsDir} does not exist, so there are no user-scope agents to tune. The built-in Explore, Plan and general-purpose agents are not files and cannot be changed here; CLAUDE_CODE_SUBAGENT_MODEL above is what moves those.`,
    }));
    return card;
  }

  for (const agent of data.agents) card.append(agentRow(agent, data.agentFields));
  return card;
}

export async function renderCost(container) {
  let data = state.aux.cost;
  if (!data) {
    container.append(node('p', { class: ui.note, text: 'Reading settings and agent files…' }));
    const id = state.storeId;
    try {
      data = await api(`/api/stores/${encodeURIComponent(id)}/cost`);
    } catch (err) {
      container.textContent = '';
      return container.append(node('p', { class: ui.note, text: err.message }));
    }
    if (state.storeId !== id || !isAt('environment', 'cost')) return;
    state.aux.cost = data;
  }
  container.textContent = '';

  container.append(node('p', {
    class: ui.noteTight,
    text: `The two settings that decide what a session costs, and the model each of your agents runs on. This is the one place in the app that writes outside a memory store: changes land in ${data.settings.userFile} and in the files under ${data.agentsDir}. Your CLAUDE.md and the rest of the instruction chain are never touched.`,
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

  container.append(node('div', { class: ui.sectionLabel, text: `Agents · ${data.agents.length}` }));
  container.append(agentsCard(data));
}
