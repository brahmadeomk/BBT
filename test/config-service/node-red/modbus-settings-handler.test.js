'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ConfigStore } = require('../../../src/config-service/store');
const { validateModbusJoints } = require('../../../src/config-service/validate-modbus-joints');
const { validateAlarms } = require('../../../src/config-service/validate-alarms');
const { handleModbusSettingsMessage, writeLegacyModbusGlobals } = require('../../../src/config-service/node-red/modbus-settings-handler');

function freshStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-msh-test-'));
  return new ConfigStore({ root, validators: { modbus_joints: validateModbusJoints, alarms: validateAlarms } });
}

function seedModbusJoints(store) {
  const doc = {
    config_domain_versions: { modbus: 1, joints: 1 },
    modbus: {
      buses: [{ bus_id: 'bus1', type: 'rtu', port: '/dev/ttyUSB0', baud: 9600, parity: 'N', stop_bits: 2, timeout_ms: 1000, retries: 2, inter_frame_ms: 10 }],
      slaves: [
        { slave_id: 'sl01', bus_id: 'bus1', unit_address: 1, model: 'LEGACY-1CH', channels: 1, poll_interval_s: 30, registers: { function_code: 3, temp_base_addr: 3, temp_word_count: 1, temp_scale: 0.1 } },
        { slave_id: 'sl02', bus_id: 'bus1', unit_address: 2, model: 'LEGACY-1CH', channels: 1, poll_interval_s: 30, registers: { function_code: 3, temp_base_addr: 3, temp_word_count: 1, temp_scale: 0.1 } },
        { slave_id: 'sl21', bus_id: 'bus1', unit_address: 101, model: 'LEGACY-1CH', channels: 1, poll_interval_s: 30, registers: { function_code: 3, temp_base_addr: 3, temp_word_count: 1, temp_scale: 0.1 } },
      ],
      ambient_sensor: { slave_id: 'sl21', channel: 1 },
    },
    joints: [{ joint_id: 'J01', slave_id: 'sl01', channel: 1, zone_id: 'z1', enabled: true, threshold_profile: 'default' }],
    zones: [{ zone_id: 'z1', name: 'Zone1' }],
  };
  const result = store.applyIfValid('modbus_joints', doc);
  assert.ok(result.applied, 'seed must apply');
}

const legacySlaveList = () => [
  { id: '6', parameterName: 'Sensor1', slaveID: 1, registerAddress: 3, dataBits: 1, enabled: true },
  { id: '6', parameterName: 'Sensor2', slaveID: 2, registerAddress: 3, dataBits: 1, enabled: true },
  { id: '6', parameterName: 'AmbientT', slaveID: 101, registerAddress: 3, dataBits: 1, enabled: true },
];

/** Loads the current table exactly the way the dashboard's initial inject does. */
function loadState(store) {
  const result = handleModbusSettingsMessage({ payload: {} }, { store, legacySlaveList: legacySlaveList() });
  return result.msg.payload;
}

describe('handleModbusSettingsMessage - load', () => {
  test('renders rows from the applied cfg/modbus, recovering display names from the legacy list', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const { slaves, bus } = loadState(store);
    assert.equal(slaves.length, 3);
    assert.deepEqual(
      slaves.map((s) => [s.slave_id, s.label, s.unit_address]),
      [['sl01', 'Sensor1', 1], ['sl02', 'Sensor2', 2], ['sl21', 'AmbientT', 101]]
    );
    assert.equal(bus.baud, 9600);
    assert.equal(bus.port, '/dev/ttyUSB0');
    assert.equal(bus.inter_frame_ms, 10);
    assert.ok(slaves.every((s) => s.editing === false));
  });

  test('renders an empty table with a default bus when nothing is applied yet', () => {
    const store = freshStore();
    const { slaves, bus } = loadState(store);
    assert.deepEqual(slaves, []);
    assert.equal(bus.parity, 'N');
  });

  test('prefers a persisted label over the legacy-list name once one exists', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const state = loadState(store);
    state.slaves[0].label = 'Joint 1 sensor';
    handleModbusSettingsMessage(
      { payload: { action: 'apply', slaves: state.slaves, bus: state.bus } },
      { store, legacySlaveList: legacySlaveList() }
    );
    const reloaded = handleModbusSettingsMessage({ payload: {} }, { store, legacySlaveList: [] }); // no legacy list at all
    assert.equal(reloaded.msg.payload.slaves[0].label, 'Joint 1 sensor');
  });
});

