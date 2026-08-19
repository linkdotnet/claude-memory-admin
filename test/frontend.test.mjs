import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildProject } from '../src/model.mjs';
import { FIXTURE_ROOT } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const frontendSources = [
  ...fs.readdirSync(path.join(root, 'public'))
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => `public/${name}`),
  'styles/app.css',
];

// The comment-free rule is a house style that review keeps missing, so it is
// checked rather than remembered.
test('frontend sources carry no comments', () => {
  for (const file of frontendSources) {
    const lines = read(file).split('\n');
    const offenders = lines
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => line.startsWith('//') || line.startsWith('/*') || line.startsWith('*'));
    assert.deepEqual(offenders, [], `${file} has comments: ${JSON.stringify(offenders)}`);
  }
});

// Tailwind scans source as plain text, so an interpolated class name compiles
// to nothing and fails silently in the browser rather than at build time.
test('class names are never interpolated', () => {
  for (const file of frontendSources.filter((f) => f.endsWith('.mjs'))) {
    const matches = [...read(file).matchAll(/class(?:Name)?:?\s*=?\s*`[^`]*\$\{/g)];
    assert.equal(matches.length, 0, `${file} builds a class name by interpolation: ${matches.map((m) => m[0])}`);
  }
});

test('every ui token used by the frontend is exported', async () => {
  const ui = await import(new URL('../public/ui.mjs', import.meta.url));
  const exported = new Set(Object.keys(ui));
  for (const file of ['public/app.mjs', 'public/graph.mjs', 'public/dialog.mjs']) {
    const used = new Set([...read(file).matchAll(/(?<![/\w])ui\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
    const missing = [...used].filter((name) => !exported.has(name));
    assert.deepEqual(missing, [], `${file} uses undefined ui exports: ${missing}`);
  }
});

// A native confirm() ignores the theme and flattens the dialog body into one
// string, which is the whole reason the dialog service exists.
test('the frontend never falls back to a browser dialog', () => {
  for (const file of frontendSources.filter((f) => f.endsWith('.mjs'))) {
    const matches = [...read(file).matchAll(/(?<![\w.])(?:confirm|prompt|alert)\s*\(/g)];
    assert.deepEqual(matches.map((m) => m[0]), [], `${file} calls a browser dialog`);
  }
});

// Nothing renders the scrim any more except the dialog's own ::backdrop, so
// dropping the variant would fail silently in the browser rather than here.
test('the dialog paints its own backdrop', async () => {
  const ui = await import(new URL('../public/ui.mjs', import.meta.url));
  assert.match(ui.dialog, /backdrop:bg-scrim/);
  assert.equal(ui.modalBackdrop, undefined);
});

test('the compiled stylesheet carries the semantic token layer', () => {
  const css = read('public/styles.css');
  assert.ok(css.length > 1000, 'public/styles.css looks empty - run npm run build:css');
  for (const token of ['--ui-canvas', '--ui-surface', '--ui-line', '--ui-fg', '--ui-accent', '--ui-danger']) {
    assert.ok(css.includes(token), `compiled stylesheet is missing ${token}`);
  }
});

test('index.html role hooks all resolve to a ui export', async () => {
  const ui = await import(new URL('../public/ui.mjs', import.meta.url));
  const roles = [...read('public/index.html').matchAll(/data-ui="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(roles.length > 0);
  const unknown = [...new Set(roles)].filter((role) => typeof ui[role] !== 'string');
  assert.deepEqual(unknown, [], `index.html references unknown ui exports: ${unknown}`);
});

test('every model field the tab strip reads is one the model actually produces', () => {
  const app = read('public/app.mjs');
  const overflow = buildProject(FIXTURE_ROOT, '-Users-demo-repos-overflow');

  const reads = (prefix, object) => {
    const pattern = new RegExp(`${prefix.replace(/\./g, '\\.')}\\.([A-Za-z_$][\\w$]*)`, 'g');
    const used = new Set([...app.matchAll(pattern)].map((m) => m[1]));
    const missing = [...used].filter((key) => !(key in object));
    assert.deepEqual(missing, [], `${prefix} reads fields nothing sets: ${missing}`);
  };

  reads('state.store.stats.index', overflow.stats.index);
  reads('state.store.health', overflow.health);
});

test('an index past the load limit is one the tab strip can warn about', () => {
  const { stats } = buildProject(FIXTURE_ROOT, '-Users-demo-repos-overflow');
  assert.equal(stats.index.level, 'over', 'the fixture exists to be over the limit');
  assert.match(read('public/app.mjs'), /stats\.index\.level/);
});

test('the theme boot script and the runtime share one storage key', () => {
  const html = read('public/index.html');
  const app = read('public/app.mjs');
  assert.match(html, /localStorage\.getItem\('theme'\)/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(app, /localStorage\.setItem\('theme', value\)/);
  assert.match(app, /localStorage\.getItem\('theme'\)/);
});
