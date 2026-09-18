'use strict';

/**
 * The on-screen keyboard policy, and the guarantee that what runs in the
 * browser is what is tested here.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createOskPolicy, isTextEntry } = require('../../src/hmi/osk-policy');

const FLOWS_PATH = path.join(__dirname, '..', '..', 'flows', 'flows_BBT.json');
const POLICY_PATH = path.join(__dirname, '..', '..', 'src', 'hmi', 'osk-policy.js');

const field = (over = {}) => ({ tag: 'INPUT', type: 'text', ...over });

describe('isTextEntry - what deserves a keyboard', () => {
  test('the field types the config tables actually use', () => {
    for (const type of ['text', 'password', 'number', 'email', 'tel', 'search', 'url', '']) {
      assert.equal(isTextEntry(field({ type })), true, type || '(no type)');
    }
    assert.equal(isTextEntry({ tag: 'TEXTAREA' }), true);
    assert.equal(isTextEntry({ tag: 'DIV', isContentEditable: true }), true);
    assert.equal(isTextEntry({ tag: 'INPUT' }), true, 'a bare <input> defaults to text');
  });

  test('a control with its own picker or a click target does NOT raise it', () => {
    // Raising a keyboard over these is worse than not raising one: it covers the
    // control the operator is reaching for.
    for (const type of ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'date', 'time']) {
      assert.equal(isTextEntry(field({ type })), false, type);
    }
    assert.equal(isTextEntry({ tag: 'SELECT' }), false, 'the Alarm Profile dropdown is not typed into');
    assert.equal(isTextEntry({ tag: 'BUTTON' }), false);
  });

  test('read-only and disabled fields are not typed into either', () => {
    // The joint table renders every cell as an input and toggles readOnly on
    // EDIT - so without this, merely tapping a row would raise the keyboard.
    assert.equal(isTextEntry(field({ readOnly: true })), false);
    assert.equal(isTextEntry(field({ disabled: true })), false);
  });

  test('nothing, or a malformed descriptor, is not a text field', () => {
    assert.equal(isTextEntry(null), false);
    assert.equal(isTextEntry(undefined), false);
    assert.equal(isTextEntry({}), false);
  });

  test('type matching is case-insensitive, as HTML is', () => {
    assert.equal(isTextEntry({ tag: 'input', type: 'TEXT' }), true);
  });
});

describe('policy - show', () => {
  test('focusing a text field raises it once', () => {
    const p = createOskPolicy();
    assert.equal(p.focus(field(), 0).command, 'show');
    assert.equal(p.isVisible(), true);
  });

  test('moving between fields says NOTHING rather than re-showing', () => {
    // Each command is one exec spawn on the Pi. Tabbing across the 9 columns of
    // the joint table would otherwise fire nine.
    const p = createOskPolicy();
    p.focus(field(), 0);
    for (let t = 100; t < 900; t += 100) {
      assert.equal(p.focus(field(), t).command, null, `t=${t}`);
    }
  });

  test('focusing a non-text control never raises it', () => {
    const p = createOskPolicy();
    assert.equal(p.focus({ tag: 'BUTTON' }, 0).command, null);
    assert.equal(p.isVisible(), false);
  });
});

describe('policy - the delayed hide', () => {
  test('a blur only ARMS the hide, and reports when to tick', () => {
    const p = createOskPolicy({ hideDelayMs: 400 });
    p.focus(field(), 0);
    const r = p.blur(1000);
    assert.equal(r.command, null, 'still up');
    assert.equal(r.nextTickMs, 1400);
    assert.equal(p.isVisible(), true);
  });

  test('the tick hides it once the window has passed', () => {
    const p = createOskPolicy({ hideDelayMs: 400 });
    p.focus(field(), 0);
    p.blur(1000);
    assert.equal(p.tick(1399).command, null, 'not yet');
    assert.equal(p.tick(1400).command, 'hide');
    assert.equal(p.isVisible(), false);
  });

  test('focusing another field inside the window CANCELS the hide', () => {
    // This is the whole reason for the delay: field -> field fires focusout
    // then focusin, and an immediate hide would flap on every cell.
    const p = createOskPolicy({ hideDelayMs: 400 });
    p.focus(field(), 0);
    p.blur(1000);
    assert.equal(p.focus(field(), 1100).command, null);
    assert.equal(p.tick(2000).command, null, 'the armed hide is gone');
    assert.equal(p.isVisible(), true);
  });

  test('focus moving to a BUTTON also arms the hide, rather than doing nothing', () => {
    // Tapping APPLY should put the keyboard away - but through the same armed
    // path, so a spinner tapped between two fields does not flap it.
    const p = createOskPolicy({ hideDelayMs: 400 });
    p.focus(field(), 0);
    const r = p.focus({ tag: 'BUTTON' }, 1000);
    assert.equal(r.command, null);
    assert.equal(r.nextTickMs, 1400);
    assert.equal(p.tick(1400).command, 'hide');
  });

  test('a blur while hidden is a no-op, and arms nothing', () => {
    const p = createOskPolicy();
    const r = p.blur(500);
    assert.equal(r.command, null);
    assert.equal(r.nextTickMs, null);
  });

  test('a stray tick never hides a keyboard that was not armed', () => {
    const p = createOskPolicy();
    p.focus(field(), 0);
    assert.equal(p.tick(99999).command, null);
    assert.equal(p.isVisible(), true);
  });
});

describe('policy - putting it away deliberately', () => {
  test('done() hides immediately, with no window', () => {
    const p = createOskPolicy();
    p.focus(field(), 0);
    assert.equal(p.done().command, 'hide');
    assert.equal(p.isVisible(), false);
  });

  test('done() while hidden emits nothing', () => {
    assert.equal(createOskPolicy().done().command, null);
  });

  test('a hidden page never leaves the keyboard up', () => {
    const p = createOskPolicy();
    p.focus(field(), 0);
    assert.equal(p.pageHidden().command, 'hide');
  });

  test('done() also disarms a pending hide, so no second hide follows', () => {
    const p = createOskPolicy({ hideDelayMs: 400 });
    p.focus(field(), 0);
    p.blur(1000);
    assert.equal(p.done().command, 'hide');
    assert.equal(p.tick(5000).command, null, 'must not hide twice');
  });
});

describe('policy - on demand', () => {
  test('toggle raises it with no field focused, and puts it back', () => {
    const p = createOskPolicy();
    assert.equal(p.toggle().command, 'show');
    assert.equal(p.toggle().command, 'hide');
  });

  test('a manually-raised keyboard still hides on a blur', () => {
    const p = createOskPolicy({ hideDelayMs: 400 });
    p.toggle();
    p.blur(1000);
    assert.equal(p.tick(1400).command, 'hide');
  });

  test('syncVisible recovers when the operator closed it from onboard itself', () => {
    // Without this the policy believes it is still up and never sends another
    // show - the keyboard would appear dead until the page reloaded.
    const p = createOskPolicy();
    p.focus(field(), 0);
    p.syncVisible(false);
    assert.equal(p.focus(field(), 100).command, 'show');
  });
});

describe('the browser copy is the tested copy', () => {
  // The policy ships inside a ui_template in flows_BBT.json because a global
  // dashboard template cannot require() anything. That is a duplicate, so it is
  // pinned: edit src/hmi/osk-policy.js without regenerating the flow and this
  // fails, rather than the panel quietly running last month's policy.
  const watcher = () => {
    const flows = JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'));
    const node = flows.find((n) => n.name === 'OSK Focus Watcher');
    assert.ok(node, 'the OSK Focus Watcher global ui_template must exist');
    return node;
  };

  test('the embedded policy source is byte-identical to src/hmi/osk-policy.js', () => {
    const source = fs.readFileSync(POLICY_PATH, 'utf8');
    assert.ok(
      watcher().format.includes(source.trim()),
      'flows_BBT.json is out of date - run: node tools/sync-osk-policy.js'
    );
  });

  test('it is a GLOBAL template, or it only runs on one dashboard page', () => {
    assert.equal(watcher().templateScope, 'global');
  });
});

describe('the generated browser bundle actually runs', () => {
  // The glue in tools/sync-osk-policy.js is the one piece that is not a plain
  // module, and CLAUDE.md notes that ui_template JS is exercised by nothing in
  // this suite. It is small, but it is also the piece that decides whether the
  // keyboard appears at all - so it is loaded into a vm with a fake document
  // and driven. Catches a syntax error or a renamed listener before the panel does.
  const vm = require('node:vm');

  function bundle() {
    const flows = JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'));
    const node = flows.find((n) => n.id === '05c0a11b0a5d0001');
    return [...node.format.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  }

  function boot() {
    const doc = { handlers: {}, hidden: false, addEventListener(t, h) { this.handlers[t] = h; } };
    const calls = [];
    const sandbox = {
      document: doc, console, setTimeout, clearTimeout, Date, Math,
      fetch: (u) => { calls.push(u); return Promise.resolve(); },
    };
    sandbox.self = sandbox;
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    for (const s of bundle()) vm.runInContext(s, sandbox);
    return { doc, calls, win: sandbox.window };
  }

  const el = (tagName, over = {}) => ({
    tagName, getAttribute: (a) => (a === 'type' ? (over.type ?? null) : null),
    readOnly: !!over.readOnly, disabled: !!over.disabled, isContentEditable: !!over.isContentEditable,
  });

  test('every script block parses', () => {
    for (const [i, src] of bundle().entries()) {
      assert.doesNotThrow(() => new vm.Script(src), `block ${i}`);
    }
  });

  test('it attaches the four listeners it needs', () => {
    const { doc } = boot();
    for (const ev of ['focusin', 'focusout', 'keydown', 'visibilitychange']) {
      assert.equal(typeof doc.handlers[ev], 'function', ev);
    }
  });

  test('the policy and the on-demand hook reach window', () => {
    const { win } = boot();
    assert.equal(typeof win.BusductOskPolicy.createOskPolicy, 'function');
    assert.equal(typeof win.onBusductKeyboard, 'function', 'a dashboard button calls this');
  });

  test('focusing a text field POSTs exactly one show', async () => {
    const { doc, calls } = boot();
    doc.handlers.focusin({ target: el('INPUT', { type: 'text' }) });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(calls, ['/osk/show']);
  });

  test('focusing a button POSTs nothing', async () => {
    const { doc, calls } = boot();
    doc.handlers.focusin({ target: el('BUTTON') });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(calls, []);
  });

  test('tabbing between fields does not re-POST', async () => {
    const { doc, calls } = boot();
    for (let i = 0; i < 5; i += 1) {
      doc.handlers.focusout({});
      doc.handlers.focusin({ target: el('INPUT', { type: 'number' }) });
    }
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(calls, ['/osk/show'], 'one show for the whole row');
  });

  test('Enter puts it away', async () => {
    const { doc, calls } = boot();
    doc.handlers.focusin({ target: el('INPUT', { type: 'text' }) });
    doc.handlers.keydown({ key: 'Enter', shiftKey: false });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(calls, ['/osk/show', '/osk/hide']);
  });

  test('leaving a field hides it once the window elapses', async () => {
    const { doc, calls } = boot();
    doc.handlers.focusin({ target: el('INPUT', { type: 'text' }) });
    doc.handlers.focusout({});
    await new Promise((r) => setTimeout(r, 550));
    assert.deepEqual(calls, ['/osk/show', '/osk/hide']);
  });

  test('a hide decided while a show is in flight is not lost', async () => {
    // The bug this pins: an `inflight` guard that simply dropped the second
    // command left the keyboard up over the field the operator had just left.
    const { doc, calls, win } = boot();
    let release;
    win.fetch = (u) => { calls.push(u); return new Promise((r) => { release = r; }); };
    doc.handlers.focusin({ target: el('INPUT', { type: 'text' }) });
    doc.handlers.keydown({ key: 'Enter', shiftKey: false });   // decided while show is pending
    assert.deepEqual(calls, ['/osk/show']);
    release();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(calls, ['/osk/show', '/osk/hide']);
  });
});
