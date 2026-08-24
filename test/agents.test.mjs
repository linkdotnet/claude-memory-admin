// User-scope agent definitions: reading them, and the one edit this tool makes
// to them.
//
// Every test runs against a temp directory, so a developer's real
// ~/.claude/agents is never read and never written.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { listAgents, listAllAgents, listProjectAgents, agentsDirExists, rewriteAgentField, setAgentField } from '../src/agents.mjs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function withAgents(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-admin-agents-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), text);
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SUMMARISER = `---
name: summariser
description: Condenses long output into a short answer
tools: Read, Grep
model: haiku
---

You summarise. Keep it to five lines.

---

That horizontal rule is part of the body.
`;

const MINIMAL = `---
name: reviewer
description: Reviews a diff
---

You review code.
`;

test('an agent file is read down to its model and effort', () => {
  withAgents({ 'summariser.md': SUMMARISER }, (dir) => {
    const [agent] = listAgents({ dir });
    assert.equal(agent.name, 'summariser');
    assert.equal(agent.description, 'Condenses long output into a short answer');
    assert.equal(agent.tools, 'Read, Grep');
    assert.equal(agent.model, 'haiku');
    assert.equal(agent.effort, null);
    assert.deepEqual(agent.problems, []);
  });
});

test('a directory that is not there is an empty list, not a failure', () => {
  const dir = path.join(os.tmpdir(), 'memory-admin-agents-absent-does-not-exist');
  assert.deepEqual(listAgents({ dir }), []);
  assert.equal(agentsDirExists({ dir }), false);
});

test('an agent named differently from its file is reported, and keeps its declared name', () => {
  withAgents({ 'summarizer.md': SUMMARISER }, (dir) => {
    const [agent] = listAgents({ dir });
    assert.equal(agent.name, 'summariser');
    assert.deepEqual(agent.problems.map((p) => p.kind), ['name-mismatch']);
  });
});

test('a file without frontmatter is reported rather than read as an agent', () => {
  withAgents({ 'notes.md': '# just some notes\n' }, (dir) => {
    const [agent] = listAgents({ dir });
    assert.deepEqual(agent.problems.map((p) => p.kind), ['no-frontmatter']);
    assert.equal(agent.problems[0].severity, 'bad');
  });
});

test('a model that is neither an alias nor a claude- name is reported', () => {
  withAgents({ 'odd.md': '---\nname: odd\ndescription: d\nmodel: gpt-9\neffort: turbo\n---\n\nbody\n' }, (dir) => {
    const [agent] = listAgents({ dir });
    assert.deepEqual(agent.problems.map((p) => p.kind), ['unknown-model', 'unknown-effort']);
  });
});

test('a full claude- model name is accepted without complaint', () => {
  withAgents({ 'pinned.md': '---\nname: pinned\ndescription: d\nmodel: claude-haiku-4-5-20251001\n---\n\nbody\n' }, (dir) => {
    const [agent] = listAgents({ dir });
    assert.equal(agent.model, 'claude-haiku-4-5-20251001');
    assert.deepEqual(agent.problems, []);
  });
});

test('setting a field that is already there replaces only that line', () => {
  withAgents({ 'summariser.md': SUMMARISER }, (dir) => {
    setAgentField('summariser.md', 'model', 'sonnet', { dir });
    const after = fs.readFileSync(path.join(dir, 'summariser.md'), 'utf8');
    assert.equal(after, SUMMARISER.replace('model: haiku', 'model: sonnet'));
  });
});

test('setting a field that is absent inserts it after the description', () => {
  withAgents({ 'reviewer.md': MINIMAL }, (dir) => {
    setAgentField('reviewer.md', 'effort', 'low', { dir });
    const after = fs.readFileSync(path.join(dir, 'reviewer.md'), 'utf8');
    assert.equal(after, MINIMAL.replace('description: Reviews a diff\n', 'description: Reviews a diff\neffort: low\n'));
  });
});

test('clearing a field removes its line and leaves the rest byte-identical', () => {
  withAgents({ 'summariser.md': SUMMARISER }, (dir) => {
    setAgentField('summariser.md', 'model', 'inherit', { dir });
    const after = fs.readFileSync(path.join(dir, 'summariser.md'), 'utf8');
    assert.equal(after, SUMMARISER.replace('model: haiku\n', ''));
  });
});

// The body of an agent file is prose somebody wrote, and it routinely contains a
// --- of its own. Re-emitting the file from a parse of it would eat that.
test('the body survives an edit untouched, horizontal rules and all', () => {
  withAgents({ 'summariser.md': SUMMARISER }, (dir) => {
    setAgentField('summariser.md', 'effort', 'low', { dir });
    const after = fs.readFileSync(path.join(dir, 'summariser.md'), 'utf8');
    const body = (text) => text.split('\n---\n').slice(1).join('\n---\n');
    assert.equal(body(after), body(SUMMARISER));
    assert.match(after, /That horizontal rule is part of the body\./);
  });
});

test('clearing a field that is not set changes nothing', () => {
  withAgents({ 'reviewer.md': MINIMAL }, (dir) => {
    setAgentField('reviewer.md', 'effort', 'default', { dir });
    assert.equal(fs.readFileSync(path.join(dir, 'reviewer.md'), 'utf8'), MINIMAL);
  });
});

