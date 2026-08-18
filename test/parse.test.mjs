import assert from 'node:assert/strict';
import test from 'node:test';

import { parseIndex, parseFrontmatter, extractWikilinks, removeIndexEntries, removeLine } from '../src/parse.mjs';

test('index bullets parse with an em dash separator', () => {
  const { entries } = parseIndex('- [Design system](design-system.md) — tokens for the site\n');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, 'Design system');
  assert.equal(entries[0].file, 'design-system.md');
  assert.equal(entries[0].hook, 'tokens for the site');
});

test('index bullets parse with a plain hyphen separator', () => {
  // Projects that have opted out of em dashes write " - " instead. A regex
  // anchored on the em dash silently drops every entry in those projects.
  const { entries } = parseIndex('- [No em-dashes](no-em-dashes.md) - always plain hyphens\n');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].hook, 'always plain hyphens');
});

test('a missing hook is still a valid entry', () => {
  const { entries } = parseIndex('- [Bare](bare.md)\n');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].hook, '');
});

test('headings are captured and attached to following entries', () => {
  const text = '# Title\n\n## Build\n\n- [A](a.md) — one\n';
  const { entries, parsedLines } = parseIndex(text);
  assert.equal(entries[0].section, 'Build');
  assert.equal(parsedLines[0].kind, 'heading');
  assert.equal(parsedLines[2].level, 2);
});

test('an indented bullet is prose, not an index entry, but still counts as a reference', () => {
  const text = '- **Frontend**: Angular\n  - Tailwind — see [tailwind-v4-setup](tailwind-v4-setup.md): config lives here\n';
  const parsed = parseIndex(text);
  assert.equal(parsed.entries.length, 0, 'indented bullets must not become index entries');
  assert.equal(parsed.inlineLinks.length, 1);
  assert.ok(parsed.referencedFiles.has('tailwind-v4-setup.md'));
  assert.ok(!parsed.indexedFiles.has('tailwind-v4-setup.md'));
});

test('frontmatter keeps the nested metadata block', () => {
  const text = [
    '---',
    'name: a-memory',
    'description: "Quoted, with: a colon"',
    'metadata: ',
    '  node_type: memory',
    '  type: project',
    '  originSessionId: abc-123',
    '---',
    '',
    'Body text.',
  ].join('\n');
  const { data, body, hasFrontmatter } = parseFrontmatter(text);
  assert.equal(hasFrontmatter, true);
  assert.equal(data.name, 'a-memory');
  assert.equal(data.description, 'Quoted, with: a colon');
  assert.equal(data.metadata.type, 'project', 'a flat key/value reader would lose this');
  assert.equal(data.metadata.originSessionId, 'abc-123');
  assert.equal(body, 'Body text.');
});

test('a horizontal rule in the body does not break frontmatter splitting', () => {
  // Splitting on '---' rather than scanning for the closing delimiter truncates
  // every body that contains a markdown rule.
  const text = '---\nname: x\n---\n\nIntro\n\n---\n\nAfter the rule.\n';
  const { data, body } = parseFrontmatter(text);
  assert.equal(data.name, 'x');
  assert.ok(body.includes('After the rule.'));
  assert.ok(body.includes('---'));
});

test('text without frontmatter is returned intact', () => {
  const { hasFrontmatter, body } = parseFrontmatter('Just a body.\n');
  assert.equal(hasFrontmatter, false);
  assert.equal(body, 'Just a body.\n');
});

test('wikilinks are extracted, de-duplicated, and support aliases', () => {
  const links = extractWikilinks('See [[a-memory]] and [[b-memory|the other]] and [[a-memory]] again.');
  assert.deepEqual(links.map((l) => l.target), ['a-memory', 'b-memory']);
  assert.equal(links[1].alias, 'the other');
});

test('deleting an entry takes its indented continuation lines with it', () => {
  const text = '# T\n\n- [A](a.md) — one\n  continued detail\n- [B](b.md) — two\n';
  const { text: after, removed } = removeIndexEntries(text, 'a.md');
  assert.equal(after, '# T\n\n- [B](b.md) — two\n');
  assert.deepEqual(removed.map((r) => r.index), [2, 3]);
});

test('removing a line refuses when the file has changed underneath', () => {
  const text = '- [A](a.md) — one\n- [B](b.md) — two\n';
  assert.throws(() => removeLine(text, 0, '- [Something else](x.md)'), /changed since/);
  assert.throws(() => removeLine(text, 99, undefined), /out of range/);
});

test('flat frontmatter without a metadata block is still readable', () => {
  // Most files nest under `metadata:`, but at least one writes type at the root.
  const text = ['---', 'name: CRM Tasks Feature', 'description: A feature', 'type: project', 'originSessionId: abc', '---', '', 'Body.'].join('\n');
  const { data } = parseFrontmatter(text);
  assert.equal(data.type, 'project');
  assert.equal(data.metadata, undefined);
});
