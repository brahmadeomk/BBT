'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FLOWS_PATH = path.join(__dirname, '..', 'flows', 'flows_BBT.json');
const nodes = JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'));
const byId = new Map(nodes.map((n) => [n.id, n]));

const one = (name) => {
  const hits = nodes.filter((n) => n.name === name);
  assert.equal(hits.length, 1, `expected exactly one node named "${name}", found ${hits.length}`);
  return hits[0];
};

/** Every node reachable from `startId` through wires and link in/out pairs. */
function reachable(startId) {
  const seen = new Set();
  const queue = [startId];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const n = byId.get(id);
    if (!n) continue;
    for (const out of n.wires || []) for (const t of out) queue.push(t);
    if (n.type === 'link out') for (const t of n.links || []) queue.push(t);
  }
  return seen;
}

// test/two-segment-flow-wiring.test.js covers the bus2 TRANSPORT (serial pair,
// per-segment Send Nano Job, bus tagging). This covers what has to be true for
// a bus2 fault to actually raise an alarm — a different and easier thing to
// break, because most of it is per-segment state that looks fine when shared.
describe('flows_BBT.json — bus2 alarm generation', () => {
  test('each segment has its OWN COMM watchdog', () => {
    // A single watchdog fed by both Nanos is satisfied while EITHER is talking,
    // so neither segment's total failure could raise a COMM alarm: a live bus2
    // would mask a dead bus1 and vice versa.
    const bus2wd = nodes.find((n) => n.type === 'trigger' && /COMM watchdog bus2/.test(n.name || ''));
    assert.ok(bus2wd, 'a bus2 COMM watchdog');
    assert.deepEqual(JSON.parse(bus2wd.op2), { commTimeout: true, busId: 'bus2' });
    assert.deepEqual(JSON.parse(bus2wd.op1), { commTimeout: false, busId: 'bus2' });

    const tag = one('Tag Bus2');
    assert.ok(reachable(tag.id).has(bus2wd.id), 'bus2 frames -> bus2 watchdog');
    assert.ok(
      !tag.wires[0].includes('13eadb263a74d6c2'),
      'bus2 must NOT feed bus1 Data Out, or it keeps bus1 watchdog alive while bus1 is dead'
    );
  });

  test('the Alarm Manager keys the COMM alarm by segment', () => {
    const am = nodes.find((n) => /Alarm Manager/.test(n.name || ''));
    assert.match(am.func, /const _commBus = msg\.payload\?\.busId;/);
    // bus1 (and any single-bus panel) must keep the original key, or its alarm
    // history and ACK state break
    assert.match(am.func, /: "SYSTEM\|MODULE\|COMM_FAILURE";/);
    assert.match(am.func, /COMM_FAILURE`/, 'and a derived key for any other segment');
    const bus2wd = nodes.find((n) => n.type === 'trigger' && /COMM watchdog bus2/.test(n.name || ''));
    assert.ok(bus2wd.wires[0].includes(am.id), 'bus2 watchdog -> Alarm Manager');
  });

  test('a blacklist resend names only the affected segment', () => {
    // The firmware re-inits its Modbus timeout on every job update, so
    // resending both segments for one device's failure disrupts the healthy one.
    const engine = one('Blacklist Engine');
    assert.match(engine.func, /res\.resendBusIds/);
    assert.match(engine.func, /busId,/);
    assert.match(engine.func, /busId:\s*msg\.bus_id/, 'and resolves the response within its bus');
  });

  test('each segment has its own USB power-cycle', () => {
    const rc = one('RECOVERY CONTROLLER');
    assert.equal(rc.outputs, 4, 'a 4th output for the bus2 exec');
    assert.match(rc.func, /planRecovery/, 'the ladder logic lives in /src, not here');
    const bus2Exec = one('USB power-cycle (bus2)');
    assert.deepEqual(rc.wires[3], [bus2Exec.id]);
    // bus1's exec keeps its hardcoded hub location; bus2's comes from the
    // controller (validated there), so it must be appended from the message
    assert.equal(bus2Exec.addpay, 'payload');
    assert.match(bus2Exec.command, /uhubctl/);
    assert.ok(!/-l\s+[0-9]/.test(bus2Exec.command), 'the hub location must not be hardcoded');
    assert.ok(reachable(bus2Exec.id).has(one('Send Nano Job (bus2)').id), 'recovery -> bus2 resend');
  });

  test('the bus2 silence watchdog retries, rather than firing once', () => {
    // A Node-RED `trigger` fires once and then needs an input to re-arm — and
    // its input is the very frame stream that has gone quiet, so a Nano that
    // missed the single resend would stay dark forever.
    const watchdog = one('Bus2 Silence Watchdog');
    assert.match(one('Tag Bus2').func, /flow\.set\('bus2_last_frame_ms'/);
    assert.match(watchdog.func, /flow\.get\('bus2_last_frame_ms'\)/);
    const tick = nodes.find((n) => n.type === 'inject' && n.wires[0]?.includes(watchdog.id));
    assert.ok(tick, 'a periodic inject drives the watchdog');
    assert.ok(Number(tick.repeat) > 0, 'and it repeats');
    assert.ok(reachable(watchdog.id).has(one('Send Nano Job (bus2)').id), 'watchdog -> bus2 resend');
  });

  test('each segment opens a stable per-port symlink, not a ttyACM name', () => {
    // ttyACM0/ttyACM1 are assigned in probe order and can swap across a reboot,
    // which would hand each segment the other's read list. Worse, the udev
    // symlinks are keyed on the same hub port that BUSDUCT_UHUBCTL_* cycles, so
    // reverting to ttyACM* also lets the polling identity drift out of step
    // with the recovery target — a COMM failure would then cycle the wrong Nano.
    const inUse = nodes
      .filter((n) => n.type === 'serial in' || n.type === 'serial out')
      .map((n) => byId.get(n.serial))
      .filter(Boolean);
    assert.ok(inUse.length >= 4, 'both segments have an in/out pair');
    for (const cfg of inUse) {
      assert.match(cfg.serialport, /^\/dev\/busduct-bus[12]$/, `${cfg.serialport} must be a stable symlink`);
    }
    assert.equal(new Set(inUse.map((c) => c.serialport)).size, 2, 'and the two segments differ');
  });

  test('the Diag status column expires instead of freezing on its last value', () => {
    // global.Status is written only when a frame arrives, so a device that
    // stopped being polled would keep reading "Connected" indefinitely — which
    // is exactly what a downed segment looks like on the Diagnostics page.
    const sink = byId.get('8324c8bf9d9f9126');
    assert.match(sink.func, /statusTs\[sID\] = Date\.now\(\);/, 'each status write is stamped');
    assert.match(sink.func, /global\.set\('StatusTs', statusTs\);/);
    const builder = byId.get('2aa9ec351622e3e9');
    assert.match(builder.func, /return 'No Data';/, 'a stale entry reads No Data');
    assert.doesNotMatch(builder.func, /Status:global\.get\('Status\[/, 'no unexpired raw read');
  });
});
