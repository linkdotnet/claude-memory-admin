import * as ui from '/ui.mjs';
import { el, node } from '/dom.mjs';

export async function api(path, options) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const data = await response.json().catch(() => ({ error: 'Bad response from server' }));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

export function toast(message, { error = false, action } = {}) {
  const element = node('div', { class: ui.toast(error) });
  element.append(document.createTextNode(message));
  if (action) {
    element.append(node('button', {
      class: ui.toastAction,
      text: action.label,
      onclick: () => { element.remove(); action.run(); },
    }));
  }
  el('toast-root').append(element);
  setTimeout(() => element.remove(), action ? 12000 : 4500);
}
