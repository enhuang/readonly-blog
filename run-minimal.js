const h = require('./test-harness');
const fs = require('fs');
const path = require('path');

const Suite = new Map();
let currentDescribe = null;

global.describe = function (name, fn) {
  const s = { name, tests: [], setup: null, teardown: null, parent: currentDescribe };
  const p = currentDescribe;
  currentDescribe = s;
  try { fn(); } finally { currentDescribe = p; }
  if (s.parent) s.parent.tests.push(s);
  else Suite.set(name, s);
};
global.beforeEach = function (fn) {
  if (!currentDescribe) throw new Error('bce');
  currentDescribe.setup = fn;
};
global.afterEach = function (fn) {
  if (!currentDescribe) throw new Error('ace');
  currentDescribe.teardown = fn;
};
global.it = function (name, fn) {
  if (!currentDescribe) throw new Error('it');
  currentDescribe.tests.push({ name, fn });
};
global.expect = function (a) { return h.createExpect(a); };

function runSuite(suite) {
  if (suite.setup) { try { suite.setup(); } catch (e) { return [null, e]; } }
  const results = [];
  for (const e of suite.tests) {
    if (e.tests) { results.push(runSuite(e)); continue; }
    try { e.fn(); results.push([e.name, null]); }
    catch (e) { results.push([e.name, e]); }
  }
  if (suite.teardown) { try { suite.teardown(); } catch (e) { /* ignore */ } }
  return results;
}

function runFile(file) {
  Suite.clear();
  delete require.cache[require.resolve(file)];
  require(file);
  let total = 0, passes = 0, fails = 0;
  const details = [];
  for (const [, suite] of Suite) {
    if (!suite.parent) {
      const results = runSuite(suite);
      for (const [name, err] of results) {
        total++;
        if (err) { fails++; details.push([suite.name, name, err.message]); }
        else passes++;
      }
    }
  }
  return { total, passes, fails, details };
}

const dir = process.cwd();
function find(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git' && e.name !== 'docs' && e.name !== '.agents')
      out.push(...find(p));
    else if (e.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

for (const f of find(dir)) {
  console.log('\n' + path.relative(dir, f));
  const r = runFile(f);
  console.log(r.total + ' tests, ' + r.passes + ' passed, ' + r.fails + ' failed');
  for (const [suite, name, msg] of r.details) {
    console.log('  FAIL ' + suite + ' > ' + name + ': ' + msg);
  }
}
