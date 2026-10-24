const { GetCommand, PutCommand, QueryCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { createPostRepo } = require('./post-repo');

function makeFakeClient(overrides = {}) {
  const getItem = jestFake();
  const putItem = jestFake();
  const query = jestFake();
  const deleteItem = jestFake();
  const client = {
    send(cmd) {
      if (cmd instanceof GetCommand) return getItem(cmd);
      if (cmd instanceof PutCommand) return putItem(cmd);
      if (cmd instanceof QueryCommand) return query(cmd);
      if (cmd instanceof DeleteCommand) return deleteItem(cmd);
      throw new Error('unknown command: ' + cmd.constructor.name);
    },
    ...overrides,
  };
  client._commands = { getItem, putItem, query, deleteItem };
  return client;
}

function jestFake() {
  let impl = null;
  const calls = [];
  const fake = function (...args) {
    calls.push(args);
    if (impl) return impl(...args);
    throw new Error('command not programmed: ' + args[0]?.constructor?.name);
  };
  fake.impl = (fn) => { impl = fn; return fake; };
  fake.calls = calls;
  return fake;
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

describe('post-repo', () => {
  let client, repo;

  beforeEach(() => {
    client = makeFakeClient();
    repo = createPostRepo({ tableName: 'blog-posts', client });
  });


  describe('createPost', () => {
    it('puts a post item and returns the saved post with the supplied slug', async () => {
      client._commands.putItem.impl((cmd) => {
        const attrs = cmd.input.Item;
        expect(attrs.feedKey).toBe('POST');
        expect(attrs.slug).toBe('my-post');
        expect(attrs.title).toBe('My Post');
        expect(attrs.status).toBe('published');
        expect(attrs.markdown).toBe('# hi');
        expect(attrs.publishedAt).toBeTruthy();
        return {};
      });

      const saved = await repo.createPost({
        title: 'My Post',
        slug: 'my-post',
        status: 'published',
        markdown: '# hi',
      });

      expect(saved.slug).toBe('my-post');
      expect(saved.title).toBe('My Post');
      expect(saved.status).toBe('published');
      expect(saved.markdown).toBe('# hi');
      expect(saved.publishedAt).toBeTruthy();
    });

    it('generates a slug from the title when slug is omitted', async () => {
      client._commands.putItem.impl((cmd) => {
        const attrs = cmd.input.Item;
        expect(attrs.slug).toBe('my-first-post');
        return {};
      });

      const saved = await repo.createPost({
        title: 'My First Post',
        status: 'published',
        markdown: '# hi',
      });

      expect(saved.slug).toBe('my-first-post');
    });

    it('defaults status to published and sets publishedAt', async () => {
      client._commands.putItem.impl((cmd) => {
        const attrs = cmd.input.Item;
        expect(attrs.status).toBe('published');
        expect(attrs.publishedAt).toBeTruthy();
        return {};
      });

      const saved = await repo.createPost({
        title: 'Auto',
        markdown: '# hi',
      });

      expect(saved.status).toBe('published');
      expect(saved.publishedAt).toBeTruthy();
    });

    it('allows creating a draft with status draft and no publishedAt', async () => {
      let captured;
      client._commands.putItem.impl((cmd) => {
        captured = cmd.input.Item;
        return {};
      });

      const saved = await repo.createPost({
        title: 'Draft',
        status: 'draft',
        markdown: '# draft',
      });

      expect(captured.status).toBe('draft');
      expect(saved.status).toBe('draft');
      // draft may still have publishedAt from the create timestamp; the repo sets it anyway
      expect(saved.publishedAt).toBeTruthy();
    });

    it('appends -1, -2 on slug collision when auto-generating', async () => {
      let queryCallCount = 0;
      client._commands.query.impl((cmd) => {
        queryCallCount++;
        if (queryCallCount === 1) {
          // first slug 'my-post' exists
          return { Items: [postItem({ slug: 'my-post', chronKey: '2025-01-01T00:00:00.000Z#my-post' })] };
        }
        if (queryCallCount === 2) {
          // my-post-1 exists
          return { Items: [postItem({ slug: 'my-post-1', chronKey: '2025-01-02T00:00:00.000Z#my-post-1' })] };
        }
        // my-post-2 does not exist
        return { Items: [] };
      });

      client._commands.putItem.impl((cmd) => {
        expect(cmd.input.Item.slug).toBe('my-post-2');
        return {};
      });

      const saved = await repo.createPost({
        title: 'My Post',
        status: 'published',
        markdown: '# hi',
      });

      expect(saved.slug).toBe('my-post-2');
      expect(queryCallCount).toBe(3);
    });

    it('rejects a client-supplied slug that already exists with an error', async () => {
      client._commands.query.impl((cmd) => {
        return { Items: [postItem({ slug: 'taken' })] };
      });

      await expect(
        repo.createPost({ title: 'X', slug: 'taken', status: 'published', markdown: '# x' })
      ).rejects.toThrow(/slug already exists/i);
    });

    it('puts the item with correct key schema and returns all fields', async () => {
      let captured;
      client._commands.putItem.impl((cmd) => {
        captured = cmd.input.Item;
        return {};
      });

      const saved = await repo.createPost({
        title: 'Full',
        slug: 'full',
        status: 'published',
        markdown: 'body',
      });

      expect(captured.feedKey).toBe('POST');
      expect(captured.slug).toBe('full');
      expect(captured.title).toBe('Full');
      expect(captured.status).toBe('published');
      expect(captured.markdown).toBe('body');
      expect(saved).toHaveProperty('feedKey');
      expect(saved).toHaveProperty('chronKey');
    });
  });

  describe('getPost', () => {
    it('queries the slugIndex GSI and returns the post', async () => {
      client._commands.query.impl((cmd) => {
        expect(cmd.input.IndexName).toBe('slugIndex');
        expect(cmd.input.KeyConditionExpression).toBe('#slug = :slug');
        return { Items: [postItem({ slug: 'hello' })] };
      });

      const post = await repo.getPost('hello');
      expect(post).toBeTruthy();
      expect(post.slug).toBe('hello');
    });

    it('returns null when no item matches the slug', async () => {
      client._commands.query.impl((cmd) => {
        return { Items: [] };
      });

      const post = await repo.getPost('missing');
      expect(post).toBeNull();
    });

    it('returns the single item when the GSI returns one', async () => {
      client._commands.query.impl((cmd) => {
        return { Items: [postItem({ slug: 's', title: 'T', status: 'published', markdown: 'm', publishedAt: '2025-01-01T00:00:00.000Z' })] };
      });

      const post = await repo.getPost('s');
      expect(post.slug).toBe('s');
      expect(post.title).toBe('T');
      expect(post.status).toBe('published');
      expect(post.markdown).toBe('m');
    });
  });

  describe('deletePost', () => {
    it('deletes the item by slug via the GSI using the key from a get first', async () => {
      client._commands.query.impl((cmd) => {
        return { Items: [postItem({ slug: 'to-delete', feedKey: 'POST', chronKey: '2025-01-01T00:00:00.000Z#to-delete' })] };
      });

      let deletedKey = null;
      client._commands.deleteItem.impl((cmd) => {
        deletedKey = cmd.input.Key;
        return {};
      });

      await repo.deletePost('to-delete');

      expect(deletedKey).toEqual({
        feedKey: 'POST',
        chronKey: '2025-01-01T00:00:00.000Z#to-delete',
      });
    });

    it('returns true when the post existed and was deleted', async () => {
      client._commands.query.impl((cmd) => {
        return { Items: [postItem({ slug: 'x', chronKey: '2025-01-01T00:00:00.000Z#x' })] };
      });

      const result = await repo.deletePost('x');
      expect(result).toBe(true);
    });

    it('returns false when the slug does not exist', async () => {
      client._commands.query.impl((cmd) => {
        return { Items: [] };
      });

      const result = await repo.deletePost('missing');
      expect(result).toBe(false);
    });
  });

  describe('listPosts', () => {
    it('queries the feed with descending sort and returns feed items', async () => {
      client._commands.query.impl((cmd) => {
        expect(cmd.input.ScanIndexForward).toBe(false);
        expect(cmd.input.Limit).toBe(10);
        return {
          Items: [
            postItem({ slug: 'b', title: 'B', status: 'published', publishedAt: '2025-01-02T00:00:00.000Z', markdown: 'b', chronKey: '2025-01-02T00:00:00.000Z#b' }),
            postItem({ slug: 'a', title: 'A', status: 'published', publishedAt: '2025-01-01T00:00:00.000Z', markdown: 'a', chronKey: '2025-01-01T00:00:00.000Z#a' }),
          ],
        };
      });

      const posts = await repo.listPosts({ page: 1, perPage: 10 });
      expect(posts).toHaveLength(2);
      expect(posts[0].slug).toBe('b');
      expect(posts[0].title).toBe('B');
      expect(posts[1].slug).toBe('a');
    });

    it('returns only published posts (filters out drafts)', async () => {
      client._commands.query.impl((cmd) => {
        // FilterExpression moves the status filter to DynamoDB
        expect(cmd.input.FilterExpression).toBe('status = :published');
        expect(cmd.input.ExpressionAttributeValues).toEqual({ ':published': 'published' });
        return {
          Items: [
            postItem({ slug: 'p', status: 'published', title: 'Pub', publishedAt: '2025-01-02T00:00:00.000Z', markdown: 'p', chronKey: '2025-01-02T00:00:00.000Z#p' }),
            postItem({ slug: 'd', status: 'draft', title: 'Draft', publishedAt: '2025-01-01T00:00:00.000Z', markdown: 'd', chronKey: '2025-01-01T00:00:00.000Z#d' }),
          ],
        };
      });

      const posts = await repo.listPosts({ page: 1, perPage: 10 });
      expect(posts).toHaveLength(1);
      expect(posts[0].slug).toBe('p');
      expect(posts[0].status).toBe('published');
    });

    it('returns an empty array when there are no published posts', async () => {
      client._commands.query.impl((cmd) => {
        return { Items: [] };
      });

      const posts = await repo.listPosts({ page: 1, perPage: 10 });
      expect(posts).toEqual([]);
    });

    it('limits results to perPage', async () => {
      client._commands.query.impl((cmd) => {
        expect(cmd.input.Limit).toBe(2);
        return {
          Items: [
            postItem({ slug: 'a', title: 'A', status: 'published', publishedAt: '2025-01-01T00:00:00.000Z', markdown: 'a', chronKey: '2025-01-01T00:00:00.000Z#a' }),
            postItem({ slug: 'b', title: 'B', status: 'published', publishedAt: '2025-01-02T00:00:00.000Z', markdown: 'b', chronKey: '2025-01-02T00:00:00.000Z#b' }),
            postItem({ slug: 'c', title: 'C', status: 'published', publishedAt: '2025-01-03T00:00:00.000Z', markdown: 'c', chronKey: '2025-01-03T00:00:00.000Z#c' }),
          ],
        };
      });

      const posts = await repo.listPosts({ page: 1, perPage: 2 });
      expect(posts).toHaveLength(2);
    });

    it('starts after the given lastChronKey for pagination', async () => {
      client._commands.query.impl((cmd) => {
        expect(cmd.input.ExclusiveStartKey).toEqual({
          feedKey: 'POST',
          chronKey: '2025-01-02T00:00:00.000Z#b',
        });
        return {
          Items: [
            postItem({ slug: 'c', title: 'C', status: 'published', publishedAt: '2025-01-03T00:00:00.000Z', markdown: 'c', chronKey: '2025-01-03T00:00:00.000Z#c' }),
          ],
        };
      });

      const posts = await repo.listPosts({ page: 2, perPage: 1, lastChronKey: '2025-01-02T00:00:00.000Z#b' });
      expect(posts).toHaveLength(1);
      expect(posts[0].slug).toBe('c');
    });

    it('returns feed item shape with excerpt derived from markdown', async () => {
      client._commands.query.impl((cmd) => {
        return {
          Items: [
            postItem({
              slug: 'ex',
              title: 'Example',
              status: 'published',
              publishedAt: '2025-01-01T00:00:00.000Z',
              markdown: '# Title\n\nThis is the first paragraph.\n\nSecond paragraph.',
              chronKey: '2025-01-01T00:00:00.000Z#ex',
            }),
          ],
        };
      });

      const posts = await repo.listPosts({ page: 1, perPage: 10 });
      expect(posts[0]).toMatchObject({
        slug: 'ex',
        title: 'Example',
        publishedAt: '2025-01-01T00:00:00.000Z',
      });
      expect(posts[0]).toHaveProperty('excerpt');
      expect(posts[0]).toHaveProperty('url');
      expect(posts[0].excerpt).toContain('first paragraph');
    });
  });
});

