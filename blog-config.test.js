const { createConfig, resetState } = require('./blog-config');
const fs = require('fs');
const path = require('path');

const REQ_KEYS = ['AWS_REGION', 'DYNAMODB_TABLE_NAME', 'BLOG_WRITE_TOKEN'];
const ALL_KEYS = ['PORT', 'AWS_REGION', 'DYNAMODB_TABLE_NAME', 'BLOG_WRITE_TOKEN', 'LOG_FILE', 'DEBUG_LOG'];

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

// Write a temp .env.PROD next to blog-config.js for the duration of fn().
// Restores the original file content (or deletes it if it didn't exist).
function withProdEnv(lines, fn) {
  const dir = path.resolve(__dirname);
  const prodPath = path.resolve(dir, '.env.PROD');
  const existed = fs.existsSync(prodPath);
  const oldContent = existed ? fs.readFileSync(prodPath, 'utf8') : null;
  const content = lines.length ? lines.join('\n') + '\n' : '';
  if (content) {
    fs.writeFileSync(prodPath, content, 'utf8');
  } else if (existed) {
    fs.writeFileSync(prodPath, '', 'utf8');
  } else {
    fs.writeFileSync(prodPath, '', 'utf8');
  }
  try {
    return fn(prodPath);
  } finally {
    if (oldContent === null) {
      try { fs.unlinkSync(prodPath); } catch (_) {}
    } else {
      fs.writeFileSync(prodPath, oldContent, 'utf8');
    }
  }
}

