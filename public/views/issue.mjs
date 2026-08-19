import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { confirmDialog } from '/dialog.mjs';
import { api, toast } from '/api.mjs';
import { state } from '/state.mjs';
import { issue, goTo } from '/parts.mjs';
import { openStore, selectMemory, restoreFromTrash } from '/store.mjs';
import { openDeleteDialog } from '/dialogs/delete.mjs';
import { openAddEntryDialog } from '/dialogs/add-entry.mjs';
import { openHookEditor } from '/dialogs/hook-editor.mjs';

async function removeIndexLine(lineIndex, expectedText, done) {
  const go = await confirmDialog({
    title: `Remove line ${lineIndex + 1} from MEMORY.md?`,
    confirmLabel: 'Remove',
    tone: 'danger',
    body: [
      node('div', { class: ui.willBlock }, [
        node('div', { class: ui.willTitle, text: 'Will be removed' }),
        node('div', { class: ui.willItem('remove'), text: expectedText }),
      ]),
      node('p', { class: ui.noteTight, text: 'Only this line goes. The memory file it points at is left on disk.' }),
    ],
  });
  if (!go) return;
  try {
    await api(`/api/stores/${encodeURIComponent(state.storeId)}/index-line/delete`, {
      method: 'POST',
      body: JSON.stringify({ lineIndex, expectedText }),
    });
    toast(done);
    await openStore(state.storeId, { keepTab: true });
  } catch (err) {
    toast(err.message, { error: true });
  }
}

