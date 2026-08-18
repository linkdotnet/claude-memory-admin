// Parsers for the on-disk memory format.
//
// These are written against the real data in ~/.claude/projects rather than the
// idealised format, because three properties of the real files break the obvious
// implementations:
//
//   1. MEMORY.md is not a flat index. It mixes index bullets with `#` headings,
//      free-prose bullets, indented sub-bullets, and links embedded mid-sentence.
//   2. The hook separator is an em dash in most projects but " - " in projects
//      that have opted out of em dashes. A regex anchored on `—` silently drops
//      every entry in those projects.
//   3. Frontmatter has exactly one level of nesting (`metadata:`), so a flat
//      `key: value` reader loses `metadata.type` -- the field the UI keys on.

/** A top-level `- [Title](file.md) — hook` bullet. Indent is captured, not assumed. */
const INDEX_LINE = /^(\s*)-[ \t]+\[([^\]]*)\]\(([^)\s]+\.md)\)[ \t]*(.*)$/;

/** Any markdown link to a .md file, wherever it appears (including mid-sentence). */
const MD_LINK = /\[([^\]]*)\]\(([^)\s]+\.md)\)/g;

/** `[[name]]` or `[[name|alias]]`. */
const WIKILINK = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;

/** Leading hook separator: em dash, en dash, hyphen or colon. */
const HOOK_SEP = /^[ \t]*(?:—|–|-|:)[ \t]*/;

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Minimal YAML reader for frontmatter: scalars at the root plus one level of
 * nesting. Anything it does not understand is skipped rather than guessed at,
 * and the raw block is kept by the caller so nothing is ever rewritten from it.
 */
function readYaml(lines) {
  const data = {};
  const nestedKeys = new Set();
  let parent = null;

  for (const raw of lines) {
    const withoutComment = raw.trimStart().startsWith('#') ? '' : raw;
    if (!withoutComment.trim()) continue;

    const match = withoutComment.match(/^([ \t]*)([A-Za-z0-9_.\-]+):[ \t]*(.*)$/);
    if (!match) continue;

    const [, indent, key, rest] = match;
    const value = unquote(rest);

    if (indent.length === 0) {
      if (value === '') {
        // Might open a nested block, or might just be an empty scalar. Decided
        // after the loop, once we know whether anything nested under it.
        data[key] = {};
        parent = key;
      } else {
        data[key] = value;
        parent = null;
      }
    } else if (parent !== null) {
      if (typeof data[parent] !== 'object' || data[parent] === null) data[parent] = {};
      data[parent][key] = value;
      nestedKeys.add(parent);
    }
  }

  // An empty scalar that never got children is a string, not an object.
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && !nestedKeys.has(key)) data[key] = '';
  }
  return data;
}

/**
 * Split frontmatter from body. Scans for the closing `---` on its own line
 * rather than splitting on '---', which would break on any horizontal rule in
 * the body.
 */
export function parseFrontmatter(text) {
  const lines = text.split('\n');
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { data: {}, raw: '', body: text, hasFrontmatter: false };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) {
    return { data: {}, raw: '', body: text, hasFrontmatter: false };
  }

  const block = lines.slice(1, end);
  return {
    data: readYaml(block),
    raw: block.join('\n'),
    body: lines.slice(end + 1).join('\n').replace(/^\n+/, ''),
    hasFrontmatter: true,
  };
}

/** Every `[[wikilink]]` in a body, in order, de-duplicated. */
export function extractWikilinks(body) {
  const found = [];
  const seen = new Set();
  for (const match of body.matchAll(WIKILINK)) {
    const target = match[1].trim();
    if (!target || seen.has(target)) continue;
    seen.add(target);
    found.push({ target, alias: match[2]?.trim() || null });
  }
  return found;
}

/**
 * Parse MEMORY.md into a line-addressed model.
 *
 * Every line is preserved verbatim so the file can be rewritten byte-for-byte.
 * Lines are classified, never rewritten:
 *   - `index`     a top-level `- [Title](file.md)` bullet
 *   - `heading`   a `#`-prefixed line, used to group entries in the UI
 *   - `text`      everything else, including prose and nested bullets
 * `links` additionally records every .md link anywhere in the file, which is how
 * a file referenced only mid-sentence is told apart from a genuine orphan.
 */
