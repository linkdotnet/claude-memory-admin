import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { state, SEGMENT_STORAGE } from '/state.mjs';
import { paint } from '/bus.mjs';

export function issue(title, detail, { bad = false, action, secondary } = {}) {
  return node('div', { class: ui.issue(bad) }, [
    node('div', { class: ui.issueBody }, [
      node('div', { class: ui.issueTitle, text: title }),
      node('div', { class: ui.issueDetail, text: detail }),
    ]),
    secondary ? node('button', { class: ui.buttonSmall, text: secondary.label, onclick: secondary.run }) : null,
    action ? node('button', { class: ui.buttonSmall, text: action.label, onclick: action.run }) : null,
  ]);
}

export function goTo(tab, segment) {
  state.tab = tab;
  if (segment && SEGMENT_STORAGE[tab]) {
    state.segment[tab] = segment;
    localStorage.setItem(SEGMENT_STORAGE[tab], segment);
  }
  paint('tabs', 'tab');
}

export const isAt = (tab, segment) => state.tab === tab
  && (!segment || state.segment[tab] === segment);

export function cutMarker(cutoff) {
  return node('div', { class: ui.cutLine }, [
    node('span', { class: ui.cutLabel, text: `not loaded past here — ${cutoff.droppedLines} lines dropped on ${cutoff.by}` }),
  ]);
}

export function highlight(text, terms) {
  const wrapper = node('span');
  if (!terms.length) { wrapper.textContent = text; return wrapper; }
  const pattern = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig');
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) wrapper.append(document.createTextNode(text.slice(last, match.index)));
    wrapper.append(node('mark', { class: ui.resultMark, text: match[0] }));
    last = match.index + match[0].length;
  }
  if (last < text.length) wrapper.append(document.createTextNode(text.slice(last)));
  return wrapper;
}

export function formatAge(days) {
  if (days === null || days === undefined) return 'undated';
  if (days < 1) return 'today';
  if (days < 31) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

export const sizeLabel = (bytes) => (bytes >= 1048576
  ? `${(bytes / 1048576).toFixed(1)} MB`
  : `${(bytes / 1024).toFixed(1)} KB`);

export function sessionDate(iso) {
  return iso ? iso.replace('T', ' ').replace(/\..*$/, '') : 'unknown';
}

export const byteLength = (text) => new TextEncoder().encode(text).length;
