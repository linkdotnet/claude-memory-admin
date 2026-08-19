#!/usr/bin/env node
// Generates a throwaway memory store with invented content, for screenshots and
// for poking at the UI without pointing it at a real ~/.claude.
//
//   node scripts/demo-store.mjs /tmp/demo-store
//   claude-memory-admin --root /tmp/demo-store
//
// Nothing here describes a real project. The shapes are what matter: a long
// index with headings, hooks of varying length, a pair of overlapping notes, an
// orphan, a broken wikilink, and a second project that uses hyphens instead of
// em dashes.

import fs from 'node:fs';
import path from 'node:path';

const target = process.argv[2] || path.join(process.cwd(), 'demo-store');

const MEMORIES = [
  ['queue-retry-backoff', 'project', 'Retries use exponential backoff with jitter; the ceiling is 30s and it is deliberate', 45,
    'Workers retry through `RetryPolicy`, which is exponential with full jitter.\n\nThe 30s ceiling is load bearing: past it the visibility timeout expires and the\nmessage is redelivered, so a longer wait silently doubles the work.\n\nSee [[queue-visibility-timeout]].'],
  ['queue-visibility-timeout', 'project', 'Visibility timeout is 30s and must stay above the retry ceiling', 60,
    'If the retry ceiling ever exceeds this, messages are redelivered mid-retry.\n\nRelated: [[queue-retry-backoff]].'],
  ['db-migrations-are-forward-only', 'project', 'Migrations never roll back in production; write a compensating migration instead', 90,
    'Down migrations exist for local work only. Production rolls forward.\n\nA migration that needs a bigger pool is usually the wrong migration, see\n[[db-connection-pool-sizing]].'],
  ['db-connection-pool-sizing', 'project', 'Pool is sized to 2x cores, not per-request; raising it hides the real problem', 120,
    'A saturated pool almost always means a slow query, not too few connections.\n\nQueue workers hold a connection for the whole retry window, see\n[[queue-retry-backoff]].'],
  ['api-error-envelope', 'project', 'All handlers return the shared error envelope; never a bare string', 30,
    'Use `problem+json`. The shape is asserted in contract tests, so a bare string\nfails the suite rather than reaching a client.\n\nErrors are logged as fields, never interpolated, see [[logging-structured-only]].\nThe envelope is versioned with the path, see [[api-versioning-in-path]].'],
  ['api-versioning-in-path', 'project', 'Versions live in the path, not a header, and old versions stay until usage hits zero', 200,
    'Header versioning was tried and abandoned: caches ignored it.\n\nThe generated client is rebuilt per version, see [[build-output-is-not-committed]].'],
  ['auth-token-refresh-race', 'project', 'Two tabs refreshing at once produced a logout loop; the fix is a single-flight lock', 15,
    'The refresh call is wrapped in a single-flight promise keyed on the session.\n\nWithout it, the second tab invalidates the first tab\'s freshly issued token.\n\nSee [[auth-session-storage]] and [[a-note-that-was-deleted]].'],
  ['auth-session-storage', 'project', 'Sessions live in memory plus an httpOnly cookie, never in localStorage', 220,
    'localStorage is readable by any injected script.'],
  ['ui-empty-states-are-required', 'feedback', 'Every list needs an empty state before review; a blank panel is treated as a bug', 8,
    '**Why:** a blank panel is indistinguishable from a failed load.\n\n**How to apply:** ship the empty state in the same change as the list.\n\nSee also [[ui-no-spinners-under-300ms]].'],
  ['ui-no-spinners-under-300ms', 'feedback', 'Do not show a spinner for work that usually finishes under 300ms', 25,
    '**Why:** a flashing spinner reads as jank.\n\n**How to apply:** delay the spinner, do not delay the content.'],
  ['test-fixtures-over-mocks', 'feedback', 'Prefer a real fixture to a mock when the real thing is cheap to construct', 40,
    '**Why:** mocks drift from the code they stand in for.\n\n**How to apply:** mock the network boundary, build everything else for real.\n\nQuarantine anything that stays flaky, see [[ci-flaky-test-quarantine]].'],
  ['ci-cache-keyed-on-lockfile', 'project', 'The CI cache key is the lockfile hash; keying on the branch produced stale installs', 70,
    'A branch-keyed cache served a lockfile from another branch.\n\nGenerated output is never cached, it is rebuilt, see\n[[build-output-is-not-committed]].'],
  ['ci-flaky-test-quarantine', 'project', 'Flaky tests are quarantined with an issue link, never silently skipped', 150,
    'A skip with no link becomes permanent. The quarantine list is reviewed weekly.\n\nMost flakes here were fixture drift, see [[test-fixtures-over-mocks]].'],
  ['build-output-is-not-committed', 'project', 'Generated output stays out of version control, including the generated client', 300,
    'The generated API client is produced at build time from the schema.'],
  ['logging-structured-only', 'project', 'Logs are structured; string interpolation into a log message is rejected in review', 180,
    'Interpolated messages cannot be queried. Pass fields, not sentences.\n\nRetry attempts are logged with the attempt number, see [[queue-retry-backoff]].'],
  ['feature-flags-are-booleans', 'project', 'Flags stay plain booleans; multi-valued flags become configuration instead', 95,
    'A flag that carries a value is configuration wearing a flag costume.\n\nFlag reads go through the error envelope on failure, see [[api-error-envelope]].'],
  ['orphaned-scratch-note', 'reference', 'A note nothing points at, kept to show what an orphan looks like', 400,
    'Nothing in MEMORY.md references this file, so Claude never loads it.'],
];

