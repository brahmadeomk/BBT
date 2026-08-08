'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ConfigStore } = require('../../../src/config-service/store');
const { validateModbusJoints } = require('../../../src/config-service/validate-modbus-joints');
const { validateAlarms } = require('../../../src/config-service/validate-alarms');
const { buildNanoJobMessage } = require('../../../src/config-service/node-red/nano-resend-handler');
const { validModbusJointsDoc } = require('../fixtures');

function freshStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-resend-test-'));
  return new ConfigStore({ root, validators: { modbus_joints: validateModbusJoints, alarms: validateAlarms } });
}

describe('buildNanoJobMessage', () => {
  test('errors clearly when nothing has been applied yet', () => {
    const store = freshStore();
    const result = buildNanoJobMessage(store);
    assert.ok(result.error.includes('no cfg/modbus+joints'));
  });

  test('compiles the currently applied document', () => {
    const store = freshStore();
    store.applyIfValid('modbus_joints', validModbusJointsDoc());
    const result = buildNanoJobMessage(store);
    assert.ok(result.job);
    assert.equal(result.job.read[0], validModbusJointsDoc().modbus.slaves.length);
  });

  test('reflects the latest applied version, not a stale one', () => {
    const store = freshStore();
    const doc1 = validModbusJointsDoc();
    store.applyIfValid('modbus_joints', doc1);

    const doc2 = validModbusJointsDoc();
    doc2.config_domain_versions = { modbus: doc1.config_domain_versions.modbus + 1, joints: doc1.config_domain_versions.joints + 1 };
    doc2.modbus.slaves.push({
      slave_id: 'sl03',
      bus_id: 'bus1',
      unit_address: 3,
      model: 'BT-SCM-4',
      channels: 4,
      registers: { function_code: 3, temp_base_addr: 100, temp_word_count: 1, temp_scale: 0.1 },
    });
    store.applyIfValid('modbus_joints', doc2);

    const result = buildNanoJobMessage(store);
    assert.equal(result.job.read[0], 3);
  });

  // The flow's "Send Nano Job" node always passes the segment it is wired to
  // (BUSDUCT_BUS_ID, default 'bus1'). On a single-bus panel there is exactly
  // one Nano, so renaming the sole bus in cfg/modbus must not silently stop the
  // panel polling - the id is a preference there, not a filter.
  test('a single-bus panel compiles even when its bus is not named bus1', () => {
    const store = freshStore();
    const doc = validModbusJointsDoc();
    doc.modbus.buses[0].bus_id = 'bus2';
    for (const s of doc.modbus.slaves) s.bus_id = 'bus2';
    assert.ok(store.applyIfValid('modbus_joints', doc).applied);
    const result = buildNanoJobMessage(store, { busId: 'bus1' });
    assert.ok(!result.error, result.error);
    assert.equal(result.job.read[0], doc.modbus.slaves.length);
  });

  test('on a multi-bus panel busId selects the segment, and omitting it errors', () => {
    const store = freshStore();
    const doc = validModbusJointsDoc();
    doc.modbus.buses.push({ ...doc.modbus.buses[0], bus_id: 'bus2', port: '/dev/ttyACM1' });
    doc.modbus.slaves[0].bus_id = 'bus2';
    assert.ok(store.applyIfValid('modbus_joints', doc).applied);

    assert.match(buildNanoJobMessage(store).error, /specify \{busId\}/);
    const b2 = buildNanoJobMessage(store, { busId: 'bus2' });
    assert.equal(b2.job.read[0], 1, 'only the one slave moved to segment 2');
    const b1 = buildNanoJobMessage(store, { busId: 'bus1' });
    assert.equal(b1.job.read[0], doc.modbus.slaves.length - 1);
  });
});
