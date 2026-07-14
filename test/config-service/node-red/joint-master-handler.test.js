'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ConfigStore } = require('../../../src/config-service/store');
const { validateModbusJoints } = require('../../../src/config-service/validate-modbus-joints');
const { validateAlarms } = require('../../../src/config-service/validate-alarms');
const { handleJointMasterMessage } = require('../../../src/config-service/node-red/joint-master-handler');

function freshStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-jmh-test-'));
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
        { slave_id: 'sl03', bus_id: 'bus1', unit_address: 3, model: 'LEGACY-1CH', channels: 1, poll_interval_s: 30, registers: { function_code: 3, temp_base_addr: 3, temp_word_count: 1, temp_scale: 0.1 } },
        { slave_id: 'sl21', bus_id: 'bus1', unit_address: 101, model: 'LEGACY-1CH', channels: 1, poll_interval_s: 30, registers: { function_code: 3, temp_base_addr: 3, temp_word_count: 1, temp_scale: 0.1 } },
        { slave_id: 'sl22', bus_id: 'bus1', unit_address: 102, model: 'LEGACY-1CH', channels: 1, poll_interval_s: 30, registers: { function_code: 3, temp_base_addr: 3, temp_word_count: 1, temp_scale: 0.1 } },
      ],
      ambient_sensor: { slave_id: 'sl21', channel: 1 },
    },
    joints: [{ joint_id: 'J01', slave_id: 'sl01', channel: 1, zone_id: 'z1', enabled: true, threshold_profile: 'default' }],
    zones: [{ zone_id: 'z1', name: 'Zone1' }],
  };
  store.applyIfValid('modbus_joints', doc);
}

/** Same seed, but slave sl03 (unit 3) is a 2-channel module at addresses 3 and 4. */
function seedMultiChannelSlave(store) {
  const doc = {
    config_domain_versions: { modbus: 1, joints: 1 },
    modbus: {
      buses: [{ bus_id: 'bus1', type: 'rtu', port: '/dev/ttyUSB0', baud: 9600, parity: 'N', stop_bits: 2, timeout_ms: 1000, retries: 2, inter_frame_ms: 10 }],
      slaves: [
        { slave_id: 'sl03', bus_id: 'bus1', unit_address: 3, model: 'LEGACY-2CH', channels: 2, poll_interval_s: 30, registers: { function_code: 3, temp_base_addr: 3, temp_word_count: 1, temp_scale: 0.1, channel_addrs: [3, 4], channel_labels: ['S3-A', 'S3-B'] } },
        { slave_id: 'sl21', bus_id: 'bus1', unit_address: 101, model: 'LEGACY-1CH', channels: 1, poll_interval_s: 30, registers: { function_code: 3, temp_base_addr: 3, temp_word_count: 1, temp_scale: 0.1 } },
      ],
      ambient_sensor: { slave_id: 'sl21', channel: 1 },
    },
    joints: [{ joint_id: 'J01', slave_id: 'sl03', channel: 1, zone_id: 'z1', enabled: true, threshold_profile: 'default' }],
    zones: [{ zone_id: 'z1', name: 'Zone1' }],
  };
  const result = store.applyIfValid('modbus_joints', doc);
  assert.ok(result.applied, `multi-channel seed must apply: ${JSON.stringify(result.errors)}`);
}

const legacySlaveList = () => [
  { slaveID: 1, parameterName: 'Sensor1' },
  { slaveID: 2, parameterName: 'Sensor2' },
  { slaveID: 3, parameterName: 'Sensor3' },
  { slaveID: 101, parameterName: 'AmbientT' },
  { slaveID: 102, parameterName: 'AmbientT2' },
];
const legacyZones = () => [{ zone_id: 'Z1', zone_name: 'Zone1' }];

