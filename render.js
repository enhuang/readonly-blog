// marked v18 ships as ESM only (its package.json "exports" points to
// marked.esm.js), so a plain require('marked') throws ERR_REQUIRE_ESM.
// Load it with a dynamic import() at module init and keep the public API
// async to match.
let _marked = null;
let _markedReady = null;
// Cache of parsed markdown results: input string -> HTML output
// Each entry: { html: string, timestamp: number }
let _renderCache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 1 minute TTL

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

function clearRenderCache() {
  _renderCache.clear();
}

async function renderMarkdown(markdown) {
  if (markdown == null) return '';
  const s = String(markdown);
  if (s.trim() === '') return '';
  // Check cache first to avoid re-parsing the same markdown
  const cached = _renderCache.get(s);
  if (cached !== undefined) {
    // Verify cache is not stale (TTL check)
    const entry = _renderCache.get(s);
    if (entry && Date.now() - entry.timestamp < CACHE_TTL_MS) {
      cacheHits++;
      return entry.html;
    }
    // Cache stale, fall through to re-render
    _renderCache.delete(s);
    cacheMisses++;
  } else {
    cacheMisses++;
  }
  const marked = await getMarked();
  let html = marked.parse(s);
  html = sanitizeHtml(html);
  // strip any language class that marked adds to code fences (we do not do syntax highlighting)
  html = html.replace(/<code\s+class=[^>]*>/gi, '<code>');
  // Store in cache with timestamp
  if (html !== '') {
    _renderCache.set(s, { html, timestamp: Date.now() });
  }
  return html;
}

// Dependency-free HTML sanitizer for rendered markdown. marked passes raw
// HTML in the source through untouched, and posts here are assembled from
// external material, so active content must not survive rendering:
// - drop script/style/iframe/object/embed/form/link/meta/base elements
//   together with their contents;
// - strip inline event-handler attributes (onclick, onerror, ...);
// - strip javascript:/vbscript:/data:text/html URLs from link-bearing attrs.
// This is deliberately conservative, not a full DOMPurify replacement.
function sanitizeHtml(html) {
  if (html == null) return '';
  let out = String(html);
  out = out.replace(/<(script|style|iframe|object|embed|form|link|meta|base|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  out = out.replace(/<(script|style|iframe|object|embed|form|link|meta|base|title)\b[^>]*\/?>/gi, '');
  out = out.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(/\s+(href|src|xlink:href|action|formaction)\s*=\s*"\s*(?:javascript|vbscript|data)\s*:[^"]*"/gi, '');
  out = out.replace(/\s+(href|src|xlink:href|action|formaction)\s*=\s*'\s*(?:javascript|vbscript|data)\s*:[^']*'/gi, '');
  return out;
}

function extractExcerpt(html) {
  if (html == null) return '';
  const s = String(html).trim();
  if (s === '') return '';

  // take the first <p>...</p> after stripping any leading heading
  // Remove a leading h1-h6 heading line and its surrounding whitespace
  let body = s;
  // Strip a leading heading: <h1>...</h1>, <h2>...</h2>, etc.
  body = body.replace(/^<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>\s*/, '');
  // Now find the first <p>...</p>
  const m = body.match(/<p[\s>][\s\S]*?<\/p>/i);
  if (!m) {
    // no paragraph: return the whole thing stripped of tags, truncated
    return truncate(stripTagsSimple(body));
  }
  return truncate(stripTagsSimple(m[0]));
}

function stripTagsSimple(html) {
  return html
    .replace(/<br\s*\\?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&/gi, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .trim();
}

function truncate(text) {
  if (text.length <= 200) return text;
  const cut = text.slice(0, 200);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > 150) {
    return cut.slice(0, lastSpace) + '…';
  }
  return cut.replace(/\\S+$/, '') + '…';
}let cacheHits = 0;
let cacheMisses = 0;

function getCacheHitRate() {
  const total = cacheHits + cacheMisses;
  return total === 0 ? 0 : cacheHits / total;
}

function getCacheMissRate() {
  const total = cacheHits + cacheMisses;
  return total === 0 ? 0 : cacheMisses / total;
}

function clearPerfStats() {
  cacheHits = 0;
  cacheMisses = 0;
}

module.exports = { renderMarkdown, extractExcerpt, sanitizeHtml, clearRenderCache, getCacheHitRate, getCacheMissRate, clearPerfStats };
