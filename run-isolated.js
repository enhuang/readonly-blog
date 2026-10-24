const h = require('./test-harness');
const fs = require('fs');
const path = require('path');

const Suite = new Map();
let cd = null;

global.describe = function (n, fn) {
  const s = { n, tests: [], setup: null, teardown: null, parent: cd };
  const p = cd;
  cd = s;
  try { fn(); } finally { cd = p; }
  if (s.parent) s.parent.tests.push(s);
  else Suite.set(n, s);
};
global.beforeEach = function (fn) {
  if (!cd) throw new Error('bce');
  cd.setup = fn;
};
global.afterEach = function (fn) {
  if (!cd) throw new Error('ace');
  cd.teardown = fn;
};
global.it = function (n, fn) {
  if (!cd) throw new Error('it');
  cd.tests.push({ n, fn });
};
global.expect = function (a) { return h.createExpect(a); };

function rs(s) {
  if (s.setup) try { s.setup(); } catch (e) { /* ignore */ }
  const r = [];
  for (const e of s.tests) {
    if (e.tests) { r.push(rs(e)); continue; }
    try { e.fn(); r.push([e.n, null]); }
    catch (e) { r.push([e.n, e]); }
  }
  if (s.teardown) try { s.teardown(); } catch (e) { /* ignore */ }
  return r;
}

function rf(file) {
  Suite.clear();
  delete require.cache[require.resolve(file)];
  require(file);
  let tot = 0, pas = 0, fai = 0;
  for (const [, s] of Suite) {
    if (!s.parent) {
      for (const [e, err] of rs(s)) {
        tot++;
        if (err) { fai++; console.log('FAIL ' + s.n + ' > ' + e.n + ': ' + err.message); }
        else pas++;
      }
    }
  }
  console.log(tot + ' tests, ' + pas + ' passed, ' + fai + ' failed');
}

const target = process.argv[2] || './slugify.test.js';
console.log('=== ' + path.resolve(target) + ' ===');
rf(target);
console.log('done, heap used:', (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1) + ' MB');
