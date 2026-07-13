'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { ConfigStore } = require('../../src/config-service/store');
const { validateModbusJoints } = require('../../src/config-service/validate-modbus-joints');
const { validateAlarms } = require('../../src/config-service/validate-alarms');
const { validAlarmsDoc } = require('../config-service/fixtures');

const SCRIPT = path.join(__dirname, '..', '..', 'tools', 'apply-migrated-config.js');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-apply-migrated-test-'));
}

describe('apply-migrated-config.js', () => {
  test('applies the committed migrated config to a fresh store', () => {
    const root = tmpRoot();
    const output = execFileSync('node', [SCRIPT, `--root=${root}`], { encoding: 'utf8' });
    assert.match(output, /modbus_joints applied/);
    assert.match(output, /alarms applied/);
    assert.ok(fs.existsSync(path.join(root, 'modbus_joints.json')));
    assert.ok(fs.existsSync(path.join(root, 'alarms.json')));
  });

  test('running it again just skips both domains (idempotent, not an error)', () => {
    const root = tmpRoot();
    execFileSync('node', [SCRIPT, `--root=${root}`]);
    const output = execFileSync('node', [SCRIPT, `--root=${root}`], { encoding: 'utf8' });
    assert.match(output, /Skipping modbus_joints/);
    assert.match(output, /Skipping alarms/);
  });

  test('bootstraps modbus_joints even when alarms already has something applied (the reported bug)', () => {
    const root = tmpRoot();
    // Simulate someone having clicked "Restore Defaults" on the alarm
    // screen before ever running this tool - alarms gets applied,
    // modbus_joints does not.
    const store = new ConfigStore({ root, validators: { modbus_joints: validateModbusJoints, alarms: validateAlarms } });
    store.applyIfValid('alarms', validAlarmsDoc());

    const output = execFileSync('node', [SCRIPT, `--root=${root}`], { encoding: 'utf8' });
    assert.match(output, /modbus_joints applied/);
    assert.match(output, /Skipping alarms/);
    assert.ok(fs.existsSync(path.join(root, 'modbus_joints.json')));

    const { doc } = store.readDomain('modbus_joints');
    assert.ok(doc); // actually got applied, not skipped
  });

  test('bootstraps alarms even when modbus_joints already has something applied', () => {
    const root = tmpRoot();
    const modbusJoints = require('../../config/examples/migrated_modbus_joints.json');
    const store = new ConfigStore({ root, validators: { modbus_joints: validateModbusJoints, alarms: validateAlarms } });
    store.applyIfValid('modbus_joints', modbusJoints);

    const output = execFileSync('node', [SCRIPT, `--root=${root}`], { encoding: 'utf8' });
    assert.match(output, /Skipping modbus_joints/);
    assert.match(output, /alarms applied/);

    const { doc } = store.readDomain('alarms');
    assert.ok(doc);
  });
});
