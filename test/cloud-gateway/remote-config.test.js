'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const configService = require('../../src/config-service/node-red');
const { createGateway, setupRemoteConfig, drainRemoteConfig, flushIfDue, setTelemetryInterval, ingestKpiTap } = require('../../src/cloud-gateway/node-red');
const { RuntimeSettings } = require('../../src/cloud-gateway/runtime-settings');
const { validAlarmsDoc } = require('../config-service/fixtures');

function bench() {
  const outboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-rc-e2e-'));
  const gateway = createGateway({
    outboxDir,
    topics: {
      telemetry: 'dt/C1/S1/P1/tel',
      alarm: 'dt/C1/S1/P1/alarm',
      cmd_config: 'cmd/C1/S1/P1/config',
      cmd_config_ack: 'cmd/C1/S1/P1/config/ack',
    },
  });
  gateway.outbox.stop();

  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-rc-e2e-store-'));
  const cs = { ...configService, createStore: () => configService.createStore(storeRoot) };

  // globalContext honors the store argument the way Node-RED does (here a
  // single map keyed by name+store is enough - the "default" store is the
  // only one used).
  const ctx = new Map();
  // On the Pi the unnamed default store IS the store named "default"
  // (contextStorage: { default: {...} }) - model that so a value written
  // without a store name is readable with "default" and vice-versa.
  const key = (k, store) => `${store && store !== 'default' ? store : 'default'}::${k}`;
  const globalContext = {
    get: (k, store) => ctx.get(key(k, store)),
    set: (k, v, store) => ctx.set(key(k, store), v),
  };
  const sends = [];
  const b = { gateway, cs, ctx, globalContext, sends, storeRoot };
  b.status = setupRemoteConfig({ gateway });
  b.ctxGet = (k, store = 'default') => ctx.get(key(k, store));
  return b;
}

/** Simulates the cloud pushing on the cmd topic (loopback dispatches to the inbox). */
function cloudPush(gateway, payload) {
  return gateway.transport.publish('cmd/C1/S1/P1/config', payload, 1);
}

/** Simulates the flow's drain tick running in message context. */
function drive(b) {
  const out = drainRemoteConfig(b.gateway, b.cs, b.globalContext);
  for (const s of out) b.sends.push(s);
  return out;
}

async function drainAcks(gateway) {
  await gateway.outbox.drain();
  return gateway.transport.published.filter((p) => p.topic === 'cmd/C1/S1/P1/config/ack');
}

