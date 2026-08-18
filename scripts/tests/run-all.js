/**
 * Central Theatre Revenue — domain tests.
 *
 *     npm test
 *
 * These suites run the pure domain modules in src/lib with no database, no
 * network and no clock but the one they pass in. That is deliberate: the things
 * most worth testing here — that a split sums back to its total, that a payment
 * cannot reach SUCCESSFUL without proof, that a ledger entry balances — are
 * properties of arithmetic and rules, and a test that needs a live Postgres to
 * check them is a test nobody runs.
 *
 * A minimal vitest-compatible surface is provided so the suites can move to a
 * real runner later without being rewritten. TypeScript is compiled in-process.
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '../..');
const ts = require(path.join(ROOT, 'node_modules/typescript'));

let passed = 0;
let failed = 0;
const failures = [];
const stack = [];

// ---------------------------------------------------------------------------
// Minimal vitest-compatible surface
// ---------------------------------------------------------------------------
function makeExpect() {
  const fail = (msg) => { throw new Error(msg); };
  const show = (v) => {
    try { return JSON.stringify(v); } catch { return String(v); }
  };

  const matchers = (actual, negated) => {
    const check = (ok, describeExpectation) => {
      if (negated ? ok : !ok) {
        fail(`expected ${show(actual)}${negated ? ' NOT' : ''} ${describeExpectation}`);
      }
    };
    return {
      toBe: (e) => check(Object.is(actual, e) || actual === e, `to be ${show(e)}`),
      toEqual: (e) => check(JSON.stringify(actual) === JSON.stringify(e), `to equal ${show(e)}`),
      toBeNull: () => check(actual === null, 'to be null'),
      toBeUndefined: () => check(actual === undefined, 'to be undefined'),
      toBeDefined: () => check(actual !== undefined, 'to be defined'),
      toBeTruthy: () => check(Boolean(actual), 'to be truthy'),
      toBeFalsy: () => check(!actual, 'to be falsy'),
      toHaveLength: (n) => check(actual != null && actual.length === n,
        `to have length ${n} (got ${actual == null ? 'null' : actual.length})`),
      toContain: (x) => check(
        typeof actual === 'string' ? actual.includes(x) : Array.isArray(actual) && actual.includes(x),
        `to contain ${show(x)}`),
      toBeGreaterThan: (n) => check(actual > n, `to be > ${show(n)}`),
      toBeLessThan: (n) => check(actual < n, `to be < ${show(n)}`),
      toBeGreaterThanOrEqual: (n) => check(actual >= n, `to be >= ${show(n)}`),
      toBeLessThanOrEqual: (n) => check(actual <= n, `to be <= ${show(n)}`),
      toMatchObject: (e) => check(
        Object.entries(e).every(([k, v]) => JSON.stringify(actual?.[k]) === JSON.stringify(v)),
        `to match ${show(e)}`),
      toThrow: (expected) => {
        let threw = false;
        let message = '';
        try { actual(); } catch (err) { threw = true; message = err?.message ?? String(err); }
        if (negated) {
          if (threw) fail(`expected not to throw, but threw: ${message}`);
          return;
        }
        if (!threw) fail('expected function to throw, but it did not');
        if (expected instanceof RegExp && !expected.test(message)) {
          fail(`expected throw matching ${expected}, got "${message}"`);
        } else if (typeof expected === 'string' && !message.includes(expected)) {
          fail(`expected throw containing "${expected}", got "${message}"`);
        }
      },
    };
  };

  return (actual) => ({ ...matchers(actual, false), not: matchers(actual, true) });
}

function describe(name, fn) {
  stack.push(name);
  try { fn(); } finally { stack.pop(); }
}

function it(name, fn) {
  const label = [...stack, name].join(' > ');
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    failures.push(`${label}\n      ${err?.message ?? err}`);
  }
}

const VITEST = { describe, it, test: it, expect: makeExpect() };

// ---------------------------------------------------------------------------
// Load a TS module and its relative imports through the TypeScript compiler
// ---------------------------------------------------------------------------
const cache = new Map();
const LIB = path.join(ROOT, 'src/lib');

function resolveTs(absNoExt) {
  return [absNoExt, absNoExt + '.ts', path.join(absNoExt, 'index.ts')].find(
    (p) => fs.existsSync(p) && fs.statSync(p).isFile()
  );
}

function loadTs(absNoExt) {
  // Suites live in scripts/tests and import the modules by name ('./allocation'),
  // so an import that does not resolve beside the suite is looked up in src/lib.
  // The subdirectory is PRESERVED, so './payments/states' resolves rather than
  // being flattened to 'states'.
  const file =
    resolveTs(absNoExt) ||
    resolveTs(path.join(LIB, path.relative(__dirname, absNoExt))) ||
    resolveTs(path.join(LIB, path.basename(absNoExt)));
  if (!file) throw new Error(`cannot resolve ${absNoExt}`);
  if (cache.has(file)) return cache.get(file);

  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: file,
  }).outputText;

  const m = new Module(file);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  cache.set(file, m.exports);
  m.require = (id) => {
    if (id === 'vitest') return VITEST;
    if (id.startsWith('.')) return loadTs(path.resolve(path.dirname(file), id));
    if (id.startsWith('@/')) return loadTs(path.join(ROOT, 'src', id.slice(2)));
    if (Module.builtinModules.includes(id) || id.startsWith('node:')) return require(id);
    return require(path.join(ROOT, 'node_modules', id));
  };
  m._compile(js, file);
  cache.set(file, m.exports);
  return m.exports;
}

const SUITES = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.ts')).sort();

console.log(`Central Theatre Revenue — domain tests (${SUITES.length} suites)\n`);

for (const suite of SUITES) {
  const before = { passed, failed };
  try {
    loadTs(path.join(__dirname, suite));
  } catch (err) {
    failed++;
    failures.push(`${suite} (failed to load)\n      ${err?.stack ?? err?.message ?? err}`);
  }
  const p = passed - before.passed;
  const f = failed - before.failed;
  console.log(`  ${f ? 'FAIL' : 'ok  '}  ${suite.padEnd(26)} ${p} passed${f ? `, ${f} failed` : ''}`);
}

if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
