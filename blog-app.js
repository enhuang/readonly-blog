const express = require('express');
const { config } = require('./blog-config');

function createApp(repo, renderMarkdown, cfg = {}) {
  const app = express();
  // Enable ETag support for HTTP caching (saves bandwidth for repeat visitors)
  app.enable('etag'); // adds Etag header to responses
  app.use(express.json({ limit: '1mb' }));
  let _renderMarkdown = renderMarkdown;

  const writeToken = (cfg && cfg.writeToken) || config.writeToken || process.env.BLOG_WRITE_TOKEN || '';

  function requireWriteToken(req, res, next) {
    const token = req.get('X-Blog-Token') || req.headers['x-blog-token'];
    if (!token || token !== writeToken) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  }

  app.get('/', async (req, res, next) => {
    try {
      const posts = await repo.listPosts({ page: 1, perPage: 50, tableName: config.tableName });
      const body = await renderFeedPage(posts);
      res.type('html').send(body);
    } catch (err) {
      next(err);
    }
  });

  app.get('/post/:slug', async (req, res, next) => {
    try {
      const post = await repo.getPost(req.params.slug, { tableName: config.tableName });
      if (!post) {
        return res.status(404).type('html').send(renderNotFoundPage());
      }
      const html = await renderMarkdown(post.markdown);
      const body = renderPostPage(post, html);
      res.type('html').send(body);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/posts', async (req, res, next) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const perPage = Math.min(50, Math.max(1, parseInt(req.query.perPage, 10) || 10));
      const posts = await repo.listPosts({ page, perPage });
      res.json(posts);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/posts/:slug', async (req, res, next) => {
    try {
      const post = await repo.getPost(req.params.slug, { tableName: config.tableName });
      if (!post) {
        return res.status(404).json({ error: 'not found' });
      }
      const html = await renderMarkdown(post.markdown);
      res.json({
        feedKey: post.feedKey,
        chronKey: post.chronKey,
        slug: post.slug,
        title: post.title,
        status: post.status,
        publishedAt: post.publishedAt,
        markdown: post.markdown,
        html,
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/posts', requireWriteToken, express.json({ limit: '1mb' }), async (req, res, next) => {
    try {
      const { markdown, title, slug, status } = req.body || {};
      if (!markdown && markdown !== '') {
        return res.status(400).json({ error: 'markdown is required' });
      }
      if (!title && title !== '') {
        return res.status(400).json({ error: 'title is required' });
      }
      const post = await repo.createPost({
        markdown: String(markdown),
        title: String(title),
        slug: slug || undefined,
        status: status || undefined,
        tableName: config.tableName,
      });
      res.status(201).json(post);
    } catch (err) {
      if (err.message && err.message.includes('slug already exists')) {
        return res.status(409).json({ error: 'slug already exists' });
      }
      next(err);
    }
  });

  app.delete('/api/posts/:slug', requireWriteToken, async (req, res, next) => {
    try {
      await repo.deletePost(req.params.slug, { tableName: config.tableName });
      res.status(204).send('');
    } catch (err) {
      next(err);
    }
  });

  app.use((err, req, res, next) => {
    console.error('server error:', err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

async function renderFeedPage(posts) {
  const renderMarkdown = _renderMarkdown;
  const items = (await Promise.all(posts.map(async (p) => {
    const raw = await renderMarkdown(p.markdown);
    const excerpt = raw
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const short = excerpt.length > 200 ? excerpt.slice(0, 200).replace(/\s+\S*$/, '') + '…' : excerpt;
    return `<li>
      <h2><a href="/post/${escapeHtml(p.slug)}">${escapeHtml(p.title)}</a></h2>
      <time datetime="${escapeHtml(p.publishedAt)}">${formatDate(p.publishedAt)}</time>
      <p>${escapeHtml(short)}</p>
    </li>`;
  }))).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Blog</title>
  <style>
    :root { --max: 48rem; --pad: 1.5rem; --gap: 1.5rem; }
    html, body { margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #111; background: #fafafa; line-height: 1.6; }
    .wrap { max-width: var(--max); margin: 0 auto; padding: var(--pad); }
    header { border-bottom: 1px solid #e5e5e5; margin-bottom: var(--gap); padding-bottom: var(--gap); }
    h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
    header time { color: #666; font-size: .875rem; }
    nav { margin-top: 1rem; font-size: .875rem; }
    nav a { color: #0066cc; text-decoration: none; }
    nav a:hover { text-decoration: underline; }
    article { background: #fff; border: 1px solid #e5e5e5; border-radius: 6px; padding: var(--gap); margin-bottom: var(--gap); }
    article h2 { margin: 0 0 .25rem; font-size: 1.25rem; }
    article h2 a { color: inherit; text-decoration: none; }
    article h2 a:hover { color: #0066cc; }
    article time { color: #666; font-size: .875rem; display: block; margin-bottom: .5rem; }
    article p { margin: 0; color: #444; }
    footer { border-top: 1px solid #e5e5e5; margin-top: var(--gap); padding-top: var(--gap); color: #666; font-size: .875rem; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>Blog</h1>
      <time></time>
      <nav><a href="/api/posts">JSON feed</a></nav>
    </nav>
    <main>
      ${items || '<p>No posts yet.</p>'}
    </main>
    <footer>A personal blog.</footer>
  </div>
</body>
</html>`;
}

function renderPostPage(post, html) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(post.title)} — Blog</title>
  <style>
    :root { --max: 48rem; --pad: 1.5rem; --gap: 1.5rem; }
    html, body { margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #111; background: #fafafa; line-height: 1.6; }
    .wrap { max-width: var(--max); margin: 0 auto; padding: var(--pad); }
    header { border-bottom: 1px solid #e5e5e5; margin-bottom: var(--gap); padding-bottom: var(--gap); }
    a.back { color: #0066cc; text-decoration: none; font-size: .875rem; }
    a.back:hover { text-decoration: underline; }
    article { background: #fff; border: 1px solid #e5e5e5; border-radius: 6px; padding: var(--gap); }
    article h1 { margin: 0 0 .25rem; font-size: 1.75rem; }
    article time { color: #666; font-size: .875rem; display: block; margin-bottom: 1rem; }
    article .body { color: #222; }
    article .body p { margin: 0 0 1rem; }
    article .body p:last-child { margin-bottom: 0; }
    article .body pre { background: #f5f5f5; border: 1px solid #e5e5e5; border-radius: 4px; padding: .75rem 1rem; overflow-x: auto; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: .875rem; }
    article .body code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: .875rem; background: #f0f0f0; padding: .125rem .25rem; border-radius: 3px; }
    article .body pre code { background: none; padding: 0; }
    article .body a { color: #0066cc; }
    article .body img { max-width: 100%; }
    footer { border-top: 1px solid #e5e5e5; margin-top: var(--gap); padding-top: var(--gap); color: #666; font-size: .875rem; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <a class="back" href="/">← Blog</a>
      <h1>${escapeHtml(post.title)}</h1>
      <time datetime="${escapeHtml(post.publishedAt)}">${formatDate(post.publishedAt)}</time>
    </header>
    <main>
      <article>
        <div class="body">${html}</div>
      </article>
    </main>
    <footer>A personal blog.</footer>
  </div>
</body>
</html>`;
}

function renderNotFoundPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Not found — Blog</title>
  <style>
    :root { --max: 48rem; --pad: 1.5rem; }
    html, body { margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #111; background: #fafafa; }
    .wrap { max-width: var(--max); margin: 0 auto; padding: var(--pad); }
    h1 { font-size: 1.25rem; margin-bottom: .5rem; }
    a { color: #0066cc; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Post not found</h1>
    <a href="/">Back to blog</a>
  </div>
</body>
</html>`;
}

module.exports = { createApp };
