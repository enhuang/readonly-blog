// describe/it/expect/beforeEach/afterEach are injected by the test harness as globals.
const { createApp } = require('./blog-app');
const { createPostRepo } = require('./post-repo');

// minimal mock req/res for testing express apps without HTTP
function mockReq(method, url, body, headers = {}) {
  const parsed = url.includes('?') ? url.split('?') : [url, ''];
  const path = parsed[0];
  const queryStr = parsed[1] || '';
  const query = Object.fromEntries(new URLSearchParams(queryStr));
  return {
    method,
    url: path,
    path,
    query,
    headers: Object.assign({
      'content-type': 'application/json',
      'x-blog-token': undefined,
    }, headers),
    body: body != null ? body : {},
    params: {},
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    _body: undefined,
    _sent: false,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(data) {
      res._body = data;
      res._sent = true;
      return res;
    },
    send(data) {
      res._body = data;
      res._sent = true;
      return res;
    },
    type(value) {
      res.headers['content-type'] = value;
      return res;
    },
    set(key, value) {
      res.headers[key.toLowerCase()] = value;
      return res;
    },
    get(key) {
      return res.headers[key.toLowerCase()];
    },
    redirect(code, url) {
      res.statusCode = code;
      res.headers['location'] = url;
      res._sent = true;
      res._body = '' + url;
      return res;
    },
    on() {},
  };
  return res;
}

// fake DynamoDBClient that passes `instanceof` checks against the real
// @aws-sdk/client-dynamodb command classes.
function fakeClient(sendImpl) {
  const lc = require('@aws-sdk/client-dynamodb');
  // Create a real client instance so its prototype chain is intact.
  const base = new lc.DynamoDBClient({ region: 'us-east-1', endpoint: 'http://localhost:8000' });
  base.send = function (cmd) {
    return sendImpl.call(this, cmd);
  };
  return base;
}

function postItem(overrides = {}) {
  return {
    feedKey: 'POST',
    chronKey: '2025-01-15T10:00:00.000Z#hello-world',
    slug: 'hello-world',
    title: 'Hello World',
    status: 'published',
    publishedAt: '2025-01-15T10:00:00.000Z',
    markdown: '# Hello World\n\nSome content.',
    ...overrides,
  };
}

function render(html) {
  return function renderMarkdown(markdown) {
    if (markdown == null) return '';
    const s = String(markdown);
    if (s.trim() === '') return '';
    return html;
  };
}

