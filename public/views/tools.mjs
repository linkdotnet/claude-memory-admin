import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { api } from '/api.mjs';
import { state } from '/state.mjs';
import { isAt } from '/parts.mjs';
import { paint } from '/bus.mjs';
import { renderRtk, rtkSummary } from '/views/rtk.mjs';
import { renderCcusage, ccusageSummary } from '/views/ccusage.mjs';

const OPT_IN = 'toolsOptIn';

const PANELS = {
  rtk: { render: renderRtk, summary: rtkSummary },
  ccusage: { render: renderCcusage, summary: ccusageSummary },
};

const installed = () => state.tools.filter((tool) => tool.found && PANELS[tool.id]);
const missing = () => state.tools.filter((tool) => !tool.found && PANELS[tool.id]);

const openKey = (id) => `toolOpen:${id}`;
const isOpen = (id) => localStorage.getItem(openKey(id)) === '1';

function setOpen(id, open) {
  if (open) localStorage.setItem(openKey(id), '1');
  else localStorage.removeItem(openKey(id));
}

async function fetchTool(id) {
  const storeId = state.storeId;
  let next;
  try {
    next = { data: await api(`/api/stores/${encodeURIComponent(storeId)}/tools/${encodeURIComponent(id)}`) };
  } catch (err) {
    next = { error: err.message };
  }
  if (state.storeId !== storeId) return;
  state.aux.tools = { ...state.aux.tools, [id]: next };
  if (isAt('environment', 'tools')) paint('tab');
}

function start({ remember = true } = {}) {
  if (remember) localStorage.setItem(OPT_IN, '1');
  const running = {};
  for (const tool of installed()) running[tool.id] = { running: true };
  state.aux.tools = running;
  for (const tool of installed()) fetchTool(tool.id);
}

function readAll() {
  start();
  paint('tab');
}

function turnOff() {
  localStorage.removeItem(OPT_IN);
  state.aux.tools = null;
  paint('tab');
}

function gate(container, tools) {
  const names = tools.map((tool) => tool.label).join(' and ');
  const verb = tools.length > 1 ? 'are installed' : 'is installed';
  container.append(node('div', { class: ui.issue(false) }, [
    node('div', { class: ui.issueBody }, [
      node('div', { class: ui.issueTitle, text: `${names} ${verb}, and not being read` }),
      node('div', { class: ui.issueDetail, text: `Each keeps a ledger of what it saved or spent on your behalf. Reading them runs ${names} on this machine, so it stays off until you ask.` }),
    ]),
    node('button', { class: ui.buttonSmall, text: 'Read tool stats', onclick: readAll }),
  ]));
}

function headline(tool, slot) {
  if (!slot || slot.running) return 'reading…';
  if (slot.error) return 'could not be read';
  return PANELS[tool.id].summary(slot.data);
}

function subtitle(tool, slot) {
  const report = slot && slot.data;
  if (report && report.version) return `${tool.label} ${report.version}`;
  return tool.label;
}

function body(tool, slot) {
  const host = node('div');
  if (!slot || slot.running) {
    host.append(node('p', { class: ui.note, text: `Reading the ${tool.label} ledger…` }));
    return host;
  }
  if (slot.error) {
    host.append(node('div', { class: ui.issue(true) }, [
      node('div', { class: ui.issueBody }, [
        node('div', { class: ui.issueTitle, text: `${tool.label} could not be read` }),
        node('div', { class: ui.issueDetail, text: slot.error }),
      ]),
      node('button', { class: ui.buttonSmall, text: 'Try again', onclick: readAll }),
    ]));
    return host;
  }
  PANELS[tool.id].render(host, slot.data);
  return host;
}

function accordion(container, tool, slot) {
  const open = isOpen(tool.id);
  const panel = body(tool, slot);
  panel.hidden = !open;

  const caret = node('span', { class: ui.contextCaret, text: open ? '▾' : '▸' });

  container.append(node('button', {
    class: ui.contextRowButton,
    'aria-expanded': String(open),
    onclick: (event) => {
      const next = panel.hidden;
      panel.hidden = !next;
      caret.textContent = next ? '▾' : '▸';
      event.currentTarget.setAttribute('aria-expanded', String(next));
      setOpen(tool.id, next);
    },
  }, [
    node('div', { class: ui.contextMain }, [
      node('div', { class: ui.contextFile }, [caret, document.createTextNode(subtitle(tool, slot))]),
    ]),
    node('div', { class: ui.contextSize, text: headline(tool, slot) }),
  ]));
  container.append(panel);
}

function notInstalled(container, tool) {
  container.append(node('div', { class: ui.contextRowStatic }, [
    node('div', { class: ui.contextMain }, [
      node('div', { class: ui.contextFile, text: tool.label }),
    ]),
    node('div', { class: ui.contextSize, text: 'not installed' }),
  ]));

  container.append(node('div', { class: ui.toolMissingBody }, [
    node('p', { class: ui.noteTight, text: tool.blurb }),
    node('a', {
      class: ui.linkButton,
      href: tool.repo,
      target: '_blank',
      rel: 'noopener noreferrer',
      text: 'View on GitHub \u2197',
    }),
  ]));
}

export function renderTools(container) {
  const found = installed();
  const absent = missing();
  if (!found.length && !absent.length) return;

  if (found.length && !state.aux.tools && localStorage.getItem(OPT_IN) === '1') start({ remember: false });
  const opted = Boolean(state.aux.tools);

  const bar = [
    node('span', { class: ui.sectionLabelInline, text: 'Companion tools' }),
    node('span', { class: ui.listSpacer }),
  ];
  if (found.length && opted) {
    bar.push(node('button', { class: ui.buttonSmall, text: 'Re-read', onclick: readAll }));
    bar.push(node('button', { class: ui.buttonSmall, text: 'Turn off', onclick: turnOff }));
  }
  container.append(node('div', { class: ui.listBar }, bar));

  if (found.length && !opted) gate(container, found);
  else for (const tool of found) accordion(container, tool, state.aux.tools[tool.id]);

  for (const tool of absent) notInstalled(container, tool);
}
