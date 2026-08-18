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
  resolveInstructions,
} from '../src/instructions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures', 'instructions');
const PROJECT = path.join(FIXTURES, 'project');

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
