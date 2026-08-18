import assert from 'node:assert/strict';
import test from 'node:test';

import { searchProject } from '../src/search.mjs';

const project = {
  slug: 's', label: 'demo',
  memories: [
    { file: 'a.md', name: 'tailwind-v4-setup', description: 'CSS-first config', type: 'project', status: 'indexed', body: 'The repo migrated Tailwind v3 to v4.', entry: { hook: 'setup notes' } },
    { file: 'b.md', name: 'unrelated', description: 'nothing here', type: 'project', status: 'indexed', body: 'Some other text entirely.', entry: null },
  ],
  index: { lines: [{ index: 0, kind: 'index', text: '- [Tailwind](a.md) — setup notes', file: 'a.md' }, { index: 1, kind: 'text', text: 'prose mentioning tailwind loosely' }] },
};

test('a name match outranks a body match', () => {
  const { results } = searchProject(project, ['tailwind']);
  assert.equal(results[0].file, 'a.md');
  assert.ok(results[0].fields.includes('name'));
});

test('every term must match, so extra words narrow the results', () => {
  assert.equal(searchProject(project, ['tailwind']).results.length, 1);
  assert.equal(searchProject(project, ['tailwind', 'zzz']).results.length, 0);
  assert.equal(searchProject(project, ['tailwind', 'migrated']).results.length, 1);
});

test('a snippet is returned around the match', () => {
  const { results } = searchProject(project, ['migrated']);
  assert.ok(results[0].snippet.text.includes('migrated'));
});

test('index prose is searchable even when no memory matches', () => {
  const { results, indexHits } = searchProject(project, ['loosely']);
  assert.equal(results.length, 0);
  assert.equal(indexHits.length, 1);
  assert.match(indexHits[0].text, /loosely/);
});