export function parseIndex(text) {
  const lines = text.split('\n');
  const entries = [];
  const links = [];
  const parsedLines = [];
  let section = null;

  lines.forEach((line, i) => {
    const heading = line.match(/^(#{1,6})[ \t]+(.*)$/);
    if (heading) {
      section = heading[2].trim();
      parsedLines.push({ index: i, kind: 'heading', text: line, level: heading[1].length, section });
    } else {
      const indexMatch = line.match(INDEX_LINE);
      // Only an unindented bullet is an index entry. An indented one is a
      // sub-bullet of surrounding prose and must not be treated as a pointer.
      if (indexMatch && indexMatch[1] === '') {
        const [, , title, file, tail] = indexMatch;
        entries.push({
          index: i,
          title: title.trim(),
          file: file.trim(),
          hook: tail.replace(HOOK_SEP, '').trim(),
          section,
          text: line,
        });
        parsedLines.push({ index: i, kind: 'index', text: line, file: file.trim(), section });
      } else {
        parsedLines.push({ index: i, kind: 'text', text: line, section });
      }
    }

    for (const link of line.matchAll(MD_LINK)) {
      links.push({ index: i, label: link[1], file: link[2].trim(), text: line });
    }
  });

  const indexedFiles = new Set(entries.map((e) => e.file));
  return {
    lines,
    parsedLines,
    entries,
    links,
    // Links that are not index bullets, e.g. a mention inside a prose sentence.
    inlineLinks: links.filter((l) => !entries.some((e) => e.index === l.index)),
    indexedFiles,
    referencedFiles: new Set(links.map((l) => l.file)),
  };
}

/**
 * Remove index bullets pointing at `fileOrFiles`, plus the more-indented
 * continuation lines that belong to them. Every other byte is untouched.
 * Returns the new text and the removed lines with their ORIGINAL indices.
 *
 * Several files are handled in one pass on purpose: removing them one at a time
 * would shift the line numbers under each subsequent removal, and the recorded
 * indices would no longer describe the file we started from.
 */
export function removeIndexEntries(text, fileOrFiles) {
  const files = new Set([].concat(fileOrFiles));
  const parsed = parseIndex(text);
  const targets = parsed.entries.filter((e) => files.has(e.file));
  if (targets.length === 0) return { text, removed: [] };

  const drop = new Set();
  for (const entry of targets) {
    drop.add(entry.index);
    // Continuation lines: indented, non-blank, until the next unindented line.
    for (let i = entry.index + 1; i < parsed.lines.length; i++) {
      const line = parsed.lines[i];
      if (!line.trim()) break;
      if (!/^[ \t]/.test(line)) break;
      drop.add(i);
    }
  }

  const removed = [...drop].sort((a, b) => a - b).map((i) => ({ index: i, text: parsed.lines[i] }));
  const kept = parsed.lines.filter((_, i) => !drop.has(i));
  return { text: kept.join('\n'), removed };
}

/** Remove a single line by index, guarded by the text the caller expected to find. */
export function removeLine(text, index, expectedText) {
  const lines = text.split('\n');
  if (index < 0 || index >= lines.length) {
    throw new Error(`Line ${index} is out of range`);
  }
  if (typeof expectedText === 'string' && lines[index] !== expectedText) {
    throw new Error('MEMORY.md changed since this was loaded - reload and try again');
  }
  const removed = [{ index, text: lines[index] }];
  lines.splice(index, 1);
  return { text: lines.join('\n'), removed };
}

/** Re-insert previously removed lines at their original indices. */
export function insertLines(text, removed) {
  const lines = text.split('\n');
  for (const entry of [...removed].sort((a, b) => a.index - b.index)) {
    const at = Math.min(entry.index, lines.length);
    lines.splice(at, 0, entry.text);
  }
  return lines.join('\n');
}

/**
 * Turn `[[target]]` into plain text wherever it appears, leaving the sentence
 * around it intact. `[[target|alias]]` collapses to the alias.
 * Used to clear links whose target no longer exists.
 */
export function unwrapWikilink(text, target) {
  let count = 0;
  const pattern = new RegExp(WIKILINK.source, 'g');
  const out = text.replace(pattern, (match, name, alias) => {
    if (name.trim() !== target) return match;
    count += 1;
    return (alias || name).trim();
  });
  return { text: out, count };
}
