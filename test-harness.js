const fs = require('fs');
const path = require('path');

function throwAssert(condition, message) {
  if (!condition) {
    throw new Error(message || 'assertion failed');
  }
}

function createExpect(actual) {
  return {
    toBe(expected) {
      throwAssert(actual === expected, `expected ${format(actual)} toBe ${format(expected)}`);
      return this;
    },
    toBeTruthy() {
      throwAssert(Boolean(actual), `expected ${format(actual)} toBeTruthy`);
      return this;
    },
    toBeFalsy() {
      throwAssert(!actual, `expected ${format(actual)} toBeFalsy`);
      return this;
    },
    toBeNull() {
      throwAssert(actual === null, `expected ${format(actual)} toBeNull`);
      return this;
    },
    toBeUndefined() {
      throwAssert(actual === undefined, `expected ${format(actual)} toBeUndefined`);
      return this;
    },
    toBeGreaterThan(expected) {
      throwAssert(Number(actual) > Number(expected), `expected ${format(actual)} toBeGreaterThan ${format(expected)}`);
      return this;
    },
    toContain(expected) {
      throwAssert(
        actual && typeof actual.includes === 'function' && actual.includes(expected),
        `expected ${format(actual)} toContain ${format(expected)}`
      );
      return this;
    },
    toHaveLength(expected) {
      throwAssert(Array.isArray(actual) || typeof actual.length === 'number', `expected ${format(actual)} toHaveLength (not array-like)`);
      throwAssert(actual.length === expected, `expected ${format(actual)} toHaveLength ${format(expected)} (got ${actual.length})`);
      return this;
    },
    toMatchObject(expected) {
      if (expected && typeof expected === 'object') {
        for (const k of Object.keys(expected)) {
          throwAssert(
            Object.prototype.hasOwnProperty.call(actual, k) && actual[k] === expected[k],
            `expected property ${k} to be ${format(expected[k])}, got ${format(actual[k])}`
          );
        }
      }
      return this;
    },
    toEndWith(suffix) {
      throwAssert(
        typeof actual === 'string' && actual.endsWith(suffix),
        `expected ${format(actual)} toEndWith ${format(suffix)}`
      );
      return this;
    },
    toMatch(regex) {
      if (regex instanceof RegExp) {
        throwAssert(regex.test(actual), `expected ${format(actual)} toMatch ${format(regex)}`);
      } else {
        throwAssert(actual === regex, `expected ${format(actual)} toMatch ${format(regex)}`);
      }
      return this;
    },
    toBeLessThanOrEqual(value) {
      throwAssert(Number(actual) <= Number(value), `expected ${format(actual)} toBeLessThanOrEqual ${format(value)}`);
      return this;
    },
    toBeLessThan(value) {
      throwAssert(Number(actual) < Number(value), `expected ${format(actual)} toBeLessThan ${format(value)}`);
      return this;
    },
    not: new Proxy({}, {
        get (_, prop) {
          return function (...args) {
            const matcher = createExpect(actual);
            const method = matcher[prop];
            if (typeof method !== 'function') {
              throw new Error(`expect(x).not.${prop} is not a matcher`);
            }
            try {
              method.apply(matcher, args);
              throw new Error(`expected ${format(actual)} NOT to ${String(prop)} (but it did)`);
            } catch (e) {
              if (e.message && e.message.startsWith('expected')) {
                // the inner matcher failed (good for not): suppress
                return this;
              }
              throw e;
            }
          };
        }
      })
  };
}

function format(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'function') return '[Function]';
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch (_) { return '[Object]'; }
  }
  return String(v);
}

function captureLogs(fn) {
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => { logs.push({ type: 'log', args: args.map(format) }); originalLog.apply(console, args); };
  console.error = (...args) => { logs.push({ type: 'error', args: args.map(format) }); originalError.apply(console, args); };
  let result;
  let error;
  try {
    result = fn();
  } catch (e) {
    error = e;
  }
  console.log = originalLog;
  console.error = originalError;
  return { result, error, logs };
}

