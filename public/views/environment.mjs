import { renderSegmented } from '/views/segments.mjs';
import { renderContext } from '/views/context.mjs';
import { renderSettings } from '/views/settings.mjs';
import { renderCost } from '/views/cost.mjs';
import { renderAttribution } from '/views/attribution.mjs';
import { renderSessions } from '/views/sessions.mjs';
import { renderTools } from '/views/tools.mjs';

export function renderEnvironment(container) {
  return renderSegmented(container, 'environment', {
    instructions: renderContext,
    settings: renderSettings,
    cost: renderCost,
    attribution: renderAttribution,
    sessions: renderSessions,
    tools: renderTools,
  });
}
