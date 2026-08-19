import * as ui from '/ui.mjs';
import { node } from '/dom.mjs';
import { renderMarkdown } from '/markdown.mjs';
import { api } from '/api.mjs';
import { state } from '/state.mjs';
import { isAt } from '/parts.mjs';

const SCOPE_ORDER = ['managed', 'user', 'project', 'local'];

const CONTEXT_PROBLEMS = {
  missing: (p) => ['Import does not resolve', `${p.spec} from ${p.from} - nothing at ${p.file}`],
  'too-deep': (p) => ['Import chain is too deep', `${p.file} is a fifth hop; Claude Code follows four, so this never loads`],
  cycle: (p) => ['Circular import', `${p.from} imports ${p.file}, which was already loaded`],
  external: (p) => ['Import resolves outside the project', `${p.file} - Claude Code asks you to approve these once, and a declined one stays disabled silently`],
  'invalid-glob': (p) => [`Rule matches nothing: ${p.pattern}`, `${p.file} - ${p.reason}`],
  'glob-budget': (p) => ['Rule has too many brace expansions', `${p.file} expands to ${p.expansions} patterns, past the 1,000 budget, so it is used unexpanded and its literal braces match no file`],
  'long-claude-md': (p) => [`${p.lines} lines, over the 200-line guidance`, `${p.file} - long files cost context every session and reduce adherence`],
  'agents-md-not-imported': (p) => ['AGENTS.md is not loaded', `${p.file} exists, but Claude Code reads CLAUDE.md. Import it with @AGENTS.md, or symlink it.`],
  'unreferenced-user-file': (p) => ['Nothing in the chain reaches this file', `${p.file} sits next to CLAUDE.md and loads nothing. Import it with @${p.file.split('/').pop()}, or delete it.`],
  'duplicate-load': (p) => [`Loaded ${p.count} times: ${p.file}`, `reached from ${[...new Set(p.via)].join(' and ')} - every copy is read into context, so you pay ~${p.wastedTokens.toLocaleString()} extra tokens a session`],
  'empty-instruction-file': (p) => ['Loads, but says nothing', `${p.file} is empty apart from its frontmatter, so it costs a read and contributes no instruction`],
};

export async function renderContext(container) {
  let data = state.aux.instructions;
  if (!data) {
    container.append(node('p', { class: ui.note, text: 'Reading instruction files…' }));
    try {
      data = await api(`/api/stores/${encodeURIComponent(state.storeId)}/instructions`);
    } catch (err) {
      container.textContent = '';
      return container.append(node('p', { class: ui.note, text: err.message }));
    }
    if (!isAt('environment', 'instructions')) return;
  }
  container.textContent = '';

  const global = state.store.kind === 'global';
  if (!data.projectDir && !global) {
    return container.append(node('p', { class: ui.note, text: 'This store is not tied to a project directory, so there are no instruction files to resolve.' }));
  }

  const { totals } = data;
  container.append(node('div', { class: ui.meter }, [
    node('div', { class: ui.meterTop }, [
      node('span', { class: ui.meterValue, text: `~${totals.alwaysTokens.toLocaleString()}` }),
      node('span', { class: ui.meterUnit, text: 'estimated tokens of instructions, every session' }),
    ]),
    node('div', { class: ui.meterFacts }, [
      node('span', {}, [node('b', { class: ui.meterFactValue, text: String(totals.files) }), document.createTextNode(' files resolved')]),
      node('span', {}, [node('b', { class: ui.meterFactValue, text: String(totals.alwaysLines) }), document.createTextNode(' lines always loaded')]),
      node('span', {}, [node('b', { class: ui.meterFactValue, text: `${(totals.alwaysBytes / 1024).toFixed(1)} KB` }), document.createTextNode(' always loaded')]),
      node('span', {}, [node('b', { class: ui.meterFactValue, text: String(totals.conditionalFiles) }), document.createTextNode(' path-scoped rules, loaded only on a match')]),
    ]),
    node('p', { class: ui.meterNote, text: 'Unlike MEMORY.md, none of this is truncated: CLAUDE.md files load in full however long they are. The 200-line figure is Claude Code’s guidance, not a cutoff, because long files cost context every session and are followed less reliably.' }),
  ]));

  if (data.problems.length) {
    container.append(node('div', { class: ui.sectionLabel, text: `Problems · ${data.problems.length}` }));
    for (const problem of data.problems) {
      const describe = CONTEXT_PROBLEMS[problem.kind];
      const [title, detail] = describe ? describe(problem) : [problem.kind, problem.file || ''];
      container.append(node('div', { class: ui.issue(problem.severity === 'bad') }, [
        node('div', { class: ui.issueBody }, [
          node('div', { class: ui.issueTitle, text: title }),
          node('div', { class: ui.issueDetail, text: detail }),
        ]),
      ]));
    }
  }

  container.append(node('div', { class: ui.sectionLabel, text: `Loaded in this order · ${data.files.length}` }));
  const card = node('div', { class: ui.card });
  for (const file of data.files) {
    const tags = [node('span', { class: ui.scopeBadge(file.scope), text: file.scope })];
    if (file.kind === 'import') tags.push(node('span', { class: ui.badge(), text: `import · depth ${file.depth}` }));
    if (file.kind === 'rule') tags.push(node('span', { class: ui.badge(), text: 'rule' }));
    if (file.kind === 'managed-settings') tags.push(node('span', { class: ui.badge(), text: 'claudeMd setting' }));
    if (file.conditional) tags.push(node('span', { class: ui.badge('warn'), text: 'only on a path match' }));

    const body = node('div', { class: ui.contextBody, hidden: true });
    const bodyProse = node('div', { class: ui.prose });
    body.append(bodyProse);
    const caret = node('span', { class: ui.contextCaret, text: '\u25b8' });
    let rendered = false;

    card.append(node('button', {
      class: ui.contextRowButton,
      'aria-expanded': 'false',
      onclick: (event) => {
        const open = body.hidden;
        body.hidden = !open;
        caret.textContent = open ? '\u25be' : '\u25b8';
        event.currentTarget.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open && !rendered) {
          rendered = true;
          renderMarkdown(bodyProse, file.text);
        }
      },
    }, [
      node('div', { class: ui.contextMain }, [
        node('div', { class: ui.contextTags }, tags),
        node('div', { class: ui.contextFile }, [caret, document.createTextNode(file.file)]),
      ]),
      node('div', { class: ui.contextSize, text: `${file.lines} L · ~${file.tokens.toLocaleString()} tok` }),
    ]));
    card.append(body);
  }
  container.append(card);

  if (data.excluded.length) {
    container.append(node('div', { class: ui.sectionLabel, text: `Excluded by claudeMdExcludes · ${data.excluded.length}` }));
    for (const file of data.excluded) {
      container.append(node('div', { class: ui.issue(false) }, [
        node('div', { class: ui.issueBody }, [node('div', { class: ui.issueDetail, text: file })]),
      ]));
    }
  }

  container.append(node('p', { class: ui.meterNote, text: 'This is re-derived from the documented resolution rules, not a report from Claude Code. Run /context in a session to see what it actually loaded.' }));
}
