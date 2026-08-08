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
    const row = { slave_id: '', label: 'S1', unit_address: 1, channel: 1, base_addr: 3, model: 'M', temp_word_count: 1, temp_scale: 0.1, poll_interval_s: 30, editing: false };
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
    state.slaves.push({ slave_id: '', label: 'Sensor3', unit_address: 3, channel: 1, base_addr: 3, model: 'BT-SCM-4', temp_word_count: 1, temp_scale: 0.1, poll_interval_s: 30, editing: false });
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

  test('rejects two rows claiming the same channel of one unit', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const state = loadState(store);
    state.slaves[1].unit_address = 1; // both rows now unit 1, both channel 1
    const result = handleModbusSettingsMessage(
      { payload: { action: 'apply', slaves: state.slaves, bus: state.bus } },
      { store, legacySlaveList: legacySlaveList() }
    );
    assert.match(result.msg.payload.error, /Unit 1: channels must be 1\.\.2/);
  });

  test('rejects two channels of one unit sharing a base address', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const state = loadState(store);
    state.slaves[1].unit_address = 1;
    state.slaves[1].channel = 2; // channels now 1..2, but both at base 3
    const result = handleModbusSettingsMessage(
      { payload: { action: 'apply', slaves: state.slaves, bus: state.bus } },
      { store, legacySlaveList: legacySlaveList() }
    );
    assert.match(result.msg.payload.error, /Unit 1: duplicate base address 3/);
  });

  test('rejects mismatched poll intervals across one unit\'s channels (polling is per slave)', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const state = loadState(store);
    state.slaves[1].unit_address = 1;
    state.slaves[1].channel = 2;
    state.slaves[1].base_addr = 4;
    state.slaves[1].poll_interval_s = 60; // row 0 stays at 30
    const result = handleModbusSettingsMessage(
      { payload: { action: 'apply', slaves: state.slaves, bus: state.bus } },
      { store, legacySlaveList: legacySlaveList() }
    );
    assert.match(result.msg.payload.error, /Unit 1: poll interval must match across its channels/);
  });

  test('commissions a multi-channel unit: rows grouped into one slave with channel_addrs/channel_labels', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const state = loadState(store);
    state.slaves.push(
      { slave_id: '', label: 'Joint7-Top', unit_address: 7, channel: 1, base_addr: 10, model: 'BT-SCM-2', temp_word_count: 1, temp_scale: 0.1, poll_interval_s: 30, editing: false },
      { slave_id: '', label: 'Joint7-Bottom', unit_address: 7, channel: 2, base_addr: 12, model: 'BT-SCM-2', temp_word_count: 1, temp_scale: 0.1, poll_interval_s: 30, editing: false }
    );
    const result = handleModbusSettingsMessage(
      { payload: { action: 'apply', slaves: state.slaves, bus: state.bus } },
      { store, legacySlaveList: legacySlaveList() }
    );
    assert.equal(result.msg.payload.success, 'Modbus configuration applied');
    assert.equal(result.resendNeeded, true);

    const { doc } = store.readDomain('modbus_joints');
    const unit7 = doc.modbus.slaves.find((s) => s.unit_address === 7);
    assert.equal(unit7.channels, 2);
    assert.equal(unit7.registers.temp_base_addr, 10);
    assert.deepEqual(unit7.registers.channel_addrs, [10, 12]);
    assert.deepEqual(unit7.registers.channel_labels, ['Joint7-Top', 'Joint7-Bottom']);
    assert.equal(unit7.label, undefined); // per-channel labels carry the names

    // round trip: reload explodes it back into two rows
    const reloaded = loadState(store);
    const rows7 = reloaded.slaves.filter((r) => r.unit_address === 7);
    assert.deepEqual(
      rows7.map((r) => [r.channel, r.base_addr, r.label, r.slave_id]),
      [[1, 10, 'Joint7-Top', unit7.slave_id], [2, 12, 'Joint7-Bottom', unit7.slave_id]]
    );
  });

  test('add_channel pre-fills a new row for the same unit with the next channel number', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const state = loadState(store);
    const result = handleModbusSettingsMessage(
      { payload: { action: 'add_channel', index: 0, slaves: state.slaves, bus: state.bus } },
      { store, legacySlaveList: legacySlaveList() }
    );
    const added = result.msg.payload.slaves[1];
    assert.equal(added.unit_address, state.slaves[0].unit_address);
    assert.equal(added.channel, 2);
    assert.equal(added.model, state.slaves[0].model);
    assert.equal(added.editing, true);
  });

  test('refuses to remove a channel still mapped to a joint', () => {
    const store = freshStore();
    seedModbusJoints(store);
    // remap J01 to channel 2 of a two-channel unit first
    const state0 = loadState(store);
    state0.slaves.push(
      { slave_id: '', label: 'U7-A', unit_address: 7, channel: 1, base_addr: 10, model: 'M', temp_word_count: 1, temp_scale: 0.1, poll_interval_s: 30, editing: false },
      { slave_id: '', label: 'U7-B', unit_address: 7, channel: 2, base_addr: 11, model: 'M', temp_word_count: 1, temp_scale: 0.1, poll_interval_s: 30, editing: false }
    );
    handleModbusSettingsMessage({ payload: { action: 'apply', slaves: state0.slaves, bus: state0.bus } }, { store, legacySlaveList: legacySlaveList() });
    const { doc } = store.readDomain('modbus_joints');
    const unit7Id = doc.modbus.slaves.find((s) => s.unit_address === 7).slave_id;
    doc.joints.push({ joint_id: 'J07', slave_id: unit7Id, channel: 2, zone_id: 'z1', enabled: true, threshold_profile: 'default' });
    doc.config_domain_versions.modbus++;
    doc.config_domain_versions.joints++;
    assert.ok(store.applyIfValid('modbus_joints', doc).applied);

    // now try to drop channel 2 of unit 7
    const state = loadState(store);
    const idx = state.slaves.findIndex((r) => r.unit_address === 7 && r.channel === 2);
    state.slaves.splice(idx, 1);
    const result = handleModbusSettingsMessage(
      { payload: { action: 'apply', slaves: state.slaves, bus: state.bus } },
      { store, legacySlaveList: legacySlaveList() }
    );
    assert.match(result.msg.payload.error, /channel still mapped to a joint: J07 \(channel 2\)/);
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
    state.slaves.push(
      { slave_id: '', label: 'New-A', unit_address: 7, channel: 1, base_addr: 10, model: 'BT-SCM-4', temp_word_count: 2, temp_scale: 0.1, poll_interval_s: 30, editing: false },
      { slave_id: '', label: 'New-B', unit_address: 7, channel: 2, base_addr: 12, model: 'BT-SCM-4', temp_word_count: 2, temp_scale: 0.1, poll_interval_s: 30, editing: false }
    );
    const { legacy } = handleModbusSettingsMessage(
      { payload: { action: 'apply', slaves: state.slaves, bus: state.bus } },
      { store, legacySlaveList: mixedLegacy }
    );
    assert.equal(legacy.SlaveIDList[1].id, '9'); // carried by unit_address
    const addedRows = legacy.SlaveIDList.filter((ls) => ls.slaveID === 7);
    assert.equal(addedRows.length, 2); // one legacy entry per channel
    assert.ok(addedRows.every((ls) => ls.id === '6')); // panel-dominant type
    assert.deepEqual(addedRows.map((ls) => [ls.parameterName, ls.registerAddress, ls.dataBits]), [['New-A', 10, 2], ['New-B', 12, 2]]);
    assert.deepEqual(legacy.paraRaw.find((t) => t[0] === 7), [7, 10, 4]); // span 10..13 = (12-10)+2 words
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

/**
 * Two-segment RS-485 (Slice 10 §B). The Nano firmware drives exactly one
 * RS-485 port, so a second segment is a second Nano on its own serial port -
 * the settings table therefore carries a `buses` ARRAY, each slave row names
 * its bus, and a resend is decided per bus so editing segment 2 can't glitch
 * segment 1's live polling.
 */
describe('handleModbusSettingsMessage - two RS-485 segments', () => {
  const BUS2 = { bus_id: 'bus2', port: '/dev/ttyACM1', baud: 9600, parity: 'N', stop_bits: 1, timeout_ms: 1000, retries: 2, inter_frame_ms: 10 };

  test('load echoes buses as an array (and bus as buses[0] for older clients)', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const { buses, bus, slaves } = loadState(store);
    assert.equal(buses.length, 1);
    assert.equal(buses[0].bus_id, 'bus1');
    assert.deepEqual(bus, buses[0]);
    assert.ok(slaves.every((s) => s.bus_id === 'bus1'), 'every row names its bus');
  });

  test('a single-bus draft saved before multi-bus still loads', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const legacyDraft = { slaves: loadState(store).slaves, bus: { port: '/dev/ttyUSB9', baud: 19200, parity: 'N', stop_bits: 1, timeout_ms: 1000, retries: 2, inter_frame_ms: 10 } };
    const result = handleModbusSettingsMessage({ payload: {} }, { store, draft: legacyDraft, legacySlaveList: legacySlaveList() });
    assert.equal(result.msg.payload.buses.length, 1);
    assert.equal(result.msg.payload.buses[0].bus_id, 'bus1', 'the unnamed legacy bus becomes bus1');
    assert.equal(result.msg.payload.buses[0].port, '/dev/ttyUSB9');
  });

  test('add_bus appends a second segment; delete_bus removes an empty one', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const state = loadState(store);
    const added = handleModbusSettingsMessage(
      { payload: { action: 'add_bus', slaves: state.slaves, buses: state.buses } },
      { store, legacySlaveList: legacySlaveList() }
    );
    assert.deepEqual(added.msg.payload.buses.map((b) => b.bus_id), ['bus1', 'bus2']);
    assert.equal(added.draft.buses.length, 2, 'persisted so a refresh does not lose it');

    const removed = handleModbusSettingsMessage(
      { payload: { action: 'delete_bus', index: 1, slaves: state.slaves, buses: added.msg.payload.buses } },
      { store, legacySlaveList: legacySlaveList() }
    );
    assert.deepEqual(removed.msg.payload.buses.map((b) => b.bus_id), ['bus1']);
  });

  test('delete_bus refuses while sensors still sit on it, naming them', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const state = loadState(store);
    const buses = [state.buses[0], { ...BUS2 }];
    const slaves = state.slaves.map((s, i) => (i === 0 ? { ...s, bus_id: 'bus2' } : s));
    const result = handleModbusSettingsMessage(
      { payload: { action: 'delete_bus', index: 1, slaves, buses } },
      { store, legacySlaveList: legacySlaveList() }
    );
    assert.match(result.msg.payload.error, /bus2 still carries 1 sensor\(s\) \(Sensor1\)/);
    assert.equal(result.draft, null);
  });

  test('delete_bus refuses to remove the last bus', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const state = loadState(store);
    const result = handleModbusSettingsMessage(
      { payload: { action: 'delete_bus', index: 0, slaves: [], buses: state.buses } },
      { store, legacySlaveList: legacySlaveList() }
    );
    assert.match(result.msg.payload.error, /at least one RS-485 bus/);
  });

  test('applies a two-bus document and compiles one Nano job per segment', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const state = loadState(store);
    const buses = [state.buses[0], { ...BUS2, baud: 19200 }];
    // move the ambient unit (101) onto segment 2
    const slaves = state.slaves.map((s) => (s.unit_address === 101 ? { ...s, bus_id: 'bus2' } : s));
    const result = handleModbusSettingsMessage(
      { payload: { action: 'apply', slaves, buses } },
      { store, legacySlaveList: legacySlaveList() }
    );
    assert.equal(result.msg.payload.success, 'Modbus configuration applied');

    const { doc } = store.readDomain('modbus_joints');
    assert.deepEqual(doc.modbus.buses.map((b) => [b.bus_id, b.port, b.baud]), [['bus1', '/dev/ttyUSB0', 9600], ['bus2', '/dev/ttyACM1', 19200]]);
    assert.deepEqual(doc.modbus.slaves.map((s) => [s.unit_address, s.bus_id]), [[1, 'bus1'], [2, 'bus1'], [101, 'bus2']]);

    const { compileNanoJob } = require('../../../src/config-service/nano-compiler');
    const j1 = compileNanoJob(doc, { busId: 'bus1' });
    const j2 = compileNanoJob(doc, { busId: 'bus2' });
    assert.deepEqual(j1.job.read, [2, [1, 3, 1], [2, 3, 1]], 'segment 1 polls only its own slaves');
    assert.deepEqual(j2.job.read, [1, [101, 3, 1]]);
    assert.equal(j2.job.comm[1], 19200, "each segment carries its own bus's comm");
  });

  test('resend is decided per bus - a bus2-only edit does not resend bus1', () => {
    const store = freshStore();
    seedModbusJoints(store);
    // start from a committed two-bus panel
    const state0 = loadState(store);
    const buses0 = [state0.buses[0], { ...BUS2 }];
    const slaves0 = state0.slaves.map((s) => (s.unit_address === 101 ? { ...s, bus_id: 'bus2' } : s));
    assert.ok(handleModbusSettingsMessage({ payload: { action: 'apply', slaves: slaves0, buses: buses0 } }, { store, legacySlaveList: legacySlaveList() }).msg.payload.success);

    const state = loadState(store);
    const buses = state.buses.map((b) => (b.bus_id === 'bus2' ? { ...b, timeout_ms: 1500 } : b));
    const result = handleModbusSettingsMessage(
      { payload: { action: 'apply', slaves: state.slaves, buses } },
      { store, legacySlaveList: legacySlaveList() }
    );
    assert.equal(result.msg.payload.success, 'Modbus configuration applied');
    assert.deepEqual(result.resendBusIds, ['bus2'], 'only the changed segment is resent');
    assert.equal(result.resendNeeded, true);
  });

  test('rejects two buses sharing one serial port', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const state = loadState(store);
    const buses = [state.buses[0], { ...BUS2, port: '/dev/ttyUSB0' }];
    const result = handleModbusSettingsMessage(
      { payload: { action: 'apply', slaves: state.slaves, buses } },
      { store, legacySlaveList: legacySlaveList() }
    );
    assert.match(result.msg.payload.error, /share the serial port '\/dev\/ttyUSB0'/);
  });

  test('rejects the same unit address on two different buses', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const state = loadState(store);
    const buses = [state.buses[0], { ...BUS2 }];
    const slaves = [...state.slaves, { slave_id: '', label: 'Clash', bus_id: 'bus2', unit_address: 1, channel: 1, base_addr: 3, model: 'M', temp_word_count: 1, temp_scale: 0.1, poll_interval_s: 30, editing: false }];
    const result = handleModbusSettingsMessage(
      { payload: { action: 'apply', slaves, buses } },
      { store, legacySlaveList: legacySlaveList() }
    );
    assert.match(result.msg.payload.error, /Unit address 1 is used on both bus1 and bus2/);
  });

  test('rejects a slave assigned to a bus that is not defined', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const state = loadState(store);
    const slaves = state.slaves.map((s, i) => (i === 0 ? { ...s, bus_id: 'bus2' } : s));
    const result = handleModbusSettingsMessage(
      { payload: { action: 'apply', slaves, buses: state.buses } },
      { store, legacySlaveList: legacySlaveList() }
    );
    assert.match(result.msg.payload.error, /assigned to bus 'bus2', which is not defined/);
  });

  test('the legacy bridge covers bus1 only - paraRaw excludes the other segment', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const state = loadState(store);
    const buses = [state.buses[0], { ...BUS2, baud: 19200 }];
    const slaves = state.slaves.map((s) => (s.unit_address === 101 ? { ...s, bus_id: 'bus2' } : s));
    const { legacy } = handleModbusSettingsMessage(
      { payload: { action: 'apply', slaves, buses } },
      { store, legacySlaveList: legacySlaveList() }
    );
    // the legacy read-job builder writes to bus1's serial port only: asking that
    // Nano for a unit that lives on the other segment would just time out
    assert.deepEqual(legacy.paraRaw, [[1, 3, 1], [2, 3, 1]]);
    assert.equal(legacy.comm.baudRate, 9600, "comm describes bus1, the legacy path's port");
    // ...but the decode side must still be able to decode either Nano's response
    assert.equal(legacy.slaveLength, 3);
    assert.deepEqual(legacy.SlaveIDList.map((ls) => ls.slaveID), [1, 2, 101]);
  });
});
