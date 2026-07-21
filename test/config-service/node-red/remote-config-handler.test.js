'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ConfigStore } = require('../../../src/config-service/store');
const { validateModbusJoints } = require('../../../src/config-service/validate-modbus-joints');
const { validateAlarms } = require('../../../src/config-service/validate-alarms');
const { processRemoteConfig, buildLegacyDrafts } = require('../../../src/config-service/node-red/remote-config-handler');
const { validAlarmsDoc } = require('../fixtures');

function freshStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-rcfg-test-'));
  return new ConfigStore({ root, validators: { modbus_joints: validateModbusJoints, alarms: validateAlarms } });
}

function seedModbusJoints(store, version = 1) {
  const doc = modbusDoc(version);
  const result = store.applyIfValid('modbus_joints', doc);
  assert.ok(result.applied);
  return doc;
}

function modbusDoc(version) {
  return {
    config_domain_versions: { modbus: version, joints: version },
    modbus: {
      buses: [{ bus_id: 'bus1', type: 'rtu', port: '/dev/ttyUSB0', baud: 9600, parity: 'N', stop_bits: 2, timeout_ms: 1000, retries: 2, inter_frame_ms: 10 }],
      slaves: [
        { slave_id: 'sl01', bus_id: 'bus1', unit_address: 1, model: 'LEGACY-1CH', label: 'Sensor1', channels: 1, poll_interval_s: 30, registers: { function_code: 3, temp_base_addr: 3, temp_word_count: 1, temp_scale: 0.1 } },
        { slave_id: 'sl02', bus_id: 'bus1', unit_address: 5, model: 'BT-SCM-2', channels: 2, poll_interval_s: 30, registers: { function_code: 3, temp_base_addr: 10, temp_word_count: 1, temp_scale: 0.1, channel_addrs: [10, 12], channel_labels: ['U5-A', 'U5-B'] } },
        { slave_id: 'sl21', bus_id: 'bus1', unit_address: 101, model: 'LEGACY-1CH', label: 'AmbientT', channels: 1, poll_interval_s: 30, registers: { function_code: 3, temp_base_addr: 3, temp_word_count: 1, temp_scale: 0.1 } },
      ],
      ambient_sensor: { slave_id: 'sl21', channel: 1 },
    },
    joints: [
      { joint_id: 'J01', slave_id: 'sl01', channel: 1, zone_id: 'z1', enabled: true, threshold_profile: 'default' },
      { joint_id: 'J02', slave_id: 'sl02', channel: 2, zone_id: 'z1', enabled: true, threshold_profile: 'default' },
    ],
    zones: [{ zone_id: 'z1', name: 'Zone1' }],
  };
}

const telemetryDeps = (applied = []) => ({
  min: 1,
  max: 1440,
  apply: (min) => {
    if (!Number.isInteger(min) || min < 1 || min > 1440) return `telemetry_interval_min must be an integer 1-1440 (got ${JSON.stringify(min)})`;
    applied.push(min);
    return null;
  },
});

describe('processRemoteConfig - envelope', () => {
  test('rejects malformed envelopes with ENVELOPE rule and echoes request_id', () => {
    const store = freshStore();
    const r1 = processRemoteConfig({ request_id: 'req-1', domain: 'nope', doc: {} }, { store });
    assert.equal(r1.ack.result, 'rejected');
    assert.equal(r1.ack.request_id, 'req-1');
    assert.equal(r1.ack.errors[0].rule, 'ENVELOPE');

    const r2 = processRemoteConfig({ domain: 'alarms' }, { store });
    assert.match(r2.ack.errors[0].message, /doc/);

    const r3 = processRemoteConfig(null, { store });
    assert.equal(r3.ack.result, 'rejected');
  });
});

describe('processRemoteConfig - alarms domain', () => {
  test('applies a valid alarms doc: ack carries versions, runtimeConfig feeds the live engine (A10)', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const doc = validAlarmsDoc();
    const result = processRemoteConfig({ request_id: 'r-42', user: 'cloud-ops', domain: 'alarms', doc }, { store, maintenanceMode: false });
    assert.equal(result.ack.result, 'applied');
    assert.deepEqual(result.ack.applied_versions, { alarms: doc.config_domain_versions.alarms });
    assert.deepEqual(result.runtimeConfig.deltaT, doc.profiles.default.deltaT);
    assert.equal(result.audits[0].key, 'audit_busbartherm');
    assert.equal(result.audits[0].entry.user, 'remote:cloud-ops');

    const { doc: stored } = store.readDomain('alarms');
    assert.equal(stored.config_domain_versions.alarms, doc.config_domain_versions.alarms);
  });

  test('rejects an invalid alarms doc with the correct rule id (A1) and leaves the store unchanged', () => {
    const store = freshStore();
    const doc = validAlarmsDoc();
    doc.profiles.default.deltaT = { watch: 30, warning: 20, critical: 35 }; // A1 ordering violation
    const result = processRemoteConfig({ domain: 'alarms', doc }, { store });
    assert.equal(result.ack.result, 'rejected');
    assert.ok(result.ack.errors.some((e) => e.rule === 'A1'), JSON.stringify(result.ack.errors));
    assert.equal(store.readDomain('alarms').doc, null);
    assert.ok(!result.runtimeConfig);
  });
});

