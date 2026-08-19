import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { state } from '/state.mjs';
import { goTo } from '/parts.mjs';
import { segmentsFor } from '/views/header.mjs';

export function segmentBar(tab) {
  const segments = segmentsFor(tab);
  if (segments.length < 2) return null;
  return node('div', { class: ui.segmentBar }, [
    node('div', { class: ui.segmentGroup, role: 'tablist' }, segments.map((seg) => node('button', {
      class: ui.segment(state.segment[tab] === seg.id),
      role: 'tab',
      'aria-selected': String(state.segment[tab] === seg.id),
      onclick: () => goTo(tab, seg.id),
    }, [
      document.createTextNode(seg.label),
      seg.badge ? node('span', { class: ui.tabBadge(seg.tone) }, [document.createTextNode(seg.badge)]) : null,
    ]))),
  ]);
}

export function activeSegment(tab) {
  const segments = segmentsFor(tab);
  if (!segments.length) return null;
  const current = state.segment[tab];
  return segments.some((seg) => seg.id === current) ? current : segments[0].id;
}

export function renderSegmented(container, tab, views) {
  const bar = segmentBar(tab);
  if (bar) container.append(bar);
  const host = node('div');
  container.append(host);
  const segment = activeSegment(tab);
  return views[segment] ? views[segment](host) : null;
}
