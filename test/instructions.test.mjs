import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MAX_IMPORT_DEPTH,
  checkGlob,
  checkGlobList,
  expandImports,
  findImports,
  maskCode,
  resolveGlobalInstructions,
  resolveInstructions,
} from '../src/instructions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures', 'instructions');
const PROJECT = path.join(FIXTURES, 'project');
const USER_HOME = path.join(FIXTURES, 'user-home');

const byName = (files) => files.map((f) => path.basename(f.file)).sort();

test('code spans and fences hide their imports', () => {
  // This is the documented way to write a path in a CLAUDE.md without importing
  // it, so getting it wrong would make the tool wrong about its own examples.
  const specs = findImports(['Import @real.md here.', '`@span.md` stays literal.', '```', '@fenced.md', '```'].join('\n'))
    .map((i) => i.spec);
  assert.deepEqual(specs, ['real.md']);
});

test('masking keeps every offset intact', () => {
  const text = 'a `@b.md` c\n```\n@d.md\n```\ne';
  const masked = maskCode(text);
  assert.equal(masked.length, text.length);
  assert.equal(masked.split('\n').length, text.split('\n').length);
});

test('the full stop that ended the sentence is not part of the path', () => {
  // A dot is legal in a filename, so an import written at the end of a sentence
  // used to swallow the punctuation and resolve to a file nobody has.
  assert.deepEqual(findImports('Conventions live in @extra.md.').map((i) => i.spec), ['extra.md']);
  assert.deepEqual(findImports('See @docs/real.md...').map((i) => i.spec), ['docs/real.md']);
  assert.deepEqual(
    findImports('Both @a.md. and @b/c.md, plus (@d.md).').map((i) => i.spec),
    ['a.md', 'b/c.md', 'd.md'],
  );
});

test('trimming the sentence leaves every real path alone', () => {
  // Leading dots carry meaning, and only a trailing run is ever dropped.
  assert.deepEqual(findImports('Hidden @.claude/rules.md stays').map((i) => i.spec), ['.claude/rules.md']);
  assert.deepEqual(findImports('Home @~/.claude/CLAUDE.md.').map((i) => i.spec), ['~/.claude/CLAUDE.md']);
  assert.deepEqual(findImports('Parent @../shared.md.').map((i) => i.spec), ['../shared.md']);
  // A trailing slash says "directory", which is a real thing to have written and
  // a real thing for the import to fail on, so it is left to fail.
  assert.deepEqual(findImports('Everything in @docs/ is included').map((i) => i.spec), ['docs/']);
});

test('punctuation with an @ in front of it is not an import', () => {
  assert.deepEqual(findImports('Punctuation @. and @... alone').map((i) => i.spec), []);
});

test('an email address is not an import', () => {
  assert.deepEqual(findImports('Mail team@example.com or @docs/real.md').map((i) => i.spec), ['docs/real.md']);
});

test('imports resolve relative to the file that wrote them, not the cwd', () => {
  const text = 'See @deep/one.md';
  const from = path.join(PROJECT, 'docs', 'conventions.md');
  const { files } = expandImports(from, text, { projectDir: PROJECT });
  assert.equal(files[0].file, path.join(PROJECT, 'docs', 'deep', 'one.md'));
});

test('the import chain stops at the documented maximum depth', () => {
  const root = path.join(PROJECT, 'CLAUDE.md');
  const { files, problems } = expandImports(root, `@docs/conventions.md`, { projectDir: PROJECT });

  assert.ok(files.every((f) => f.depth <= MAX_IMPORT_DEPTH));
  // conventions(1) -> one(2) -> two(3) -> three(4); four would be a fifth hop.
  assert.deepEqual(byName(files), ['conventions.md', 'one.md', 'three.md', 'two.md']);
  assert.ok(problems.some((p) => p.kind === 'too-deep' && p.file.endsWith('four.md')));
});

test('a missing import is reported rather than passed over', () => {
  const root = path.join(PROJECT, 'CLAUDE.md');
  const { problems } = expandImports(root, '@docs/missing-file.md', { projectDir: PROJECT });
  assert.deepEqual(problems.map((p) => p.kind), ['missing']);
});

test('a file two chains both reach is reported as loaded twice', () => {
  const { problems, files } = resolveInstructions(path.join(FIXTURES, 'duplicate'));
  const duplicate = problems.find((p) => p.kind === 'duplicate-load');

  assert.ok(duplicate, 'shared.md is imported by both CLAUDE.md files');
  assert.equal(path.basename(duplicate.file), 'shared.md');
  assert.equal(duplicate.count, 2);
  assert.ok(duplicate.wastedTokens > 0);
  assert.equal(files.filter((f) => path.basename(f.file) === 'shared.md').length, 2);
});

test('a rule that is nothing but frontmatter is named as loading nothing', () => {
  const { problems } = resolveInstructions(path.join(FIXTURES, 'duplicate'));
  const empty = problems.filter((p) => p.kind === 'empty-instruction-file').map((p) => path.basename(p.file));
  assert.deepEqual(empty, ['blank.md']);
});

test('every instruction problem carries a severity the UI can colour', () => {
  for (const dir of [PROJECT, path.join(FIXTURES, 'duplicate'), path.join(FIXTURES, 'cycle')]) {
    for (const problem of resolveInstructions(dir).problems) {
      assert.ok(['warn', 'bad'].includes(problem.severity), `${problem.kind} has severity ${problem.severity}`);
    }
  }
  const bad = resolveInstructions(PROJECT).problems.findIndex((p) => p.severity === 'bad');
  const warn = resolveInstructions(PROJECT).problems.findIndex((p) => p.severity === 'warn');
  if (bad !== -1 && warn !== -1) assert.ok(bad < warn, 'bad problems sort ahead of warnings');
});

