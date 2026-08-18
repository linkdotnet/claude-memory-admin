import * as ui from '/ui.mjs';


const TYPE_COLORS = {
  project: 'var(--ui-type-project)',
  feedback: 'var(--ui-type-feedback)',
  user: 'var(--ui-type-user)',
  reference: 'var(--ui-type-reference)',
  unknown: 'var(--ui-fg-subtle)',
};

function colorFor(type) {
  return TYPE_COLORS[type] || TYPE_COLORS.unknown;
}

function simulate(nodes, edges, { width, height, iterations = 320, repulsion = 1.6 }) {
  const area = width * height;
  const k = Math.sqrt(area / Math.max(nodes.length, 1)) * 0.72;
  const index = new Map(nodes.map((n, i) => [n.id, i]));

  nodes.forEach((node, i) => {
    const angle = (i / nodes.length) * Math.PI * 2;
    const radius = Math.min(width, height) * 0.32 * (0.55 + ((i * 37) % 100) / 220);
    node.x = width / 2 + Math.cos(angle) * radius;
    node.y = height / 2 + Math.sin(angle) * radius;
  });

  const links = edges
    .map((e) => ({ a: index.get(e.from), b: index.get(e.to) }))
    .filter((l) => l.a !== undefined && l.b !== undefined && l.a !== l.b);

  let temperature = Math.min(width, height) * 0.14;
  for (let step = 0; step < iterations; step++) {
    for (const node of nodes) { node.dx = 0; node.dy = 0; }

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) { dx = (i % 7) - 3 || 1; dy = (j % 5) - 2 || 1; dist = Math.hypot(dx, dy); }
        const force = ((k * k) / dist) * repulsion;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.dx += fx; a.dy += fy;
        b.dx -= fx; b.dy -= fy;
      }
    }

    for (const link of links) {
      const a = nodes[link.a];
      const b = nodes[link.b];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const force = ((dist * dist) / k) * 0.85;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.dx -= fx; a.dy -= fy;
      b.dx += fx; b.dy += fy;
    }

    for (const node of nodes) {
      node.dx += (width / 2 - node.x) * 0.006;
      node.dy += (height / 2 - node.y) * 0.006;
    }

    for (const node of nodes) {
      const disp = Math.hypot(node.dx, node.dy) || 0.01;
      node.x += (node.dx / disp) * Math.min(disp, temperature);
      node.y += (node.dy / disp) * Math.min(disp, temperature);
    }
    temperature *= 0.99;
  }

  fitToBox(nodes, width, height, 46);
  return nodes;
}

function fitToBox(nodes, width, height, pad) {
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  let scaleX = (width - pad * 2) / spanX;
  let scaleY = (height - pad * 2) / spanY;
  const MAX_ANISOTROPY = 1.45;
  if (scaleX > scaleY * MAX_ANISOTROPY) scaleX = scaleY * MAX_ANISOTROPY;
  if (scaleY > scaleX * MAX_ANISOTROPY) scaleY = scaleX * MAX_ANISOTROPY;

  const offsetX = (width - spanX * scaleX) / 2;
  const offsetY = (height - spanY * scaleY) / 2;
  for (const node of nodes) {
    node.x = offsetX + (node.x - minX) * scaleX;
    node.y = offsetY + (node.y - minY) * scaleY;
  }
}

function findComponents(nodes, edges) {
  const adjacency = new Map(nodes.map((n) => [n.id, []]));
  for (const edge of edges) {
    if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue;
    adjacency.get(edge.from).push(edge.to);
    adjacency.get(edge.to).push(edge.from);
  }

  const seen = new Set();
  const groups = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    const stack = [node.id];
    const group = [];
    seen.add(node.id);
    while (stack.length) {
      const id = stack.pop();
      group.push(id);
      for (const neighbour of adjacency.get(id) || []) {
        if (seen.has(neighbour)) continue;
        seen.add(neighbour);
        stack.push(neighbour);
      }
    }
    groups.push(group);
  }
  return groups;
}