describe('blog-app', () => {
  let app, repo, client, renderer;

  beforeEach(() => {
    client = fakeClient((cmd) => {
      const name = cmd.constructor.name;
      if (name === 'QueryCommand' && cmd.input.IndexName === 'slugIndex') {
        return { Items: [], $metadata: {} };
      }
      if (name === 'QueryCommand') {
        return { Items: [], $metadata: {} };
      }
      if (name === 'PutCommand') return { $metadata: {} };
      if (name === 'DeleteCommand') return { $metadata: {} };
      if (name === 'GetCommand') return { Item: undefined, $metadata: {} };
      return { $metadata: {} };
    });
    repo = createPostRepo({ tableName: 'blog-posts', client });
    renderer = render('<p>canned body</p>');
    app = createApp(repo, renderer, {
      port: 3000,
      writeToken: 's3cret',
      blogHost: '',
    });
  });

  describe('GET /', () => {
    it('renders the feed page with excerpts for published posts', async () => {
      client.send = (cmd) => ({
        Items: [
          postItem({
            slug: 'first',
            title: 'First Post',
            publishedAt: '2025-01-15T10:00:00.000Z',
            markdown: '# First\n\nFirst paragraph.',
            chronKey: '2025-01-15T10:00:00.000Z#first',
          }),
          postItem({
            slug: 'second',
            title: 'Second Post',
            publishedAt: '2025-01-14T10:00:00.000Z',
            markdown: '# Second\n\nSecond paragraph here.',
            chronKey: '2025-01-14T10:00:00.000Z#second',
          }),
        ],
        $metadata: {},
      });

      const req = mockReq('GET', '/');
      const res = mockRes();
      await new Promise((resolve) => app(req, res, resolve));
      await Promise.resolve();

      expect(res.statusCode).toBe(200);
      expect(res._body).toContain('First Post');
      expect(res._body).toContain('Second Post');
      expect(res._body).toContain('/post/first');
      expect(res._body).toContain('/post/second');
    });

    it('renders an empty state when there are no posts', async () => {
      client.send = () => ({ Items: [], $metadata: {} });
      const req = mockReq('GET', '/');
      const res = mockRes();
      await new Promise((resolve) => app(req, res, resolve));
      await Promise.resolve();
      expect(res.statusCode).toBe(200);
      expect(res._body).toContain('blog');
    });
  });

  describe('GET /post/:slug (HTML permalink)', () => {
    it('renders the full post page for an existing post', async () => {
      client.send = (cmd) => ({
        Items: [postItem({ slug: 'hello' })],
        $metadata: {},
      });
      const req = mockReq('GET', '/post/hello');
      req.params = { slug: 'hello' };
      const res = mockRes();
      await new Promise((resolve) => app(req, res, resolve));
      await Promise.resolve();
      expect(res.statusCode).toBe(200);
      expect(res._body).toContain('Hello World');
      expect(res._body).toContain('<p>canned body</p>');
    });

    it('returns 404 for a missing post', async () => {
      client.send = () => ({ Items: [], $metadata: {} });
      const req = mockReq('GET', '/post/missing');
      req.params = { slug: 'missing' };
      const res = mockRes();
      await new Promise((resolve) => app(req, res, resolve));
      await Promise.resolve();
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/posts (JSON feed)', () => {
    it('returns a JSON array of feed items', async () => {
      client.send = () => ({
        Items: [
          postItem({
            slug: 'a',
            title: 'A',
            publishedAt: '2025-01-15T10:00:00.000Z',
            markdown: '# A\n\nFirst para.',
            chronKey: '2025-01-15T10:00:00.000Z#a',
          }),
        ],
        $metadata: {},
      });
      const req = mockReq('GET', '/api/posts?page=1&perPage=10');
      req.query = { page: '1', perPage: '10' };
      const res = mockRes();
      await new Promise((resolve) => app(req, res, resolve));
      await Promise.resolve();
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res._body)).toBe(true);
      expect(res._body).toHaveLength(1);
      expect(res._body[0]).toMatchObject({
        slug: 'a',
        title: 'A',
        publishedAt: '2025-01-15T10:00:00.000Z',
      });
      expect(res._body[0]).toHaveProperty('excerpt');
      expect(res._body[0]).toHaveProperty('url');
      expect(res._body[0].url).toBe('/post/a');
    });

    it('handles pagination params', async () => {
      client.send = (cmd) => {
        expect(cmd.input.Limit).toBe(2);
        expect(cmd.input.ExclusiveStartKey).toEqual({
          feedKey: 'POST',
          chronKey: '2025-01-10T00:00:00.000Z#x',
        });
        return { Items: [], $metadata: {} };
      };
      const req = mockReq('GET', '/api/posts?page=2&perPage=2');
      req.query = { page: '2', perPage: '2' };
      const res = mockRes();
      await new Promise((resolve) => app(req, res, resolve));
      await Promise.resolve();
      expect(res.statusCode).toBe(200);
      expect(res._body).toEqual([]);
    });

    it('returns published posts only', async () => {
      client.send = () => ({
        Items: [
          postItem({ slug: 'pub', status: 'published', title: 'Pub', publishedAt: '2025-01-15T10:00:00.000Z', markdown: 'p', chronKey: '2025-01-15T10:00:00.000Z#pub' }),
          postItem({ slug: 'draft', status: 'draft', title: 'Draft', publishedAt: '2025-01-14T10:00:00.000Z', markdown: 'd', chronKey: '2025-01-14T10:00:00.000Z#draft' }),
        ],
        $metadata: {},
      });
      const req = mockReq('GET', '/api/posts');
      const res = mockRes();
      await new Promise((resolve) => app(req, res, resolve));
      await Promise.resolve();
      expect(res._body).toHaveLength(1);
      expect(res._body[0].slug).toBe('pub');
    });

    it('caps perPage at 50', async () => {
      client.send = (cmd) => {
        expect(cmd.input.Limit).toBe(50);
        return { Items: [], $metadata: {} };
      };
      const req = mockReq('GET', '/api/posts?perPage=200');
      req.query = { perPage: '200' };
      const res = mockRes();
      await new Promise((resolve) => app(req, res, resolve));
      await Promise.resolve();
      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /api/posts/:slug (JSON permalink)', () => {
    it('returns the full post as JSON', async () => {
      client.send = () => ({ Items: [postItem({ slug: 'x', markdown: '# X' })], $metadata: {} });
      const req = mockReq('GET', '/api/posts/x');
      req.params = { slug: 'x' };
      const res = mockRes();
      await new Promise((resolve) => app(req, res, resolve));
      await Promise.resolve();
      expect(res.statusCode).toBe(200);
      expect(res._body).toMatchObject({ slug: 'x', html: expect.anything() });
      expect(res._body.html).toContain('<p>canned body</p>');
    });

    it('returns 404 for a missing slug', async () => {
      client.send = () => ({ Items: [], $metadata: {} });
      const req = mockReq('GET', '/api/posts/missing');
      req.params = { slug: 'missing' };
      const res = mockRes();
      await new Promise((resolve) => app(req, res, resolve));
      await Promise.resolve();
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/posts (create)', () => {
    it('creates a post when the write token is valid', async () => {
      let putItemCmd = null;
      client.send = (cmd) => {
        if (cmd.constructor.name === 'PutCommand') {
          putItemCmd = cmd;
          return { $metadata: {} };
        }
        if (cmd.constructor.name === 'QueryCommand') {
          return { Items: [], $metadata: {} };
        }
        if (cmd.constructor.name === 'DeleteCommand') return { $metadata: {} };
        if (cmd.constructor.name === 'GetCommand') return { Item: undefined, $metadata: {} };
        return { $metadata: {} };
      };
      const req = mockReq('POST', '/api/posts', {
        markdown: '# New',
        title: 'New Post',
        status: 'published',
      });
      req.headers['x-blog-token'] = 's3cret';
      const res = mockRes();
      await new Promise((resolve) => app(req, res, resolve));
      await Promise.resolve();
      expect(res.statusCode).toBe(201);
      expect(res._body).toHaveProperty('slug');
      expect(res._body.title).toBe('New Post');
      expect(res._body.status).toBe('published');
      expect(res._body.markdown).toBe('# New');
    });

    it('returns 401 when the write token is missing', async () => {
      const req = mockReq('POST', '/api/posts', { markdown: '# x', title: 'X' });
      req.headers['x-blog-token'] = 'wrong';
      const res = mockRes();
      await new Promise((resolve) => app(req, res, resolve));
      await Promise.resolve();
      expect(res.statusCode).toBe(401);
    });

    it('returns 400 when markdown is missing', async () => {
      const req = mockReq('POST', '/api/posts', { title: 'X' });
      req.headers['x-blog-token'] = 's3cret';
      const res = mockRes();
      await new Promise((resolve) => app(req, res, resolve));
      await Promise.resolve();
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when title is missing', async () => {
      const req = mockReq('POST', '/api/posts', { markdown: '# x' });
      req.headers['x-blog-token'] = 's3cret';
      const res = mockRes();
      await new Promise((resolve) => app(req, res, resolve));
      await Promise.resolve();
      expect(res.statusCode).toBe(400);
    });

    it('returns 409 when the supplied slug already exists', async () => {
      client.send = (cmd) => {
        if (cmd.constructor.name === 'QueryCommand') {
          return { Items: [postItem({ slug: 'taken' })], $metadata: {} };
        }
        if (cmd.constructor.name === 'PutCommand') return { $metadata: {} };
        if (cmd.constructor.name === 'DeleteCommand') return { $metadata: {} };
        if (cmd.constructor.name === 'GetCommand') return { Item: undefined, $metadata: {} };
        return { $metadata: {} };
      };
      const req = mockReq('POST', '/api/posts', {
        markdown: '# x',
        title: 'X',
        slug: 'taken',
      });
      req.headers['x-blog-token'] = 's3cret';
      const res = mockRes();
      await new Promise((resolve) => app(req, res, resolve));
      await Promise.resolve();
      expect(res.statusCode).toBe(409);
    });
  });

  describe('DELETE /api/posts/:slug (delete)', () => {
    it('deletes a post when the token is valid', async () => {
      let deletedKey = null;
      client.send = (cmd) => {
        if (cmd.constructor.name === 'QueryCommand') {
          if (cmd.input.IndexName === 'slugIndex') {
            return { Items: [postItem({ slug: 'to-delete', feedKey: 'POST', chronKey: '2025-01-01T00:00:00.000Z#to-delete' })], $metadata: {} };
          }
          return { Items: [], $metadata: {} };
        }
        if (cmd.constructor.name === 'DeleteCommand') {
          deletedKey = cmd.input.Key;
          return { $metadata: {} };
        }
        if (cmd.constructor.name === 'PutCommand') return { $metadata: {} };
        if (cmd.constructor.name === 'GetCommand') return { Item: undefined, $metadata: {} };
        return { $metadata: {} };
      };
      const req = mockReq('DELETE', '/api/posts/to-delete');
      req.params = { slug: 'to-delete' };
      req.headers['x-blog-token'] = 's3cret';
      const res = mockRes();
      await new Promise((resolve) => app(req, res, resolve));
      await Promise.resolve();
      expect(res.statusCode).toBe(204);
      expect(deletedKey).toEqual({
        feedKey: 'POST',
        chronKey: '2025-01-01T00:00:00.000Z#to-delete',
      });
    });

    it('returns 204 even when the slug does not exist (idempotent)', async () => {
      client.send = () => ({ Items: [], $metadata: {} });
      const req = mockReq('DELETE', '/api/posts/missing');
      req.params = { slug: 'missing' };
      req.headers['x-blog-token'] = 's3cret';
      const res = mockRes();
      await new Promise((resolve) => app(req, res, resolve));
      await Promise.resolve();
      expect(res.statusCode).toBe(204);
    });

    it('returns 401 when the token is wrong', async () => {
      const req = mockReq('DELETE', '/api/posts/x');
      req.params = { slug: 'x' };
      req.headers['x-blog-token'] = 'wrong';
      const res = mockRes();
      await new Promise((resolve) => app(req, res, resolve));
      await Promise.resolve();
      expect(res.statusCode).toBe(401);
    });

    it('is idempotent for an unknown slug', async () => {
      client.send = () => ({ Items: [], $metadata: {} });
      client.send = () => ({ Items: [], $metadata: {} });
      const req = mockReq('DELETE', '/api/posts/nope');
      req.params = { slug: 'nope' };
      req.headers['x-blog-token'] = 's3cret';
      const res = mockRes();
      await new Promise((resolve) => app(req, res, resolve));
      await Promise.resolve();
      expect(res.statusCode).toBe(204);
    });
  });

  describe('auth on read endpoints', () => {
    it('does not require a token to read the feed', async () => {
      client.send = () => ({ Items: [], $metadata: {} });
      const req = mockReq('GET', '/api/posts');
      req.headers['x-blog-token'] = 'wrong';
      const res = mockRes();
      await new Promise((resolve) => app(req, res, resolve));
      await Promise.resolve();
      expect(res.statusCode).toBe(200);
    });

    it('does not require a token to read a post', async () => {
      client.send = () => ({ Items: [postItem({ slug: 'x' })], $metadata: {} });
      const req = mockReq('GET', '/api/posts/x');
      req.params = { slug: 'x' };
      req.headers['x-blog-token'] = 'wrong';
      const res = mockRes();
      await new Promise((resolve) => app(req, res, resolve));
      await Promise.resolve();
      expect(res.statusCode).toBe(200);
    });
  });

  describe('aux: body parsing and error handling', () => {
    it('returns 500 on unexpected repo errors', async () => {
      client.send = () => { throw new Error('boom'); };
      const req = mockReq('GET', '/api/posts');
      const res = mockRes();
      await new Promise((resolve) => app(req, res, resolve));
      await Promise.resolve();
      expect(res.statusCode).toBe(500);
    });

    it('returns 400 when POST body has invalid JSON', async () => {
      const req = mockReq('POST', '/api/posts');
      req.headers['content-type'] = 'application/json';
      req.body = 'not json';
      req.headers['x-blog-token'] = 's3cret';
      const res = mockRes();
      await new Promise((resolve) => app(req, res, resolve));
      await Promise.resolve();
      expect(res.statusCode).toBe(400);
    });
  });
});
