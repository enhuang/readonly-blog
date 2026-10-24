const {
  DynamoDBClient,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  DeleteCommand,
} = require('@aws-sdk/lib-dynamodb');

const { slugify } = require('./slugify');
const { awsCredentialsProvider } = require('./blog-config');

let _docClient = null;

function docClient() {
  if (!_docClient) {
    const client = new DynamoDBClient({
      region: process.env.AWS_REGION || 'us-west-2',
      credentials: awsCredentialsProvider(),
    });
    _docClient = DynamoDBDocumentClient.from(client);
  }
  return _docClient;
}

function nowISO() {
  return new Date().toISOString();
}

function feedKey() {
  return 'POST';
}

function chronKey(publishedAt, slug) {
  return publishedAt + '#' + slug;
}

function makeItem(publishedAt, slug, title, status, markdown) {
  return {
    feedKey: feedKey(),
    chronKey: chronKey(publishedAt, slug),
    slug,
    title,
    status,
    publishedAt,
    markdown,
  };
}

function excerptFromMarkdown(markdown) {
  // first paragraph of the markdown (before first blank line)
  const trimmed = markdown.trim();
  if (!trimmed) return '';
  const firstPara = trimmed.split(/\n\s*\n/)[0];
  // strip a leading ATX heading line if present
  const withoutHeading = firstPara.replace(/^#{1,6}\s+/, '');
  const text = withoutHeading.replace(/\s+/g, ' ').trim();
  if (text.length > 200) return text.slice(0, 200).replace(/\s+\S*$/, '') + '…';
  return text;
}

function validateSlug(slug) {
  if (!slug || typeof slug !== 'string') {
    return 'slug must be a non-empty string';
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return 'slug must contain only lowercase letters, digits, and hyphens';
  }
  return null;
}

function createPostRepo(opts = {}) {
  const tableName = opts.tableName || process.env.BLOG_TABLE_NAME;
  const _client = opts.client || null;

  if (!tableName) throw new Error('tableName is required');

  function client() {
    if (_client) return _client;
    return docClient();
  }

  async function getPost(slug) {
    const result = await client().send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'slugIndex',
        KeyConditionExpression: '#slug = :slug',
        ExpressionAttributeNames: { '#slug': 'slug' },
        ExpressionAttributeValues: { ':slug': slug },
        Limit: 1,
      })
    );
    const items = result.Items || [];
    if (items.length === 0) return null;
    return items[0];
  }

  async function slugExists(slug) {
    const result = await client().send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'slugIndex',
        KeyConditionExpression: '#slug = :slug',
        ExpressionAttributeNames: { '#slug': 'slug' },
        ExpressionAttributeValues: { ':slug': slug },
        Limit: 1,
      })
    );
    return (result.Items || []).length > 0;
  }

  async function createPost({ title, slug, status, markdown }) {
    if (!title) throw new Error('title is required');
    if (!markdown) throw new Error('markdown is required');

    const publishedAt = nowISO();
    const effectiveStatus = status || 'published';

    let effectiveSlug = slug;
    if (effectiveSlug) {
      const err = validateSlug(effectiveSlug);
      if (err) throw new Error(err);
      const exists = await slugExists(effectiveSlug);
      if (exists) throw new Error('slug already exists');
    } else {
      effectiveSlug = slugify(title) || 'post';
      let candidate = effectiveSlug;
      let counter = 1;
      while (await slugExists(candidate)) {
        candidate = effectiveSlug + '-' + counter;
        counter++;
      }
      effectiveSlug = candidate;
    }

    const item = makeItem(publishedAt, effectiveSlug, title, effectiveStatus, markdown);

    await client().send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      })
    );

    return item;
  }

  async function deletePost(slug) {
    const post = await getPost(slug);
    if (!post) return false;
    await client().send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          feedKey: post.feedKey,
          chronKey: post.chronKey,
        },
      })
    );
    return true;
  }

  async function listPosts({ page = 1, perPage = 10, lastChronKey } = {}) {
    if (perPage > 50) perPage = 50;
    if (page < 1) page = 1;

    const params = {
      TableName: tableName,
      KeyConditionExpression: 'feedKey = :fk',
      ExpressionAttributeValues: {
        ':fk': feedKey(),
      },
      ScanIndexForward: false,
      Limit: perPage,
      FilterExpression: 'status = :published',
      ExpressionAttributeValues: {
        ':fk': feedKey(),
        ':published': 'published',
      },
    };

    if (lastChronKey) {
      params.ExclusiveStartKey = {
        feedKey: feedKey(),
        chronKey: lastChronKey,
      };
    }

    const result = await client().send(new QueryCommand(params));
    const items = result.Items || [];

    const published = items.filter((it) => it.status === 'published');

    return published.map((it) => ({
      feedKey: it.feedKey,
      chronKey: it.chronKey,
      slug: it.slug,
      title: it.title,
      status: it.status,
      publishedAt: it.publishedAt,
      markdown: it.markdown,
      excerpt: excerptFromMarkdown(it.markdown),
      url: '/post/' + it.slug,
    }));
  }

  return {
    createPost,
    getPost,
    deletePost,
    listPosts,
  };
}

module.exports = { createPostRepo };
