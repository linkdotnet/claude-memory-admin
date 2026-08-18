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
 * The text that actually counts against the limits. Claude Code strips YAML
 * frontmatter and block-level HTML comments before loading the index, so
 * measuring the raw file would overstate the size.
 */
export function loadedIndexText(indexText) {
  if (!indexText) return '';
  let text = indexText;
  const frontmatter = text.match(/^---\n[\s\S]*?\n---\n?/);
  if (frontmatter) text = text.slice(frontmatter[0].length);
  return text.replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*\n?/gm, '');
}

export function indexStats(indexText, entries) {
  if (indexText === null || indexText === undefined) {
    return {
      bytes: 0, lines: 0, tokens: 0, entryCount: 0, longHooks: [], longestHook: 0,
      lineLimit: INDEX_LINE_LIMIT, byteLimit: INDEX_BYTE_LIMIT,
      linePercent: 0, bytePercent: 0, worstPercent: 0, level: 'ok', overLimit: false, nearLimit: false,
    };
  }

  const loaded = loadedIndexText(indexText);
  const lines = loaded.split('\n').filter((line, i, all) => i < all.length - 1 || line.length > 0).length;
  const bytes = Buffer.byteLength(loaded, 'utf8');

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
    tokens: estimateTokens(loaded),
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