describe('handleJointMasterMessage - draft bookkeeping (add/edit/delete/save)', () => {
  test('add appends an empty editable row, persists it, and sends the updated table', () => {
    const store = freshStore();
    const result = handleJointMasterMessage(
      { payload: { action: 'add' } },
      { joints: [], slaveList: legacySlaveList(), zones: legacyZones(), store }
    );
    assert.equal(result.draft.length, 1);
    assert.equal(result.draft[0].editing, true);
    // the dashboard table repaints immediately after add, showing the new blank row
    assert.equal(result.msg.payload.joints.length, 1);
    assert.equal(result.msg.payload.joints[0].editing, true);
  });

  test('add_below inserts after the given index and sends the updated table', () => {
    const store = freshStore();
    const joints = [{ joint_id: 'J01', slaveID: 1, zone_id: 'Z1', editing: false }];
    const result = handleJointMasterMessage(
      { payload: { action: 'add_below', index: 0 } },
      { joints, slaveList: legacySlaveList(), zones: legacyZones(), store }
    );
    assert.equal(result.draft.length, 2);
    assert.equal(result.draft[1].editing, true);
    assert.equal(result.msg.payload.joints.length, 2);
  });

  test('edit marks the row editable and sends the updated table', () => {
    const store = freshStore();
    const joints = [{ joint_id: 'J01', slaveID: 1, zone_id: 'Z1', editing: false }];
    const result = handleJointMasterMessage(
      { payload: { action: 'edit', index: 0 } },
      { joints, slaveList: legacySlaveList(), zones: legacyZones(), store }
    );
    assert.equal(result.draft[0].editing, true);
    assert.equal(result.msg.payload.joints[0].editing, true);
  });

  test('save rejects missing fields without persisting', () => {
    const store = freshStore();
    const joints = [{ joint_name: '', joint_id: '', slaveID: '', zone_id: '', editing: true }];
    const result = handleJointMasterMessage(
      { payload: { action: 'save', index: 0 } },
      { joints, slaveList: legacySlaveList(), zones: legacyZones(), store }
    );
    assert.equal(result.msg.payload.error, 'Missing fields');
    assert.equal(result.draft, null);
  });

  test('save rejects an unknown slave', () => {
    const store = freshStore();
    const joints = [{ joint_name: 'J01', joint_id: 'J01', slaveID: 999, zone_id: 'Z1', editing: true }];
    const result = handleJointMasterMessage(
      { payload: { action: 'save', index: 0 } },
      { joints, slaveList: legacySlaveList(), zones: legacyZones(), store }
    );
    assert.equal(result.msg.payload.error, 'Invalid Slave');
  });

  test('save accepts a complete row and fills in slaveName/zone_name', () => {
    const store = freshStore();
    const joints = [{ joint_name: 'J01', joint_id: 'J01', slaveID: 1, zone_id: 'Z1', editing: true }];
    const result = handleJointMasterMessage(
      { payload: { action: 'save', index: 0 } },
      { joints, slaveList: legacySlaveList(), zones: legacyZones(), store }
    );
    assert.equal(result.msg.payload.success, 'Saved');
    assert.equal(result.draft[0].slaveName, 'Sensor1');
    assert.equal(result.draft[0].zone_name, 'Zone1');
    assert.equal(result.draft[0].editing, false);
  });

  test('delete removes the row at the given index and sends the updated table', () => {
    const store = freshStore();
    const joints = [{ joint_id: 'J01' }, { joint_id: 'J02' }];
    const result = handleJointMasterMessage(
      { payload: { action: 'delete', index: 0 } },
      { joints, slaveList: legacySlaveList(), zones: legacyZones(), store }
    );
    assert.equal(result.draft.length, 1);
    assert.equal(result.draft[0].joint_id, 'J02');
    assert.equal(result.msg.payload.joints.length, 1);
  });

  test('preserves other msg properties (topic, req/res, socketid) the dashboard needs for routing', () => {
    const store = freshStore();
    const joints = [{ joint_id: 'J01' }];
    const fakeReq = {};
    const fakeRes = {};
    const result = handleJointMasterMessage(
      { topic: 'joints', socketid: 'abc123', req: fakeReq, res: fakeRes, _msgid: 'xyz', payload: { action: 'add' } },
      { joints, slaveList: legacySlaveList(), zones: legacyZones(), store }
    );
    assert.equal(result.msg.topic, 'joints');
    assert.equal(result.msg.socketid, 'abc123');
    assert.equal(result.msg.req, fakeReq);
    assert.equal(result.msg.res, fakeRes);
    assert.equal(result.msg._msgid, 'xyz');
  });

  test('suppresses output on a plain refresh while a row is mid-edit (safe refresh)', () => {
    const store = freshStore();
    const joints = [{ joint_id: 'J01', editing: true }];
    const result = handleJointMasterMessage({ payload: {} }, { joints, slaveList: legacySlaveList(), zones: legacyZones(), store });
    assert.equal(result.msg, null);
    assert.equal(result.draft, null);
  });

  test('returns the draft as-is on a plain refresh with nothing mid-edit', () => {
    const store = freshStore();
    const joints = [{ joint_id: 'J01', editing: false }];
    const result = handleJointMasterMessage({ payload: {} }, { joints, slaveList: legacySlaveList(), zones: legacyZones(), store });
    assert.deepEqual(result.msg.payload.joints, joints);
  });
});

