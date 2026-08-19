import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { state } from '/state.mjs';
import { buildWorklist } from '/views/worklist.mjs';
import { renderCostIssue, COST_KINDS } from '/views/cost-issue.mjs';
import { renderIssue } from '/views/issue.mjs';
import { renderPathCheck } from '/views/path-check.mjs';

const SHOWN = 40;

function renderMeter(container) {
  const { index } = state.store.stats;
  const percent = Math.min(100, index.worstPercent);

  const note = index.level === 'over'
    ? 'Over the limit. Everything past the cutoff is dropped when the session loads it, so those entries are effectively invisible to Claude right now.'
    : index.level === 'near'
      ? 'Approaching the limit. Once MEMORY.md passes it, everything after the cutoff stops being loaded at all.'
      : 'Comfortably inside the limit. MEMORY.md is loaded at the start of every session.';

  container.append(node('div', { class: ui.meter }, [
    node('div', { class: ui.meterTop }, [
      node('span', { class: ui.meterValue, text: `${Math.round(index.worstPercent)}%` }),
      node('span', { class: ui.meterUnit, text: `of the MEMORY.md load limit, currently bounded by ${index.limitedBy}` }),
    ]),
    node('div', { class: ui.meterBar }, [
      node('div', { class: ui.meterFill(index.level), style: `width:${percent.toFixed(1)}%` }),
    ]),
    node('p', { class: ui.meterNote, text: note }),
    node('div', { class: ui.meterFacts }, [
      node('span', {}, [node('b', { class: ui.meterFactValue, text: `${index.lines} / ${index.lineLimit}` }), document.createTextNode(' lines')]),
      node('span', {}, [node('b', { class: ui.meterFactValue, text: `${(index.bytes / 1024).toFixed(1)} / ${index.byteLimit / 1024} KB` }), document.createTextNode(' loaded size')]),
      node('span', {}, [node('b', { class: ui.meterFactValue, text: String(index.entryCount) }), document.createTextNode(' index entries')]),
      node('span', {}, [node('b', { class: ui.meterFactValue, text: `~${index.tokens.toLocaleString()}` }), document.createTextNode(' tokens, every session')]),
    ]),
    node('p', { class: ui.meterNote, text: 'Claude Code loads the first 200 lines or 25KB of MEMORY.md, whichever comes first, and drops the rest. Topic files are only read when Claude follows a link, so detail belongs in them and MEMORY.md should stay one line per entry.' }),
  ]));
}

export function renderCleanup(container) {
  const { memories } = state.store;
  renderMeter(container);

  const items = buildWorklist(state.store);
  if (!items.length) {
    container.append(node('div', { class: ui.card }, [
      node('p', { class: ui.okLine, text: '✓ Nothing to fix.' }),
      node('p', { class: ui.noteTight, text: 'MEMORY.md is inside its load limit, every memory file is referenced by it, every pointer resolves, and every [[wikilink]] finds its target.' }),
    ]));
  } else {
    container.append(node('div', { class: ui.sectionLabel, text: `Worst first · ${items.length}` }));
    for (const item of items.slice(0, SHOWN)) {
      const row = COST_KINDS.has(item.kind) ? renderCostIssue(item) : renderIssue(item, memories);
      if (row) container.append(row);
    }
    if (items.length > SHOWN) {
      container.append(node('p', { class: ui.note, text: `${items.length - SHOWN} more not listed. Fix some of the above and they move up.` }));
    }
  }

  container.append(node('div', { class: ui.sectionLabel, text: 'Beyond the memory directory' }));
  renderPathCheck(container);
}