const INDEX_SECTIONS = [
  ['Conventions', ['api-error-envelope', 'api-versioning-in-path', 'logging-structured-only', 'feature-flags-are-booleans', 'build-output-is-not-committed']],
  ['Data and queues', ['queue-retry-backoff', 'queue-visibility-timeout', 'db-migrations-are-forward-only', 'db-connection-pool-sizing']],
  ['Auth', ['auth-token-refresh-race', 'auth-session-storage']],
  ['Preferences', ['ui-empty-states-are-required', 'ui-no-spinners-under-300ms', 'test-fixtures-over-mocks']],
  ['CI', ['ci-cache-keyed-on-lockfile', 'ci-flaky-test-quarantine']],
];

const HOOKS = {
  'queue-retry-backoff': 'read before touching any retry, backoff or jitter constant',
  'queue-visibility-timeout': 'read before changing the visibility timeout',
  'db-migrations-are-forward-only': 'read before writing a migration',
  'db-connection-pool-sizing': 'read when the pool looks saturated',
  'api-error-envelope': 'read before adding a handler or a new error path',
  'logging-structured-only': 'read before adding a log line',
  'feature-flags-are-booleans': 'read before adding a flag',
  'build-output-is-not-committed': 'read before committing anything generated',
  'auth-token-refresh-race': 'read before touching token refresh',
  'ui-empty-states-are-required': 'read before shipping a list view',
  'test-fixtures-over-mocks': 'read before reaching for a mock',
  'ci-cache-keyed-on-lockfile': 'read before changing the CI cache key',
};

// A couple of deliberately long hooks, so the Prune tab has something to flag.
const LONG_HOOKS = {
  'api-versioning-in-path': 'versions live in the path and never in a header, because the CDN in front of the API ignores Vary and served one version to clients that asked for another; old versions stay reachable until telemetry shows zero calls for a full billing period, and only then are they removed in a separate change',
  'ci-flaky-test-quarantine': 'a flaky test is moved to the quarantine list with a link to the issue that tracks it, never skipped inline, because an inline skip has no owner and no expiry and will still be there a year later; the list is reviewed weekly and anything older than a month is either fixed or deleted outright',
};

function frontmatter(name, description, type, ageDays) {
  const stamp = new Date(Date.UTC(2026, 0, 1) + (400 - ageDays) * 86400000).toISOString();
  return ['---', `name: ${name}`, `description: "${description}"`, 'metadata: ',
    '  node_type: memory', `  type: ${type}`,
    `  originSessionId: 00000000-0000-4000-8000-${String(ageDays).padStart(12, '0')}`,
    `  modified: ${stamp}`, '---', ''].join('\n');
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

const main = path.join(target, '-Users-demo-repos-orbital-api', 'memory');
fs.rmSync(target, { recursive: true, force: true });

for (const [name, type, description, ageDays, body] of MEMORIES) {
  write(path.join(main, `${name}.md`), `${frontmatter(name, description, type, ageDays)}${body}\n`);
}

const lines = ['# orbital-api Project Memory', ''];
for (const [section, names] of INDEX_SECTIONS) {
  lines.push(`## ${section}`, '');
  for (const name of names) {
    const memory = MEMORIES.find((m) => m[0] === name);
    const hook = LONG_HOOKS[name] || HOOKS[name] || memory[2];
    lines.push(`- [${name.replace(/-/g, ' ')}](${name}.md) — ${hook}`);
  }
  lines.push('');
}
lines.push('## Architecture', '', '- **Services** live under `services/`, one process each',
  '  - The queue worker shares the retry policy, see [queue retry backoff](queue-retry-backoff.md)',
  '- Contracts are generated from the schema at build time', '');
write(path.join(main, 'MEMORY.md'), lines.join('\n'));

write(path.join(target, '-Users-demo-repos-orbital-api', 'session.jsonl'),
  '{"type":"user","cwd":"/Users/demo/repos/orbital-api","timestamp":"2026-01-05T09:00:00.000Z"}\n');

// A second project, which has opted out of em dashes.
const side = path.join(target, '-Users-demo-repos-orbital-cli', 'memory');
write(path.join(side, 'no-em-dashes.md'),
  `${frontmatter('no-em-dashes', 'Plain hyphens everywhere, in replies and in code alike', 'feedback', 12)}Use plain hyphens, never em dashes.\n`);
write(path.join(side, 'MEMORY.md'),
  '- [No em-dashes](no-em-dashes.md) - always plain hyphens, in replies and in code\n');
write(path.join(target, '-Users-demo-repos-orbital-cli', 'session.jsonl'),
  '{"type":"user","cwd":"/Users/demo/repos/orbital-cli","timestamp":"2026-02-05T09:00:00.000Z"}\n');

console.log(`Demo store written to ${target}`);
console.log(`  claude-memory-admin --root ${target}`);
