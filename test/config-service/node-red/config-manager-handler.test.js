'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ConfigStore } = require('../../../src/config-service/store');
const { validateModbusJoints } = require('../../../src/config-service/validate-modbus-joints');
const { validateAlarms } = require('../../../src/config-service/validate-alarms');
const { handleConfigManagerMessage, DEFAULT_PROFILE } = require('../../../src/config-service/node-red/config-manager-handler');

function freshStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-cmh-test-'));
  return new ConfigStore({ root, validators: { modbus_joints: validateModbusJoints, alarms: validateAlarms } });
}

describe('handleConfigManagerMessage - load', () => {
  test('returns the built-in default when nothing has been applied yet', () => {
    const store = freshStore();
    const result = handleConfigManagerMessage({ payload: {} }, store);
    assert.deepEqual(result.payload.config, DEFAULT_PROFILE);
  });

  test('returns the currently applied profile', () => {
    const store = freshStore();
    handleConfigManagerMessage({ payload: { action: 'save', config: DEFAULT_PROFILE } }, store);
    const result = handleConfigManagerMessage({ payload: {} }, store);
    assert.deepEqual(result.payload.config, DEFAULT_PROFILE);
  });
});

describe('handleConfigManagerMessage - save', () => {
  test('applies a valid config and reports success', () => {
    const store = freshStore();
    const newProfile = { deltaT: { watch: 10, warning: 20, critical: 30 }, ror: { watch: 10, warning: 20, critical: 40, timeWindowMin: 15 }, persistence: { watchMin: 20, warningMin: 10, criticalMin: 5 } };
    const result = handleConfigManagerMessage({ payload: { action: 'save', config: newProfile, user: 'alice' } }, store);
    assert.equal(result.payload.success, 'Configuration saved successfully');
    assert.deepEqual(result.payload.config, newProfile);

    const { doc } = store.readDomain('alarms');
    assert.equal(doc.config_domain_versions.alarms, 1);
    assert.deepEqual(doc.profiles.default.deltaT, newProfile.deltaT);
  });

  test('rejects an invalid config (A1 ordering) and leaves the current one unchanged', () => {
    const store = freshStore();
    handleConfigManagerMessage({ payload: { action: 'save', config: DEFAULT_PROFILE } }, store);

    const bad = { ...DEFAULT_PROFILE, deltaT: { watch: 30, warning: 20, critical: 35 } };
    const result = handleConfigManagerMessage({ payload: { action: 'save', config: bad } }, store);
    assert.ok(result.payload.error);
    assert.ok(result.payload.error.includes('A1'));
    assert.deepEqual(result.payload.config, DEFAULT_PROFILE);

    const { doc } = store.readDomain('alarms');
    assert.equal(doc.config_domain_versions.alarms, 1); // unchanged
  });

  test('bumps config_domain_versions.alarms on every successful save', () => {
    const store = freshStore();
    handleConfigManagerMessage({ payload: { action: 'save', config: DEFAULT_PROFILE } }, store);
    handleConfigManagerMessage({ payload: { action: 'save', config: DEFAULT_PROFILE } }, store);
    const { doc } = store.readDomain('alarms');
    assert.equal(doc.config_domain_versions.alarms, 2);
  });

  test('writes an audit entry for both accepted and rejected saves', () => {
    const store = freshStore();
    handleConfigManagerMessage({ payload: { action: 'save', config: DEFAULT_PROFILE, user: 'alice' } }, store);
    handleConfigManagerMessage({ payload: { action: 'save', config: { ...DEFAULT_PROFILE, deltaT: { watch: 99, warning: 1, critical: 1 } }, user: 'bob' } }, store);

    const lines = fs
      .readFileSync(path.join(store.root, 'audit_trail.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].result, 'applied');
    assert.equal(lines[0].user, 'alice');
    assert.equal(lines[1].result, 'rejected');
    assert.equal(lines[1].user, 'bob');
  });
});

describe('handleConfigManagerMessage - restore', () => {
  test('resets to the built-in default profile', () => {
    const store = freshStore();
    const customProfile = { deltaT: { watch: 10, warning: 20, critical: 30 }, ror: { watch: 10, warning: 20, critical: 40, timeWindowMin: 15 }, persistence: { watchMin: 20, warningMin: 10, criticalMin: 5 } };
    handleConfigManagerMessage({ payload: { action: 'save', config: customProfile } }, store);

    const result = handleConfigManagerMessage({ payload: { action: 'restore' } }, store);
    assert.equal(result.payload.success, 'Default configuration restored');
    assert.deepEqual(result.payload.config, DEFAULT_PROFILE);
  });
});
