'use strict';

/**
 * Device health as a published message (design review EC-2). The panel already
 * computed all of this for its own HMI; these tests cover the part that was
 * missing - getting it off the panel, in a shape a fleet view can trust.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildDeviceHealth, buildBusHealth, DeviceHealthPublisher, DEFAULT_BUS_SILENCE_SEC,
} = require('../../src/cloud-gateway/device-health');
const { MESSAGE_TYPES } = require('../../src/cloud-gateway/message-types');
const { Outbox } = require('../../src/cloud-gateway/outbox');
const { LoopbackTransport } = require('../../src/cloud-gateway/transport');
const { summarizeBlacklist } = require('../../src/config-service/node-red/blacklist-handler');

const NOW = Date.parse('2026-08-27T10:00:00.000Z');

function freshOutbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-health-test-'));
  return new Outbox({ dir, transport: new LoopbackTransport() });
}

const doc = () => ({
  modbus: {
    buses: [
      { bus_id: 'bus1', type: 'rtu', port: '/dev/busduct-bus1' },
      { bus_id: 'bus2', type: 'rtu', port: '/dev/busduct-bus2' },
    ],
    slaves: [
      { slave_id: 'sl01', bus_id: 'bus1', unit_address: 1, channels: 2, label: 'SCM_1' },
      { slave_id: 'sl02', bus_id: 'bus2', unit_address: 50, channels: 1, label: 'SCM_50' },
      { slave_id: 'sl21', bus_id: 'bus1', unit_address: 101, channels: 1, label: 'AMBIENT_101' },
    ],
  },
  joints: [
    { joint_id: 'J01', slave_id: 'sl01', channel: 1, zone_id: 'z1', enabled: true },
    { joint_id: 'J02', slave_id: 'sl01', channel: 2, zone_id: 'z1', enabled: true },
    { joint_id: 'J03', slave_id: 'sl02', channel: 1, zone_id: 'z2', enabled: true },
  ],
  zones: [{ zone_id: 'z1', ambient_sensor: { slave_id: 'sl21', channel: 1 } }, { zone_id: 'z2' }],
});

// A panel with sl02 blacklisted and J03 consequently dark.
const troubledState = () => ({
  updatedTs: '2026-08-27T09:59:00.000Z',
  slaves: {
    sl01: { status: 'active', fails: 0, goods: 0 },
    sl02: { status: 'blacklisted', fails: 3, goods: 0, nextProbeMs: NOW + 45_000 },
    sl21: { status: 'active', fails: 0, goods: 0 },
  },
  joints: {
    J01: { slave_id: 'sl01', state: 'LIVE' },
    J02: { slave_id: 'sl01', state: 'LIVE' },
    J03: { slave_id: 'sl02', state: 'OFFLINE' },
  },
});

const healthy = () => ({
  updatedTs: '2026-08-27T09:59:00.000Z',
  slaves: { sl01: { status: 'active' }, sl02: { status: 'active' }, sl21: { status: 'active' } },
  joints: {
    J01: { slave_id: 'sl01', state: 'LIVE' },
    J02: { slave_id: 'sl01', state: 'LIVE' },
    J03: { slave_id: 'sl02', state: 'LIVE' },
  },
});

// busSeen defaults RELATIVE to nowMs: on a live panel the frame stamps advance
// with the clock. Holding them fixed while time moves is a bus going silent -
// a real state change, and the subject of its own test below.
const build = (state, over = {}) => {
  const nowMs = over.nowMs ?? NOW;
  return buildDeviceHealth({
    summary: summarizeBlacklist(state, nowMs, { doc: doc() }),
    doc: doc(),
    busSeen: { bus1: nowMs - 500, bus2: nowMs - 800 },
    nowMs,
    ...over,
  });
};

describe('device_health - the snapshot', () => {
  test('is typed, timestamped, and counts what the fleet view needs', () => {
    const p = build(troubledState());
    assert.equal(p.type, MESSAGE_TYPES.DEVICE_HEALTH);
    assert.equal(p.timestamp, '2026-08-27T10:00:00.000Z');
    assert.deepEqual(p.counts, {
      joints_total: 3,
      joints_live: 2,     // J03 is offline
      joints_stale: 0,
      joints_offline: 1,
      devices_blacklisted: 1,
      devices_probing: 0,
    });
  });

  test('names the failed device the way it was commissioned, not by internal id', () => {
    // "sl02" means nothing to whoever wired the panel; unit address 50 does.
    const [d] = build(troubledState()).devices;
    assert.equal(d.slave_id, 'sl02');
    assert.equal(d.unit_address, 50);
    assert.match(d.display, /50/);
    assert.equal(d.status, 'blacklisted');
    assert.equal(d.next_probe_in_sec, 45);
    assert.deepEqual(d.joints, ['J03']);
  });

  test('a healthy panel sends an almost empty message', () => {
    // 110 devices in good health must not cost 110 rows every hour.
    const p = build(healthy());
    assert.deepEqual(p.devices, []);
    assert.deepEqual(p.joints, { stale: [], offline: [] });
    assert.equal(p.counts.joints_live, 3);
  });

  test('carries the Pi supply state, including the post-recovery forensic flag', () => {
    const p = build(healthy(), {
      power: { state: 'ok', low_voltage_now: false, low_voltage_since_boot: true, throttled_now: false },
    });
    assert.equal(p.power.under_voltage_now, false);
    assert.equal(p.power.under_voltage_since_boot, true,
      'an intermittent brown-out that already recovered must stay visible');
  });

  test('omits the power block entirely when the probe returned nothing', () => {
    assert.equal(build(healthy()).power, undefined);
  });
});

describe('device_health - per-segment bus liveness', () => {
  test('a silent segment is visible even though the other one keeps publishing', () => {
    // This is the whole point: a two-segment panel with a dead Nano still sends
    // telemetry for the other half, so "the panel is reporting" proves nothing
    // about bus2.
    const p = build(healthy(), { busSeen: { bus1: NOW - 500, bus2: NOW - 120_000 } });
    const by = Object.fromEntries(p.buses.map((b) => [b.bus_id, b]));
    assert.equal(by.bus1.status, 'ok');
    assert.equal(by.bus2.status, 'silent');
    assert.equal(by.bus2.last_frame_age_sec, 120);
  });

  test('a bus never seen is "unknown", not "silent"', () => {
    // At boot every segment is briefly unseen; reporting that as a fault would
    // alarm the fleet view on every restart.
    const p = build(healthy(), { busSeen: {} });
    assert.deepEqual(p.buses.map((b) => b.status), ['unknown', 'unknown']);
    assert.equal(p.buses[0].last_frame_age_sec, null);
  });

  test('the silence threshold is the boundary, not an approximation', () => {
    const at = buildBusHealth({
      doc: doc(), nowMs: NOW, summary: { slaves: [] },
      busSeen: { bus1: NOW - DEFAULT_BUS_SILENCE_SEC * 1000, bus2: NOW - (DEFAULT_BUS_SILENCE_SEC * 1000 + 1000) },
    });
    assert.equal(at[0].status, 'ok', 'exactly at the threshold is still ok');
    assert.equal(at[1].status, 'silent');
  });

  test('counts unhealthy devices against the segment they are wired to', () => {
    const p = build(troubledState());
    const by = Object.fromEntries(p.buses.map((b) => [b.bus_id, b]));
    assert.equal(by.bus1.devices_total, 2);
    assert.equal(by.bus1.devices_unhealthy, 0);
    assert.equal(by.bus2.devices_total, 1);
    assert.equal(by.bus2.devices_unhealthy, 1, 'sl02 is on bus2');
  });
});

describe('device_health - publish cadence', () => {
  test('publishes the first snapshot, then stays quiet while nothing changes', () => {
    const outbox = freshOutbox();
    const pub = new DeviceHealthPublisher({ outbox, topic: 'tel', resyncSec: 3600 });
    assert.deepEqual(pub.publish(build(healthy()), NOW), { published: true, reason: 'changed' });
    // a later snapshot with a NEW timestamp but identical content is not a change
    assert.deepEqual(pub.publish(build(healthy(), { nowMs: NOW + 60_000 }), NOW + 60_000),
      { published: false, reason: 'unchanged' });
    assert.equal(outbox.queues.telemetry.length, 1);
  });

  test('publishes immediately when a device drops out', () => {
    const outbox = freshOutbox();
    const pub = new DeviceHealthPublisher({ outbox, topic: 'tel' });
    pub.publish(build(healthy()), NOW);
    const r = pub.publish(build(troubledState(), { nowMs: NOW + 5000 }), NOW + 5000);
    assert.deepEqual(r, { published: true, reason: 'changed' });
    assert.equal(outbox.queues.telemetry.length, 2);
  });

  test('resyncs on schedule so a late subscriber converges', () => {
    // QoS 1 protects delivery to a CONNECTED subscriber; it does nothing for a
    // consumer that started after the last change. Without this, a fleet view
    // brought up on a calm panel would show nothing until the next fault.
    const outbox = freshOutbox();
    const pub = new DeviceHealthPublisher({ outbox, topic: 'tel', resyncSec: 3600 });
    pub.publish(build(healthy()), NOW);
    assert.equal(pub.publish(build(healthy(), { nowMs: NOW + 3599_000 }), NOW + 3599_000).published, false);
    assert.deepEqual(pub.publish(build(healthy(), { nowMs: NOW + 3600_000 }), NOW + 3600_000),
      { published: true, reason: 'resync' });
  });

  test('QoS 1 - losing a recovery would leave the fleet view showing a stale fault', () => {
    const outbox = freshOutbox();
    new DeviceHealthPublisher({ outbox, topic: 'tel' }).publish(build(healthy()), NOW);
    assert.equal(outbox.queues.telemetry[0].qos, 1);
  });
});
