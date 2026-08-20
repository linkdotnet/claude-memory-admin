import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';

const compact = (value) => {
  const rounded = Math.round(value);
  if (Math.abs(rounded) >= 1000000) return `${(rounded / 1000000).toFixed(1)}M`;
  if (Math.abs(rounded) >= 1000) return `${(rounded / 1000).toFixed(1)}K`;
  return String(rounded);
};

const clamp = (percent) => Math.min(100, Math.max(0, percent));

const fact = (value, label) => node('span', {}, [
  node('b', { class: ui.meterFactValue, text: value }),
  document.createTextNode(` ${label}`),
]);

function meter(percent, unit, note, facts) {
  return node('div', { class: ui.meter }, [
    node('div', { class: ui.meterTop }, [
      node('span', { class: ui.meterValue, text: `${percent.toFixed(1)}%` }),
      node('span', { class: ui.meterUnit, text: unit }),
    ]),
    node('div', { class: ui.meterBar }, [
      node('div', { class: ui.meterFill('accent'), style: `width:${clamp(percent).toFixed(1)}%` }),
    ]),
    note ? node('p', { class: ui.meterNote, text: note }) : null,
    facts.length ? node('div', { class: ui.meterFacts }, facts) : null,
  ]);
}

function head(report, actions) {
  return node('div', { class: ui.sectionLabelRow }, [
    node('span', { class: ui.sectionLabelInline, text: report.version ? `rtk ${report.version}` : 'rtk' }),
    node('span', { class: ui.note, text: report.path || '' }),
    node('span', { class: ui.listSpacer }),
    node('button', { class: ui.buttonSmall, text: 'Re-read', onclick: actions.reread }),
    node('button', { class: ui.buttonSmall, text: 'Turn off', onclick: actions.turnOff }),
  ]);
}

function projectSection(report) {
  const project = report.project;
  if (!project) return [];
  if (!project.commands) {
    return [
      node('div', { class: ui.sectionLabel, text: 'This project' }),
      node('p', { class: ui.noteTight, text: `rtk has filtered nothing in ${report.projectDir} yet.` }),
    ];
  }
  return [node('div', { class: ui.sectionLabel, text: 'This project' }), meter(
    project.savedPct,
    'of what rtk read in this project never reached the model',
    'rtk scopes its ledger by working directory, so this covers every command run from this project path.',
    [
      fact(compact(project.saved), 'tokens saved'),
      fact(compact(project.commands), 'commands filtered'),
      fact(`${compact(project.input)} → ${compact(project.output)}`, 'in / out'),
      fact(`${compact(project.avgMs)}ms`, 'average'),
    ],
  )];
}

function machineMeter(report) {
  const machine = report.machine;
  if (!machine) return null;
  const window = machine.window;
  const facts = [
    fact(compact(machine.saved), 'tokens saved'),
    fact(compact(machine.commands), 'commands filtered'),
    fact(`${compact(machine.avgMs)}ms`, 'average'),
  ];
  if (window && window.commands) {
    facts.push(fact(`${compact(window.saved)} (${window.savedPct.toFixed(1)}%)`, `saved in the last ${window.days} days`));
  }
  return meter(
    machine.savedPct,
    'of everything rtk has ever filtered on this machine',
    null,
    facts,
  );
}

function missedRow(item) {
  const saving = `${compact(item.savedTokens)} tokens (${item.savedPct.toFixed(0)}%)`;
  return node('div', { class: ui.issue(false) }, [
    node('div', { class: ui.issueBody }, [
      node('div', { class: ui.issueTitle, text: `${item.command} ran ${item.count.toLocaleString()} times unfiltered` }),
      node('div', { class: ui.issueDetail, text: `${item.equivalent} would have saved about ${saving}` }),
    ]),
    node('span', { class: ui.badge('neutral'), text: item.category || 'Other' }),
  ]);
}

function discoverSection(report) {
  const discover = report.discover;
  if (!discover || !discover.commands) return [];

  const parts = [
    node('div', { class: ui.sectionLabel, text: 'Left on the table' }),
    meter(
      discover.adoptionPct,
      `of the commands in the last ${discover.sinceDays} days already went through rtk`,
      `Counted across ${discover.sessionsScanned.toLocaleString()} session transcripts for this project.`,
      [
        fact(discover.alreadyRtk.toLocaleString(), 'already filtered'),
        fact(discover.commands.toLocaleString(), 'commands seen'),
        fact(discover.sessionsScanned.toLocaleString(), 'sessions scanned'),
      ],
    ),
  ];

  if (!discover.missed.length) {
    parts.push(node('p', { class: ui.okLine, text: 'Nothing rtk knows how to filter was run raw.' }));
    return parts;
  }

  for (const item of discover.missed) parts.push(missedRow(item));
  const hidden = discover.missedTotal - discover.missed.length;
  const left = hidden === 1 ? '1 smaller one is not shown' : `${hidden} smaller ones are not shown`;
  parts.push(node('p', { class: ui.note, text: hidden > 0
    ? `Estimates from rtk itself, worst first; ${left}. They count what the filter would have stripped, not what the model would have ignored.`
    : 'Estimates from rtk itself, worst first. They count what the filter would have stripped, not what the model would have ignored.' }));
  return parts;
}

function errorNotes(report) {
  if (!report.errors.length) return [];
  return [
    node('div', { class: ui.sectionLabel, text: 'Not read' }),
    ...report.errors.map((error) => node('p', { class: ui.noteTight, text: `${error.step}: ${error.message}` })),
  ];
}

export function renderRtk(container, report, actions) {
  container.append(head(report, actions));
  for (const part of projectSection(report)) container.append(part);

  container.append(node('div', { class: ui.sectionLabel, text: report.project ? 'Every project' : 'This machine' }));
  const machine = machineMeter(report);
  container.append(machine || node('p', { class: ui.noteTight, text: 'The machine-wide ledger could not be read.' }));
  if (!report.project && !report.projectDir) {
    container.append(node('p', { class: ui.note, text: 'This entry is the user scope rather than a project, so rtk has no working directory to slice its ledger by.' }));
  }

  for (const part of discoverSection(report)) container.append(part);
  for (const part of errorNotes(report)) container.append(part);
}
