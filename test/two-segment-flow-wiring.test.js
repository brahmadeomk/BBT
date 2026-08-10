'use strict';

/**
 * Guards the two-segment RS-485 wiring in flows_BBT.json (Slice 10 §B).
 *
 * The flow is edited as JSON by tooling and imported by hand into Node-RED, so
 * nothing else catches a segment that has been silently half-wired - and a
 * half-wired segment does not fail loudly, it just stops polling half the
 * panel. These assertions encode the properties that make two Nanos safe to run
 * side by side; each one corresponds to a way the design can be broken by an
 * innocent-looking edit.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const nodes = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'flows', 'flows_BBT.json'), 'utf8'));
const byId = new Map(nodes.map((n) => [n.id, n]));
const sendJobs = nodes.filter((n) => n.type === 'function' && /^Send Nano Job/.test(n.name || ''));

describe('two-segment RS-485 flow wiring', () => {
  test('each segment has its own Send Nano Job naming its bus as a LITERAL', () => {
    assert.equal(sendJobs.length, 2, 'one Send Nano Job per segment');
    const buses = sendJobs.map((n) => n.func.match(/const MY_BUS = '([^']+)'/)?.[1]);
    assert.deepEqual(buses.sort(), ['bus1', 'bus2']);

    // Function nodes have NO per-node environment: env.get() resolves from the
    // enclosing group, then the tab. Both nodes are on the same tab, so an env
    // var could never differ between them - reading the bus id from env would
    // silently give both segments the same identity.
    for (const n of sendJobs) {
      assert.ok(!/env\.get\(\s*['"]BUSDUCT_BUS_ID/.test(n.func),
        `${n.name} must not take its bus id from env - both nodes share one tab's env`);
    }
  });

  test('a Send Nano Job drops a resend addressed to the other segment', () => {
    for (const n of sendJobs) {
      assert.match(n.func, /msg\.busId\s*&&\s*msg\.busId\s*!==\s*MY_BUS/,
        `${n.name} must ignore a resend for another bus (the firmware re-inits its Modbus timeout on every job update)`);
    }
  });

  test('every resend source reaches BOTH segments', () => {
    // The per-bus filter above is only safe if both nodes actually receive the
    // message; wiring a resend to one segment only silently strands the other.
    const targets = (n) => new Set((n.wires || []).flat());
    for (const src of nodes.filter((n) => /Resend Nano Job/.test(n.name || ''))) {
      const t = targets(src);
      for (const job of sendJobs) {
        assert.ok(t.has(job.id), `${src.type} '${src.name}' must feed ${job.name}`);
      }
    }
  });

  test('the two segments are on different serial ports', () => {
    const serialNodes = nodes.filter((n) => n.type === 'serial in' || n.type === 'serial out');
    const ports = new Map();
    for (const n of serialNodes) {
      const cfg = byId.get(n.serial);
      assert.ok(cfg, `${n.type} ${n.id} references a missing serial-port config`);
      ports.set(cfg.id, cfg.serialport);
    }
    const distinct = new Set(ports.values());
    assert.equal(distinct.size, ports.size, `each Nano needs its own port, got ${[...ports.values()].join(', ')}`);
  });

  test('bus2 responses are tagged before they reach the shared decode chain', () => {
    const tag = nodes.find((n) => n.type === 'function' && n.name === 'Tag Bus2');
    assert.ok(tag, 'bus2 needs a tap that stamps its segment');
    // Top-level msg property: payload is still a raw string at the serial edge,
    // and the json node downstream rewrites payload but leaves msg alone.
    assert.match(tag.func, /msg\.bus_id\s*=\s*'bus2'/);

    const bus2SerialIn = nodes.find((n) => n.type === 'serial in' && n.name === 'bus2 Nano in');
    assert.deepEqual((bus2SerialIn.wires || []).flat(), [tag.id],
      'the bus2 serial in must feed ONLY the tag - an untagged path would reach the blacklist tap');

    const engine = byId.get('d9b1ac57e0f10002');
    assert.match(engine.func, /busId:\s*msg\.bus_id/,
      'the Blacklist Engine must pass the tag through as ctx.busId');
  });

  test('each segment has its own serial-silence watchdog', () => {
    // Sharing one watchdog would let bus2 traffic keep bus1 looking alive.
    const bus1In = nodes.find((n) => n.type === 'serial in' && n.serial === 'b4162a7f8dcb9f60');
    const tag = nodes.find((n) => n.type === 'function' && n.name === 'Tag Bus2');
    const triggersOf = (n) => (n.wires || []).flat().map((id) => byId.get(id)).filter((t) => t && t.type === 'trigger');

    const t1 = triggersOf(bus1In);
    const t2 = triggersOf(tag);
    assert.equal(t1.length, 1, 'bus1 has exactly one watchdog');
    assert.equal(t2.length, 1, 'bus2 has exactly one watchdog');
    assert.notEqual(t1[0].id, t2[0].id, 'the segments must not share a watchdog');

    // bus2's watchdog recovers via its own compiled job, not the legacy
    // paraRaw read-job builder (which is bus1-only by design).
    const bus2Job = sendJobs.find((n) => n.func.includes("MY_BUS = 'bus2'"));
    assert.ok((t2[0].wires || []).flat().includes(bus2Job.id),
      "bus2's watchdog must resend bus2's own job");
  });
});
