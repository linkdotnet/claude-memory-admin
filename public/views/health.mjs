import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { state } from '/state.mjs';
import { renderIssue } from '/views/issue.mjs';
import { renderPathCheck } from '/views/path-check.mjs';

export function renderHealth(container) {
  const { health, memories } = state.store;

  if (!health.issues.length) {
    container.append(node('div', { class: ui.card }, [
      node('p', { class: ui.okLine, text: '\u2713 No consistency problems found.' }),
      node('p', { class: ui.noteTight, text: 'Every memory file is referenced by MEMORY.md, every pointer resolves, and every [[wikilink]] finds its target.' }),
    ]));
  } else {
    for (const item of health.issues) container.append(renderIssue(item, memories));
  }

  container.append(node('div', { class: ui.sectionLabel, text: 'Beyond the memory directory' }));
  renderPathCheck(container);
}
