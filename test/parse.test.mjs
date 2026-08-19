import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseIndex,
  parseFrontmatter,
  extractWikilinks,
  removeIndexEntries,
  removeLine,
  dominantSeparator,
  setIndexHook,
  moveIndexEntry,
  retargetWikilink,
  sectionInsertIndex,
  insertIndexEntry,
  topInsertIndex,
  sectionStartIndex,
} from '../src/parse.mjs';

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

const SECTIONED = [
  '# Memory',
  '',
  '## Preferences',
  '',
  '- [One](one.md) — first hook',
  '- [Two](two.md) — second hook',
  '  continues under two',
  '',
  '## Projects',
  '',
  '- [Three](three.md) — third hook',
  '',
].join('\n');

test('setIndexHook keeps the em dash the index already uses', () => {
  const { entries } = parseIndex(SECTIONED);
  const { text, after } = setIndexHook(SECTIONED, entries[0].index, entries[0].text, 'shorter');
  assert.equal(after, '- [One](one.md) — shorter');
  assert.equal(text.split('\n')[entries[1].index], entries[1].text);
});

test('setIndexHook keeps a plain hyphen separator', () => {
  const source = '- [No em-dashes](no-em-dashes.md) - always plain hyphens\n';
  const { entries } = parseIndex(source);
  const { after } = setIndexHook(source, entries[0].index, entries[0].text, 'trimmed');
  assert.equal(after, '- [No em-dashes](no-em-dashes.md) - trimmed');
});

test('setIndexHook writing the original hook back reproduces the line', () => {
  for (const source of [SECTIONED, '- [X](x.md): colon separated\n']) {
    const { entries } = parseIndex(source);
    const entry = entries[0];
    const edited = setIndexHook(source, entry.index, entry.text, 'placeholder');
    const restored = setIndexHook(edited.text, entry.index, edited.after, entry.hook);
    assert.equal(restored.text, source);
  }
});

test('an empty hook drops the separator instead of leaving it dangling', () => {
  const { entries } = parseIndex(SECTIONED);
  const { after } = setIndexHook(SECTIONED, entries[0].index, entries[0].text, '   ');
  assert.equal(after, '- [One](one.md)');
});

test('an entry with no hook gains the separator its neighbours use', () => {
  const source = '- [One](one.md) - first\n- [Two](two.md)\n';
  const { entries } = parseIndex(source);
  const { after } = setIndexHook(source, entries[1].index, entries[1].text, 'now has one');
  assert.equal(after, '- [Two](two.md) - now has one');
});

test('dominantSeparator follows the majority rather than a default', () => {
  assert.equal(dominantSeparator(parseIndex(SECTIONED)), ' — ');
  assert.equal(dominantSeparator(parseIndex('- [a](a.md) - x\n- [b](b.md) - y\n- [c](c.md) — z\n')), ' - ');
  assert.equal(dominantSeparator(parseIndex('# no entries at all\n')), ' — ');
});

test('a hook may not smuggle in a second line', () => {
  const { entries } = parseIndex(SECTIONED);
  assert.throws(
    () => setIndexHook(SECTIONED, entries[0].index, entries[0].text, 'one\ntwo'),
    /one line/,
  );
});

test('editing an index line refuses a stale expectation', () => {
  const { entries } = parseIndex(SECTIONED);
  assert.throws(
    () => setIndexHook(SECTIONED, entries[0].index, '- [One](one.md) — stale', 'x'),
    /changed since this was loaded/,
  );
});

test('setIndexHook refuses a line that is not an index entry', () => {
  assert.throws(() => setIndexHook(SECTIONED, 0, '# Memory', 'x'), /not an index entry/);
});

test('moveIndexEntry carries the continuation lines with its bullet', () => {
  const { entries } = parseIndex(SECTIONED);
  const two = entries.find((entry) => entry.file === 'two.md');
  const { text, moved } = moveIndexEntry(SECTIONED, two.index, two.text, 0);
  const lines = text.split('\n');

  assert.equal(moved.length, 2);
  assert.equal(lines[0], '- [Two](two.md) — second hook');
  assert.equal(lines[1], '  continues under two');
  assert.equal(lines.length, SECTIONED.split('\n').length);
  assert.ok(!text.includes('continues under two\n  continues under two'));
});

