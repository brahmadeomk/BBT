'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ConfigStore } = require('../../src/config-service/store');
const { validateModbusJoints } = require('../../src/config-service/validate-modbus-joints');
const { validateAlarms } = require('../../src/config-service/validate-alarms');
const { validModbusJointsDoc, validAlarmsDoc } = require('./fixtures');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-store-test-'));
}

// A permissive mock validator: valid unless doc.__forceInvalid is set,
// and checks version monotonicity the same way the real ones do, so
// R11/A6-style behavior can be exercised without the full schema.
function mockValidator(versionKey) {
  return (doc, context = {}) => {
    if (doc.__forceInvalid) {
      return { valid: false, errors: [{ rule: 'mock', message: 'forced invalid' }] };
    }
    const applied = versionKey === 'alarms' ? context.appliedVersion : context.appliedVersions?.[versionKey];
    const incoming = versionKey === 'alarms' ? doc.config_domain_versions.alarms : doc.config_domain_versions[versionKey];
    if (applied != null && incoming <= applied) {
      return { valid: false, errors: [{ rule: 'version', message: 'not monotonic' }] };
    }
    return { valid: true, errors: [] };
  };
}

function mockStore(root) {
  return new ConfigStore({
    root,
    validators: {
      modbus_joints: mockValidator('modbus'),
      alarms: mockValidator('alarms'),
    },
  });
}

describe('ConfigStore - basic apply/read', () => {
  test('applies a first-time push and reads it back', () => {
    const store = mockStore(tmpRoot());
    const doc = { config_domain_versions: { modbus: 1, joints: 1 }, hello: 'world' };
    const result = store.applyIfValid('modbus_joints', doc);
    assert.equal(result.applied, true);
    assert.deepEqual(result.appliedVersions, { modbus: 1, joints: 1 });

    const read = store.readDomain('modbus_joints');
    assert.equal(read.source, 'current');
    assert.deepEqual(read.doc, doc);
  });

  test('rejects an invalid push and leaves the current doc unchanged', () => {
    const root = tmpRoot();
    const store = mockStore(root);
    store.applyIfValid('modbus_joints', { config_domain_versions: { modbus: 1, joints: 1 } });

    const bad = { config_domain_versions: { modbus: 2, joints: 2 }, __forceInvalid: true };
    const result = store.applyIfValid('modbus_joints', bad);
    assert.equal(result.applied, false);
    assert.ok(result.errors.length > 0);

    const read = store.readDomain('modbus_joints');
    assert.equal(read.doc.config_domain_versions.modbus, 1);
  });

  test('injects the currently applied version so a non-monotonic push is rejected', () => {
    const store = mockStore(tmpRoot());
    store.applyIfValid('modbus_joints', { config_domain_versions: { modbus: 3, joints: 3 } });

    const result = store.applyIfValid('modbus_joints', { config_domain_versions: { modbus: 3, joints: 3 } });
    assert.equal(result.applied, false);
  });

  test('reports no applied versions before anything has been pushed', () => {
    const store = mockStore(tmpRoot());
    assert.deepEqual(store.getAppliedVersions('modbus_joints'), {});
    assert.deepEqual(store.readDomain('modbus_joints'), { doc: null, source: 'none' });
  });
});

describe('ConfigStore - atomic write', () => {
  test('never leaves a partially written domain file behind', () => {
    const root = tmpRoot();
    const store = mockStore(root);
    store.applyIfValid('modbus_joints', { config_domain_versions: { modbus: 1, joints: 1 } });

    const files = fs.readdirSync(root);
    assert.ok(files.includes('modbus_joints.json'));
    assert.ok(!files.some((f) => f.includes('.tmp-')));
  });
});

describe('ConfigStore - last-known-good fallback', () => {
  test('falls back to the LKG snapshot if the current file is corrupt', () => {
    const root = tmpRoot();
    const store = mockStore(root);
    store.applyIfValid('modbus_joints', { config_domain_versions: { modbus: 1, joints: 1 }, tag: 'good' });

    fs.writeFileSync(path.join(root, 'modbus_joints.json'), '{not valid json');

    const read = store.readDomain('modbus_joints');
    assert.equal(read.source, 'last-known-good');
    assert.equal(read.doc.tag, 'good');
  });

  test('falls back to the LKG snapshot if the current file fails validation', () => {
    const root = tmpRoot();
    const store = mockStore(root);
    store.applyIfValid('modbus_joints', { config_domain_versions: { modbus: 1, joints: 1 }, tag: 'good' });

    fs.writeFileSync(
      path.join(root, 'modbus_joints.json'),
      JSON.stringify({ config_domain_versions: { modbus: 2, joints: 2 }, __forceInvalid: true })
    );

    const read = store.readDomain('modbus_joints');
    assert.equal(read.source, 'last-known-good');
    assert.equal(read.doc.tag, 'good');
  });

  test('reports nothing when both current and LKG are unusable', () => {
    const root = tmpRoot();
    const store = mockStore(root);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'modbus_joints.json'), '{not valid json');
    fs.writeFileSync(path.join(root, 'modbus_joints.lkg.json'), '{also not valid');

    assert.deepEqual(store.readDomain('modbus_joints'), { doc: null, source: 'none' });
  });
});