const Suite = new Map();
let currentDescribe = null;
let currentIt = null;
const failures = [];
const passes = [];
let totalTests = 0;

global.describe = function(name, fn) {
  const suite = { name, tests: [], setup: null, teardown: null, parent: currentDescribe };
  const prev = currentDescribe;
  currentDescribe = suite;
  try {
    fn();
  } finally {
    currentDescribe = prev;
  }
  if (suite.parent) {
    suite.parent.tests.push(suite);
  } else {
    Suite.set(name, suite);
  }
};

global.beforeEach = function(fn) {
  if (!currentDescribe) throw new Error('beforeEach outside describe');
  currentDescribe.setup = fn;
};

global.afterEach = function(fn) {
  if (!currentDescribe) throw new Error('afterEach outside describe');
  currentDescribe.teardown = fn;
};

global.it = function(name, fn) {
  if (!currentDescribe) throw new Error('it() outside describe()');
  currentDescribe.tests.push({ name, fn });
};

global.it.skip = function() {};
global.it.only = function() {};

global.expect = function(actual) {
  return createExpect(actual);
};

function runSuite(suite, depth) {
  if (suite.setup) {
    try { suite.setup(); } catch (e) {
      failures.push({ suite: suite.name, test: '(beforeEach)', error: e });
    }
  }
  for (const entry of suite.tests) {
    if (entry.tests) {
      runSuite(entry, depth + 1);
      continue;
    }
    totalTests++;
    const captured = captureLogs(() => {
      entry.fn();
    });
    if (captured.error) {
      failures.push({ suite: suite.name, test: entry.name, error: captured.error });
    } else {
      passes.push({ suite: suite.name, test: entry.name });
    }
  }
  if (suite.teardown) {
    try { suite.teardown(); } catch (e) {
      failures.push({ suite: suite.name, test: '(afterEach)', error: e });
    }
  }
  for (const child of suite.tests) {
    if (child.tests) {
      // already handled above
    }
  }
}

function runFile(file) {
  Suite.clear();
  totalTests = 0;
  failures.length = 0;
  passes.length = 0;
  const mod = require(file);
  // run top-level suites
  for (const [, suite] of Suite) {
    if (!suite.parent) {
      runSuite(suite, 0);
    }
  }
  return { passes, failures, total: totalTests };
}

function findTestFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== '.git' && e.name !== 'docs' && e.name !== '.agents') {
        files.push(...findTestFiles(p));
      }
    } else if (e.name.endsWith('.test.js')) {
      files.push(p);
    }
  }
  return files;
}

function report(results) {
  console.log(`\n  ${results.total} test${results.total === 1 ? '' : 's'}`);
  if (results.passes.length) {
    console.log(`  ${results.passes.length} passed`);
  }
  if (results.failures.length) {
    console.log(`  ${results.failures.length} failed`);
    for (const f of results.failures) {
      console.log(`  ✗ ${f.suite} › ${f.test}`);
      console.log(`    ${f.error.message}`);
    }
  }
  if (results.failures.length === 0) {
    console.log('  ✓ all passed');
  }
}

function run() {
  const dir = process.cwd();
  const files = findTestFiles(dir);
  if (files.length === 0) {
    console.log('No test files found.');
    process.exit(0);
  }
  let allPassed = true;
  for (const file of files) {
    console.log(`\n  ${path.relative(dir, file)}`);
    const results = runFile(file);
    report(results);
    if (results.failures.length > 0) allPassed = false;
  }
  console.log('');
  if (allPassed) {
    console.log('  ✓ all tests passed');
  } else {
    console.log('  ✗ some tests failed');
    process.exit(1);
  }
}

if (require.main === module) {
  run();
}

module.exports = { throwAssert, createExpect, format, captureLogs };
