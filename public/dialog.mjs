import * as ui from '/ui.mjs';
import { el, node } from '/dom.mjs';

const root = () => el('dialog-root');

const TEXT_ENTRY = /^(text|search|url|email|tel|number|password)$/;

export const isDialogOpen = () => Boolean(root().firstElementChild);

export function closeDialog() {
  const dialog = root().firstElementChild;
  if (!dialog) return;
  dialog.close();
  dialog.remove();
}

export function openDialog({ title, subtitle, body, actions, focus }) {
  const previous = root().firstElementChild;
  if (previous) {
    previous.close();
    previous.remove();
  }

  const dialog = node('dialog', { class: ui.dialog, 'aria-labelledby': 'dialog-title' });
  const primary = actions[actions.length - 1];
  let outcome = null;

  const buttons = actions.map((action) => {
    const button = node('button', {
      class: ui.button({ tone: action.tone }),
      text: action.label,
      onclick: async () => {
        if (action.guard) {
          for (const other of actions) other.el.disabled = true;
          const passed = await action.guard();
          for (const other of actions) other.el.disabled = false;
          if (!passed) return;
        }
        outcome = action.value ?? null;
        dialog.close();
      },
    });
    action.el = button;
    return button;
  });

  dialog.append(
    node('header', { class: ui.dialogHead }, [
      node('h3', { id: 'dialog-title', class: ui.dialogTitle, text: title }),
      subtitle ? node('p', { class: ui.note, text: subtitle }) : null,
    ]),
    node('div', { class: ui.dialogBody }, [].concat(body)),
    node('footer', { class: ui.dialogFoot }, buttons),
  );

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && TEXT_ENTRY.test(event.target.type || '')) {
      event.preventDefault();
      primary.el.click();
    }
  });

  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(outcome);
    });
    root().append(dialog);
    dialog.showModal();
    if (focus) {
      focus.focus();
      focus.select?.();
    }
  });
}

export function confirmDialog({ title, subtitle, body, confirmLabel = 'Confirm', tone = 'primary' }) {
  return openDialog({
    title,
    subtitle,
    body,
    actions: [
      { label: 'Cancel' },
      { label: confirmLabel, tone, value: true },
    ],
  });
}
