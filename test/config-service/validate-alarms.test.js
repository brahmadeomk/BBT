'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateAlarms,
  checkHysteresisSanity,
  checkDefaultProfilePresent,
} = require('../../src/config-service/validate-alarms');
const { validAlarmsDoc, validModbusJointsDoc } = require('./fixtures');

function errorsFor(rule, result) {
  return result.errors.filter((e) => e.rule === rule);
}

describe('validateAlarms - baseline', () => {
  test('accepts a fully valid document', () => {
    const result = validateAlarms(validAlarmsDoc());
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  test('rejects a document that fails JSON Schema', () => {
    const doc = validAlarmsDoc();
    delete doc.profiles.default;
    const result = validateAlarms(doc);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.rule === 'schema'));
  });
});

describe('A1 - deltaT/ror threshold ordering', () => {
  test('accepts strictly increasing thresholds', () => {
    const result = validateAlarms(validAlarmsDoc());
    assert.equal(errorsFor('A1', result).length, 0);
  });

  test('rejects deltaT thresholds out of order', () => {
    const doc = validAlarmsDoc();
    doc.profiles.default.deltaT = { watch: 30, warning: 25, critical: 35 };
    const result = validateAlarms(doc);
    assert.equal(result.valid, false);
    assert.equal(errorsFor('A1', result).length, 1);
  });

  test('rejects ror thresholds out of order', () => {
    const doc = validAlarmsDoc();
    doc.profiles.default.ror = { watch: 60, warning: 30, critical: 60, timeWindowMin: 20 };
    const result = validateAlarms(doc);
    assert.equal(result.valid, false);
    assert.equal(errorsFor('A1', result).length, 1);
  });
});

describe('A2 - persistence ordering', () => {
  test('accepts non-increasing persistence with severity', () => {
    const result = validateAlarms(validAlarmsDoc());
    assert.equal(errorsFor('A2', result).length, 0);
  });

  test('rejects persistence that reacts slower at higher severity', () => {
    const doc = validAlarmsDoc();
    doc.profiles.default.persistence = { watchMin: 5, warningMin: 15, criticalMin: 30 };
    const result = validateAlarms(doc);
    assert.equal(result.valid, false);
    assert.equal(errorsFor('A2', result).length, 1);
  });
});

describe('A3 - threshold_profile references resolve (cross-domain)', () => {
  test('accepts when every referenced profile exists', () => {
    const alarms = validAlarmsDoc();
    const joints = validModbusJointsDoc(); // all joints use threshold_profile: 'default'
    const result = validateAlarms(alarms, { jointsDoc: joints });
    assert.equal(errorsFor('A3', result).length, 0);
  });

  test('rejects when cfg/joints references a deleted/unknown profile', () => {
    const alarms = validAlarmsDoc();
    const joints = validModbusJointsDoc();
    joints.joints[0].threshold_profile = 'no_such_profile';
    const result = validateAlarms(alarms, { jointsDoc: joints });
    assert.equal(result.valid, false);
    assert.equal(errorsFor('A3', result).length, 1);
  });

  test('is not evaluated when no cfg/joints context is supplied', () => {
    const result = validateAlarms(validAlarmsDoc());
    assert.equal(errorsFor('A3', result).length, 0);
  });
});

describe('A4 - default profile cannot be removed (defense-in-depth)', () => {
  test('passes when default is present', () => {
    assert.deepEqual(checkDefaultProfilePresent({ default: {} }), []);
  });

  test('fails when default is absent', () => {
    const errors = checkDefaultProfilePresent({ hot_tapoff: {} });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].rule, 'A4');
  });
});

describe('A5 - ambient sensor required in cfg/modbus (cross-domain)', () => {
  test('accepts when ambient_sensor is configured', () => {
    const alarms = validAlarmsDoc();
    const modbus = validModbusJointsDoc(); // has modbus.ambient_sensor
    const result = validateAlarms(alarms, { modbusDoc: modbus });
    assert.equal(errorsFor('A5', result).length, 0);
  });

  test('rejects when cfg/modbus has no ambient_sensor', () => {
    const alarms = validAlarmsDoc();
    const modbus = validModbusJointsDoc();
    delete modbus.modbus.ambient_sensor;
    const result = validateAlarms(alarms, { modbusDoc: modbus });
    assert.equal(result.valid, false);
    assert.equal(errorsFor('A5', result).length, 1);
  });

  test('is not evaluated when no cfg/modbus context is supplied', () => {
    const result = validateAlarms(validAlarmsDoc());
    assert.equal(errorsFor('A5', result).length, 0);
  });
});

describe('A6 - version monotonicity', () => {
  test('accepts a version greater than the currently applied one', () => {
    const result = validateAlarms(validAlarmsDoc(), { appliedVersion: 11 });
    assert.equal(errorsFor('A6', result).length, 0);
  });

  test('rejects a version not greater than the currently applied one', () => {
    const result = validateAlarms(validAlarmsDoc(), { appliedVersion: 12 });
    assert.equal(errorsFor('A6', result).length, 1);
  });
});

describe('A7 - enabled notification channels need recipients', () => {
  test('accepts enabled channels with recipients', () => {
    const result = validateAlarms(validAlarmsDoc());
    assert.equal(errorsFor('A7', result).length, 0);
  });

  test('rejects an enabled email channel with no recipients', () => {
    const doc = validAlarmsDoc();
    delete doc.notifications.email.recipients;
    const result = validateAlarms(doc);
    assert.equal(result.valid, false);
    assert.equal(errorsFor('A7', result).length, 1);
  });

  test('accepts a disabled channel with no recipients', () => {
    const doc = validAlarmsDoc();
    doc.notifications.sms.enabled = false;
    delete doc.notifications.sms.recipients;
    const result = validateAlarms(doc);
    assert.equal(errorsFor('A7', result).length, 0);
  });
});

describe('A9 - hysteresis sanity (defense-in-depth)', () => {
  test('passes within schema-valid bounds', () => {
    const errors = checkHysteresisSanity('default', { deltaT: { watch: 5, warning: 10, critical: 20 }, clear_hysteresis_pct: 30 });
    assert.deepEqual(errors, []);
  });

  test('fails if hysteresis would push the clear level below zero', () => {
    // Out of the schema's own numeric range (max 30%), but the pure
    // logic must still catch it if that bound is ever loosened.
    const errors = checkHysteresisSanity('default', { deltaT: { watch: 5, warning: 10, critical: 20 }, clear_hysteresis_pct: 150 });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].rule, 'A9');
  });
});