describe('handleModbusSettingsMessage - draft bookkeeping', () => {
  test('add appends an empty editable row and persists the draft', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const state = loadState(store);
    const result = handleModbusSettingsMessage(
      { payload: { action: 'add', slaves: state.slaves, bus: state.bus } },
      { store, legacySlaveList: legacySlaveList() }
    );
    assert.equal(result.msg.payload.slaves.length, 4);
    assert.equal(result.msg.payload.slaves[3].editing, true);
    assert.equal(result.draft.slaves.length, 4);
  });

  test('save rejects a bad unit address without persisting', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const state = loadState(store);
    state.slaves[0] = { ...state.slaves[0], unit_address: 999, editing: true };
    const result = handleModbusSettingsMessage(
      { payload: { action: 'save', index: 0, slaves: state.slaves, bus: state.bus } },
      { store, legacySlaveList: legacySlaveList() }
    );
    assert.match(result.msg.payload.error, /Unit address/);
    assert.equal(result.draft, null);
  });

  test('save accepts a complete row and clears its editing flag', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const state = loadState(store);
    state.slaves[0] = { ...state.slaves[0], editing: true };
    const result = handleModbusSettingsMessage(
      { payload: { action: 'save', index: 0, slaves: state.slaves, bus: state.bus } },
      { store, legacySlaveList: legacySlaveList() }
    );
    assert.equal(result.msg.payload.success, 'Saved');
    assert.equal(result.draft.slaves[0].editing, false);
  });

  test('delete removes the row (referential safety is enforced at apply)', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const state = loadState(store);
    const result = handleModbusSettingsMessage(
      { payload: { action: 'delete', index: 2, slaves: state.slaves, bus: state.bus } },
      { store, legacySlaveList: legacySlaveList() }
    );
    assert.equal(result.msg.payload.slaves.length, 2);
  });

  test('suppresses output on a plain refresh while a row is mid-edit', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const state = loadState(store);
    state.slaves[0].editing = true;
    const result = handleModbusSettingsMessage(
      { payload: { slaves: state.slaves, bus: state.bus } },
      { store, legacySlaveList: legacySlaveList() }
    );
    assert.equal(result.msg, null);
  });

  test('preserves other msg properties the dashboard needs for routing', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const result = handleModbusSettingsMessage(
      { topic: 'modbus', socketid: 'abc', _msgid: 'xyz', payload: { action: 'add' } },
      { store, legacySlaveList: legacySlaveList() }
    );
    assert.equal(result.msg.topic, 'modbus');
    assert.equal(result.msg.socketid, 'abc');
    assert.equal(result.msg._msgid, 'xyz');
  });
});