export function renderIssue(item, memories) {
  const bad = item.severity === 'bad';

  if (item.kind === 'dangling-index') {
    const { entry } = item;
    return issue(
      `MEMORY.md points at a file that does not exist: ${entry.file}`,
      `line ${entry.index + 1}: ${entry.text}`,
      {
        bad,
        action: {
          label: 'Remove pointer',
          run: () => removeIndexLine(entry.index, entry.text, 'Pointer removed'),
        },
      },
    );
  }

  if (item.kind === 'dangling-wikilink') {
    const { link } = item;
    return issue(
      `Broken [[${link.target}]]`,
      `referenced from ${link.from} - no memory has that name`,
      {
        bad,
        secondary: { label: 'Open source', run: () => selectMemory(link.from) },
        action: {
          label: 'Remove link',
          run: async () => {
            const go = await confirmDialog({
              title: `Remove [[${link.target}]] from ${link.from}?`,
              confirmLabel: 'Remove link',
              tone: 'danger',
              body: [
                node('p', { class: ui.noteTight, text: 'The link markup goes, the words stay.' }),
                node('div', { class: ui.willBlock }, [
                  node('div', { class: ui.willTitle, text: 'Will change' }),
                  node('div', { class: ui.willItem('remove'), text: `see [[${link.target}]]` }),
                  node('div', { class: ui.willItem('keep'), text: `see ${link.target}` }),
                ]),
                node('p', { class: ui.noteTight, text: 'A copy of the file is kept in the trash, so this can be undone.' }),
              ],
            });
            if (!go) return;
            try {
              const result = await api(`/api/stores/${encodeURIComponent(state.storeId)}/wikilink/remove`, {
                method: 'POST',
                body: JSON.stringify({ file: link.from, target: link.target }),
              });
              await openStore(state.storeId, { keepTab: true });
              toast(`Unlinked ${result.occurrences} reference(s)`, {
                action: { label: 'Undo', run: () => restoreFromTrash(result.record.id) },
              });
            } catch (err) {
              toast(err.message, { error: true });
            }
          },
        },
      },
    );
  }

  if (item.kind === 'orphan') {
    const memory = memories.find((m) => m.file === item.file);
    return issue(
      `Not referenced anywhere in MEMORY.md: ${item.file}`,
      `"${memory?.name || item.file}" exists on disk but nothing points to it, so Claude will not load it.`,
      {
        bad,
        secondary: { label: 'Open', run: () => selectMemory(item.file) },
        action: { label: 'Add to MEMORY.md', run: () => openAddEntryDialog(item.file) },
      },
    );
  }

  if (item.kind === 'referenced-only') {
    const memory = memories.find((m) => m.file === item.file);
    return issue(
      `Linked mid-sentence, not indexed: ${item.file}`,
      `"${memory?.name || item.file}" is mentioned inside prose in MEMORY.md but has no index bullet of its own.`,
      {
        bad,
        secondary: { label: 'Open', run: () => selectMemory(item.file) },
        action: { label: 'Add to MEMORY.md', run: () => openAddEntryDialog(item.file) },
      },
    );
  }

  if (item.kind === 'name-mismatch') {
    return issue(
      `Frontmatter name differs from filename: ${item.mismatch.file}`,
      `name: "${item.mismatch.name}" - [[wikilinks]] must use this name, not the filename.`,
      { bad, action: { label: 'Open', run: () => selectMemory(item.mismatch.file) } },
    );
  }

  if (item.kind === 'missing-frontmatter') {
    return issue(
      `No YAML frontmatter: ${item.file}`,
      'Type and description cannot be read from this file.',
      { bad, action: { label: 'Open', run: () => selectMemory(item.file) } },
    );
  }

  if (item.kind === 'duplicate-name') {
    return issue(
      `Two memories claim the name "${item.name}"`,
      `${item.files.join(', ')} - every [[${item.name}]] resolves to ${item.reachable}, so the other one cannot be linked at all.`,
      {
        bad,
        secondary: { label: 'Open first', run: () => selectMemory(item.files[0]) },
        action: { label: 'Open second', run: () => selectMemory(item.files[1]) },
      },
    );
  }

  if (item.kind === 'duplicate-index-entry') {
    return issue(
      `Listed twice in MEMORY.md: ${item.file}`,
      `lines ${item.lines.map((line) => line + 1).join(' and ')} - one memory, two index lines, both loaded every session.`,
      {
        bad,
        action: {
          label: 'Remove duplicate',
          run: () => removeIndexLine(item.removable.index, item.removable.text, 'Duplicate removed'),
        },
      },
    );
  }

  if (item.kind === 'missing-description') {
    return issue(
      `No description: ${item.file}`,
      'The description is what a memory is recalled by, so this one is found on its name alone.',
      { bad, action: { label: 'Open', run: () => selectMemory(item.file) } },
    );
  }

  if (item.kind === 'unknown-type') {
    return issue(
      `Unrecognised type: ${item.file}`,
      `type: "${item.type}" - expected one of user, feedback, project, reference.`,
      { bad, action: { label: 'Open', run: () => selectMemory(item.file) } },
    );
  }

  if (item.kind === 'empty-body') {
    const memory = memories.find((m) => m.file === item.file);
    return issue(
      `Almost nothing in it: ${item.file}`,
      `"${memory?.name || item.file}" has ${item.chars} characters of body - it costs an index line every session and says nothing.`,
      {
        bad,
        secondary: { label: 'Open', run: () => selectMemory(item.file) },
        action: { label: 'Delete', run: () => openDeleteDialog(item.file) },
      },
    );
  }

  if (item.kind === 'hook-repeats-description') {
    const row = issue(
      `Hook repeats the description: ${item.file}`,
      `MEMORY.md line ${item.index + 1} - ${item.hookLength} characters restating what the file's own description already says. Only the hook loads every session.`,
      { bad, secondary: { label: 'Open', run: () => selectMemory(item.file) } },
    );
    row.append(node('button', {
      class: ui.buttonPrimarySmall,
      text: 'Edit hook',
      onclick: () => openHookEditor(row, item.index),
    }));
    return row;
  }

  if (item.kind === 'empty-section') {
    return issue(
      `Empty section in MEMORY.md: "${item.section}"`,
      `line ${item.index + 1} - the heading has no entries under it, and headings count against the 200-line budget too.`,
      { bad, action: { label: 'Open MEMORY.md', run: () => goTo('memory', 'index') } },
    );
  }

  if (item.kind === 'stale-path') {
    return issue(
      `No file matches ${item.token}`,
      `named by "${item.name || item.file}"`,
      { bad, action: { label: 'Open', run: () => selectMemory(item.file) } },
    );
  }

  if (item.kind === 'index-continuation') {
    return issue(
      `${item.count} index ${item.count === 1 ? 'entry spills' : 'entries spill'} onto extra lines`,
      `${item.extraLines} extra line${item.extraLines === 1 ? '' : 's'} of the 200-line budget - the guidance is one line per entry, with the detail in the topic file.`,
      { bad, action: { label: 'Open MEMORY.md', run: () => goTo('memory', 'index') } },
    );
  }

  if (item.kind === 'provenance-expired') {
    return issue(
      `Provenance gone: ${item.name}`,
      `the session it was written in (${item.sessionId}) has been swept, so why this memory exists can no longer be traced. Nothing recovers it - judge the memory on what it says.`,
      { bad, action: { label: 'Open', run: () => selectMemory(item.file) } },
    );
  }

  if (item.kind === 'path-evidence-expiring') {
    return issue(
      item.days === 0
        ? 'The last transcript naming this project is due to be swept'
        : `The last transcript naming this project is swept in ${item.days} days`,
      `${item.path} is recovered from the session transcripts, and Claude Code drops those after ${item.retentionDays} days while never touching memory/. Once the last one goes this store shows its raw folder name instead. Remember path records it now.`,
      { bad, action: { label: 'Remember path\u2026', run: openRememberPathDialog } },
    );
  }

  if (item.kind === 'no-memory-despite-sessions') {
    return issue(
      `${item.sessionCount} ${item.sessionCount === 1 ? 'session' : 'sessions'}, and no memory written`,
      `auto memory is on for this project, but nothing has been saved in the ${item.retentionDays} days of transcripts kept here. Either nothing was worth remembering, or memory is not being written.`,
      { bad },
    );
  }

  return issue(item.kind, JSON.stringify(item));
}
