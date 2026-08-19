import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { openDialog } from '/dialog.mjs';
import { api, toast } from '/api.mjs';
import { state } from '/state.mjs';
import { openStore, reloadStores } from '/store.mjs';

export async function openRememberPathDialog() {
  const store = state.store;
  const input = node('input', {
    type: 'text',
    class: ui.pathInput,
    value: store.guess || '',
    placeholder: '/Users/you/repos/the-project',
    spellcheck: 'false',
  });

  const remembered = await openDialog({
    title: 'Remember this project\u2019s path',
    body: [
      node('p', { class: ui.note, text: `The folder on disk is "${store.slug}", and its name is a lossy encoding of a path. No session transcript remains to recover the real one from, so tell it once and it will be used from now on.` }),
      input,
      node('p', { class: ui.noteTight, text: 'Saved to ~/.claude-memory-admin/paths.json. That file records slugs and folder paths only, never memory content, and is the one thing this app writes outside a memory/ directory.' }),
    ],
    actions: [
      { label: 'Cancel' },
      {
        label: 'Remember',
        tone: 'primary',
        value: true,
        guard: async () => {
          const value = input.value.trim();
          if (!value) return false;
          try {
            await api(`/api/stores/${encodeURIComponent(state.storeId)}/path/remember`, {
              method: 'POST',
              body: JSON.stringify({ path: value }),
            });
          } catch (err) {
            toast(err.message, { error: true });
            return false;
          }
          return true;
        },
      },
    ],
    focus: input,
  });
  if (!remembered) return;

  await reloadStores();
  await openStore(state.storeId, { keepTab: true });
  toast(`Remembered ${input.value.trim()}`);
}

export async function forgetProjectPath() {
  try {
    await api(`/api/stores/${encodeURIComponent(state.storeId)}/path/forget`, { method: 'POST' });
  } catch (err) {
    return toast(err.message, { error: true });
  }
  await reloadStores();
  await openStore(state.storeId, { keepTab: true });
  toast('Forgot the remembered path');
}