describe('handleModbusSettingsMessage - apply', () => {
  test('rejects when cfg/modbus has not been provisioned yet', () => {
    const store = freshStore();
    const row = { slave_id: '', label: 'S1', unit_address: 1, model: 'M', channels: 1, temp_base_addr: 3, temp_word_count: 1, temp_scale: 0.1, poll_interval_s: 30, editing: false };
    const result = handleModbusSettingsMessage(
      { payload: { action: 'apply', slaves: [row], bus: { port: '/dev/ttyUSB0', baud: 9600, parity: 'N', stop_bits: 1, timeout_ms: 1000, retries: 2, inter_frame_ms: 10 } } },
      { store, legacySlaveList: [] }
    );
    assert.match(result.msg.payload.error, /No cfg\/modbus applied yet/);
  });

  test('a bus comm change applies, bumps versions, and flags a resend', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const state = loadState(store);
    state.bus.baud = 19200;
    const result = handleModbusSettingsMessage(
      { payload: { action: 'apply', slaves: state.slaves, bus: state.bus } },
      { store, legacySlaveList: legacySlaveList(), user: 'alice' }
    );
    assert.equal(result.msg.payload.success, 'Modbus configuration applied');
    assert.equal(result.resendNeeded, true);
    const { doc } = store.readDomain('modbus_joints');
    assert.equal(doc.modbus.buses[0].baud, 19200);
    assert.equal(doc.config_domain_versions.modbus, 2);
    assert.equal(doc.config_domain_versions.joints, 2);
    assert.deepEqual(doc.modbus.ambient_sensor, { slave_id: 'sl21', channel: 1 }); // carried through
  });

  test('a label-only change applies but does NOT flag a resend (labels never reach the Nano)', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const state = loadState(store);
    state.slaves[1].label = 'Renamed sensor';
    const result = handleModbusSettingsMessage(
      { payload: { action: 'apply', slaves: state.slaves, bus: state.bus } },
      { store, legacySlaveList: legacySlaveList() }
    );
    assert.equal(result.msg.payload.success, 'Modbus configuration applied');
    assert.equal(result.resendNeeded, false);
    const { doc } = store.readDomain('modbus_joints');
    assert.equal(doc.modbus.slaves[1].label, 'Renamed sensor');
  });

  test('adding a slave allocates the lowest unused slave_id and keeps existing ids stable', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const state = loadState(store);
    state.slaves.push({ slave_id: '', label: 'Sensor3', unit_address: 3, model: 'BT-SCM-4', channels: 1, temp_base_addr: 3, temp_word_count: 1, temp_scale: 0.1, poll_interval_s: 30, editing: false });
    const result = handleModbusSettingsMessage(
      { payload: { action: 'apply', slaves: state.slaves, bus: state.bus } },
      { store, legacySlaveList: legacySlaveList() }
    );
    assert.equal(result.msg.payload.success, 'Modbus configuration applied');
    assert.equal(result.resendNeeded, true);
    const { doc } = store.readDomain('modbus_joints');
    assert.deepEqual(doc.modbus.slaves.map((s) => s.slave_id), ['sl01', 'sl02', 'sl21', 'sl03']); // sl03 was free
    assert.deepEqual(doc.joints[0].slave_id, 'sl01'); // untouched
  });

  test('refuses to delete a slave still mapped to a joint, naming the joint', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const state = loadState(store);
    state.slaves.splice(0, 1); // sl01 is mapped to J01
    const result = handleModbusSettingsMessage(
      { payload: { action: 'apply', slaves: state.slaves, bus: state.bus } },
      { store, legacySlaveList: legacySlaveList() }
    );
    assert.match(result.msg.payload.error, /still mapped to a joint: J01/);
    const { doc } = store.readDomain('modbus_joints');
    assert.equal(doc.config_domain_versions.modbus, 1); // untouched
  });

  test('refuses to delete the slave used as the panel ambient reference', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const state = loadState(store);
    state.slaves.splice(2, 1); // sl21 is modbus.ambient_sensor
    const result = handleModbusSettingsMessage(
      { payload: { action: 'apply', slaves: state.slaves, bus: state.bus } },
      { store, legacySlaveList: legacySlaveList() }
    );
    assert.match(result.msg.payload.error, /ambient reference/);
  });

  test('rejects duplicate unit addresses before touching the store', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const state = loadState(store);
    state.slaves[1].unit_address = 1;
    const result = handleModbusSettingsMessage(
      { payload: { action: 'apply', slaves: state.slaves, bus: state.bus } },
      { store, legacySlaveList: legacySlaveList() }
    );
    assert.match(result.msg.payload.error, /Duplicate unit address 1/);
  });

  test('surfaces real validator rule errors and does not flag a resend on rejection', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const state = loadState(store);
    // 100ms inter-frame across 3 slaves with a 5s poll... craft an R10-style overload:
    // shortest poll 5s, timeout 5000ms + retries 5 -> straggler allowance alone busts it
    state.slaves.forEach((s) => (s.poll_interval_s = 5));
    state.bus.timeout_ms = 5000;
    state.bus.retries = 5;
    state.bus.inter_frame_ms = 500;
    const result = handleModbusSettingsMessage(
      { payload: { action: 'apply', slaves: state.slaves, bus: state.bus } },
      { store, legacySlaveList: legacySlaveList() }
    );
    assert.ok(result.msg.payload.error, 'expected a validator rejection');
    assert.ok(!result.resendNeeded);
    assert.ok(!result.legacy);
  });
});

