// marked v18 ships as ESM only (its package.json "exports" points to
// marked.esm.js), so a plain require('marked') throws ERR_REQUIRE_ESM.
// Load it with a dynamic import() at module init and keep the public API
// async to match.
let _marked = null;
let _markedReady = null;

function getMarked() {
  if (_marked) return _marked;
  if (!_markedReady) {
    _markedReady = import('marked').then((m) => {
      _marked = m.marked;
      return _marked;
    });
  }
  return _markedReady.then(() => _marked);
}

async function renderMarkdown(markdown) {
  if (markdown == null) return '';
  const s = String(markdown);
  if (s.trim() === '') return '';
  const marked = await getMarked();
  let html = marked.parse(s);
  // strip any language class that marked adds to code fences (we do not do syntax highlighting)
  html = html.replace(/<code\s+class=["']language-[^"']*["']/gi, '<code>');
  return html;
}

function extractExcerpt(html) {
  if (html == null) return '';
  const s = String(html).trim();
  if (s === '') return '';

  // take the first <p>...</p> after stripping any leading heading
  const body = s.replace(/^<(h[1-6]|h[1-6][^>]*)>[\s\S]*?<\/\1>\s*/i, '');
  const m = body.match(/<p[\s>][\s\S]*?<\/p>/i);
  if (!m) {
    // no paragraph: return the whole thing stripped of tags, truncated
    return truncate(stripTags(s));
  }
  return truncate(stripTags(m[0]));
}

function stripTags(html) {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text) {
  if (text.length <= 200) return text;
  const cut = text.slice(0, 200);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > 150) {
    return cut.slice(0, lastSpace) + '…';
  }
  return cut.replace(/\S+$/, '') + '…';
}

module.exports = { renderMarkdown, extractExcerpt };

