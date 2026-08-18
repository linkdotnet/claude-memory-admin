// Tests run against two stores.
//
// The committed fixture under test/fixtures/store is the one that matters: it
// encodes the awkward shapes found in real memory directories (headings and
// prose in MEMORY.md, a link buried mid-sentence, both dash conventions, nested
// and flat frontmatter, a dangling wikilink, an orphan, an empty memory dir) and
// it exists on a CI runner, where a real ~/.claude does not.
//
// The developer's real store is used as an extra guard when it happens to be
// present, so genuine data can catch anything the fixture does not model.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ROOT } from '../src/projects.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURE_ROOT = path.join(here, 'fixtures', 'store');
export const FIXTURE_SLUG = '-Users-demo-repos-alpha';
export const REAL_ROOT = DEFAULT_ROOT;
export const hasRealStore = fs.existsSync(REAL_ROOT);

/** Every root worth checking: the fixture always, the real store when present. */
export const allRoots = [FIXTURE_ROOT, ...(hasRealStore ? [REAL_ROOT] : [])];

/** Copy a store into a temp dir so mutations never touch the original. */
export function makeFixture(source = FIXTURE_ROOT) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-admin-fixture-'));
  fs.cpSync(source, dir, { recursive: true });
  return dir;
}

export function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Every memory dir under a root that actually has a MEMORY.md. */
export function memoryDirs(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(root, e.name, 'memory'))
    .filter((dir) => fs.existsSync(path.join(dir, 'MEMORY.md')));
}

/** A stable snapshot of a directory's files, for before/after comparison. */
export function snapshot(dir) {
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    // Finder droppings are not memory content and the app must not touch them.
    // Everything else is kept, so stray temp/backup files still show up here.
    if (name === '.DS_Store' || name === '.gitkeep') continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) continue;
    out[name] = fs.readFileSync(full, 'utf8');
  }
  return out;
}