test('a cycle is named once and not followed', () => {
  const dir = path.join(FIXTURES, 'cycle');
  const resolved = resolveInstructions(dir);
  assert.ok(resolved.problems.some((p) => p.kind === 'cycle'));
  // Reported, and the walk still terminated.
  assert.ok(resolved.files.length < 10);
});

test('an unclosed bracket makes a glob match nothing', () => {
  assert.equal(checkGlob('src/**/*.ts').valid, true);
  assert.equal(checkGlob('photos [2024/**').valid, false);
  assert.match(checkGlob('photos [2024/**').reason, /matches nothing/);
  // An escaped bracket is a literal and stays valid.
  assert.equal(checkGlob('photos \\[2024/**').valid, true);
});

test('brace expansion is counted against the shared budget', () => {
  assert.equal(checkGlob('src/*.{ts,tsx}').expansions, 2);
  assert.equal(checkGlob('{a,b}/{c,d}/*.{ts,tsx}').expansions, 8);
  // Patterns without braces do not count toward it.
  assert.equal(checkGlobList(['src/**/*.ts', 'lib/**/*.ts']).expansions, 0);
  assert.equal(checkGlobList(['{a,b,c,d,e,f,g,h,i,j}/{k,l,m,n,o,p,q,r,s,t}/{u,v,w,x,y,z,aa,bb,cc,dd}/*.{ts,tsx}']).overBudget, true);
});

test('a session resolves its whole instruction set in load order', () => {
  const resolved = resolveInstructions(PROJECT);
  const names = resolved.files.map((f) => path.basename(f.file));

  assert.ok(names.includes('CLAUDE.md'));
  assert.ok(names.includes('conventions.md'), 'imports are part of what loads');
  assert.ok(names.includes('style.md') && names.includes('api.md'), 'rules load too');
  assert.ok(!names.includes('never-imported.md'), 'a fenced import must not be followed');

  // The unconditional rule is paid for every session; the path-scoped one is not.
  const style = resolved.files.find((f) => path.basename(f.file) === 'style.md');
  const api = resolved.files.find((f) => path.basename(f.file) === 'api.md');
  assert.equal(style.conditional, false);
  assert.equal(api.conditional, true);
  assert.ok(resolved.totals.conditionalFiles >= 3);
  assert.ok(resolved.totals.alwaysTokens > 0);
});

test('the inert and over-budget rules are both surfaced', () => {
  const { problems } = resolveInstructions(PROJECT);
  assert.ok(problems.some((p) => p.kind === 'invalid-glob' && p.pattern === 'photos [2024/**'));
  assert.ok(problems.some((p) => p.kind === 'glob-budget'));
});

test('an AGENTS.md nothing imports is flagged', () => {
  const { problems } = resolveInstructions(path.join(FIXTURES, 'agents-only'));
  assert.ok(problems.some((p) => p.kind === 'agents-md-not-imported'));
  // And not flagged where the project imports it.
  assert.ok(!resolveInstructions(PROJECT).problems.some((p) => p.kind === 'agents-md-not-imported'));
});

test('the user scope resolves without a project, and stays inside it', () => {
  const resolved = resolveGlobalInstructions({ home: USER_HOME });
  const names = resolved.files.map((f) => path.basename(f.file));

  assert.equal(resolved.projectDir, null);
  assert.ok(names.includes('CLAUDE.md'));
  assert.ok(names.includes('extra.md'), 'imports are followed here too');
  assert.ok(names.includes('style.md') && names.includes('api.md'), 'user rules load');
  assert.ok(!names.includes('fenced.md'), 'a code span is still not an import');

  // The whole point is that no project is involved, so nothing project-scoped
  // may leak in from the machine this runs on.
  assert.deepEqual([...new Set(resolved.files.map((f) => f.scope))].filter((s) => s !== 'managed'), ['user']);
  assert.ok(resolved.totals.alwaysTokens > 0);
  assert.equal(resolved.files.find((f) => path.basename(f.file) === 'api.md').conditional, true);
});

test('with no project there is no boundary for an import to resolve outside of', () => {
  const resolved = resolveGlobalInstructions({ home: USER_HOME });
  assert.ok(resolved.files.every((f) => !f.external));
  assert.ok(!resolved.problems.some((p) => p.kind === 'external'));
});

test('a markdown file next to CLAUDE.md that nothing reaches is named', () => {
  const { problems } = resolveGlobalInstructions({ home: USER_HOME });
  const orphans = problems.filter((p) => p.kind === 'unreferenced-user-file').map((p) => path.basename(p.file));

  assert.deepEqual(orphans, ['unused.md']);
  // Files that do load are not orphans, and the directories below ~/.claude hold
  // markdown that was never meant to be an instruction file.
  assert.ok(!orphans.includes('CLAUDE.md'));
  assert.ok(!orphans.includes('extra.md'));
  assert.ok(!orphans.includes('buried.md'));
});

test('the per-project view does not report the home directory as broken', () => {
  const { problems } = resolveInstructions(PROJECT);
  assert.ok(!problems.some((p) => p.kind === 'unreferenced-user-file'));
});
