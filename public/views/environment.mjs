import { renderSegmented } from '/views/segments.mjs';
import { renderContext } from '/views/context.mjs';
import { renderSettings } from '/views/settings.mjs';
import { renderSessions } from '/views/sessions.mjs';

export function renderEnvironment(container) {
  return renderSegmented(container, 'environment', {
    instructions: renderContext,
    settings: renderSettings,
    sessions: renderSessions,
  });
}