describe('processRemoteConfig - modbus_joints domain (R12 gate)', () => {
  test('rejects a remote modbus change outside maintenance mode with R12', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const result = processRemoteConfig({ domain: 'modbus_joints', doc: modbusDoc(2) }, { store, maintenanceMode: false });
    assert.equal(result.ack.result, 'rejected');
    assert.ok(result.ack.errors.some((e) => e.rule === 'R12'));
  });

  test('applies in maintenance mode: versions ack, drafts rebuilt, content-aware resend', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const newDoc = modbusDoc(2);
    newDoc.modbus.buses[0].baud = 19200; // polling-relevant change
    const result = processRemoteConfig({ domain: 'modbus_joints', doc: newDoc }, { store, maintenanceMode: true });
    assert.equal(result.ack.result, 'applied');
    assert.deepEqual(result.ack.applied_versions, { modbus: 2, joints: 2 });
    assert.equal(result.resendNeeded, true);
    assert.equal(result.newDoc, newDoc);
    assert.equal(result.drafts.joints.length, 2);

    const label = processRemoteConfig({ domain: 'modbus_joints', doc: (() => { const d = modbusDoc(3); d.modbus.buses[0].baud = 19200; d.modbus.slaves[0].label = 'Renamed'; return d; })() }, { store, maintenanceMode: true });
    assert.equal(label.ack.result, 'applied');
    assert.equal(label.resendNeeded, false); // label-only change never disturbs polling
  });

  test('rejects an invalid modbus doc with real rule ids even in maintenance mode', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const bad = modbusDoc(2);
    bad.joints[0].slave_id = 'sl99'; // R1 violation
    const result = processRemoteConfig({ domain: 'modbus_joints', doc: bad }, { store, maintenanceMode: true });
    assert.equal(result.ack.result, 'rejected');
    assert.ok(result.ack.errors.some((e) => e.rule === 'R1'));
  });
});

describe('processRemoteConfig - edge domain (telemetry interval knob)', () => {
  test('applies a valid interval and acks it', () => {
    const applied = [];
    const result = processRemoteConfig(
      { request_id: 'k1', domain: 'edge', doc: { telemetry_interval_min: 5 } },
      { store: freshStore(), telemetryInterval: telemetryDeps(applied) }
    );
    assert.equal(result.ack.result, 'applied');
    assert.deepEqual(result.ack.applied_versions, { telemetry_interval_min: 5 });
    assert.deepEqual(applied, [5]);
  });

  test('rejects an out-of-bounds interval and unknown knobs', () => {
    const deps = { store: freshStore(), telemetryInterval: telemetryDeps() };
    const bad = processRemoteConfig({ domain: 'edge', doc: { telemetry_interval_min: 0 } }, deps);
    assert.equal(bad.ack.result, 'rejected');
    assert.match(bad.ack.errors[0].message, /1-1440/);

    const unknown = processRemoteConfig({ domain: 'edge', doc: { reboot: true } }, deps);
    assert.equal(unknown.ack.result, 'rejected');
    assert.match(unknown.ack.errors[0].message, /unknown edge setting/);
  });
});

describe('buildLegacyDrafts', () => {
  test('reverse-maps a schema doc into the legacy dashboard draft shapes', () => {
    const doc = modbusDoc(1);
    doc.joints[0].ambient_sensor = { slave_id: 'sl02', channel: 1 }; // joint-level override
    const { joints, zones } = buildLegacyDrafts(doc);

    assert.deepEqual(zones, [{ zone_id: 'Z1', zone_name: 'Zone1', editing: false }]);
    assert.deepEqual(joints[0], {
      joint_name: 'J01',
      joint_id: 'J01',
      slaveID: 1,
      channel: 1,
      slaveName: 'Sensor1',
      slaveTooltip: 'Slave 1\nSensor1',
      zone_id: 'Z1',
      zone_name: 'Zone1',
      ambientSlaveID: 5, // the joint-level override wins over the panel default
      editing: false,
    });
    // multi-channel joint: channel label + panel-default ambient
    assert.equal(joints[1].slaveName, 'U5-B');
    assert.equal(joints[1].channel, 2);
    assert.equal(joints[1].ambientSlaveID, 101);
  });
});
