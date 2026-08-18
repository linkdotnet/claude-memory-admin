// Full-text search across every project's memory.
//
// The whole store is a few hundred kilobytes, so this scans it directly on each
// query rather than maintaining an index that could go stale.

import { buildStore } from './model.mjs';
import { listStores } from './stores.mjs';

const FIELD_WEIGHT = { name: 6, description: 3, hook: 2, body: 1 };

function fold(text) {
  return String(text || '').toLowerCase();
}

/** Character offsets of every occurrence of `term` in `haystack`. */
function positions(haystack, term) {
  const found = [];
  let at = haystack.indexOf(term);
  while (at !== -1 && found.length < 20) {
    found.push(at);
    at = haystack.indexOf(term, at + term.length);
  }
  return found;
}

/** A short excerpt around the first hit, with the match marked by offsets. */
function snippet(body, term, radius = 90) {
  const at = fold(body).indexOf(term);
  if (at === -1) return null;
  const start = Math.max(0, at - radius);
  const end = Math.min(body.length, at + term.length + radius);
  return {
    text: (start > 0 ? '…' : '') + body.slice(start, end).replace(/\s+/g, ' ').trim() + (end < body.length ? '…' : ''),
    term,
  };
}

/**
 * Search one project's already-built model. Every term must appear somewhere in
 * a memory for it to match, so extra words narrow rather than widen - which is
 * what people expect from a search box.
 */
export function searchProject(project, terms) {
  const results = [];

  for (const memory of project.memories) {
    const fields = {
      name: fold(memory.name),
      description: fold(memory.description),
      hook: fold(memory.entry?.hook || ''),
      body: fold(memory.body),
    };

    let score = 0;
    const matchedFields = new Set();
    const everyTermPresent = terms.every((term) => {
      let present = false;
      for (const [field, text] of Object.entries(fields)) {
        const hits = positions(text, term);
        if (hits.length) {
          present = true;
          matchedFields.add(field);
          score += FIELD_WEIGHT[field] * Math.min(hits.length, 3);
        }
      }
      return present;
    });
    if (!everyTermPresent) continue;

    // Prefer the most specific field for the excerpt.
    const first = terms[0];
    const excerpt = snippet(memory.body, first)
      || (memory.description ? { text: memory.description, term: first } : null);

    results.push({
      slug: project.slug,
      projectLabel: project.label,
      file: memory.file,
      name: memory.name,
      description: memory.description,
      type: memory.type,
      status: memory.status,
      score,
      fields: [...matchedFields],
      snippet: excerpt,
    });
  }

  // Index lines that mention the terms but whose file did not match, so a hit in
  // MEMORY.md prose is still findable.
  const indexHits = [];
  if (project.index) {
    for (const line of project.index.lines) {
      const text = fold(line.text);
      if (!line.text.trim()) continue;
      if (!terms.every((term) => text.includes(term))) continue;
      if (line.kind === 'index' && results.some((r) => r.file === line.file)) continue;
      indexHits.push({ slug: project.slug, projectLabel: project.label, index: line.index, text: line.text, kind: line.kind, file: line.file || null });
    }
  }

  return { results: results.sort((a, b) => b.score - a.score), indexHits };
}

/** Search every store: auto memory and subagent memory alike. */
export function searchAll(root, query, { limit = 200 } = {}) {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return { terms, total: 0, projects: [] };

  const stores = [];
  let total = 0;
  for (const listed of listStores(root)) {
    if (!listed.hasMemoryDir) continue;
    const store = buildStore(listed);
    const { results, indexHits } = searchProject(store, terms);
    if (!results.length && !indexHits.length) continue;
    total += results.length;
    stores.push({
      id: listed.id,
      kind: listed.kind,
      label: store.label,
      sublabel: listed.sublabel || null,
      results: results.slice(0, limit),
      indexHits: indexHits.slice(0, 20),
    });
  }

  return { terms, total, stores: stores.sort((a, b) => b.results.length - a.results.length) };
}