function boundsOf(nodes) {
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function layoutComponents(nodes, edges, { width, height, repulsion }) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const groups = findComponents(nodes, edges)
    .map((ids) => ids.map((id) => byId.get(id)))
    .sort((a, b) => b.length - a.length);

  const placed = [];
  for (const group of groups) {
    const ids = new Set(group.map((n) => n.id));
    const inner = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    const side = Math.max(180, Math.sqrt(group.length) * 190);
    simulate(group, inner, { width: side, height: side, iterations: 420, repulsion });
    const bounds = boundsOf(group);
    placed.push({
      group,
      width: Math.max(bounds.maxX - bounds.minX, 60) + 90,
      height: Math.max(bounds.maxY - bounds.minY, 40) + 60,
      bounds,
    });
  }

  const gap = 26;
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  for (const item of placed) {
    if (cursorX > 0 && cursorX + item.width > width) {
      cursorX = 0;
      cursorY += rowHeight + gap;
      rowHeight = 0;
    }
    item.offsetX = cursorX;
    item.offsetY = cursorY;
    cursorX += item.width + gap;
    rowHeight = Math.max(rowHeight, item.height);
  }
  for (const item of placed) {
    for (const node of item.group) {
      node.x = item.offsetX + (node.x - item.bounds.minX) + 45;
      node.y = item.offsetY + (node.y - item.bounds.minY) + 30;
    }
  }

  fitToBox(nodes, width, height, 40);
}

const NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

