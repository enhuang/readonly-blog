// Smoke test: confirm the live DynamoDB settings (region, table, credentials)
// that blog.js / post-repo.js use can actually reach the table.
//
// This does NOT use mocks. It uses the real @aws-sdk client. If the table
// doesn't exist or credentials are wrong you get a clear error here rather
// than a cryptic ResourceNotFoundException later at request time.

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { config, awsAccessKeyId, awsSecretAccessKey } = require('./blog-config');

const TABLE = config.tableName;
const REGION = config.awsRegion;
const ACCESS_KEY = awsAccessKeyId();
const SECRET_KEY = awsSecretAccessKey();

console.log('live DynamoDB smoke test');
console.log('  table:     ', TABLE);
console.log('  region:    ', REGION);
console.log('  accessKey: ', ACCESS_KEY ? ACCESS_KEY.slice(0, 4) + '...' : 'undefined');
console.log('  secretKey: ', SECRET_KEY ? SECRET_KEY.slice(0, 4) + '...' : 'undefined');
console.log('');

async function run() {
  const rawClient = new DynamoDBClient({
    region: REGION,
    credentials: ACCESS_KEY && SECRET_KEY
      ? { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY }
      : undefined,
  });

  const doc = DynamoDBDocumentClient.from(rawClient);

  // Lightweight: describe the table. This confirms the table exists and is
  // reachable with the given credentials without reading or writing any data.
  const { DynamoDBClient: DC } = require('@aws-sdk/client-dynamodb');
  const { DescribeTableCommand } = require('@aws-sdk/client-dynamodb');
  try {
    const desc = await rawClient.send(new DescribeTableCommand({ TableName: TABLE }));
    console.log('OK  table exists:     ', desc.Table?.TableName);
    console.log('     table status:    ', desc.Table?.TableStatus);
    console.log('     table ARN:       ', desc.Table?.TableArn);
    console.log('     endpoint:        ', rawClient.config.endpoint);
  } catch (err) {
    console.log('FAIL describeTable:', err.name, err.message);
    if (err.$metadata) {
      console.log('     httpStatusCode:  ', err.$metadata.httpStatusCode);
      console.log('     requestId:       ', err.$metadata.requestId);
    }
    console.log('');
    console.log('HINT: if ResourceNotFoundException, the table name or region is wrong.');
    console.log('      if AccessDeniedException, the credentials are wrong or lack perms.');
    console.log('      if SignatureDoesNotMatch, the secret key is wrong.');
    process.exit(1);
  }

  // Also confirm the document client can serialize a trivial query structure
  // (no network call for the marshalling check itself, but we do a real Query
  // with Limit 1 to confirm the index is reachable).
  try {
    const q = await doc.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'feedKey = :fk',
        ExpressionAttributeValues: { ':fk': 'POST' },
        Limit: 1,
      })
    );
    console.log('OK  query reachable:  ', (q.Items || []).length === 0 ? 'empty (expected for new table)' : q.Items.length + ' items');
  } catch (err) {
    console.log('FAIL query:         ', err.name, err.message);
    if (err.$metadata) {
      console.log('     httpStatusCode:  ', err.$metadata.httpStatusCode);
      console.log('     requestId:       ', err.$metadata.requestId);
    }
    process.exit(1);
  }

  console.log('');
  console.log('All checks passed.');
  process.exit(0);
}

run().catch((err) => {
  console.error('unexpected error:', err);
  process.exit(2);
});
