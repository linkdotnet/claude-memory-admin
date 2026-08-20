import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { api } from '/api.mjs';
import { state } from '/state.mjs';
import { isAt } from '/parts.mjs';
import { paint } from '/bus.mjs';
import { renderRtk } from '/views/rtk.mjs';

const OPT_IN = 'toolsOptIn';

const installedRtk = () => state.tools.find((tool) => tool.id === 'rtk' && tool.found) || null;

async function fetchRtk() {
  const id = state.storeId;
  let next;
  try {
    next = { data: await api(`/api/stores/${encodeURIComponent(id)}/tools/rtk`) };
  } catch (err) {
    next = { error: err.message };
  }
  if (state.storeId !== id) return;
  state.aux.rtk = next;
  if (isAt('environment', 'tools')) paint('tab');
}

function startRtk({ remember = true } = {}) {
  if (remember) localStorage.setItem(OPT_IN, '1');
  state.aux.rtk = { running: true };
  fetchRtk();
}

function readRtk() {
  startRtk();
  paint('tab');
}

function turnOff() {
  localStorage.removeItem(OPT_IN);
  state.aux.rtk = null;
  paint('tab');
}

function gate(container, tool) {
  container.append(node('div', { class: ui.issue(false) }, [
    node('div', { class: ui.issueBody }, [
      node('div', { class: ui.issueTitle, text: 'rtk is installed, and is not being read' }),
      node('div', { class: ui.issueDetail, text: `${tool.path} keeps a ledger of what its filters stripped before it reached the model. Reading it runs rtk on this machine, so it stays off until you ask.` }),
    ]),
    node('button', { class: ui.buttonSmall, text: 'Read rtk stats', onclick: readRtk }),
  ]));
}

function failure(container, message) {
  container.append(node('div', { class: ui.issue(true) }, [
    node('div', { class: ui.issueBody }, [
      node('div', { class: ui.issueTitle, text: 'rtk could not be read' }),
      node('div', { class: ui.issueDetail, text: message }),
    ]),
    node('button', { class: ui.buttonSmall, text: 'Turn off', onclick: turnOff }),
    node('button', { class: ui.buttonSmall, text: 'Try again', onclick: readRtk }),
  ]));
}

export function renderTools(container) {
  const tool = installedRtk();
  if (!tool) return;

  if (!state.aux.rtk && localStorage.getItem(OPT_IN) === '1') startRtk({ remember: false });

  const report = state.aux.rtk;
  if (!report) return gate(container, tool);
  if (report.running) return container.append(node('p', { class: ui.note, text: 'Reading the rtk ledger…' }));
  if (report.error) return failure(container, report.error);

  renderRtk(container, report.data, { reread: readRtk, turnOff });
}