export function renderGraph(container, graph, { onSelect, onSpreadChange, selected, spread = 1.6 } = {}) {
  container.textContent = '';

  const real = graph.nodes.map((n) => ({ ...n, ghost: false }));
  const ghostTargets = [...new Set(graph.dangling.map((d) => d.target))];
  const ghosts = ghostTargets.map((target) => ({
    id: `ghost:${target}`, label: target, type: 'unknown', status: 'missing', ghost: true, degree: 0,
  }));
  const nodes = [...real, ...ghosts];

  if (nodes.length === 0) {
    const note = document.createElement('p');
    note.className = ui.graphEmpty;
    note.textContent = 'No memories to graph yet.';
    container.append(note);
    return;
  }

  const byName = new Map(real.map((n) => [n.label, n.id]));
  const edges = [
    ...graph.edges,
    ...graph.dangling.map((d) => ({ from: d.from, to: `ghost:${d.target}` })),
  ];

  const width = Math.max(container.clientWidth || 900, 480);
  const baseHeight = 620;

  const degree = new Map(nodes.map((n) => [n.id, 0]));
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
  }
  const linked = nodes.filter((n) => degree.get(n.id) > 0);
  const unlinked = nodes.filter((n) => !degree.get(n.id));

  const perRow = Math.max(1, Math.floor((width - 120) / 160));
  const stripRows = unlinked.length ? Math.ceil(unlinked.length / perRow) : 0;
  const strip = stripRows ? 34 + stripRows * 46 : 0;
  const legendRoom = 46;
  const height = baseHeight + Math.max(0, strip - 104);

  if (linked.length) {
    const linkedIds = new Set(linked.map((n) => n.id));
    const innerEdges = edges.filter((e) => linkedIds.has(e.from) && linkedIds.has(e.to));
    layoutComponents(linked, innerEdges, { width, height: height - strip, repulsion: spread });
  }
  unlinked.forEach((node, i) => {
    const row = Math.floor(i / perRow);
    const inRow = Math.min(perRow, unlinked.length - row * perRow);
    const slot = i % perRow;
    node.x = (width / (inRow + 1)) * (slot + 1);
    node.y = height - strip + 34 + row * 46;
  });

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height + (stripRows ? legendRoom : 0)}`,
    preserveAspectRatio: 'xMidYMid meet',
  });
  svg.style.height = `${height + (stripRows ? legendRoom : 0)}px`;
  const root = svgEl('g');
  svg.append(root);

  const marker = svgEl('marker', {
    id: 'arrow', viewBox: '0 0 10 10', refX: 18, refY: 5,
    markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse',
  });
  marker.append(svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'currentColor', opacity: '.45' }));
  const defs = svgEl('defs');
  defs.append(marker);
  svg.append(defs);

  const position = new Map(nodes.map((n) => [n.id, n]));
  const edgeGroup = svgEl('g', { stroke: 'currentColor', 'stroke-opacity': '.28', 'marker-end': 'url(#arrow)' });
  const drawnEdges = [];
  for (const edge of edges) {
    const a = position.get(edge.from);
    const b = position.get(edge.to);
    if (!a || !b) continue;
    const line = svgEl('line', {
      class: ui.graphEdge,
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      'stroke-dasharray': String(edge.to).startsWith('ghost:') ? '4 3' : '',
    });
    edgeGroup.append(line);
    drawnEdges.push({ line, edge });
  }
  root.append(edgeGroup);

  if (unlinked.length) {
    const y = height - strip + 12;
    root.append(svgEl('line', {
      x1: 40, y1: y, x2: width - 40, y2: y,
      stroke: 'currentColor', 'stroke-opacity': '.18', 'stroke-dasharray': '3 4',
    }));
    const caption = svgEl('text', { x: 40, y: y - 7, 'font-size': '10', fill: 'currentColor', 'fill-opacity': '.45' });
    caption.textContent = `not linked to anything (${unlinked.length})`;
    root.append(caption);
  }

  const groupsById = new Map();
  const neighbours = new Map(nodes.map((n) => [n.id, new Set([n.id])]));
  for (const edge of edges) {
    neighbours.get(edge.from)?.add(edge.to);
    neighbours.get(edge.to)?.add(edge.from);
  }

  for (const node of nodes) {
    const group = svgEl('g', { class: ui.graphNode(node.id === selected), transform: `translate(${node.x},${node.y})` });
    const radius = node.ghost ? 6 : 7 + Math.min(node.degree, 8) * 1.1;

    const hit = svgEl('circle', { class: ui.graphHit, r: Math.max(radius + 9, 15) });
    group.append(hit);

    const circle = svgEl('circle', {
      r: radius,
      fill: node.ghost ? 'transparent' : colorFor(node.type),
      stroke: node.ghost ? 'var(--ui-danger)' : node.status === 'orphan' ? 'var(--ui-warn)' : 'var(--ui-line-strong)',
      'stroke-dasharray': node.ghost ? '3 2' : node.status === 'orphan' ? '3 2' : '',
    });
    const label = svgEl('text', {
      y: radius + 10,
      'text-anchor': 'middle',
      stroke: 'var(--ui-surface)',
      'stroke-width': '2.5',
      'paint-order': 'stroke',
      'stroke-linejoin': 'round',
    });
    label.textContent = node.label.length > 20 ? `${node.label.slice(0, 18)}…` : node.label;
    group.append(circle, label);

    const title = svgEl('title');
    title.textContent = node.ghost
      ? `${node.label} - referenced by a [[wikilink]] but no such memory exists`
      : `${node.label}\n${node.type} · ${node.status} · ${node.degree} link(s)`;
    group.append(title);

    if (!node.ghost && onSelect) {
      group.style.cursor = 'pointer';
      group.addEventListener('click', (event) => { event.stopPropagation(); onSelect(node.id); });
    }

    group.addEventListener('pointerenter', () => focusOn(node.id));
    group.addEventListener('pointerleave', () => focusOn(null));

    groupsById.set(node.id, group);
    root.append(group);
  }

  function focusOn(id) {
    if (!id) {
      for (const group of groupsById.values()) group.classList.remove('dim');
      for (const { line } of drawnEdges) line.classList.remove('dim');
      return;
    }
    const near = neighbours.get(id) || new Set([id]);
    for (const [nodeId, group] of groupsById) group.classList.toggle('dim', !near.has(nodeId));
    for (const { line, edge } of drawnEdges) {
      line.classList.toggle('dim', edge.from !== id && edge.to !== id);
    }
  }

  let scale = 1;
  let panX = 0;
  let panY = 0;
  const apply = () => root.setAttribute('transform', `translate(${panX},${panY}) scale(${scale})`);

  svg.addEventListener('wheel', (event) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = Math.max(0.3, Math.min(4, scale * factor));
    const rect = svg.getBoundingClientRect();
    const mx = ((event.clientX - rect.left) / rect.width) * width;
    const my = ((event.clientY - rect.top) / rect.height) * height;
    panX = mx - ((mx - panX) / scale) * next;
    panY = my - ((my - panY) / scale) * next;
    scale = next;
    apply();
  }, { passive: false });

  const DRAG_THRESHOLD = 4;
  let pending = null;
  let panning = false;

  svg.addEventListener('pointerdown', (event) => {
    pending = { x: event.clientX, y: event.clientY, panX, panY, pointerId: event.pointerId };
    panning = false;
  });

  svg.addEventListener('pointermove', (event) => {
    if (!pending) return;
    const dx = event.clientX - pending.x;
    const dy = event.clientY - pending.y;
    if (!panning) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      panning = true;
      svg.setPointerCapture(pending.pointerId);
      svg.style.cursor = 'grabbing';
    }
    const rect = svg.getBoundingClientRect();
    panX = pending.panX + (dx / rect.width) * width;
    panY = pending.panY + (dy / rect.height) * height;
    apply();
  });

  const endDrag = (event) => {
    if (panning) {
      try { svg.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    }
    pending = null;
    panning = false;
    svg.style.cursor = 'grab';
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  const zoomBy = (factor) => {
    const next = Math.max(0.3, Math.min(6, scale * factor));
    const cx = width / 2;
    const cy = height / 2;
    panX = cx - ((cx - panX) / scale) * next;
    panY = cy - ((cy - panY) / scale) * next;
    scale = next;
    apply();
  };
  const resetView = () => { scale = 1; panX = 0; panY = 0; apply(); };

  container.append(svg);

  const toolbar = document.createElement('div');
  toolbar.className = ui.graphToolbar;

  const makeButton = (label, title, onClick) => {
    const button = document.createElement('button');
    button.className = ui.graphButton;
    button.textContent = label;
    button.title = title;
    button.onclick = onClick;
    return button;
  };
  toolbar.append(
    makeButton('\u2212', 'Zoom out', () => zoomBy(1 / 1.25)),
    makeButton('+', 'Zoom in', () => zoomBy(1.25)),
    makeButton('Fit', 'Reset zoom and position', resetView),
  );

  const spreadLabel = document.createElement('label');
  spreadLabel.className = ui.graphLabel;
  spreadLabel.title = 'How far apart the layout pushes nodes';
  const slider = document.createElement('input');
  slider.className = ui.graphRange;
  slider.type = 'range';
  slider.min = '1';
  slider.max = '4';
  slider.step = '0.2';
  slider.value = String(spread);
  slider.addEventListener('change', () => {
    if (onSpreadChange) onSpreadChange(Number(slider.value));
  });
  spreadLabel.append(document.createTextNode('spread'), slider);
  toolbar.append(spreadLabel);
  container.append(toolbar);

  const legend = document.createElement('div');
  legend.className = ui.graphLegend;
  const entries = Object.entries(TYPE_COLORS)
    .filter(([type]) => real.some((n) => n.type === type))
    .map(([type, color]) => [type, `background:${color}`]);
  entries.push(['orphan', 'border:1.5px dashed var(--ui-warn)']);
  if (ghosts.length) entries.push(['missing target', 'border:1.5px dashed var(--ui-danger)']);
  for (const [label, swatchStyle] of entries) {
    const item = document.createElement('span');
    item.className = ui.graphLegendItem;
    const swatch = document.createElement('i');
    swatch.className = ui.graphLegendSwatch;
    swatch.style.cssText = swatchStyle;
    item.append(swatch, document.createTextNode(label));
    legend.append(item);
  }
  container.append(legend);

  return byName;
}
