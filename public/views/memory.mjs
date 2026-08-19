import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { state } from '/state.mjs';
import { paint } from '/bus.mjs';
import { renderSegmented } from '/views/segments.mjs';
import { renderMemories } from '/views/memories.mjs';
import { renderIndex } from '/views/index.mjs';
import { renderGraph } from '/graph.mjs';
import { selectMemory } from '/store.mjs';

function renderMemoryGraph(container) {
  const wrap = node('div', { id: 'graph-wrap', class: ui.graphWrap });
  container.append(wrap);
  renderGraph(wrap, state.store.graph, {
    selected: state.selected,
    spread: state.spread,
    onSelect: (file) => selectMemory(file),
    onSpreadChange: (value) => {
      state.spread = value;
      localStorage.setItem('graphSpread', String(value));
      paint('tab');
    },
  });
}

export function renderMemory(container) {
  return renderSegmented(container, 'memory', {
    list: renderMemories,
    index: renderIndex,
    graph: renderMemoryGraph,
  });
}
