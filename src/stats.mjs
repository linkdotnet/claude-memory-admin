// Size accounting and overlap detection for a project's memory.
//
// The point of all of this is MEMORY.md: it is read into context at the start of
// every session, so its size is a recurring cost in a way the individual memory
// files (read only when followed) are not. Everything here exists to make that
// cost visible and to point at what to prune.

/**
 * Rough token estimate. Deliberately a heuristic - roughly four characters per
 * token for English prose - because the real tokeniser is not available here.
 * Shown as context only; the limits that actually bite are lines and bytes.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.round(text.length / 4);
}

// The limits Claude Code actually enforces on MEMORY.md: the first 200 lines or
// 25KB, whichever comes first, are loaded at the start of a session. Anything
// past that is silently dropped on the next load, which is the failure mode this
// meter exists to prevent.
export const INDEX_LINE_LIMIT = 200;
export const INDEX_BYTE_LIMIT = 25 * 1024;

/** Hooks longer than this dominate the index; they are the usual bloat. */
export const LONG_HOOK_CHARS = 200;

/**
 * The text that actually counts against the limits, plus a map from each line of
 * it back to the line it came from in the raw file.
 *
 * Claude Code strips YAML frontmatter and block-level HTML comments before
 * loading the index, so measuring the raw file would overstate the size. That
 * stripping is also why a position in the loaded text is not a line number in
 * the file: to draw the cutoff where the user can see it, the removed spans have
 * to be tracked rather than just discarded.
 */
export function loadedIndex(indexText) {
  if (!indexText) return { text: '', rawLineFor: [] };

  const removed = [];
  const frontmatter = indexText.match(/^---\n[\s\S]*?\n---\n?/);
  const base = frontmatter ? frontmatter[0].length : 0;
  if (frontmatter) removed.push([0, base]);

  // Matched on the post-frontmatter text, exactly as the stripping itself is, so
  // the `m` anchors land on the same line starts.
  for (const match of indexText.slice(base).matchAll(/^[ \t]*<!--[\s\S]*?-->[ \t]*\n?/gm)) {
    removed.push([base + match.index, base + match.index + match[0].length]);
  }

  removed.sort((a, b) => a[0] - b[0]);
  const kept = [];
  let cursor = 0;
  for (const [start, end] of removed) {
    if (start > cursor) kept.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < indexText.length) kept.push([cursor, indexText.length]);

  const rawLineStarts = [0];
  for (let i = 0; i < indexText.length; i++) {
    if (indexText[i] === '\n') rawLineStarts.push(i + 1);
  }
  const rawLineAt = (offset) => {
    let low = 0;
    let high = rawLineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (rawLineStarts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  };

  // One raw offset per surviving character, which is what makes the line map a
  // lookup rather than a second parse that could disagree with the first.
  const offsets = [];
  for (const [start, end] of kept) {
    for (let i = start; i < end; i++) offsets.push(i);
  }

  const rawLineFor = [];
  if (offsets.length) rawLineFor.push(rawLineAt(offsets[0]));
  for (let i = 0; i < offsets.length - 1; i++) {
    if (indexText[offsets[i]] === '\n') rawLineFor.push(rawLineAt(offsets[i + 1]));
  }

  return { text: kept.map(([start, end]) => indexText.slice(start, end)).join(''), rawLineFor };
}

/** The loaded text alone, for callers that do not need the line map. */
export function loadedIndexText(indexText) {
  return loadedIndex(indexText).text;
}

/**
 * Where the index stops being loaded, and which entries fall past it.
 *
 * The percentage on the meter says an index is too big; this says which memories
 * Claude can no longer see, which is the thing you can act on. Both are derived
 * from the same loaded text, so they cannot disagree.
 */
function findCutoff(loaded, entries) {
  const lines = loaded.text.split('\n');
  let bytes = 0;
  let byteCut = Infinity;
  for (let i = 0; i < lines.length; i++) {
    // Every line but the last carries its newline.
    bytes += Buffer.byteLength(lines[i], 'utf8') + (i < lines.length - 1 ? 1 : 0);
    if (bytes > INDEX_BYTE_LIMIT) { byteCut = i; break; }
  }
  const lineCut = loaded.rawLineFor.length > INDEX_LINE_LIMIT ? INDEX_LINE_LIMIT : Infinity;

  const loadedLine = Math.min(lineCut, byteCut);
  if (!Number.isFinite(loadedLine)) return null;

  const rawLine = loaded.rawLineFor[loadedLine];
  if (rawLine === undefined) return null;

  return {
    loadedLine,
    rawLine,
    by: lineCut <= byteCut ? 'lines' : 'bytes',
    droppedLines: loaded.rawLineFor.length - loadedLine,
    droppedEntries: entries
      .filter((entry) => entry.index >= rawLine)
      .map((entry) => ({ index: entry.index, file: entry.file, title: entry.title })),
  };
}

export function indexStats(indexText, entries) {
  if (indexText === null || indexText === undefined) {
    return {
      bytes: 0, lines: 0, tokens: 0, entryCount: 0, longHooks: [], longestHook: 0,
      lineLimit: INDEX_LINE_LIMIT, byteLimit: INDEX_BYTE_LIMIT,
      linePercent: 0, bytePercent: 0, worstPercent: 0, level: 'ok', overLimit: false, nearLimit: false,
      cutoff: null,
    };
  }

  const loaded = loadedIndex(indexText);
  const lines = loaded.rawLineFor.length;
  const bytes = Buffer.byteLength(loaded.text, 'utf8');

  const longHooks = entries
    .filter((entry) => entry.hook.length > LONG_HOOK_CHARS)
    .map((entry) => ({ index: entry.index, file: entry.file, title: entry.title, hookLength: entry.hook.length }))
    .sort((a, b) => b.hookLength - a.hookLength);

  const linePercent = (lines / INDEX_LINE_LIMIT) * 100;
  const bytePercent = (bytes / INDEX_BYTE_LIMIT) * 100;
  const worstPercent = Math.max(linePercent, bytePercent);

  return {
    bytes,
    lines,
    rawBytes: Buffer.byteLength(indexText, 'utf8'),
    tokens: estimateTokens(loaded.text),
    entryCount: entries.length,
    longHooks,
    longestHook: entries.reduce((max, e) => Math.max(max, e.hook.length), 0),
    lineLimit: INDEX_LINE_LIMIT,
    byteLimit: INDEX_BYTE_LIMIT,
    linePercent,
    bytePercent,
    worstPercent,
    limitedBy: linePercent >= bytePercent ? 'lines' : 'bytes',
    overLimit: lines > INDEX_LINE_LIMIT || bytes > INDEX_BYTE_LIMIT,
    nearLimit: worstPercent >= 75,
    level: worstPercent > 100 ? 'over' : worstPercent >= 75 ? 'near' : 'ok',
    cutoff: findCutoff(loaded, entries),
  };
}

function words(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    // Two-character tokens are kept on purpose: "v4", "nx", "ci" and friends
    // are among the most discriminating words in these names.
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'not', 'but', 'with', 'this', 'that', 'from', 'into', 'via', 'are', 'was',
  'has', 'have', 'its', 'you', 'use', 'used', 'uses', 'must', 'need', 'needs', 'when', 'only',
  'per', 'all', 'any', 'own', 'one', 'two', 'new', 'old', 'now', 'why', 'how', 'never', 'always',
]);

