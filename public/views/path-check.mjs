import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { api } from '/api.mjs';
import { state } from '/state.mjs';
import { isAt } from '/parts.mjs';
import { paint } from '/bus.mjs';
import { renderIssue } from '/views/issue.mjs';

function storeHasProjectDir() {
  return state.store.kind === 'auto'
    ? state.store.resolvedBy !== 'unresolved'
    : Boolean(state.store.projectPath);
}

const pathCheckKey = () => `pathCheck:${state.storeId}`;

async function fetchPathCheck() {
  const id = state.storeId;
  let next;
  try {
    next = { running: false, data: await api(`/api/stores/${encodeURIComponent(id)}/path-check`) };
  } catch (err) {
    next = { running: false, error: err.message };
  }
  if (state.storeId !== id) return;
  state.pathCheck = next;
  if (isAt('cleanup')) paint('tab');
}

function startPathCheck({ remember = true } = {}) {
  if (remember) localStorage.setItem(pathCheckKey(), '1');
  state.pathCheck = { running: true };
  fetchPathCheck();
}

function runPathCheck() {
  startPathCheck();
  paint('tab');
}

function stopPathCheck() {
  localStorage.removeItem(pathCheckKey());
  state.pathCheck = null;
  paint('tab');
}

export function renderPathCheck(container) {
  if (!storeHasProjectDir()) return;

  if (!state.pathCheck && localStorage.getItem(pathCheckKey()) === '1') {
    startPathCheck({ remember: false });
  }
  const check = state.pathCheck;

  const head = node('div', { class: ui.issue(false) });
  const body = node('div', { class: ui.issueBody });

  if (!check) {
    body.append(
      node('div', { class: ui.issueTitle, text: 'Paths named in memories are not being checked' }),
      node('div', { class: ui.issueDetail, text: 'Every other check on this tab reads only memory/. This one reads the project itself, to find memories naming files that no longer exist. It stays off until you ask, and is remembered per store.' }),
    );
    head.append(body, node('button', { class: ui.buttonSmall, text: 'Check against the repo', onclick: () => runPathCheck() }));
    return container.append(head);
  }

  if (check.running) {
    body.append(node('div', { class: ui.issueTitle, text: 'Checking paths against the repo…' }));
    head.append(body);
    return container.append(head);
  }

  if (check.error) {
    body.append(
      node('div', { class: ui.issueTitle, text: 'Path check could not run' }),
      node('div', { class: ui.issueDetail, text: check.error }),
    );
    head.append(body, node('button', { class: ui.buttonSmall, text: 'Turn off', onclick: () => stopPathCheck() }));
    return container.append(head);
  }

  const { checked, capped, missing, indexed, truncated } = check.data;
  const scanned = `${indexed.toLocaleString()} files and folders scanned${truncated ? ', stopped at the index limit' : ''}`;
  body.append(
    node('div', { class: ui.issueTitle, text: missing.length
      ? `${missing.length} of ${checked} paths named in memories match no file in the project`
      : `All ${checked} paths named in memories still match a file` }),
    node('div', { class: ui.issueDetail, text: capped
      ? `${scanned}; stopped after the first ${checked} paths, so there may be more`
      : scanned }),
  );
  if (missing.length) {
    body.append(node('div', { class: ui.issueDetail, text: 'A pointer rather than a verdict: a file that moved reads the same as one the memory never got right.' }));
  }
  head.append(
    body,
    node('button', { class: ui.buttonSmall, text: 'Turn off', onclick: () => stopPathCheck() }),
    node('button', { class: ui.buttonSmall, text: 'Re-check', onclick: () => runPathCheck() }),
  );
  container.append(head);

  for (const item of missing) container.append(renderIssue(item, state.store.memories));
}