describe('ConfigStore - audit trail (R13 / A8)', () => {
  test('appends a before/after entry for an applied change', () => {
    const root = tmpRoot();
    const store = mockStore(root);
    store.applyIfValid('modbus_joints', { config_domain_versions: { modbus: 1, joints: 1 } }, {}, 'commissioning-tool');
    store.applyIfValid('modbus_joints', { config_domain_versions: { modbus: 2, joints: 2 } }, {}, 'cloud');

    const lines = fs
      .readFileSync(path.join(root, 'audit_trail.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

    assert.equal(lines.length, 2);
    assert.equal(lines[0].oldConfig, null);
    assert.equal(lines[0].result, 'applied');
    assert.equal(lines[0].user, 'commissioning-tool');
    assert.equal(lines[1].oldConfig.config_domain_versions.modbus, 1);
    assert.equal(lines[1].newConfig.config_domain_versions.modbus, 2);
    assert.equal(lines[1].user, 'cloud');
  });

  test('appends an entry with rejection reasons for a rejected change', () => {
    const root = tmpRoot();
    const store = mockStore(root);
    store.applyIfValid('modbus_joints', { config_domain_versions: { modbus: 1, joints: 1 }, __forceInvalid: true });

    const lines = fs
      .readFileSync(path.join(root, 'audit_trail.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

    assert.equal(lines.length, 1);
    assert.equal(lines[0].result, 'rejected');
    assert.ok(lines[0].errors.length > 0);
  });
});

describe('ConfigStore - integration with the real validators', () => {
  test('applies a real cfg/modbus+joints document end to end', () => {
    const store = new ConfigStore({
      root: tmpRoot(),
      validators: { modbus_joints: validateModbusJoints, alarms: validateAlarms },
    });
    const result = store.applyIfValid('modbus_joints', validModbusJointsDoc());
    assert.equal(result.applied, true);
  });

  test('applies a real cfg/alarms document with cross-domain context', () => {
    const store = new ConfigStore({
      root: tmpRoot(),
      validators: { modbus_joints: validateModbusJoints, alarms: validateAlarms },
    });
    const modbusJoints = validModbusJointsDoc();
    const result = store.applyIfValid('alarms', validAlarmsDoc(), {
      jointsDoc: modbusJoints,
      modbusDoc: modbusJoints,
    });
    assert.equal(result.applied, true);
  });

  test('rejects a real push that violates version monotonicity (R11)', () => {
    const store = new ConfigStore({
      root: tmpRoot(),
      validators: { modbus_joints: validateModbusJoints, alarms: validateAlarms },
    });
    store.applyIfValid('modbus_joints', validModbusJointsDoc());
    const result = store.applyIfValid('modbus_joints', validModbusJointsDoc()); // same versions again
    assert.equal(result.applied, false);
    assert.ok(result.errors.some((e) => e.rule === 'R11'));
  });
});

describe('applyIfValid - warnings passthrough (Slice 10)', () => {
  test('propagates non-blocking validator warnings on a successful apply', () => {
    const root = tmpRoot();
    const store = new ConfigStore({
      root,
      validators: {
        modbus_joints: () => ({ valid: true, errors: [], warnings: [{ rule: 'R16', message: 'bus at 111/128 unit loads' }] }),
        alarms: mockValidator('alarms'),
      },
    });
    const res = store.applyIfValid('modbus_joints', validModbusJointsDoc(), { source: 'local' });
    assert.equal(res.applied, true);
    assert.deepEqual(res.warnings, [{ rule: 'R16', message: 'bus at 111/128 unit loads' }]);
  });

  test('warnings default to [] when the validator omits them', () => {
    const root = tmpRoot();
    const store = new ConfigStore({
      root,
      validators: { modbus_joints: () => ({ valid: true, errors: [] }), alarms: mockValidator('alarms') },
    });
    const res = store.applyIfValid('modbus_joints', validModbusJointsDoc(), { source: 'local' });
    assert.deepEqual(res.warnings, []);
  });
});