/**
 * Cosine similarity over word vectors weighted by how rare each word is inside
 * this project.
 *
 * Plain character trigrams were tried first and were wrong here: memory names
 * share long prefixes by convention (argus-mobile-*, admincenter-*), so unrelated
 * notes scored as high as genuinely overlapping ones. Weighting by rarity fixes
 * that - a word every second memory contains says nothing about overlap, while
 * a word shared by only two is a strong signal.
 */
function buildIdf(documents) {
  const frequency = new Map();
  for (const document of documents) {
    for (const word of new Set(document)) {
      frequency.set(word, (frequency.get(word) || 0) + 1);
    }
  }
  const total = Math.max(documents.length, 1);
  const idf = new Map();
  for (const [word, count] of frequency) {
    idf.set(word, Math.log((total + 1) / (count + 0.5)));
  }
  return idf;
}

function vector(tokens, idf) {
  const counts = new Map();
  for (const word of tokens) counts.set(word, (counts.get(word) || 0) + 1);
  const out = new Map();
  let norm = 0;
  for (const [word, count] of counts) {
    const weight = (idf.get(word) ?? 1) * (1 + Math.log(count));
    out.set(word, weight);
    norm += weight * weight;
  }
  return { out, norm: Math.sqrt(norm) || 1 };
}

function cosine(left, right) {
  let dot = 0;
  const [small, large] = left.out.size <= right.out.size ? [left, right] : [right, left];
  for (const [word, weight] of small.out) {
    const other = large.out.get(word);
    if (other) dot += weight * other;
  }
  return dot / (left.norm * right.norm);
}

/** Similarity of two short texts against a corpus, 0 to 1. */
export function similarity(a, b, corpus = [a, b]) {
  const idf = buildIdf(corpus.map(words));
  return cosine(vector(words(a), idf), vector(words(b), idf));
}

// There is no score that cleanly separates "duplicate" from "unrelated" here,
// and pretending otherwise would just produce confident nonsense. The UI shows a
// ranked shortlist above a modest floor and calls it possible overlap.
export const DUPLICATE_THRESHOLD = 0.18;
export const DUPLICATE_LIMIT = 12;

/**
 * Pairs of memories whose name and description overlap enough to be worth a
 * look. Compares the identifying text only, not the bodies: two notes about the
 * same subject are the thing to catch, and full bodies drown that signal in
 * shared vocabulary.
 */
export function findDuplicates(memories, threshold = DUPLICATE_THRESHOLD) {
  const keyed = memories.map((memory) => ({
    file: memory.file,
    name: memory.name,
    description: memory.description,
    tokens: words(`${memory.name} ${memory.description}`),
  }));
  if (keyed.length < 2) return [];

  const idf = buildIdf(keyed.map((k) => k.tokens));
  const vectors = keyed.map((k) => vector(k.tokens, idf));

  const pairs = [];
  for (let i = 0; i < keyed.length; i++) {
    for (let j = i + 1; j < keyed.length; j++) {
      const score = cosine(vectors[i], vectors[j]);
      if (score >= threshold) {
        const shared = [...vectors[i].out.keys()]
          .filter((word) => vectors[j].out.has(word))
          .sort((a, b) => (idf.get(b) ?? 0) - (idf.get(a) ?? 0))
          .slice(0, 5);
        pairs.push({
          a: { file: keyed[i].file, name: keyed[i].name, description: keyed[i].description },
          b: { file: keyed[j].file, name: keyed[j].name, description: keyed[j].description },
          score: Math.round(score * 100),
          shared,
        });
      }
    }
  }
  return pairs.sort((x, y) => y.score - x.score).slice(0, DUPLICATE_LIMIT);
}

/** Age in whole days, or null when nothing recorded a date. */
export function ageInDays(iso, now = Date.now()) {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((now - then) / 86400000));
}
