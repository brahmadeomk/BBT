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
});
