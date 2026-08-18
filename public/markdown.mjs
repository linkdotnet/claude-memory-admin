import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import * as ui from '/ui.mjs';

marked.setOptions({ gfm: true, breaks: false });

const WIKILINK = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;
const PLACEHOLDER = /%%WIKI(\d+)%%/;
const PLACEHOLDER_EXACT = /^%%WIKI(\d+)%%$/;
const PLACEHOLDER_SPLIT = /(%%WIKI\d+%%)/;
const LOCAL_MARKDOWN = /^[^/#?][^:]*\.md$/i;

function extractWikilinks(text) {
  const tokens = [];
  const masked = text.replace(WIKILINK, (_, target, alias) => {
    const key = `%%WIKI${tokens.length}%%`;
    tokens.push({ target: target.trim(), alias: (alias || '').trim() });
    return key;
  });
  return { tokens, masked };
}

function linkButton(token, resolved) {
  const button = document.createElement('button');
  button.className = ui.wikilink(Boolean(resolved));
  button.textContent = token.alias || token.target;
  button.title = resolved ? `Go to ${token.target}` : `No memory named "${token.target}"`;
  if (resolved) button.onclick = resolved.open;
  return button;
}

function rehydrateWikilinks(container, tokens, resolveWikilink) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walker.nextNode()) texts.push(walker.currentNode);

  for (const textNode of texts) {
    if (!PLACEHOLDER.test(textNode.nodeValue)) continue;
    const fragment = document.createDocumentFragment();
    for (const part of textNode.nodeValue.split(PLACEHOLDER_SPLIT)) {
      const match = part.match(PLACEHOLDER_EXACT);
      if (!match) {
        if (part) fragment.append(document.createTextNode(part));
        continue;
      }
      const token = tokens[Number(match[1])];
      fragment.append(linkButton(token, resolveWikilink(token.target)));
    }
    textNode.replaceWith(fragment);
  }
}

function rewireAnchors(container, resolveHref) {
  for (const anchor of container.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href');
    if (!LOCAL_MARKDOWN.test(href)) {
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      continue;
    }
    const resolved = resolveHref(href);
    anchor.className = ui.indexLink(Boolean(resolved));
    anchor.removeAttribute('href');
    anchor.title = resolved ? `Go to ${href}` : `${href} does not exist`;
    if (resolved) anchor.onclick = resolved.open;
  }
}

export function renderMarkdown(container, text, { resolveWikilink, resolveHref } = {}) {
  const { tokens, masked } = extractWikilinks(text);
  container.innerHTML = DOMPurify.sanitize(marked.parse(masked));
  if (tokens.length && resolveWikilink) rehydrateWikilinks(container, tokens, resolveWikilink);
  if (resolveHref) rewireAnchors(container, resolveHref);
}