// Clear ALL relevant env vars and write an empty .env.PROD so nothing leaks.
function isolateEnv() {
  const saved = {};
  for (const k of ALL_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  const dir = path.resolve(__dirname);
  const prodPath = path.resolve(dir, '.env.PROD');
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
    const restore = isolateEnv();
    try {
      process.env.PORT = '4000';
      process.env.AWS_REGION = 'us-west-2';
      process.env.DYNAMODB_TABLE_NAME = 'my-blog';
      process.env.BLOG_WRITE_TOKEN = 's3cret';
      process.env.LOG_FILE = '/tmp/blog.log';
      process.env.DEBUG_LOG = 'true';

      const cfg = createConfig();

      expect(cfg.port).toBe(4000);
      expect(cfg.awsRegion).toBe('us-west-2');
      expect(cfg.tableName).toBe('my-blog');
      expect(cfg.writeToken).toBe('s3cret');
      expect(cfg.logFile).toBe('/tmp/blog.log');
      expect(cfg.debugLog).toBe(true);
    } finally {
      restore();
    }
  });

  it('uses defaults when optional env vars are missing', () => {
    const restore = isolateEnv();
    try {
      process.env.AWS_REGION = 'eu-west-1';
      process.env.DYNAMODB_TABLE_NAME = 'minimal';
      process.env.BLOG_WRITE_TOKEN = 'x';
      // PORT, LOG_FILE, DEBUG_LOG left absent -> defaults

      const cfg = createConfig();

      expect(cfg.port).toBe(3000);
      expect(cfg.logFile).toBe('./blog.log');
      expect(cfg.debugLog).toBe(false);
      expect(cfg.awsRegion).toBe('eu-west-1');
      expect(cfg.tableName).toBe('minimal');
      expect(cfg.writeToken).toBe('x');
    } finally {
      restore();
    }
  });

  it('defaults PORT and LOG_FILE when entirely absent', () => {
    const restore = isolateEnv();
    try {
      process.env.AWS_REGION = 'ap-southeast-1';
      process.env.DYNAMODB_TABLE_NAME = 't';
      process.env.BLOG_WRITE_TOKEN = 't';
      // PORT, LOG_FILE, DEBUG_LOG left absent -> defaults

      const cfg = createConfig();
      expect(cfg.port).toBe(3000);
      expect(cfg.logFile).toBe('./blog.log');
      expect(cfg.debugLog).toBe(false);
    } finally {
      restore();
    }
  });

  it('treats DEBUG_LOG as false for anything other than "true"', () => {
    const restore = isolateEnv();
    try {
      process.env.PORT = '1';
      process.env.AWS_REGION = 'r';
      process.env.DYNAMODB_TABLE_NAME = 't';
      process.env.BLOG_WRITE_TOKEN = 't';
      process.env.LOG_FILE = 'f';

      process.env.DEBUG_LOG = 'false';
      expect(createConfig().debugLog).toBe(false);

      process.env.DEBUG_LOG = '1';
      resetState();
      expect(createConfig().debugLog).toBe(false);

      process.env.DEBUG_LOG = 'TRUE';
      resetState();
      expect(createConfig().debugLog).toBe(false);
    } finally {
      restore();
    }
  });

  it('logs startup line on config load', () => {
    const restore = isolateEnv();
    try {
      process.env.PORT = '5000';
      process.env.AWS_REGION = 'us-east-1';
      process.env.DYNAMODB_TABLE_NAME = 'blog';
      process.env.BLOG_WRITE_TOKEN = 'tok';
      process.env.LOG_FILE = './blog.log';
      process.env.DEBUG_LOG = 'false';

      createConfig();
      const seen = logged.some((args) =>
        args.some((a) => typeof a === 'string' && a.includes('blog') && a.includes('5000'))
      );
      expect(seen).toBe(true);
    } finally {
      restore();
    }
  });

  describe('.env.PROD file', () => {
    // The nested describe shares the parent's beforeEach (which runs once for the
    // whole parent suite in this harness). Tests here do not assert on logs, so we
    // do not re-install a console.log wrapper here (doing so would share the
    // mutable `originalLog` binding with the parent wrapper and recurse).

    it('reads required vars from .env.PROD when process.env is empty', () => {
      const restore = isolateEnv();
      try {
        // empty .env.PROD? no — set it to the values we want.
        withProdEnv(['AWS_REGION=us-west-2', 'DYNAMODB_TABLE_NAME=from-file', 'BLOG_WRITE_TOKEN=filetok'], () => {
          // process.env already cleared by isolateEnv(); ensure .env.PROD is the source
          const cfg = createConfig();
          expect(cfg.awsRegion).toBe('us-west-2');
          expect(cfg.tableName).toBe('from-file');
          expect(cfg.writeToken).toBe('filetok');
        });
      } finally {
        restore();
      }
    });

    it('uses process.env for required vars when both are present (process.env wins)', () => {
      const restore = isolateEnv();
      try {
        withProdEnv(['AWS_REGION=file-region', 'DYNAMODB_TABLE_NAME=file-table', 'BLOG_WRITE_TOKEN=file-token', 'PORT=9999', 'LOG_FILE=/tmp/x.log', 'DEBUG_LOG=true'], () => {
          process.env.AWS_REGION = 'env-region';
          process.env.DYNAMODB_TABLE_NAME = 'env-table-2';
          process.env.BLOG_WRITE_TOKEN = 'env-token-2';
          process.env.PORT = '8888';
          process.env.LOG_FILE = '/tmp/env.log';
          process.env.DEBUG_LOG = '1';

          const cfg = createConfig();
          // process.env wins for everything when present
          expect(cfg.awsRegion).toBe('env-region');
          expect(cfg.tableName).toBe('env-table-2');
          expect(cfg.writeToken).toBe('env-token-2');
          expect(cfg.port).toBe(8888);
          expect(cfg.logFile).toBe('/tmp/env.log');
          expect(cfg.debugLog).toBe(false); // '1' is not exactly 'true'
        });
      } finally {
        restore();
      }
    });

    it('reads optional vars from .env.PROD when process.env is absent and applies defaults when missing in both', () => {
      const restore = isolateEnv();
      try {
        withProdEnv(['AWS_REGION=r', 'DYNAMODB_TABLE_NAME=t', 'BLOG_WRITE_TOKEN=t', 'PORT=9999', 'LOG_FILE=/tmp/x.log', 'DEBUG_LOG=true'], () => {
          // process.env already cleared by isolateEnv()
          const cfg = createConfig();
          expect(cfg.port).toBe(9999);
          expect(cfg.logFile).toBe('/tmp/x.log');
          expect(cfg.debugLog).toBe(true);
          expect(cfg.awsRegion).toBe('r');
          expect(cfg.tableName).toBe('t');
          expect(cfg.writeToken).toBe('t');
        });
      } finally {
        restore();
      }
    });

    it('parses quoted values in .env.PROD', () => {
      const restore = isolateEnv();
      try {
        withProdEnv(['AWS_REGION="quoted-region"', "BLOG_WRITE_TOKEN='single-quoted'", 'DYNAMODB_TABLE_NAME=plain'], () => {
          const cfg = createConfig();
          expect(cfg.awsRegion).toBe('quoted-region');
          expect(cfg.writeToken).toBe('single-quoted');
          expect(cfg.tableName).toBe('plain');
        });
      } finally {
        restore();
      }
    });

    it('ignores comments and blank lines in .env.PROD', () => {
      const restore = isolateEnv();
      try {
        withProdEnv(['# comment', '', 'AWS_REGION=r', '  # inline comment', 'DYNAMODB_TABLE_NAME=t', 'BLOG_WRITE_TOKEN=t'], () => {
          const cfg = createConfig();
          expect(cfg.awsRegion).toBe('r');
          expect(cfg.tableName).toBe('t');
          expect(cfg.writeToken).toBe('t');
        });
      } finally {
        restore();
      }
    });

    it('strips inline comments from unquoted values in .env.PROD', () => {
      const restore = isolateEnv();
      try {
        withProdEnv(['AWS_REGION=r # inline comment', 'DYNAMODB_TABLE_NAME=t', 'BLOG_WRITE_TOKEN=t'], () => {
          const cfg = createConfig();
          expect(cfg.awsRegion).toBe('r');
        });
      } finally {
        restore();
      }
    });

    it('trims whitespace around keys and values in .env.PROD', () => {
      const restore = isolateEnv();
      try {
        withProdEnv(['  AWS_REGION =  trimmed-region  ', 'DYNAMODB_TABLE_NAME=t', 'BLOG_WRITE_TOKEN=t'], () => {
          const cfg = createConfig();
          expect(cfg.awsRegion).toBe('trimmed-region');
        });
      } finally {
        restore();
      }
    });

    it('falls back to process.env when .env.PROD is absent', () => {
      const restore = isolateEnv();
      try {
        // make .env.PROD absent
        withProdEnv([], () => {
          const dir = path.resolve(__dirname);
          const prodPath = path.resolve(dir, '.env.PROD');
          let deleted = false;
          try {
            fs.unlinkSync(prodPath);
            deleted = true;
          } catch (_) {}
          try {
            process.env.AWS_REGION = 'from-env';
            process.env.DYNAMODB_TABLE_NAME = 'env-table';
            process.env.BLOG_WRITE_TOKEN = 'env-token';
            process.env.PORT = '7000';

            const cfg = createConfig();
            expect(cfg.awsRegion).toBe('from-env');
            expect(cfg.tableName).toBe('env-table');
            expect(cfg.writeToken).toBe('env-token');
            expect(cfg.port).toBe(7000);
          } finally {
            if (deleted) {
              try { fs.writeFileSync(prodPath, '', 'utf8'); } catch (_) {}
            }
          }
        });
      } finally {
        restore();
      }
    });

    it('throws a clear error when a required var is missing in both process.env and .env.PROD', () => {
      const restore = isolateEnv();
      try {
        withProdEnv(['DYNAMODB_TABLE_NAME=only-table', 'BLOG_WRITE_TOKEN=only-token'], () => {
          const threw = (() => {
            try { createConfig(); return null; } catch (e) { return e; }
          })();
          expect(threw && typeof threw.message === 'string' && threw.message.includes('AWS_REGION')).toBe(true);
          expect(threw && threw.message).toBe('missing required env var: AWS_REGION');
        });
      } finally {
        restore();
      }
    });

    it('still throws when .env.PROD supplies an empty value for a required var', () => {
      const restore = isolateEnv();
      try {
        withProdEnv(['AWS_REGION=', 'DYNAMODB_TABLE_NAME=t', 'BLOG_WRITE_TOKEN=t'], () => {
          const threw = (() => {
            try { createConfig(); return null; } catch (e) { return e; }
          })();
          expect(threw && typeof threw.message === 'string' && threw.message.includes('AWS_REGION')).toBe(true);
          expect(threw && threw.message).toBe('missing required env var: AWS_REGION');
        });
      } finally {
        restore();
      }
    });
  });
});
