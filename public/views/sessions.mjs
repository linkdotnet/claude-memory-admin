import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { api } from '/api.mjs';
import { state } from '/state.mjs';
import { sizeLabel, sessionDate } from '/parts.mjs';
import { selectMemory } from '/store.mjs';

const TITLE_SOURCE = {
  'ai-title': 'title Claude Code generated for this session',
  slug: 'session slug, no generated title found in the part read',
  prompt: 'first prompt, no generated title found in the part read',
};

function sessionRow(session, memoriesFrom) {
  const soon = session.expiresInDays !== null && session.expiresInDays <= 7;
  const caret = node('span', { class: ui.contextCaret, text: '\u25b8' });

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

  const body = node('div', { class: ui.contextBody, hidden: true });
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
    'aria-expanded': 'false',
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
    if (state.tab !== 'sessions') return;
    state.aux.sessions = data;
  }
  container.textContent = '';

  const byOrigin = new Map();
  for (const memory of state.store.memories) {
    if (!memory.origin?.present) continue;
    if (!byOrigin.has(memory.origin.sessionId)) byOrigin.set(memory.origin.sessionId, []);
    byOrigin.get(memory.origin.sessionId).push(memory);
  }

  container.append(node('p', { class: ui.noteTight, text: 'The transcripts sitting beside this store\u2019s memory. Claude Code deletes them once they pass the retention period and never touches memory/, so this is the evidence that expires while the memories stay. This tab only reads, and only the head of each file - nothing here deletes a transcript.' }));

  container.append(node('div', { class: ui.meter }, [
    node('div', { class: ui.meterTop }, [
      node('span', { class: ui.meterValue, text: String(data.count) }),
      node('span', { class: ui.meterUnit, text: data.count === 1 ? 'session kept' : 'sessions kept' }),
    ]),
    retentionTrack(data.sessions, data.days),
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

  container.append(node('div', { class: ui.sectionLabel, text: `Sessions \u00b7 ${data.count}` }));
  const card = node('div', { class: ui.card });
  for (const session of data.sessions) {
    card.append(sessionRow(session, byOrigin.get(session.id) || []));
  }
  container.append(card);
}
