import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { focusSession } from '/views/sessions.mjs';

const money = (value) => (value >= 100 ? `$${Math.round(value).toLocaleString()}` : `$${value.toFixed(2)}`);

const compact = (value) => {
  const rounded = Math.round(value);
  if (Math.abs(rounded) >= 1000000000) return `${(rounded / 1000000000).toFixed(1)}B`;
  if (Math.abs(rounded) >= 1000000) return `${(rounded / 1000000).toFixed(1)}M`;
  if (Math.abs(rounded) >= 1000) return `${(rounded / 1000).toFixed(1)}K`;
  return String(rounded);
};

const clamp = (percent) => Math.min(100, Math.max(0, percent));

const shortModel = (name) => name.replace(/^claude-/, '').replace(/-\d{8}$/, '');

const fact = (value, label) => node('span', {}, [
  node('b', { class: ui.meterFactValue, text: value }),
  document.createTextNode(` ${label}`),
]);

function meter(percent, value, unit, note, facts) {
  return node('div', { class: ui.meter }, [
    node('div', { class: ui.meterTop }, [
      node('span', { class: ui.meterValue, text: value }),
      node('span', { class: ui.meterUnit, text: unit }),
    ]),
    node('div', { class: ui.meterBar }, [
      node('div', { class: ui.meterFill('accent'), style: `width:${clamp(percent).toFixed(1)}%` }),
    ]),
    note ? node('p', { class: ui.meterNote, text: note }) : null,
    facts.length ? node('div', { class: ui.meterFacts }, facts) : null,
  ]);
}

const row = (name, detail, value, onclick) => node('div', { class: ui.settingsLayerRow }, [
  onclick
    ? node('button', { class: ui.linkButton, text: name, onclick })
    : node('span', { class: ui.settingsKeyName, text: name }),
  node('span', { class: ui.settingsLayerFile, text: detail }),
  node('span', { class: ui.settingsEffective, text: value }),
]);

function projectSection(report) {
  const project = report.project;
  if (!project) {
    return [node('p', { class: ui.noteTight, text: 'This entry is not a project store, so ccusage has no transcripts to attribute to it.' })];
  }
  if (!project.sessions) {
    return [node('p', { class: ui.noteTight, text: 'ccusage found no billed sessions for this project.' })];
  }

  const cacheShare = project.tokens ? (project.cacheRead / project.tokens) * 100 : 0;
  return [
    node('div', { class: ui.sectionLabel, text: 'This project' }),
    meter(
      project.share,
      money(project.cost),
      `spent here, ${project.share.toFixed(1)}% of everything Claude Code has cost you`,
      'Read from the same transcripts this app lists under Sessions, priced with the ccusage cached price table. No network call is made.',
      [
        fact(String(project.sessions), 'sessions'),
        fact(compact(project.tokens), 'tokens'),
        fact(compact(project.output), 'written by Claude'),
        fact(`${cacheShare.toFixed(1)}%`, 'of it cache reads'),
      ],
    ),
  ];
}

function modelSection(report) {
  const models = report.project ? report.project.models : [];
  if (!models.length) return [];
  const top = models[0].cost;
  return [
    node('div', { class: ui.sectionLabel, text: 'Where the money went' }),
    ...models.map((model) => row(
      shortModel(model.name),
      `${compact(model.tokens)} tokens written${model.cost === top ? ' · most expensive' : ''}`,
      money(model.cost),
    )),
  ];
}

function sessionSection(report) {
  const top = report.project ? report.project.top : [];
  if (!top.length) return [];
  return [
    node('div', { class: ui.sectionLabel, text: 'Most expensive sessions' }),
    ...top.map((session) => row(
      session.id.slice(0, 8),
      `${compact(session.tokens)} tokens · ${session.last.slice(0, 10)}`,
      money(session.cost),
      () => focusSession(session.id),
    )),
    node('p', { class: ui.note, text: 'Click an id to open that transcript under Sessions. A session Claude Code has already swept is gone from there, and says so.' }),
  ];
}

function machineSection(report) {
  const machine = report.machine;
  if (!machine) return [node('p', { class: ui.noteTight, text: 'The ccusage ledger could not be read.' })];

  const window = machine.window;
  const share = machine.cost ? (window.cost / machine.cost) * 100 : 0;
  return [
    node('div', { class: ui.sectionLabel, text: report.project ? 'Every project' : 'This machine' }),
    meter(
      share,
      money(machine.cost),
      'across every project Claude Code has a transcript for',
      `The bar is how much of that fell in the last ${window.days} days, so a full one means the habit is recent rather than accumulated.`,
      [
        fact(String(machine.sessions), 'sessions'),
        fact(compact(machine.tokens), 'tokens'),
        fact(money(window.cost), `in the last ${window.days} days`),
      ],
    ),
  ];
}

function errorNotes(report) {
  if (!report.errors.length) return [];
  return [
    node('div', { class: ui.sectionLabel, text: 'Not read' }),
    ...report.errors.map((error) => node('p', { class: ui.noteTight, text: `${error.step}: ${error.message}` })),
  ];
}

export function ccusageSummary(report) {
  const project = report.project;
  if (project && project.sessions) {
    return `${money(project.cost)} here · ${project.sessions} sessions`;
  }
  if (report.machine) return `${money(report.machine.cost)} across every project`;
  return 'no ledger';
}

export function renderCcusage(container, report) {
  const parts = [
    ...projectSection(report),
    ...machineSection(report),
    ...modelSection(report),
    ...sessionSection(report),
    ...errorNotes(report),
  ];
  for (const part of parts) container.append(part);
}