describe('remote config channel end-to-end (loopback = simulated cloud push)', () => {
  test('setup subscribes and reports the topic; refuses without cmd topics', () => {
    const { status } = bench();
    assert.deepEqual(status, { enabled: true, topic: 'cmd/C1/S1/P1/config' });

    const bare = createGateway({ outboxDir: fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-rc-bare-')) });
    bare.outbox.stop();
    const s2 = setupRemoteConfig({ gateway: bare });
    assert.equal(s2.enabled, false);
  });

  test('valid alarms push: applied, acked with versions, live engine global updated (A10)', async () => {
    const b = bench();
    await cloudPush(b.gateway, { request_id: 'push-1', user: 'ops', domain: 'alarms', doc: validAlarmsDoc() });
    drive(b); // the tick drains + applies in message context

    const acks = await drainAcks(b.gateway);
    assert.equal(acks.length, 1);
    assert.equal(acks[0].payload.result, 'applied');
    assert.equal(acks[0].payload.request_id, 'push-1');
    assert.equal(acks[0].qos, 1);

    const runtime = b.ctxGet('busbartherm_system_config'); // store "default"
    assert.deepEqual(runtime.deltaT, validAlarmsDoc().profiles.default.deltaT);
    const audit = b.ctxGet('audit_busbartherm');
    assert.equal(audit[0].action, 'REMOTE_APPLY');
    assert.equal(b.sends[0][0].payload.remote_config.result, 'applied');
    assert.equal(b.sends[0][0].payload.remote_config.live_thresholds_written, true);
    assert.equal(b.sends[0][1], null); // no Nano resend for an alarms change
  });

  test('invalid alarms push: rejected ack carries the rule id, no side effects', async () => {
    const b = bench();
    const bad = validAlarmsDoc();
    bad.profiles.default.deltaT = { watch: 30, warning: 20, critical: 35 };
    await cloudPush(b.gateway, { request_id: 'push-2', domain: 'alarms', doc: bad });
    drive(b);

    const acks = await drainAcks(b.gateway);
    assert.equal(acks[0].payload.result, 'rejected');
    assert.ok(acks[0].payload.errors.some((e) => e.rule === 'A1'));
    assert.equal(b.ctxGet('busbartherm_system_config'), undefined);
  });

  test('remote modbus push respects R12, then applies in maintenance mode with full local convergence', async () => {
    const b = bench();
    const { gateway, cs, sends } = b;
    // seed the applied doc the panel is running
    const store = cs.createStore();
    const seed = {
      config_domain_versions: { modbus: 1, joints: 1 },
      modbus: {
        buses: [{ bus_id: 'bus1', type: 'rtu', port: '/dev/ttyUSB0', baud: 9600, parity: 'N', stop_bits: 2, timeout_ms: 1000, retries: 2, inter_frame_ms: 10 }],
        slaves: [
          { slave_id: 'sl01', bus_id: 'bus1', unit_address: 1, model: 'LEGACY-1CH', label: 'Sensor1', channels: 1, poll_interval_s: 30, registers: { function_code: 3, temp_base_addr: 3, temp_word_count: 1, temp_scale: 0.1 } },
          { slave_id: 'sl21', bus_id: 'bus1', unit_address: 101, model: 'LEGACY-1CH', label: 'AmbientT', channels: 1, poll_interval_s: 30, registers: { function_code: 3, temp_base_addr: 3, temp_word_count: 1, temp_scale: 0.1 } },
        ],
        ambient_sensor: { slave_id: 'sl21', channel: 1 },
      },
      joints: [{ joint_id: 'J01', slave_id: 'sl01', channel: 1, zone_id: 'z1', enabled: true, threshold_profile: 'default' }],
      zones: [{ zone_id: 'z1', name: 'Zone1' }],
    };
    assert.ok(store.applyIfValid('modbus_joints', seed).applied);

    const newDoc = JSON.parse(JSON.stringify(seed));
    newDoc.config_domain_versions = { modbus: 2, joints: 2 };
    newDoc.modbus.buses[0].baud = 19200;

    // outside maintenance mode -> R12
    await cloudPush(gateway, { request_id: 'push-3', domain: 'modbus_joints', doc: newDoc });
    drive(b);
    let acks = await drainAcks(gateway);
    assert.equal(acks[0].payload.result, 'rejected');
    assert.ok(acks[0].payload.errors.some((e) => e.rule === 'R12'));

    // in maintenance mode -> applied + bridge + drafts + resend
    b.globalContext.set('maintenanceMode', true);
    await cloudPush(gateway, { request_id: 'push-4', domain: 'modbus_joints', doc: newDoc });
    drive(b);
    acks = await drainAcks(gateway);
    assert.equal(acks[1].payload.result, 'applied');
    assert.deepEqual(acks[1].payload.applied_versions, { modbus: 2, joints: 2 });

    assert.equal(b.ctxGet('baudRate'), 19200); // legacy comm global rewritten
    assert.equal(b.ctxGet('SlaveIDList').length, 2);
    assert.equal(b.ctxGet('joint_master_zone_A')[0].joint_id, 'J01'); // draft rebuilt
    assert.equal(b.ctxGet('modbus_settings_draft'), null);
    const lastSend = sends[sends.length - 1];
    // Nano resend trigger: one message PER CHANGED SEGMENT, each tagged with its
    // bus, so a Send Nano Job wired to another segment drops it. A single-bus
    // panel gets exactly one, tagged bus1.
    assert.deepEqual(lastSend[1], [{ payload: 'remote-apply', busId: 'bus1' }]);
    assert.deepEqual(lastSend[2].payload, [[1, 3, 1], [101, 3, 1]]); // paraRaw sync
  });

  test('edge knob push changes the live flush cadence and persists across gateway restarts', async () => {
    const b = bench();
    const { gateway } = b;
    const t0 = Date.parse('2026-07-19T10:00:00Z');

    // default 10 min: not due at +9 min
    assert.equal(flushIfDue(gateway, t0), null); // schedules first flush at +10
    ingestKpiTap(gateway, { topic: 'joint', payload: { joint_id: 'J01', val: 40, ror: 1, deltaT: { raw: 10, ema: 9 } } });
    assert.equal(flushIfDue(gateway, t0 + 9 * 60_000), null);

    await cloudPush(gateway, { request_id: 'push-5', domain: 'edge', doc: { telemetry_interval_min: 2 } });
    drive(b);
    const acks = await drainAcks(gateway);
    assert.equal(acks[0].payload.result, 'applied');

    // interval now 2 min from the moment of application
    const applyAt = gateway._nextFlushAt;
    assert.ok(applyAt - Date.now() <= 2 * 60_000 + 1000);
    const status = flushIfDue(gateway, applyAt + 1);
    assert.ok(status, 'flush due on the new cadence');
    assert.equal(status.flushed_chunks, 1);

    // persisted: a fresh RuntimeSettings on the same dir sees 2
    const reloaded = new RuntimeSettings({ dir: gateway.outbox.dir });
    assert.equal(reloaded.telemetryIntervalMin, 2);
  });

  test('a garbage push is rejected, acked, and never crashes the drain', async () => {
    const b = bench();
    await cloudPush(b.gateway, 'not even an object');
    await cloudPush(b.gateway, { domain: 'alarms', doc: null });
    drive(b);
    const acks = await drainAcks(b.gateway);
    assert.equal(acks.length, 2);
    assert.ok(acks.every((a) => a.payload.result === 'rejected'));
  });
});
