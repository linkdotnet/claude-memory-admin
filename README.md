# claude-memory-admin

[![CI](https://github.com/linkdotnet/claude-memory-admin/actions/workflows/ci.yml/badge.svg)](https://github.com/linkdotnet/claude-memory-admin/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/claude-memory-admin)](https://www.npmjs.com/package/claude-memory-admin)

Browse, audit and prune the **auto memory** Claude Code writes for each project.

```bash
npm install -g claude-memory-admin
claude-memory-admin
```

It opens `http://localhost:4173` and reads `~/.claude/projects/*/memory/`.
Nothing leaves your machine; the server binds `127.0.0.1` only.

<sub>Brought to you by [BitSpire](https://bitspire.ch/).</sub>

---

### Prune: see what MEMORY.md actually costs you

![The Prune tab, showing how much of the MEMORY.md load limit a project uses and a sortable list of memories by age, size and inbound links](assets/prune.webp)

### Graph: see how memories link to each other

![The Graph tab, showing memories as nodes coloured by type with wikilinks as edges](assets/graph.webp)

---

## What this is for

Claude Code keeps two kinds of memory. This tool is about the second one:

| | CLAUDE.md | Auto memory |
| --- | --- | --- |
| Written by | you | Claude |
| Lives in | `./CLAUDE.md`, `~/.claude/CLAUDE.md` | `~/.claude/projects/<project>/memory/` |
| Contains | rules and instructions | learnings Claude picked up |

The auto memory directory holds `MEMORY.md` (a concise index) plus one topic
file per memory, cross-linked with `[[wikilinks]]`.

**`MEMORY.md` is loaded at the start of every session, and only the first 200
lines or 25KB, whichever comes first.** Everything past that cutoff is silently
dropped. That single fact drives most of this tool: it shows you how close each
project is to the cliff, and makes it quick to get back under it.

## What it does

- **Projects by real path.** The directories on disk are slugified cwds
  (`-Users-me-repos-Blog`) and the slugification is lossy. The true path is
  recovered from the `cwd` field in the session transcripts stored next to each
  memory directory; anything that cannot be confirmed is shown as the raw slug
  rather than a plausible guess. `autoMemoryDirectory` in `~/.claude/settings.json`
  is honoured if you have moved the store.
- **Search across every project**: names, descriptions, bodies and index hooks,
  with snippets and match highlighting. Press `/` to jump to it.
- **Read each memory** with its frontmatter as structured metadata and
  `[[wikilinks]]` as clickable links. Dead links are struck through in red.
- **Prune** (see below).
- **Graph** the wikilinks between memories. Hovering dims everything that is not
  a neighbour, which is the only practical way to read a dense cluster.
- **Health**: orphans, dangling pointers, broken wikilinks, files linked only
  mid-sentence, `name` fields that disagree with the filename.
- **Delete with cascade**, always reversible.

## Keeping MEMORY.md small

The **Prune** tab exists because a bloated index costs tokens on every single
session and, past the limit, silently stops loading.

- **Load meter**. How much of the 200-line / 25KB budget the index uses, and
  which of the two is binding. Frontmatter and HTML comments are excluded,
  because Claude Code strips those before loading.
- **Long hooks**. The hook is the text after the dash in `MEMORY.md`. A
  400-character hook can cost more than the memory it points at, and shortening
  it is the cheapest win available.
- **Possible overlap**. Pairs of memories ranked by shared *rare* vocabulary, to
  surface the same lesson saved three times from three sessions. It is a hint,
  not a verdict.
- **Bulk prune**. Sort by age, size, or inbound links, tick several, delete them
  as one restore point.

Anthropic's own guidance for the index: one line per entry, detail in the topic
files, merge or drop stale entries.

## Deleting is reversible

Delete shows a preview first: the exact lines that will go, the prose mentions it
will deliberately leave alone, and which other memories link here and will break.
Those linking memories each get a checkbox, tick any you want removed in the same
operation, and they are trashed and restored as a single step.

**Delete all memory** clears one project: `MEMORY.md` and every memory file, as
one restore point. Session transcripts (`*.jsonl`) and the project folder are
never touched, only the contents of `memory/`.

**Remove link** in the Health tab clears a `[[wikilink]]` whose target no longer
exists. The markup goes and the words stay, so `see [[gone]] for details` becomes
`see gone for details`.

Everything lands in `memory/.trash/` with a restore record and comes back from the
Trash tab. The app never creates memories and never rewrites their prose beyond
clearing a dead link's brackets.

## Usage

```
claude-memory-admin [options]

  -p, --port <n>    port to listen on       (default 4173)
  -r, --root <dir>  memory store to read    (default ~/.claude/projects)
      --no-open     do not launch a browser
  -h, --help        show help
  -v, --version     print the version
```

Point it at a copy if you want to experiment safely:

```bash
cp -R ~/.claude/projects /tmp/memory-snapshot
claude-memory-admin --root /tmp/memory-snapshot
```

## Safety

- Binds `127.0.0.1`; no telemetry, no network calls.
- Every write target must resolve to a plain `.md` file inside that project's own
  `memory/` directory. `..`, absolute paths and subdirectories are refused.
- `MEMORY.md` is replaced atomically (temp file, `fsync`, `rename`) with a backup
  restored if anything throws.
- A test asserts that parsing and rewriting every real `MEMORY.md` with no
  deletions reproduces it byte for byte. Real indexes are hand-written prose with
  headings and nested bullets, and mangling one would be silent.

## Development

```bash
git clone https://github.com/linkdotnet/claude-memory-admin
cd claude-memory-admin
npm install
npm start                 # or: node server.mjs
npm test                  # runs on a throwaway copy of your real store
```

No bundler and no build step: the backend is `node:http` plus `node:fs`, and the
frontend is plain ES modules the browser loads directly. Two runtime dependencies,
`marked` and `dompurify`, both only for rendering memory bodies safely.

| Path | Purpose |
| --- | --- |
| `bin/claude-memory-admin.mjs` | CLI entry point and argument parsing |
| `server.mjs` | HTTP server: static files + JSON API |
| `src/projects.mjs` | Project discovery, slug → real path resolution |
| `src/parse.mjs` | `MEMORY.md` and frontmatter parsers, wikilinks |
| `src/model.mjs` | Joins index, files, graph and health into one model |
| `src/stats.mjs` | Load-limit accounting and overlap detection |
| `src/search.mjs` | Full-text search across projects |
| `src/mutate.mjs` | Delete / restore / unlink, the only code that writes |
| `public/` | Frontend |

Tests run against a committed fixture store under `test/fixtures/store/`, which
encodes the awkward shapes real memory directories contain. Your own
`~/.claude/projects` is additionally checked when it exists, always on a
throwaway copy.

### Releasing

Publishing runs in CI. You do not bump anything by hand.

Go to **Actions, Release, Run workflow**, pick `patch`, `minor` or `major`, and
run it. The workflow tests, bumps `package.json` and `package-lock.json`, commits
and tags the bump, pushes both, then publishes to npm.

If you would rather cut the version locally, that still works:

```bash
npm version patch
git push --follow-tags
```

Pushing a `v*` tag publishes whatever is in `package.json`, after checking the
two agree. Either route refuses to publish a version that is already on npm,
because npm never allows one to be replaced.

It needs one repository secret:

| Secret | Value |
| --- | --- |
| `NPM_TOKEN` | an npm **Automation** access token with publish rights |

Add it under *Settings, Secrets and variables, Actions, New repository secret*.
An Automation token is the right kind because it bypasses 2FA, which an
unattended workflow cannot satisfy.

Two things that will bite if they apply to you: the workflow pushes the bump
commit to the default branch, so a branch protection rule that blocks pushes
will stop it; and the tag it pushes uses `GITHUB_TOKEN`, which by design does
not trigger other workflows, so there is no double publish.

### Screenshots and demo data

The screenshots come from an invented store, never a real one:

```bash
node scripts/demo-store.mjs /tmp/demo-store
npm start -- --root /tmp/demo-store
```

## License

MIT