describe('handleJointMasterMessage - apply', () => {
  test('rejects when cfg/modbus has not been provisioned yet', () => {
    const store = freshStore(); // no seed
    const joints = [{ joint_name: 'J01', joint_id: 'J01', slaveID: 1, ambientSlaveID: 101, zone_id: 'Z1', editing: false }];
    const result = handleJointMasterMessage(
      { payload: { action: 'apply' } },
      { joints, slaveList: legacySlaveList(), zones: legacyZones(), store }
    );
    assert.ok(result.msg.payload.error.includes('No cfg/modbus applied yet'));
  });

  test('rejects a slave not yet provisioned in the applied cfg/modbus', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const joints = [{ joint_name: 'J09', joint_id: 'J09', slaveID: 2, ambientSlaveID: 101, zone_id: 'Z1', editing: false }];
    // slave 2 IS provisioned; use a slave that legacy dropdown allows but isn't in the applied doc
    const extendedSlaveList = [...legacySlaveList(), { slaveID: 7, parameterName: 'Sensor7' }];
    joints[0].slaveID = 7;
    const result = handleJointMasterMessage(
      { payload: { action: 'apply' } },
      { joints, slaveList: extendedSlaveList, zones: legacyZones(), store }
    );
    assert.ok(result.msg.payload.error.includes('not yet provisioned'));
  });

  test('applies a valid draft, bumps both modbus and joints versions, sets panel ambient default', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const joints = [
      { joint_name: 'J01', joint_id: 'J01', slaveID: 1, ambientSlaveID: 101, zone_id: 'Z1', editing: false },
      { joint_name: 'J02', joint_id: 'J02', slaveID: 2, ambientSlaveID: 101, zone_id: 'Z1', editing: false },
    ];
    const result = handleJointMasterMessage(
      { payload: { action: 'apply', user: 'alice' } },
      { joints, slaveList: legacySlaveList(), zones: legacyZones(), store, user: 'alice' }
    );
    assert.equal(result.msg.payload.success, 'Configuration saved');
    // joint/zone-only edit (this scenario never touches modbus.slaves/buses) - the compiled
    // Nano job is unchanged, so no resend should be triggered (see nano-compiler.js's nanoJobsEqual)
    assert.equal(result.resendNeeded, false);

    const { doc } = store.readDomain('modbus_joints');
    assert.equal(doc.config_domain_versions.modbus, 2);
    assert.equal(doc.config_domain_versions.joints, 2);
    assert.equal(doc.joints.length, 2);
    assert.deepEqual(doc.modbus.ambient_sensor, { slave_id: 'sl21', channel: 1 });
    assert.ok(doc.joints.every((j) => !j.ambient_sensor)); // everyone agrees with the panel default
  });

  test('does not flag a resend for a joint-mapping-only apply (the reported bug: joint edits must not disturb Nano polling)', () => {
    const store = freshStore();
    seedModbusJoints(store);
    // Re-map J01 from slave 1 to slave 2 and change its zone/ambient - a real joint-mapping
    // edit, the kind that triggered the bug report. It never touches modbus.slaves/buses,
    // so the compiled Nano job (which only reads those) must be unchanged.
    const joints = [{ joint_name: 'J01-moved', joint_id: 'J01', slaveID: 2, ambientSlaveID: 102, zone_id: 'Z1', editing: false }];
    const result = handleJointMasterMessage({ payload: { action: 'apply' } }, { joints, slaveList: legacySlaveList(), zones: legacyZones(), store });
    assert.equal(result.msg.payload.success, 'Configuration saved');
    assert.equal(result.resendNeeded, false);
  });

  test('does not flag a resend for a rejected apply', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const joints = [
      { joint_name: 'J01', joint_id: 'J01', slaveID: 1, ambientSlaveID: 101, zone_id: 'Z1', editing: false },
      { joint_name: 'J01', joint_id: 'J01', slaveID: 2, ambientSlaveID: 101, zone_id: 'Z1', editing: false }, // duplicate joint_id
    ];
    const result = handleJointMasterMessage({ payload: { action: 'apply' } }, { joints, slaveList: legacySlaveList(), zones: legacyZones(), store });
    assert.ok(!result.resendNeeded);
  });

  test('does not flag a resend for draft-only actions (add/edit/delete/save)', () => {
    const store = freshStore();
    const result = handleJointMasterMessage({ payload: { action: 'add' } }, { joints: [], slaveList: legacySlaveList(), zones: legacyZones(), store });
    assert.ok(!result.resendNeeded);
  });

  test('sets a joint-level ambient override for an outlier joint referencing a dedicated ambient probe', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const joints = [
      { joint_name: 'J01', joint_id: 'J01', slaveID: 1, ambientSlaveID: 102, zone_id: 'Z1', editing: false }, // outlier: uses the 2nd ambient probe
      { joint_name: 'J02', joint_id: 'J02', slaveID: 2, ambientSlaveID: 101, zone_id: 'Z1', editing: false },
      { joint_name: 'J03', joint_id: 'J03', slaveID: 3, ambientSlaveID: 101, zone_id: 'Z1', editing: false },
    ];

    handleJointMasterMessage({ payload: { action: 'apply' } }, { joints, slaveList: legacySlaveList(), zones: legacyZones(), store });

    const { doc } = store.readDomain('modbus_joints');
    const j01 = doc.joints.find((j) => j.joint_id === 'J01');
    assert.deepEqual(j01.ambient_sensor, { slave_id: 'sl22', channel: 1 });
  });

  test('rejects duplicate joint IDs before touching the store', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const joints = [
      { joint_name: 'J01', joint_id: 'J01', slaveID: 1, ambientSlaveID: 101, zone_id: 'Z1', editing: false },
      { joint_name: 'J01', joint_id: 'J01', slaveID: 2, ambientSlaveID: 101, zone_id: 'Z1', editing: false },
    ];
    const result = handleJointMasterMessage({ payload: { action: 'apply' } }, { joints, slaveList: legacySlaveList(), zones: legacyZones(), store });
    assert.equal(result.msg.payload.error, 'Duplicate Joint ID');

    const { doc } = store.readDomain('modbus_joints');
    assert.equal(doc.config_domain_versions.joints, 1); // unchanged from seed
  });

  test('rejects two joints claiming the same (slave, channel) pair, naming the conflict', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const joints = [
      { joint_name: 'J01', joint_id: 'J01', slaveID: 1, ambientSlaveID: 101, zone_id: 'Z1', editing: false },
      { joint_name: 'J02', joint_id: 'J02', slaveID: 1, ambientSlaveID: 101, zone_id: 'Z1', editing: false },
    ];
    const result = handleJointMasterMessage({ payload: { action: 'apply' } }, { joints, slaveList: legacySlaveList(), zones: legacyZones(), store });
    assert.equal(result.msg.payload.error, 'Slave 1 channel 1 is already mapped to joint J01');
  });

  test('accepts two joints on different channels of the same multi-channel slave', () => {
    const store = freshStore();
    seedMultiChannelSlave(store);
    const joints = [
      { joint_name: 'J01', joint_id: 'J01', slaveID: 3, channel: 1, ambientSlaveID: 101, zone_id: 'Z1', editing: false },
      { joint_name: 'J02', joint_id: 'J02', slaveID: 3, channel: 2, ambientSlaveID: 101, zone_id: 'Z1', editing: false },
    ];
    const result = handleJointMasterMessage({ payload: { action: 'apply' } }, { joints, slaveList: legacySlaveList(), zones: legacyZones(), store });
    assert.equal(result.msg.payload.success, 'Configuration saved');

    const { doc } = store.readDomain('modbus_joints');
    assert.deepEqual(
      doc.joints.map((j) => [j.joint_id, j.slave_id, j.channel]),
      [['J01', 'sl03', 1], ['J02', 'sl03', 2]]
    );
  });

  test('rejects a joint selecting a channel the slave does not have, with a friendly message', () => {
    const store = freshStore();
    seedModbusJoints(store); // slave 1 has a single channel
    const joints = [{ joint_name: 'J01', joint_id: 'J01', slaveID: 1, channel: 2, ambientSlaveID: 101, zone_id: 'Z1', editing: false }];
    const result = handleJointMasterMessage({ payload: { action: 'apply' } }, { joints, slaveList: legacySlaveList(), zones: legacyZones(), store });
    assert.equal(result.msg.payload.error, 'Slave 1 only has 1 channel - joint J01 selects channel 2');
  });

  test('save rejects an out-of-range channel', () => {
    const store = freshStore();
    const joints = [{ joint_name: 'J01', joint_id: 'J01', slaveID: 1, channel: 9, zone_id: 'Z1', editing: true }];
    const result = handleJointMasterMessage(
      { payload: { action: 'save', index: 0 } },
      { joints, slaveList: legacySlaveList(), zones: legacyZones(), store }
    );
    assert.equal(result.msg.payload.error, 'Channel must be 1-8');
  });

  test('legacy draft rows without a channel field still apply as channel 1', () => {
    const store = freshStore();
    seedModbusJoints(store);
    const joints = [{ joint_name: 'J01', joint_id: 'J01', slaveID: 1, ambientSlaveID: 101, zone_id: 'Z1', editing: false }];
    const result = handleJointMasterMessage({ payload: { action: 'apply' } }, { joints, slaveList: legacySlaveList(), zones: legacyZones(), store });
    assert.equal(result.msg.payload.success, 'Configuration saved');
    const { doc } = store.readDomain('modbus_joints');
    assert.equal(doc.joints[0].channel, 1);
  });
});
