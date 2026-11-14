'use strict';

/**
 * dashboard-render.test.js — the regression test the battery was missing.
 *
 * The blank-dashboard incident (Nov 2026): a patch script rewrote
 * `lines.join('\\n')` in the CLIENT script (which lives inside a server-side
 * template literal) to `lines.join('\n')` — collapsing the escape into a real
 * newline inside a JS string literal. The whole client <script> became a
 * SyntaxError, so NOTHING on the dashboard executed and the page rendered
 * blank — while every Node-side test stayed green because they never
 * evaluated the served page's script.
 *
 * This suite closes that gap: it builds the real dashboard page with the
 * real widget registry (loaded plugins included) and does what the BROWSER
 * does, in order:
 *   1. extract every <script> block from the served HTML,
 *   2. JSON-parse the embedded WIDGETS / initialData / ALL_COMMANDS
 *      literals exactly as the client declares them,
 *   3. vm.Script-COMPILE each full script block (real syntax check, with
 *      line-numbered errors),
 *   4. compile every widget's render function with new Function (the
 *      client's exact compile step),
 *   5. execute the whole script in a DOM-stubbed vm context and assert the
 *      widget cards got built (the client's actual boot path, minus real
 *      DOM layout),
 *   6. assert the known escape-collision sites still carry their escapes.
 *
 * Run: node test/dashboard-render.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function run() {
  for (const { name, fn } of tests) {
    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error('TEST TIMEOUT (5s)')), 5000);
    });
    try {
      await Promise.race([fn(), timeout]);
      passed++; console.log(`  ok  ${name}`);
    } catch (e) {
      failed++; console.error(`  FAIL ${name}\n      ${e.message}`);
    } finally { clearTimeout(timer); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

// ── Shared fixture: the real page HTML ─────────────────────────────────────
process.env.DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'test-pass-123';
const { buildDashboardPage } = require('../src/dashboard/views/dashboard-page');
// Load real plugins so the widget registry matches production (includes the
// connections widget, all render strings, etc).
require('../src/plugins/index').loadPlugins();

const html = buildDashboardPage();
const scriptBlocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);

test('served page has exactly one client script block', () => {
  assert.strictEqual(scriptBlocks.length, 1, `expected 1 <script> block, got ${scriptBlocks.length}`);
});

test('client script compiles in V8 with real line numbers (blank-page regression)', () => {
  // This is THE test that would have caught the incident: a real newline
  // inside a string literal anywhere in the client script fails here with
  // the exact line number.
  for (const [i, s] of scriptBlocks.entries()) {
    try { new vm.Script(s, { filename: `dashboard-script-${i}.js` }); }
    catch (e) {
      const at = (e.stack || '').split('\n').filter(l => l.includes('dashboard-script')).join(' | ');
      assert.fail(`script block ${i} does not compile: ${e.message} ${at}`);
    }
  }
});

test('embedded WIDGETS / initialData / ALL_COMMANDS literals are valid JSON', () => {
  const s = scriptBlocks[0];
  for (const name of ['WIDGETS', 'initialData', 'ALL_COMMANDS']) {
    const re = new RegExp(`const ${name}\\s*= (.*?);\\n`, 's');
    const m = s.match(re);
    assert.ok(m, `const ${name} literal not found`);
    let v;
    try { v = JSON.parse(m[1]); }
    catch (e) { assert.fail(`${name} literal is invalid JSON: ${e.message}`); }
    assert.ok(v !== null && typeof v === 'object', `${name} parsed to an object`);
  }
});

test('every widget render function compiles via new Function (client compile step)', () => {
  const s = scriptBlocks[0];
  const m = s.match(/const WIDGETS\s*= (.*?);\n/s);
  const widgets = JSON.parse(m[1]);
  assert.ok(widgets.length >= 10, `expected >=10 widgets, got ${widgets.length}`);
  for (const w of widgets) {
    try { new Function('return (' + w.render + ')')(); }
    catch (e) { assert.fail(`render for '${w.id}' does not compile: ${e.message}`); }
  }
});

test('full client script executes against a DOM stub and builds widget cards', () => {
  // Minimal DOM stub — enough for the client boot path: getElementById,
  // createElement, querySelector on cards, addEventListener, classList.
  function makeEl(tag) {
    const el = {
      tagName: tag, children: [], style: { setProperty() {}, removeProperty() {} }, dataset: {},
      _inner: '', _text: '', className: '', id: '', title: '', href: '',
      classList: { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } },
      addEventListener() {}, removeEventListener() {},
      appendChild(c) { el.children.push(c); return c; },
      removeChild() {}, remove() {},
      setAttribute() {}, getAttribute() { return null; },
      querySelector() { return makeEl('div'); },
      querySelectorAll() { return []; },
      contains() { return false; },
      focus() {},
    };
    Object.defineProperty(el, 'innerHTML', {
      get() { return el._inner; },
      set(v) { el._inner = String(v); el.children = []; },
    });
    Object.defineProperty(el, 'textContent', {
      get() { return el._text; },
      set(v) { el._text = String(v); },
    });
    return el;
  }
  const elements = new Map();
  const document = {
    title: '',
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeEl('div'));
      return elements.get(id);
    },
    createElement(tag) { return makeEl(tag); },
    querySelector() { return makeEl('div'); },
    querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
    body: makeEl('body'),
  };
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const sandbox = {
    document,
    window: { addEventListener() {}, location: { href: '', reload() {} }, localStorage: storage },
    localStorage: storage,
    setTimeout, clearTimeout, setInterval, clearInterval,
    console: { log() {}, warn() {}, error() {}, info() {} },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    EventSource: function () { this.onopen = null; this.onmessage = null; this.onerror = null; this.close = () => {}; },
    navigator: { userAgent: 'test' },
    location: { href: '', reload() {} },
  };
  sandbox.window.localStorage = storage;
  vm.createContext(sandbox);
  // Execute exactly like a browser would (wrap so top-level (function(){})() runs).
  const script = new vm.Script(scriptBlocks[0], { filename: 'dashboard-exec.js' });
  script.runInContext(sandbox);
  // The client boot builds all widget cards into #widget-grid — count children.
  const grid = elements.get('widget-grid');
  assert.ok(grid, 'widget-grid element was requested by the client script');
  assert.ok(grid.children.length >= 10,
    `expected >=10 built widget cards, got ${grid.children.length} — client boot failed silently`);
});

test('escape-collision sites keep their backslashes (incident root cause)', () => {
  const s = scriptBlocks[0];
  // The incident: lines.join('\n') in SOURCE template → real newline in the
  // served client script. In the served script it must appear as the
  // two-character sequence backslash + n INSIDE the string literal:
  assert.ok(s.includes("lines.join('\\n')"),
    "lines.join escape collapsed again — served script has a raw newline in a string literal");
  // No raw control characters inside string literals: any literal U+0000-U+0009
  // other than structured newlines between statements is a red flag. Cheap
  // proxy: script must round-trip through vm compile (covered above) AND the
  // source file must carry the escaped form:
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/dashboard/views/dashboard-page.js'), 'utf8');
  assert.ok(src.includes("lines.join('\\\\n')"),
    'source lost the double-backslash — a template-literal rewriter collapsed escapes');
});

test('widget icons are sanitized, not blanket-escaped (SVG-as-text regression)', () => {
  // Incident 2 (Nov 2026): the first XSS fix (escIcon) escaped ALL icon
  // content, but 14 of 15 real widget icons are <svg> markup — so headers
  // rendered literal '<svg width="20"…>' text. The replacement is
  // iconHtml(): strict allowlist parser. These assertions pin it.
  const s = scriptBlocks[0];
  assert.ok(s.includes('function iconHtml'), 'iconHtml helper present in client script');
  assert.ok(s.includes('iconHtml(w.icon)'), 'widget card icons go through iconHtml');
  assert.ok(s.includes('iconHtml(w.icon)'), 'dropdown icons go through iconHtml');
  assert.ok(!s.includes("' + w.icon          + '"), 'no raw w.icon interpolation remains');
  assert.ok(!s.includes('function escIcon'), 'blanket escIcon must not come back');
  assert.ok(!s.includes('escIcon(w.icon)'), 'no escIcon call sites remain');
});

test('iconHtml passes safe SVG and escapes everything else', () => {
  // Reuse the exact iconHtml the client receives: extract + eval it in a vm.
  const s = scriptBlocks[0];
  const helper = 'function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}';
  const block = s.slice(s.indexOf('const _ICON_TAG_OK'), s.indexOf('  // Build widget cards'));
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(helper + '\n' + block, ctx);

  const goodSvg = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16v16H4z"/></svg>';
  assert.strictEqual(ctx.iconHtml(goodSvg), goodSvg, 'safe SVG must pass through byte-identical');
  assert.strictEqual(ctx.iconHtml('🔗'), '🔗', 'emoji must pass through unchanged');

  const hostile = [
    '<svg onload="alert(1)"><path d="M0 0"/></svg>',
    '<svg><foreignObject><iframe src="x"></iframe></foreignObject></svg>',
    '<svg><script>alert(1)</script></svg>',
    '<svg width=20></svg>',
    '<svg><use href="evil.svg"/></svg>',
    "<svg width='20'></svg>",
    '<svg></svg> HOOK',
    '<svg><rect width="1" height="1" onmouseover="x"/></svg>',
    '<svg style="fill:url(#x)"><path d="M0 0"/></svg>',
  ];
  for (const h of hostile) {
    const out = ctx.iconHtml(h);
    assert.ok(String(out).includes('&lt;'),
      `hostile icon must be escaped, got: ${out.slice(0, 60)}`);
  }
});

test('every registered widget icon renders as markup, not escaped text', () => {
  // The 14 real SVG icons (incl. sub-counter's <text COUNT> variant) and the
  // emoji icon must all pass iconHtml unmodified — otherwise the dashboard
  // shows '<svg …>' text in headers again.
  const s = scriptBlocks[0];
  const helper = 'function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}';
  const block = s.slice(s.indexOf('const _ICON_TAG_OK'), s.indexOf('  // Build widget cards'));
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(helper + '\n' + block, ctx);
  const reg = require('../src/dashboard/widget-registry');
  const sorted = reg.getSortedWidgets().sort((a, b) => a.order - b.order);
  assert.ok(sorted.length >= 15, `expected >=15 widgets, got ${sorted.length}`);
  for (const w of sorted) {
    const icon = String(w.icon || '');
    const out = ctx.iconHtml(icon);
    assert.strictEqual(out, icon.trim(),
      `icon of '${w.id}' got blocked by the sanitizer: ${icon.slice(0, 70)}`);
  }
});

run();
