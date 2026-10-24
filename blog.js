// Credentials are read by blog-config with the same source priority as every
// other setting: process.env (local dev) beats .env.PROD (the deployed file),
// which beats absent. blog-config never writes into process.env, so the host's
// process.env stays untouched. The getters are called once at startup.
const { awsAccessKeyId, awsSecretAccessKey } = require('./blog-config');
const awsAccessKeyIdVal = awsAccessKeyId();
const awsSecretAccessKeyVal = awsSecretAccessKey();


// Instantiate the AWS SDK clients ONCE at module level (outside any request handler)
// so the underlying HTTP agent can reuse a single pool of persistent sockets across
// the lifetime of the process. Creating a new client per request would defeat
// connection pooling and cause connection churn and memory growth.
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

const { config } = require('./blog-config');
const { createPostRepo } = require('./post-repo');
const { createApp } = require('./blog-app');
const { renderMarkdown } = require('./render');

// Module-level singleton: one DynamoDBClient for the life of the process.
const rawClient = new DynamoDBClient({
  region: config.awsRegion,
  credentials: awsAccessKeyIdVal && awsSecretAccessKeyVal
    ? { accessKeyId: awsAccessKeyIdVal, secretAccessKey: awsSecretAccessKeyVal }
    : undefined,
});

// Wrap with the document client so commands accept plain JS objects (marshalling
///unmarshalling handled by the SDK). This is also a singleton.
const docClient = DynamoDBDocumentClient.from(rawClient);

const repo = createPostRepo({ tableName: config.tableName, client: docClient });


const app = createApp(repo, renderMarkdown, {
  writeToken: config.writeToken,
  blogHost: config.blogHost || '',
});

// The SDK v3 NodeHttpHandler creates its own http.Agent with { keepAlive: true,
// maxSockets: 50 } on the first request (externalAgent: false by default).
// Because rawClient is a singleton at module scope, that agent is reused for the
// lifetime of the process, giving us a single pooled connection set instead of
// per-request agent churn. No extra agent configuration is needed.

function start() {
  const server = app.listen(config.port, () => {
    console.log(`blog listening on port ${config.port}`);
  });

  // Graceful shutdown: close the HTTP server and destroy the SDK client's
  // underlying connection pool so the process can exit cleanly.
  async function shutdown(signal) {
    console.log(`blog shutting down (received ${signal})`);
    server.close(() => {
      console.log('blog http server closed');
      // Destroy the client to clean up any in-flight HTTP connections.
      rawClient.destroy?.();
      process.exit(0);
    });
    // Force exit if graceful close takes too long.
    setTimeout(() => {
      console.log('blog forced shutdown (timeout)');
      rawClient.destroy?.();
      process.exit(1);
    }, 10000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

// If this module is run directly (`node blog.js`), start the server.
// If it is required by a test or another module, the caller owns lifecycle.
if (require.main === module) {
  start();
}

module.exports = { app, repo, start, rawClient, docClient };
