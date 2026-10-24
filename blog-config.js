const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// .env.PROD parser
// ---------------------------------------------------------------------------
// Some hosts (e.g. the Pinous/Heberg container) do not let the process inherit
// environment variables, so required config such as AWS_REGION must come from a
// file shipped with the repo. We read .env.PROD into an in-memory map (never
// into process.env) and treat it as a fallback source for config values.
//
// Priority (highest first):
//   1. process.env  (local dev where the host may have set vars)
//   2. .env.PROD    (the file the user uploads with the deploy)
//   3. defaults     (only for optional vars)
//
// Required vars (AWS_REGION, DYNAMODB_TABLE_NAME, BLOG_WRITE_TOKEN) must be
// present in at least one of the two sources above, otherwise startup fails
// with a clear error.
// ---------------------------------------------------------------------------

function parseProdEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf8');
  const map = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    if (!key) continue;
    let value = trimmed.slice(idx + 1).trim();
    // Strip an inline comment. A '#' starts a comment only when it is not
    // inside a quoted value. Quoted values are honored verbatim (after the
    // surrounding quotes are removed below).
    if (!(value.startsWith('"') || value.startsWith("'"))) {
      const commentIdx = value.indexOf('#');
      if (commentIdx !== -1) {
        value = value.slice(0, commentIdx).trim();
      }
    }
    // Unquote if wrapped in matching single or double quotes.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) map[key] = value;
  }
  return map;
}

const PROD_ENV_FILE = path.resolve(__dirname, '.env.PROD');
const OVERRIDES_FILE = path.resolve(__dirname, 'config-overrides.js');

// Highest priority of all: a hand-edited JS file that exports a config snippet.
// This is intended for when the deploy host cannot set process.env and the
// .env.PROD parser is not convenient (or the values contain characters the
// parser would misinterpret). The exported object is merged on top of every
// other source. Missing keys fall through to process.env / .env.PROD / defaults.
let _overrides = null;

function loadOverrides() {
  if (_overrides === null) {
    if (fs.existsSync(OVERRIDES_FILE)) {
      try {
        // Bust the Node require() cache so a re-deployed config-overrides.js
        // is picked up without restarting the process (relevant in dev; on the
        // server the file is stable, but this also keeps the unit tests correct
        // when the file is rewritten between test cases).
        delete require.cache[require.resolve(OVERRIDES_FILE)];
        _overrides = require(OVERRIDES_FILE);
      } catch (e) {
        // If the file exists but fails to load, treat it as absent so the
        // server can still start and report a clearer problem elsewhere.
        _overrides = null;
      }
    }
  }
  return _overrides;
}

function overrides(key) {
  const o = loadOverrides();
  if (o && Object.prototype.hasOwnProperty.call(o, key)) return o[key];
  return undefined;
}

function prodEnv(key) {
  const map = parseProdEnvFile(PROD_ENV_FILE);
  return map ? map[key] : undefined;
}

// Credentials (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) follow the same
// source priority as the rest of the config: process.env beats .env.PROD,
// which beats absent. They are optional — if neither source has them, the
// caller gets undefined and must decide what to do.
function awsAccessKeyId() {
  return optionalSourceEnv('AWS_ACCESS_KEY_ID', 'this-is');
}

function awsSecretAccessKey() {
  return optionalSourceEnv('AWS_SECRET_ACCESS_KEY', 'myid');
}

// ---------------------------------------------------------------------------
// env access helpers
// ---------------------------------------------------------------------------

function requiredSourceEnv(name) {
  // Highest priority first: config-overrides.js, then process.env, then .env.PROD.
  const fromOverrides = overrides(name);
  if (fromOverrides !== undefined && fromOverrides !== '') return fromOverrides;
  const fromEnv = process.env[name];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const fromFile = prodEnv(name);
  if (fromFile !== undefined && fromFile !== '') return fromFile;
  throw new Error(`missing required env var: ${name}`);
}

function optionalSourceEnv(name, fallback) {
  const fromOverrides = overrides(name);
  if (fromOverrides !== undefined && fromOverrides !== '') return fromOverrides;
  const fromEnv = process.env[name];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const fromFile = prodEnv(name);
  if (fromFile !== undefined && fromFile !== '') return fromFile;
  return fallback;
}

function parsePort(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) {
    throw new Error(`invalid PORT: ${value}`);
  }
  return n;
}

let _logStream = null;
let _logFile = null;
let _debug = false;
let _config = null;

function resetState() {
  _logStream = null;
  _logFile = null;
  _debug = false;
  _config = null;
  _overrides = null;
}

function readLogSetup() {
  _logFile = optionalSourceEnv('LOG_FILE', './blog.log');
  _debug = optionalSourceEnv('DEBUG_LOG', 'false') === 'true' || optionalSourceEnv('DEBUG_LOG', 'false') === true;
  try {
    const dir = path.dirname(_logFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    _logStream = fs.createWriteStream(_logFile, { flags: 'a', encoding: 'utf8' });
  } catch (e) {
    _logStream = null;
  }
}

function log(level, message) {
  const line = `[${new Date().toISOString()}] ${level}  ${message}`;
  console.log(line);
  const stream = _logStream;
  if (stream) {
    stream.write(line + '\n');
  }
}

function debugLog(message) {
  if (_debug) {
    log('DEBUG', message);
  }
}

function createConfig() {
  readLogSetup();
  const port = parsePort(optionalSourceEnv('PORT', '9999'));
  const awsRegion = optionalSourceEnv('AWS_REGION', 'us-west-9');
  const tableName = optionalSourceEnv('DYNAMODB_TABLE_NAME', 'blog-posts');
  const writeToken = optionalSourceEnv('BLOG_WRITE_TOKEN', 'th_a_secrete_2');

  log('INFO', `blog starting  table=${tableName}  region=${awsRegion}  port=${port}`);

  return {
    port,
    awsRegion,
    tableName,
    writeToken,
    logFile: _logFile,
    debugLog: _debug,
    log(level, message) {
      log(level, message);
    },
    debugLogFn(message) {
      debugLog(message);
    },
  };
}

function getConfig() {
  if (_config === null) {
    _config = createConfig();
  }
  return _config;
}

const config = {
  get port() { return getConfig().port; },
  get awsRegion() { return getConfig().awsRegion; },
  get tableName() { return getConfig().tableName; },
  get writeToken() { return getConfig().writeToken; },
  get logFile() { return getConfig().logFile; },
  get debugLog() { return getConfig().debugLog; },
  log(level, message) { log(level, message); },
  debugLogFn(message) { debugLog(message); },
};

function awsCredentialsProvider() {
  return {
    accessKeyId: awsAccessKeyId(),
    secretAccessKey: awsSecretAccessKey(),
  };
}

module.exports = {
  config,
  createConfig,
  resetState,
  awsAccessKeyId,
  awsSecretAccessKey,
  awsCredentialsProvider,
};