test('moveIndexEntry refuses a target inside the block being moved', () => {
  const { entries } = parseIndex(SECTIONED);
  const two = entries.find((entry) => entry.file === 'two.md');
  for (const target of [two.index, two.index + 1, two.index + 2]) {
    assert.throws(() => moveIndexEntry(SECTIONED, two.index, two.text, target), /inside the entry/);
  }
});

test('moveIndexEntry refuses a target off the end of the file', () => {
  const { entries } = parseIndex(SECTIONED);
  assert.throws(() => moveIndexEntry(SECTIONED, entries[0].index, entries[0].text, 999), /Cannot move/);
});

test('moving an entry down and back reproduces the file', () => {
  const { entries } = parseIndex(SECTIONED);
  const one = entries[0];
  const down = moveIndexEntry(SECTIONED, one.index, one.text, SECTIONED.split('\n').length - 1);
  const movedTo = down.toIndex;
  const back = moveIndexEntry(down.text, movedTo, one.text, one.index);
  assert.equal(back.text, SECTIONED);
});

test('retargetWikilink moves a link instead of unwrapping it', () => {
  const { text, count } = retargetWikilink('see [[old]], [[old|the old one]] and [[other]]', 'old', 'new');
  assert.equal(text, 'see [[new]], [[new|the old one]] and [[other]]');
  assert.equal(count, 2);
});

test('retargetWikilink leaves an unrelated target alone', () => {
  const { text, count } = retargetWikilink('only [[other]] here', 'old', 'new');
  assert.equal(text, 'only [[other]] here');
  assert.equal(count, 0);
});

test('a new bullet lands after the last entry of its section', () => {
  const parsed = parseIndex(SECTIONED);
  const at = sectionInsertIndex(parsed, 'Preferences');
  const { text } = insertIndexEntry(SECTIONED, at, '- [Four](four.md) — added');
  const lines = text.split('\n');
  assert.equal(lines[at - 1], '  continues under two');
  assert.equal(lines[at], '- [Four](four.md) — added');
  assert.equal(parseIndex(text).entries.find((e) => e.file === 'four.md').section, 'Preferences');
});

test('a section with no entries takes the bullet straight after its prose', () => {
  const source = '# Memory\n\n## Empty\n\nsome prose\n\n## Later\n\n- [One](one.md) — x\n';
  const parsed = parseIndex(source);
  const at = sectionInsertIndex(parsed, 'Empty');
  const { text } = insertIndexEntry(source, at, '- [New](new.md) — added');
  assert.equal(parseIndex(text).entries.find((e) => e.file === 'new.md').section, 'Empty');
  assert.ok(!/\n\n\n/.test(text));
});

test('with no section an appended bullet keeps the trailing newline', () => {
  const parsed = parseIndex(SECTIONED);
  const { text } = insertIndexEntry(SECTIONED, sectionInsertIndex(parsed, null), '- [Four](four.md) — added');
  assert.ok(text.endsWith('- [Four](four.md) — added\n'));
  assert.ok(!/\n\n\n/.test(text));
});

test('the top of the index is below any frontmatter and title heading', () => {
  const withMatter = '---\nname: MEMORY\n---\n\n# Index\n\n- [One](one.md) — x\n';
  assert.equal(topInsertIndex(parseIndex(withMatter)), 6);
  assert.equal(topInsertIndex(parseIndex('# Index\n\n- [One](one.md) — x\n')), 2);
  assert.equal(topInsertIndex(parseIndex('- [One](one.md) — x\n')), 0);
});

test('a move targets the start of a section, not its end', () => {
  const parsed = parseIndex(SECTIONED);
  const start = sectionStartIndex(parsed, 'Preferences');
  const end = sectionInsertIndex(parsed, 'Preferences');
  assert.equal(start, 4);
  assert.ok(start < end, 'start-of-section must sit above end-of-section');
  assert.equal(SECTIONED.split('\n')[start], '- [One](one.md) — first hook');
});

test('a move to an unknown section falls back to the top of the index', () => {
  const parsed = parseIndex(SECTIONED);
  assert.equal(sectionStartIndex(parsed, 'Nope'), topInsertIndex(parsed));
});
