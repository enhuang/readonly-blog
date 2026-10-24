const { createConfig, resetState } = require('./blog-config');
const fs = require('fs');
const path = require('path');

function config() {
  return createConfig();
}

function setEnv(key, value) {
  const old = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  return { key, old };
}

function restore(entries) {
  for (const { key, old } of entries) {
    if (old === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = old;
    }
  }
}

// Clear process.env for the config-relevant keys AND write an empty .env.PROD
// so that the file does not contribute values during the test. Returns a restore
// function that puts both back.
function isolateEnv() {
  const REQ_KEYS = ['AWS_REGION', 'DYNAMODB_TABLE_NAME', 'BLOG_WRITE_TOKEN'];
  const ALL_KEYS = ['PORT', ...REQ_KEYS, 'LOG_FILE', 'DEBUG_LOG'];
  const saved = {};
  for (const k of ALL_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  const prodPath = path.resolve(__dirname, '.env.PROD');
  const existed = fs.existsSync(prodPath);
  const oldContent = existed ? fs.readFileSync(prodPath, 'utf8') : null;
  fs.writeFileSync(prodPath, '', 'utf8');
  return () => {
    for (const k of ALL_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (oldContent === null) {
      try { fs.unlinkSync(prodPath); } catch (_) {}
    } else {
      fs.writeFileSync(prodPath, oldContent, 'utf8');
    }
  };
}

describe('blog-config', () => {
  let logged;
  let originalLog;

  beforeEach(() => {
    resetState();
    logged = [];
    originalLog = console.log;
    console.log = (...args) => {
      logged.push(args);
      originalLog.apply(console, args);
    };
  });

  afterEach(() => {
    console.log = originalLog || console.log;
    resetState();
  });

  it('reads required env vars and coerces types', () => {
    const entries = [
      setEnv('PORT', '4000'),
      setEnv('AWS_REGION', 'us-west-2'),
      setEnv('DYNAMODB_TABLE_NAME', 'my-blog'),
      setEnv('BLOG_WRITE_TOKEN', 's3cret'),
      setEnv('LOG_FILE', '/tmp/blog.log'),
      setEnv('DEBUG_LOG', 'true'),
    ];

    const cfg = config();

    expect(cfg.port).toBe(4000);
    expect(cfg.awsRegion).toBe('us-west-2');
    expect(cfg.tableName).toBe('my-blog');
    expect(cfg.writeToken).toBe('s3cret');
    expect(cfg.logFile).toBe('/tmp/blog.log');
    expect(cfg.debugLog).toBe(true);

    restore(entries);
  });

  it('uses defaults when optional env vars are missing', () => {
    const restoreEnv = isolateEnv();
    try {
      process.env.AWS_REGION = 'eu-west-1';
      process.env.DYNAMODB_TABLE_NAME = 'minimal';
      process.env.BLOG_WRITE_TOKEN = 'x';
      // PORT, LOG_FILE, DEBUG_LOG intentionally absent -> defaults

      const cfg = config();

      expect(cfg.port).toBe(3000);
      expect(cfg.logFile).toBe('./blog.log');
      expect(cfg.debugLog).toBe(false);
      expect(cfg.awsRegion).toBe('eu-west-1');
      expect(cfg.tableName).toBe('minimal');
      expect(cfg.writeToken).toBe('x');
    } finally {
      restoreEnv();
    }
  });

  it('defaults PORT and LOG_FILE when entirely absent', () => {
    const restoreEnv = isolateEnv();
    try {
      process.env.AWS_REGION = 'ap-southeast-1';
      process.env.DYNAMODB_TABLE_NAME = 't';
      process.env.BLOG_WRITE_TOKEN = 't';
      // PORT, LOG_FILE, DEBUG_LOG intentionally absent -> defaults

      const cfg = config();
      expect(cfg.port).toBe(3000);
      expect(cfg.logFile).toBe('./blog.log');
      expect(cfg.debugLog).toBe(false);
    } finally {
      restoreEnv();
    }
  });

  it('treats DEBUG_LOG as false for anything other than "true"', () => {
    const entries = [
      setEnv('PORT', '1'),
      setEnv('AWS_REGION', 'r'),
      setEnv('DYNAMODB_TABLE_NAME', 't'),
      setEnv('BLOG_WRITE_TOKEN', 't'),
      setEnv('LOG_FILE', 'f'),
      setEnv('DEBUG_LOG', 'false'),
    ];
    expect(config().debugLog).toBe(false);
    setEnv('DEBUG_LOG', '1');
    expect(config().debugLog).toBe(false);
    setEnv('DEBUG_LOG', 'TRUE');
    expect(config().debugLog).toBe(false);
    restore(entries);
  });

  it('logs startup line on config load', () => {
    const entries = [
      setEnv('PORT', '5000'),
      setEnv('AWS_REGION', 'us-east-1'),
      setEnv('DYNAMODB_TABLE_NAME', 'blog'),
      setEnv('BLOG_WRITE_TOKEN', 'tok'),
      setEnv('LOG_FILE', './blog.log'),
      setEnv('DEBUG_LOG', 'false'),
    ];
    config();
    // startup log should mention table name and port
    const seen = logged.some((args) =>
      args.some((a) =>
        typeof a === 'string' && a.includes('blog') && a.includes('5000')
      )
    );
    expect(seen).toBe(true);
    restore(entries);
  });
});