describe('handleModbusSettingsMessage - legacy bridge', () => {
  test('derives SlaveIDList/indexed globals/comm/paraRaw from the applied doc', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const state = loadState(store);
    state.bus.baud = 19200;
    const { legacy } = handleModbusSettingsMessage(
      { payload: { action: 'apply', slaves: state.slaves, bus: state.bus } },
      { store, legacySlaveList: legacySlaveList() }
    );
    assert.equal(legacy.slaveLength, 3);
    assert.deepEqual(legacy.SlaveIDList[0], { id: '6', parameterName: 'Sensor1', slaveID: 1, registerAddress: 3, dataBits: 1, enabled: true });
    assert.deepEqual(legacy.indexed[2], { parameterName: 'AmbientT', parameterID: '6', sID: 101, sregisterAddress: 3, sdataBits: 1 });
    assert.deepEqual(legacy.comm, { port: '/dev/ttyUSB0', baudRate: 19200, parity: 'N', stopBits: 2, Polling: 10000, Timeout: 1000 });
    assert.deepEqual(legacy.paraRaw, [[1, 3, 1], [2, 3, 1], [101, 3, 1]]);
  });

  test('carries parameterID over by unit address and defaults new slaves to the panel-dominant type', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const mixedLegacy = [
      { id: '6', parameterName: 'Sensor1', slaveID: 1, registerAddress: 3, dataBits: 1, enabled: true },
      { id: '9', parameterName: 'Sensor2', slaveID: 2, registerAddress: 3, dataBits: 1, enabled: true },
      { id: '6', parameterName: 'AmbientT', slaveID: 101, registerAddress: 3, dataBits: 1, enabled: true },
    ];
    const load = handleModbusSettingsMessage({ payload: {} }, { store, legacySlaveList: mixedLegacy });
    const state = load.msg.payload;
    state.slaves.push({ slave_id: '', label: 'NewOne', unit_address: 7, model: 'BT-SCM-4', channels: 2, temp_base_addr: 10, temp_word_count: 2, temp_scale: 0.1, poll_interval_s: 30, editing: false });
    const { legacy } = handleModbusSettingsMessage(
      { payload: { action: 'apply', slaves: state.slaves, bus: state.bus } },
      { store, legacySlaveList: mixedLegacy }
    );
    assert.equal(legacy.SlaveIDList[1].id, '9'); // carried by unit_address
    const added = legacy.SlaveIDList.find((ls) => ls.slaveID === 7);
    assert.equal(added.id, '6'); // panel-dominant type
    assert.equal(added.dataBits, 4); // channels(2) * words(2)
    assert.deepEqual(legacy.paraRaw.find((t) => t[0] === 7), [7, 10, 4]);
  });

  test('writeLegacyModbusGlobals writes every global the decode pipeline reads (and not paraRaw)', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const state = loadState(store);
    const { legacy } = handleModbusSettingsMessage(
      { payload: { action: 'apply', slaves: state.slaves, bus: state.bus } },
      { store, legacySlaveList: legacySlaveList() }
    );
    const written = new Map();
    writeLegacyModbusGlobals({ set: (k, v) => written.set(k, v) }, legacy);
    assert.equal(written.get('slaveLength'), 3);
    assert.equal(written.get('SlaveIDList').length, 3);
    assert.equal(written.get('parameterName0'), 'Sensor1');
    assert.equal(written.get('parameterID2'), '6');
    assert.equal(written.get('sID2'), 101);
    assert.equal(written.get('sregisterAddress1'), 3);
    assert.equal(written.get('sdataBits0'), 1);
    assert.equal(written.get('baudRate'), 9600);
    assert.equal(written.get('Polling'), 10000);
    assert.equal(written.get('Timeout'), 1000);
    assert.equal(written.get('stopBits'), 2);
    assert.ok(!written.has('paraRaw')); // flow-scoped on another tab - delivered via link, not global
  });
});
