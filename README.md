# Readonly / api-only-blog:

---

## Demo

One of these image sites should work:

https://b0.xcloan.com

https://b1.xcloan.com

https://b2.xcloan.com

## Table of Contents

1. [Project Structure](#1-project-structure)
2. [Configuration: blog-config.js](#2-configuration-blog-configjs)
3. [Data Access: post-repo.js](#3-data-access-post-repojs)
4. [Web Layer: blog-app.js](#4-web-layer-blog-appjs)
5. [Server Entry: blog.js](#5-server-entry-blogjs)
6. [Testing: test-harness.js](#6-testing-test-harnessjs)
7. [Request Flows](#7-request-flows)
8. [Diagrams](#8-diagrams)
9. [Common Gotchas](#9-common-gotchas)
10. [How to Add a Feature](#10-how-to-add-a-feature)
11. [Key Exports](#11-key-exports)

---

## 1. Project Structure

```

api-only-blog/
│
├── blog-config.js          ← Config source priority + env parsing
├── blog.js                 ← Server entry point (starts HTTP + DynamoDB)
├── blog-app.js             ← Express routes + markdown rendering
├── post-repo.js            ← DynamoDB CRUD operations (abstraction layer)
├── render.js               ← Markdown → HTML renderer
├── config-overrides.js     ← Deploy-time JS config overrides (highest priority)
├── .env.PROD               ← Deployed environment variables (empty by default)
├── test-harness.js         ← Runs 69-test suite
└── package.json            ← Dependencies + test script (`node test-harness.js`)

```
**72 tests** across the loadable suites pass (blog-app 31, blog-config 16, blog 5, post-repo 20). Known issue: `render.test.js` currently fails to load with a `SyntaxError` (its content is stored with literal `\n` escapes), which also stops the harness before `slugify.test.js` runs. The test harness injects Jest-like globals (`describe`, `it`, `expect`, `beforeEach`, `afterEach`).

---

## 2. Configuration: blog-config.js

This is the **source of truth** for all configuration. It defines a strict priority chain for every environment variable.

### Source Priority (highest first)

| Priority | Source | Description |
|----------|--------|-------------|
| **1** | `config-overrides.js` | Hand-edited JS file shipped with the deploy (highest priority) |
| **2** | `process.env` | Local dev environment |
| **3** | `.env.PROD` | File shipped with deploy (fallback for hosts that don't pass env) |
| **4** | **Defaults** | Hard-coded values in the code — **only for optional vars** (see Required Variables) |

### Required Variables

`AWS_REGION`, `DYNAMODB_TABLE_NAME` and `BLOG_WRITE_TOKEN` are **required**: `createConfig()` reads them with `requiredSourceEnv()` and throws `missing required env var: <name>` at startup if none of the sources above provides a non-empty value. They have no hard-coded defaults on purpose — previously the write token had a hard-coded fallback value in the code, which would silently become the live token on any deploy that forgot to configure one. The fallback was removed; a misconfigured deploy now fails loudly instead.

### The Override File (`config-overrides.js`)

When the deploy host can't set environment variables, a JS file `config-overrides.js` is placed next to `blog-config.js`. It exports a plain object that takes **highest priority** (above `process.env`).

```js
// config-overrides.js example
module.exports = {
  PORT: 9999,
  AWS_REGION: 'ov-region',
  DYNAMODB_TABLE_NAME: 'ov-table',
  BLOG_WRITE_TOKEN: 'ov-token',
  // ... other keys
};
```

The test suite **rewrites this file between test cases** to isolate configs. Each test case saves the original content, writes new content, runs the test, then restores the original.

### Key Functions

| Function | What it does |
|----------|-------------|
| `optionalSourceEnv(name, fallback)` | Returns `overrides[name]`, then `process.env[name]`, then `.env.PROD[name]`, then `fallback` |
| `requiredSourceEnv(name)` | Same as above **but throws** if not found (used for `AWS_REGION`, `DYNAMODB_TABLE_NAME`, `BLOG_WRITE_TOKEN`) |
| `loadOverrides()` | Loads `config-overrides.js` via `require()`; caches in `_overrides` variable; supports hot-reload by deleting `require.cache` |
| `parseProdEnvFile(path)` | Parses `.env.PROD` into a key→value map (handles quotes, inline comments, quoted values) |
| `awsAccessKeyId()`, `awsSecretAccessKey()` | Return **hard-coded fallback credentials** (never require env vars to be set) |
| `parsePort(value)` | Validates PORT is a number 1–65535, throws `Error` if invalid |
| `readLogSetup()` | Sets up debug logging + creates log file stream (`_logFile`, `_logStream`) |

### Debug Log Boolean Pattern

The `readLogSetup()` function uses `optionalSourceEnv` to read `DEBUG_LOG`:

```js
_debug = optionalSourceEnv('DEBUG_LOG', 'false') === 'true' || optionalSourceEnv('DEBUG_LOG', 'false') === true;
```

This accepts both the string `'true'` and the boolean `true` from `config-overrides.js`.

### Port Default

The default PORT is `3000` (previously `2337`, changed to match test expectations). Overridden by `process.env.PORT`.

### AWS Credentials Fallbacks

```js
function awsAccessKeyId() {
  return optionalSourceEnv('AWS_ACCESS_KEY_ID', 'this-is');
}

function awsSecretAccessKey() {
  return optionalSourceEnv('AWS_SECRET_ACCESS_KEY', 'myid');
}
```

The fallback values are placeholders, not real credentials — real keys must come from `config-overrides.js`, `process.env` or `.env.PROD`. (Unlike the write token, these two are not startup-required; a deploy that relies on the placeholders will fail at the first DynamoDB call.)

---

## 3. Data Access: post-repo.js

This module **abstracts DynamoDB interactions**. It's the only place that knows about the database schema.

### Schema

| Table | PK (Hash) | SK (Range) | GSI |
|-------|-----------|------------|-----|
| **Base table** | `feedKey` (string) | `chronKey` (string) | — |
| **GSI `slugIndex`** | `slug` (string) | — | Yes — used by `getPost`, `slugExists`, `deletePost` |

### `createPostRepo(opts = {})`

| Parameter | Description |
|-----------|-------------|
| `opts.tableName` | Required. Table name, falls back to `process.env.BLOG_TABLE_NAME`; throws if neither provides one |
| `opts.client` | **Optional**. A pre-constructed `DynamoDBDocumentClient`. When provided, the repo uses it directly (for testing). When omitted, lazily creates one via `docClient()`. |

### Test Hook: `opts.client`

When `createPostRepo({ tableName, client })` is called with a `client`, the repo uses it directly. This lets unit tests use a fake client that verifies `instanceof` checks without touching AWS.

Inside the repo, `client()` is a closure:

```js
function client() {
  if (_client) return _client;    // use injected test client
  return docClient();             // lazy singleton creation
}
```

### Four Operations

| Method | DynamoDB Calls | Key Expressions |
|--------|----------------|-----------------|
| `getPost(slug)` | `QueryCommand` on GSI `slugIndex` | `IndexName: 'slugIndex'`, `KeyConditionExpression: '#slug = :slug'` |
| `createPost({title, slug, status, markdown})` | `PutCommand` on base table | `feedKey: 'POST'`, `chronKey: publishedAt#slug` |
| `deletePost(slug)` | `getPost` first, then `DeleteCommand` on base table | `Key: { feedKey, chronKey }` |
| `listPosts({page, perPage, lastChronKey})` | `QueryCommand` on base table by `feedKey` | `KeyConditionExpression: 'feedKey = :fk'`, `ScanIndexForward: false` |

### `listPosts` Filters

```js
const published = items.filter((it) => it.status === 'published');
```

Only items with `status === 'published'` are returned. Drafts are silently dropped.

### Status Validation

`createPost` only accepts `status` values of `draft` or `published` (omitted means `published`). Anything else throws `status must be one of: draft, published`, which the web layer returns as a `400` — a misspelled status used to create a post that silently never appeared in the feed.

---

## 4. Web Layer: blog-app.js

Express app with these routes:

| Route | Auth | Description |
|-------|------|-------------|
| `GET /` | None | Renders HTML feed page (all published posts) |
| `GET /post/:slug` | None* | Renders HTML permalink page |
| `GET /api/posts` | None | Returns JSON feed array (light shape, see below) |
| `GET /api/posts/:slug` | None* | Returns JSON single post + rendered HTML |
| `POST /api/posts` | **Required** | Creates a post (write token required) |
| `DELETE /api/posts/:slug` | **Required** | Deletes a post (write token required) |

\* Drafts are private: on the two single-post routes, a post whose `status` is not `published` returns `404` unless the request carries a valid write token — a draft is indistinguishable from a nonexistent post.

### Write Token Authentication

The `requireWriteToken` middleware checks the `X-Blog-Token` header (or `x-blog-token`) against the app's write token, resolved from:

1. `cfg.writeToken` (passed when creating the app)
2. `config.writeToken` (from `blog-config` singleton)
3. `process.env.BLOG_WRITE_TOKEN` (env var)

There is **no hard-coded fallback token**. If no match → `401 Unauthorized`.

### Response Shapes and Errors

- `GET /api/posts` returns the light list shape by default — `{slug, title, status, publishedAt, excerpt, url}` — without the full markdown. The DynamoDB-internal keys `feedKey`/`chronKey` are never exposed. A `?fields=` query parameter can select specific fields (full `markdown`/`html` remain available on the single-post route).
- `POST /api/posts` errors: missing `title`/`markdown` → `400`; invalid slug → `400` (was `500`); invalid `status` → `400`; duplicate slug → `409`.

### Markdown Rendering

`renderMarkdown(markdown)` is provided by the caller (the test harness or `blog.js`). It converts markdown → HTML. The renderer (`render.js`) passes its output through a dependency-free `sanitizeHtml()` step: `script`/`style`/`iframe`/`object`/`embed`/`form` elements are removed with their contents, inline event-handler attributes (`onclick`, `onerror`, …) are stripped, and `javascript:`/`vbscript:`/`data:text/html` URLs are removed — raw HTML in a post can no longer execute in a visitor's browser. Used in:

- `renderFeedPage(posts)` — for the homepage excerpt list
- `renderPostPage(post, html)` — for the full-post permalink
- `renderNotFoundPage()` — 404 page

### Render Markdown Capture Pattern

Inside `createApp`, the injected renderer is captured once as a closure constant (`const _renderMarkdown = renderMarkdown;`). The feed-page renderer is defined inside `createApp` and closes over it; the post-page and not-found renderers are pure module-level functions that receive already-rendered HTML as an argument.

---

## 5. Server Entry: blog.js

This is **the module that actually starts the HTTP server**. Key steps:

1. **Load credentials** via `awsAccessKeyId()` / `awsSecretAccessKey()` — these call `blog-config`'s functions, which may trigger `createConfig()` and print the startup log
2. **Create `DynamoDBClient`** (singleton, reused for the process lifetime)
3. **Create `DynamoDBDocumentClient`** via `DynamoDBDocumentClient.from(rawClient)`
4. **Create repo** `createPostRepo({ tableName: config.tableName, client: docClient })` — passes the document client
5. **Create app** `createApp(repo, renderMarkdown, { writeToken: config.writeToken, blogHost: ... })`
6. **`start()`** — Listens on `config.port`, installs SIGTERM/SIGINT handlers for graceful shutdown

### `require.main === module`

When run as `node blog.js`, `start()` is called automatically. When required by another module (e.g., tests), the caller controls lifecycle.

### Port Behavior

- Default: `3000` (changed from `2337`)
- `process.env.PORT` overrides the default

---

## 6. Testing: test-harness.js

The test runner uses **Jest-like globals** (`describe`, `it`, `expect`, `beforeEach`, `afterEach`) injected by the harness. Each suite is a separate `describe` block.

### Test Suites (6 files; 72 tests pass, `render.test.js` currently unloadable)

| Suite | Tests | What it covers |
|-------|-------|----------------|
| `blog-app.test.js` | 31 | All Express routes (HTML + JSON), auth, pagination, error handling |
| `blog-config.test.js` | 16 | Default values, env parsing, required-var errors, DEBUG_LOG boolean handling |
| `blog.test.js` | 5 | Config reading, type coercion, DEBUG_LOG "false" behavior, startup log |
| `post-repo.test.js` | 20 | DynamoDB CRUD, GSI queries, slug collision, pagination |
| `slugify.test.js` | 7 | Slug validation & generation (runs after `render.test.js` in harness order) |
| `render.test.js` | — | `renderMarkdown` function behavior — **currently fails to load** (file stored with literal `\n` escapes; `SyntaxError`) |

### Test Isolation Patterns

- **`.env.PROD` manipulation** — Tests write/clear this file before/after each case
- **`config-overrides.js` rewriting** — Tests swap the overrides file content between cases
- **Env var saving/restoring** — `isolateEnv()` saves/deletes all config-relevant env vars
- **Console.log capturing** — Tests override `console.log` to verify startup messages

### Key Test Helpers

| Helper | Purpose |
|--------|---------|
| `withProdEnv(lines, fn)` | Temporarily writes `.env.PROD`, runs `fn`, restores original |
| `withOverrides(code, fn)` | Temporarily writes `config-overrides.js`, runs `fn`, restores original |
| `isolateEnv()` | Saves all config-relevant env vars, clears them, restores on cleanup |
| `setEnv(key, value)` | Sets/clears a single env var, returns `{key, old}` for restoration |

---

## 7. Request Flows

### HTML Feed Page: `GET /`

```
HTTP GET /
     │
     └─> blog-app.js: app.get('/')
            │
            └─> repo.listPosts({page: 1, perPage: 50, tableName: config.tableName})
                   │
                   └─> docClient().send(QueryCommand({
                        TableName: tableName,
                        KeyConditionExpression: 'feedKey = :fk',
                        ExpressionAttributeValues: { ':fk': 'POST' },
                        ScanIndexForward: false,
                        Limit: 50,
                        ExclusiveStartKey: ... (if paginating)
                    }))
                   │
                   └─> Filters by status === 'published'
                        │
                        └─> renderFeedPage(posts)
                               │
                               └─> renders HTML <ul> list
                                    │
                                    └─> res.type('html').send(body)
```

### JSON Feed: `GET /api/posts`

```
HTTP GET /api/posts?page=2&perPage=10
     │
     └─> same listPosts path (no HTML rendering)
          │
          └─> res.json(posts)  — array of {slug, title, publishedAt, excerpt, url}
```

### Create Post: `POST /api/posts`

```
HTTP POST /api/posts
     │
     ├─> requireWriteToken middleware
     │     │
     │     └─> validates X-Blog-Token header against write token
     │
     └─> repo.createPost({title, slug, status, markdown})
            │
            ├─> validateSlug(slug) — invalid slug → 400
            ├─> validate status ∈ {draft, published} — invalid → 400
            ├─> slugExists(slug) via GSI query — duplicate → 409
            ├─> makeItem({feedKey, chronKey, ...})
            └─> docClient().send(PutCommand({TableName, Item}))
                 │
                 └─> returns 201 + created post (with auto-generated slug/chronKey)
```

### Delete Post: `DELETE /api/posts/:slug`

```
HTTP DELETE /api/posts/my-post
     │
     ├─> requireWriteToken middleware
     └─> repo.deletePost('my-post')
            │
            ├─> getPost('my-post') (looks up via GSI)
            └─> docClient().send(DeleteCommand({
                 TableName,
                 Key: { feedKey: 'POST', chronKey: '...' }
            }))
                 │
                 └─> returns 204 (idempotent — also returns 204 if slug doesn't exist)
```

---

## 8. Diagrams

### Config Source Priority

```
          ┌─────────────────────┐
          │ config-overrides.js │  ← DEPLOY FILE (highest)
          └───────┬─────┬───────┘
                  │     │
          ┌───────▼─────▼───────┐
          │  process.env        │  ← LOCAL DEV
          └───────┬─────┬───────┘
                  │     │
          ┌───────▼─────▼───────┐
          │   .env.PROD         │  ← DEPLOYED FILE
          └───────┬─────┬───────┘
                  │     │
          ┌───────▼─────▼───────┐
          │  HARD-CODED DEFAULTS│  ← blog-config.js (optional vars only)
          └─────────────────────┘
```

**Override file** `config-overrides.js` sits **above** `process.env` in priority (loaded first, its values are checked before anything else). Required vars (`AWS_REGION`, `DYNAMODB_TABLE_NAME`, `BLOG_WRITE_TOKEN`) have no default at the bottom of the chain — if no source provides one, startup throws.

### Request Handling Lifecycle

```
client request
           │
           ▼
   Express app (blog-app.js)
           │
           ├── readWriteToken() ──┐
           │                       │
           ▼                       │
    route handler ──► repo method ──► DynamoDB query/put/delete
           │                       │
           └───────────────────────┘
           │
           └─► response (JSON or HTML)
```

### DynamoDB Table Schema

```
base table:
  PK: feedKey (string)      ← always 'POST'
  SK: chronKey (string)     ← publishedAt#slug

GSI slugIndex:
  PK: slug (string)         ← used by getPost, slugExists, deletePost
  SK: (not used — range not defined)
```

---

## 9. Common Gotchas for New Engineers

| Issue | Symptom | Fix |
|-------|---------|-----|
| **Missing required config** | Startup throws `missing required env var: ...` | Set `AWS_REGION`, `DYNAMODB_TABLE_NAME` and `BLOG_WRITE_TOKEN` in env, `.env.PROD` or `config-overrides.js` — they have no defaults |
| **Wrong table name** | `ResourceNotFoundException` | Set `DYNAMODB_TABLE_NAME` in `.env.PROD` or `config-overrides.js` |
| **Wrong region** | Same error + wrong endpoint | Set `AWS_REGION` in `.env.PROD` or env |
| **DEBUG_LOG not turning on** | `cfg.debugLog === false` even with `DEBUG_LOG: true` in overrides | The comparison accepts both `'true'` and `true` |
| **`renderMarkdown is not defined`** | 500 error on `GET /` | Module-level `renderFeedPage` captures `renderMarkdown` into `_renderMarkdown` |
| **`ResourceNotFoundException` on server** | Server crashes on first DynamoDB call | Table name or region in config doesn't match actual DynamoDB table |
| **`listPosts` returns drafts** | Draft posts appear in the feed | Only `published` items are returned; drafts filtered by `status === 'published'` |

---

## 10. How to Add a Feature

1. **Config** — Add new env var to `blog-config.js`: `optionalSourceEnv()` with a sensible default, or `requiredSourceEnv()` if the app must not run without it (secrets and resource names belong in the second group).
2. **Repo** — Add a method to `post-repo.js` following existing patterns (query → put → delete). Remember: `listPosts` filters by `status === 'published'`.
3. **Routes** — Add new `app.METHOD()` route in `blog-app.js`, reusing `repo` methods and authentication via `requireWriteToken`.
4. **Markup** — Add rendering logic to `renderFeedPage`, `renderPostPage`, or create new helper. Capture `renderMarkdown` via the `_renderMarkdown` pattern.
5. **Tests** — Add `it()` blocks to appropriate test suite, using isolation helpers (`isolateEnv`, `withOverrides`, etc.).
6. **Run tests** — `node test-harness.js` to verify everything still passes.

---

## 11. Key Exports

| Module | Exported Items |
|--------|----------------|
| `blog-config` | `config`, `createConfig`, `resetState`, `awsAccessKeyId`, `awsSecretAccessKey`, `awsCredentialsProvider` |
| `blog-app` | `createApp` |
| `post-repo` | `createPostRepo` |
| `blog` | `app`, `repo`, `start`, `rawClient`, `docClient` |
| `render` | `renderMarkdown`, `extractExcerpt`, `sanitizeHtml` |

### `blog.js` Module Export Breakdown

```js
module.exports = {
  app,           // Express app (ready to listen)
  repo,          // createPostRepo instance (with repo methods)
  start,         // function() → starts HTTP server + graceful shutdown handlers
  rawClient,     // DynamoDBClient singleton (low-level, for destroy on shutdown)
  docClient      // DynamoDBDocumentClient singleton (wraps rawClient)
};
```

When run as `node blog.js`, `start()` is called automatically. When required by a test or another module, the caller owns the lifecycle.

---

```

```
