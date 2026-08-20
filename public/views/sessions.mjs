import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { api } from '/api.mjs';
import { state } from '/state.mjs';
import { sizeLabel, sessionDate, isAt } from '/parts.mjs';
import { selectMemory } from '/store.mjs';
import { paint } from '/bus.mjs';
import { goTo } from '/parts.mjs';
import { toast } from '/api.mjs';

const TITLE_SOURCE = {
  'ai-title': 'title Claude Code generated for this session',
  slug: 'session slug, no generated title found in the part read',
  prompt: 'first prompt, no generated title found in the part read',
};

export function focusSession(id) {
  state.aux.sessionFocus = id;
  state.aux.sessionDay = null;
  goTo('environment', 'sessions');
}

function sessionRow(session, memoriesFrom, focused) {
  const soon = session.expiresInDays !== null && session.expiresInDays <= 7;
  const caret = node('span', { class: ui.contextCaret, text: focused ? '\u25be' : '\u25b8' });

  const tags = [];
  if (session.gitBranch) tags.push(node('span', { class: ui.badge('neutral'), text: session.gitBranch }));
  if (session.model) tags.push(node('span', { class: ui.badge('neutral'), text: session.model }));
  if (session.expiresInDays !== null) {
    tags.push(node('span', {
      class: ui.badge(soon ? 'warn' : 'neutral'),
      text: session.expiresInDays === 0 ? 'due to be swept' : `swept in ${session.expiresInDays}d`,
    }));
  }
  for (const memory of memoriesFrom) {
    tags.push(node('span', { class: ui.badge('project'), text: memory.name }));
  }

  const body = node('div', { class: ui.contextBody, hidden: !focused });
  const facts = node('dl', { class: ui.metaList });
  const rows = [
    ['session', session.id],
    ['last active', `${sessionDate(session.modified)}  (file mtime)`],
    ['size', sizeLabel(session.bytes)],
  ];
  if (session.cwd) rows.push(['cwd', session.cwd]);
  if (session.version) rows.push(['version', session.version]);
  if (session.titleFrom) rows.push(['title from', TITLE_SOURCE[session.titleFrom] || session.titleFrom]);
  for (const [key, value] of rows) {
    facts.append(node('dt', { class: ui.metaKey, text: key }), node('dd', { class: ui.metaValue, text: value }));
  }
  body.append(facts);
  if (session.prompt) {
    body.append(node('div', { class: ui.sectionLabel, text: 'Opened with' }));
    body.append(node('p', { class: ui.note, text: session.prompt }));
  }
  if (memoriesFrom.length) {
    body.append(node('div', { class: ui.sectionLabel, text: 'Memories written here' }));
    const chips = node('div', { class: ui.linkRow });
    for (const memory of memoriesFrom) {
      chips.append(node('button', {
        class: ui.chip(true),
        text: memory.name,
        onclick: () => selectMemory(memory.file),
      }));
    }
    body.append(chips);
  }

  const button = node('button', {
    class: ui.contextRowButton,
    'aria-expanded': String(Boolean(focused)),
    onclick: (event) => {
      const open = body.hidden;
      body.hidden = !open;
      caret.textContent = open ? '\u25be' : '\u25b8';
      event.currentTarget.setAttribute('aria-expanded', open ? 'true' : 'false');
    },
  }, [
    node('div', { class: ui.contextMain }, [
      node('div', { class: ui.contextTags }, tags),
      node('div', { class: ui.contextFile }, [caret, document.createTextNode(session.title || session.id)]),
    ]),
    node('div', { class: ui.contextSize, text: sessionDate(session.modified).slice(0, 10) }),
  ]);

  return node('div', {}, [button, body]);
}

function retentionTrack(sessions, days) {
  const track = node('div', { class: ui.retentionTrack }, [node('span', { class: ui.retentionSweep })]);
  for (const session of sessions) {
    if (session.expiresInDays === null) continue;
    const share = days > 0 ? Math.min(1, session.expiresInDays / days) : 1;
    track.append(node('span', {
      class: ui.retentionTick(session.expiresInDays <= 7),
      style: `left: ${(share * 100).toFixed(2)}%`,
      title: `${session.title || session.id}\nswept in ${session.expiresInDays} days`,
    }));
  }
  return node('div', {}, [
    track,
    node('div', { class: ui.retentionScale }, [
      node('span', { text: 'swept' }),
      node('span', { text: `today · kept ${days} days` }),
    ]),
  ]);
}

const WEEKDAYS = ['Mon', '', 'Wed', '', 'Fri', '', ''];
const LEVELS = [0, 1, 2, 3, 4];

function dayLabel(cell) {
  if (cell.count === 0) return `no sessions on ${cell.date}`;
  return cell.count === 1 ? `1 session on ${cell.date}` : `${cell.count} sessions on ${cell.date}`;
}

function heatCell(cell, selected, onPick) {
  if (cell.future) return node('span', { class: ui.heatBlank });
  const label = dayLabel(cell);
  const on = cell.date === selected;
  return node('button', {
    class: ui.heatTile(cell.level, on),
    title: label,
    'aria-label': label,
    'aria-pressed': on ? 'true' : 'false',
    onclick: () => onPick(on ? null : cell.date),
  });
}

