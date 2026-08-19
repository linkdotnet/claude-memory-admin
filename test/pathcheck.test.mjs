import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MAX_PATH_CHECKS, indexProject, pathCandidates, verifyPaths } from '../src/pathcheck.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const memory = (body, over = {}) => ({ file: 'a.md', name: 'a', body, ...over });

test('only code spans produce candidates, so prose never does', () => {
  assert.deepEqual(pathCandidates('The file src/model.mjs holds the model.'), []);
  assert.deepEqual(pathCandidates('The file `src/model.mjs` holds the model.'), ['src/model.mjs']);
});

test('a claim about a file needs a file extension, because a slash alone is a route', () => {
  assert.deepEqual(pathCandidates('POST to `api/notification/push-subscription/sync`.'), []);
  assert.deepEqual(pathCandidates('The type `Api/Push/NotificationPushService` handles it.'), []);
  assert.deepEqual(pathCandidates('See `server.mjs`.'), ['server.mjs']);
});

test('an extension named on its own is not a path', () => {
  assert.deepEqual(pathCandidates('Rename every `.scss` to `.css` and drop `.ts`.'), []);
});

test('commands, globs, urls, flags and elisions are not paths', () => {
  const spans = ['`npm run build:css`', '`src/**/*.mjs`', '`https://x.com/a.md`', '`--root`', '`A=b.json`', '`apps/.../a.ts`'];
  assert.deepEqual(pathCandidates(spans.join(' and ')), []);
});

test('a line reference and trailing punctuation are trimmed off the path', () => {
  assert.deepEqual(pathCandidates('See `src/model.mjs:87-95`.'), ['src/model.mjs']);
  assert.deepEqual(pathCandidates('In `public/ui.mjs,`'), ['public/ui.mjs']);
});

test('nothing that could point outside the project is ever a candidate', () => {
  assert.deepEqual(pathCandidates('`/etc/passwd.json` `~/.ssh/config.json` `../../secrets.json` `docs/../../x.json`'), []);
});

test('a path inside a directory the index skips is not judged either way', () => {
  assert.deepEqual(pathCandidates('`node_modules/plotly.js-dist-min/plotly.min.js`'), []);
  assert.deepEqual(pathCandidates('`dist/apps/argus/main.js`'), []);
});

test('a duplicate mention is checked once', () => {
  assert.deepEqual(pathCandidates('`a/b.mjs` again `a/b.mjs`'), ['a/b.mjs']);
});

test('the index reaches dotted directories, which hold real config', () => {
  const { byLastSegment } = indexProject(REPO);
  assert.ok(byLastSegment.has('workflows'), '.github/workflows must be indexed');
  assert.ok(byLastSegment.get('workflows').some((p) => p === '.github/workflows'));
  assert.ok(!byLastSegment.has('node_modules'), 'skipped directories stay out');
});

test('a path that resolves is not reported and one that does not is', () => {
  const result = verifyPaths(REPO, [
    memory('Lives in `server.mjs` and `src/model.mjs`.', { file: 'real.md' }),
    memory('Lives in `src/gone-for-good.mjs`.', { file: 'stale.md', name: 'stale' }),
  ]);

  assert.equal(result.checked, 3);
  assert.equal(result.capped, false);
  assert.deepEqual(result.missing.map((m) => [m.file, m.token]), [['stale.md', 'src/gone-for-good.mjs']]);
  assert.equal(result.missing[0].kind, 'stale-path');
  assert.equal(result.missing[0].severity, 'warn');
});

test('a path named the way a developer says it still resolves, by suffix', () => {
  const result = verifyPaths(REPO, [memory('Defined in `fixtures/store/-Users-demo-repos-messy/memory/stub.md`.')]);
  assert.deepEqual(result.missing, [], 'the file is under test/, and the memory did not say so');
});

test('a suffix match must respect the directories in front of the filename', () => {
  const result = verifyPaths(REPO, [memory('Defined in `nowhere/near/it/stub.md`.')]);
  assert.deepEqual(result.missing.map((m) => m.token), ['nowhere/near/it/stub.md']);
});

test('the number of checks is capped, and the cap is admitted rather than hidden', () => {
  const body = Array.from({ length: MAX_PATH_CHECKS + 50 }, (_, i) => `\`src/gone-${i}.mjs\``).join(' ');
  const result = verifyPaths(REPO, [memory(body, { file: 'many.md' })]);

  assert.equal(result.checked, MAX_PATH_CHECKS);
  assert.equal(result.capped, true);
  assert.equal(result.missing.length, MAX_PATH_CHECKS);
});