test('only model and effort can be written', () => {
  withAgents({ 'reviewer.md': MINIMAL }, (dir) => {
    assert.throws(() => setAgentField('reviewer.md', 'tools', 'Bash', { dir }), /not a field this tool writes/);
    assert.throws(() => setAgentField('reviewer.md', 'description', 'anything', { dir }), /not a field this tool writes/);
    assert.equal(fs.readFileSync(path.join(dir, 'reviewer.md'), 'utf8'), MINIMAL);
  });
});

test('a value the field does not accept is refused before anything is written', () => {
  withAgents({ 'reviewer.md': MINIMAL }, (dir) => {
    assert.throws(() => setAgentField('reviewer.md', 'model', 'gpt-9', { dir }), /is not a value model accepts/);
    assert.throws(() => setAgentField('reviewer.md', 'effort', 'turbo', { dir }), /is not a value effort accepts/);
    assert.equal(fs.readFileSync(path.join(dir, 'reviewer.md'), 'utf8'), MINIMAL);
  });
});

test('a filename that is not a plain .md basename is refused', () => {
  withAgents({ 'reviewer.md': MINIMAL }, (dir) => {
    for (const file of ['../settings.json', 'sub/reviewer.md', '.hidden.md', 'reviewer.txt', '']) {
      assert.throws(() => setAgentField(file, 'model', 'haiku', { dir }));
    }
  });
});

test('a file that has gone missing is reported rather than created', () => {
  withAgents({ 'reviewer.md': MINIMAL }, (dir) => {
    assert.throws(() => setAgentField('ghost.md', 'model', 'haiku', { dir }), /no longer there/);
    assert.equal(fs.existsSync(path.join(dir, 'ghost.md')), false);
  });
});

test('a file with no frontmatter has nothing to set', () => {
  withAgents({ 'notes.md': '# just some notes\n' }, (dir) => {
    assert.throws(() => setAgentField('notes.md', 'model', 'haiku', { dir }), /no frontmatter/);
  });
});

// A folded description would swallow a line inserted straight after it, so the
// insertion falls back to the end of the block instead.
test('a folded description pushes the insertion to the end of the block', () => {
  const folded = '---\nname: folded\ndescription: |\n  a long one\n  over two lines\n---\n\nbody\n';
  assert.equal(
    rewriteAgentField(folded, 'model', 'haiku'),
    '---\nname: folded\ndescription: |\n  a long one\n  over two lines\nmodel: haiku\n---\n\nbody\n',
  );
});

test('agents are listed by name, and dotfiles are skipped', () => {
  withAgents({
    'summariser.md': SUMMARISER,
    'reviewer.md': MINIMAL,
    '.draft.md': MINIMAL,
    'readme.txt': 'not an agent',
  }, (dir) => {
    assert.deepEqual(listAgents({ dir }).map((a) => a.name), ['reviewer', 'summariser']);
  });
});

const DEFINITIONS = path.join(here, 'fixtures', 'agents', 'definitions');
const AGENT_REPO = path.join(here, 'fixtures', 'agents', 'repo');

test('the memory scope is read off the frontmatter', () => {
  const agents = listAgents({ dir: DEFINITIONS });
  const byName = Object.fromEntries(agents.map((agent) => [agent.name, agent]));
  assert.equal(byName['code-reviewer'].memory, 'user');
  assert.equal(byName.scratch.memory, 'project');
  assert.equal(byName.forgetful.memory, null);
});

test('agents in subfolders are found, and are not rewritable', () => {
  const nested = listAgents({ dir: DEFINITIONS }).find((agent) => agent.name === 'bad-scope');
  assert.equal(nested.file, 'nested/bad-scope.md');
  assert.equal(nested.writable, false);
  // A top-level file in the user directory is the one shape writes accept.
  assert.equal(listAgents({ dir: DEFINITIONS }).find((a) => a.name === 'forgetful').writable, true);
});

test('a memory scope that is not one of the three is flagged', () => {
  const nested = listAgents({ dir: DEFINITIONS }).find((agent) => agent.name === 'bad-scope');
  assert.deepEqual(nested.problems.map((p) => p.kind), ['unknown-memory-scope']);
  // The raw value is kept so the message can quote it, but it names no store.
  assert.equal(nested.memory, null);
  assert.equal(nested.memoryRaw, 'global');
});

test('project-scope definitions are read but never writable', () => {
  const agents = listProjectAgents(AGENT_REPO);
  assert.deepEqual(agents.map((a) => a.name), ['code-reviewer']);
  assert.equal(agents[0].scope, 'project');
  assert.equal(agents[0].memory, 'project');
  assert.equal(agents[0].writable, false);
  assert.equal(agents[0].projectPath, AGENT_REPO);
});

test('a relative project path contributes nothing rather than throwing', () => {
  assert.deepEqual(listProjectAgents('not/absolute'), []);
  assert.deepEqual(listProjectAgents(null), []);
});

test('listAllAgents reads a repository once however often it is named', () => {
  const agents = listAllAgents({ dir: DEFINITIONS, projectPaths: [AGENT_REPO, AGENT_REPO] });
  assert.equal(agents.filter((a) => a.scope === 'project').length, 1);
  assert.equal(agents.filter((a) => a.scope === 'user').length, 4);
});

test('a CRLF agent file keeps its line endings when a field is written', () => {
  const original = '---\r\nname: a\r\ndescription: d\r\n---\r\n\r\nbody\r\n';
  const written = rewriteAgentField(original, 'model', 'opus');
  assert.equal(written, '---\r\nname: a\r\ndescription: d\r\nmodel: opus\r\n---\r\n\r\nbody\r\n');
  assert.equal(/[^\r]\n/.test(written), false, 'no bare newline is introduced');
});