function activityGrid(heat, selected, onPick) {
  const months = node('div', { class: ui.heatMonthRow });
  for (const label of heat.months) {
    months.append(node('div', { class: ui.heatMonthCell }, [
      label ? node('span', { class: ui.heatMonthLabel, text: label }) : null,
    ]));
  }

  const grid = node('div', { class: ui.heatGrid });
  for (const week of heat.weeks) {
    for (const cell of week) grid.append(heatCell(cell, selected, onPick));
  }

  const weekdays = node('div', { class: ui.heatDayCol });
  for (const label of WEEKDAYS) weekdays.append(node('span', { class: ui.heatDayLabel, text: label }));

  const legend = node('div', { class: ui.heatLegend }, [node('span', { text: 'Less' })]);
  for (const level of LEVELS) legend.append(node('span', { class: ui.heatLegendSwatch(level) }));
  legend.append(node('span', { text: 'More' }));

  return node('div', { class: ui.heatBody }, [
    weekdays,
    node('div', { class: ui.heatMain }, [
      node('div', { class: ui.heatScroll }, [months, grid]),
      legend,
    ]),
  ]);
}

function meterPanel(title, aside, body) {
  return node('div', { class: ui.meterPanel }, [
    node('div', { class: ui.meterPanelHead }, [
      node('span', { class: ui.meterPanelTitle, text: title }),
      aside,
    ]),
    body,
  ]);
}

export async function renderSessions(container) {
  let data = state.aux.sessions;
  if (!data) {
    container.append(node('p', { class: ui.note, text: 'Reading session transcripts\u2026' }));
    try {
      data = await api(`/api/stores/${encodeURIComponent(state.storeId)}/sessions`);
    } catch (err) {
      container.textContent = '';
      return container.append(node('p', { class: ui.note, text: err.message }));
    }
    if (!isAt('environment', 'sessions')) return;
    state.aux.sessions = data;
  }
  container.textContent = '';

  const byOrigin = new Map();
  for (const memory of state.store.memories) {
    if (!memory.origin?.present) continue;
    if (!byOrigin.has(memory.origin.sessionId)) byOrigin.set(memory.origin.sessionId, []);
    byOrigin.get(memory.origin.sessionId).push(memory);
  }

  const selected = state.aux.sessionDay;
  const pickDay = (date) => {
    state.aux.sessionDay = date;
    paint('tab');
  };

  container.append(node('p', { class: ui.noteTight, text: 'The transcripts sitting beside this store\u2019s memory. Claude Code deletes them once they pass the retention period and never touches memory/, so this is the evidence that expires while the memories stay. This tab only reads, and only the head of each file - nothing here deletes a transcript.' }));

  container.append(node('div', { class: ui.meter }, [
    node('div', { class: ui.meterTop }, [
      node('span', { class: ui.meterValue, text: String(data.count) }),
      node('span', { class: ui.meterUnit, text: data.count === 1 ? 'session kept' : 'sessions kept' }),
    ]),
    node('div', { class: ui.meterPanels }, [
      meterPanel('Retention', null, retentionTrack(data.sessions, data.days)),
      data.heat ? meterPanel('Activity', null, activityGrid(data.heat, selected, pickDay)) : null,
    ]),
    node('div', { class: ui.meterFacts }, [
      node('span', {}, [node('b', { class: ui.meterFactValue, text: sizeLabel(data.bytes) }), document.createTextNode(' on disk')]),
      node('span', {}, [node('b', { class: ui.meterFactValue, text: `${data.days} days` }), document.createTextNode(' retention (cleanupPeriodDays)')]),
      node('span', {}, [
        node('b', { class: ui.meterFactValue, text: data.evidenceExpiresInDays === null ? '-' : `${data.evidenceExpiresInDays} days` }),
        document.createTextNode(' until the last proof of this path goes'),
      ]),
    ]),
    node('p', { class: ui.meterNote, text: 'Sweep dates come from each file\u2019s mtime, which any copy or restore resets, so they are an estimate of when Claude Code will drop them rather than something the transcript recorded about itself.' }),
  ]));

  const visible = selected
    ? data.sessions.filter((session) => session.modified.slice(0, 10) === selected)
    : data.sessions;
  const listHead = node('div', { class: ui.sectionLabelRow }, [
    node('span', {
      class: ui.sectionLabelInline,
      text: selected ? `Sessions \u00b7 ${visible.length} on ${selected}` : `Sessions \u00b7 ${data.count}`,
    }),
  ]);
  if (selected) {
    listHead.append(node('button', {
      class: ui.heatFilterClear,
      text: 'show every day',
      onclick: () => pickDay(null),
    }));
  }
  container.append(listHead);
  const focus = state.aux.sessionFocus;
  state.aux.sessionFocus = null;

  const card = node('div', { class: ui.card });
  let focused = null;
  for (const session of visible) {
    const row = sessionRow(session, byOrigin.get(session.id) || [], session.id === focus);
    if (session.id === focus) focused = row;
    card.append(row);
  }
  container.append(card);

  if (focus && focused) {
    requestAnimationFrame(() => focused.scrollIntoView({ block: 'center' }));
  } else if (focus) {
    toast('That transcript is no longer beside this store - Claude Code has swept it.');
  }
}
