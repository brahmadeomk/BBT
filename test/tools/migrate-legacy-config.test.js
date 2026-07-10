'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { migrateLegacyConfig } = require('../../tools/migrate-legacy-config');
const { validateModbusJoints } = require('../../src/config-service/validate-modbus-joints');
const { validateAlarms } = require('../../src/config-service/validate-alarms');
const { legacyContext } = require('./legacy-fixture');

describe('migrateLegacyConfig - structural mapping', () => {
  test('maps all 21 slaves with sequential slave_id and preserved unit_address', () => {
    const { modbusJoints } = migrateLegacyConfig(legacyContext());
    assert.equal(modbusJoints.modbus.slaves.length, 21);
    assert.deepEqual(
      modbusJoints.modbus.slaves.map((s) => s.slave_id),
      Array.from({ length: 21 }, (_, i) => `sl${String(i + 1).padStart(2, '0')}`)
    );
    assert.equal(modbusJoints.modbus.slaves[0].unit_address, 1);
    assert.equal(modbusJoints.modbus.slaves[20].unit_address, 101); // the ambient device sorts last
  });

  test('maps bus timing from the flat legacy globals, converting Polling us to inter_frame_ms', () => {
    const { modbusJoints } = migrateLegacyConfig(legacyContext());
    const bus = modbusJoints.modbus.buses[0];
    assert.equal(bus.port, '/dev/ttyUSB0');
    assert.equal(bus.baud, 9600);
    assert.equal(bus.parity, 'N');
    assert.equal(bus.stop_bits, 2);
    assert.equal(bus.timeout_ms, 1000);
    assert.equal(bus.inter_frame_ms, 10); // 10000us / 1000
  });

  test('always sets function_code to 3 (holding registers), matching what the firmware actually does', () => {
    const { modbusJoints } = migrateLegacyConfig(legacyContext());
    assert.ok(modbusJoints.modbus.slaves.every((s) => s.registers.function_code === 3));
  });

  test('maps 20 joints, one channel each, zone_id lowercased', () => {
    const { modbusJoints } = migrateLegacyConfig(legacyContext());
    assert.equal(modbusJoints.joints.length, 20);
    assert.ok(modbusJoints.joints.every((j) => j.channel === 1));
    assert.ok(modbusJoints.joints.every((j) => /^z[0-9]{1,2}$/.test(j.zone_id)));
    assert.equal(modbusJoints.joints[0].zone_id, 'z1');
  });

  test('maps 3 zones with lowercased zone_id', () => {
    const { modbusJoints } = migrateLegacyConfig(legacyContext());
    assert.deepEqual(
      modbusJoints.zones.map((z) => z.zone_id),
      ['z1', 'z2', 'z3']
    );
  });
});

describe('migrateLegacyConfig - ambient sensor resolution', () => {
  test('sets modbus.ambient_sensor to the dedicated ambient slave when every joint agrees', () => {
    const { modbusJoints } = migrateLegacyConfig(legacyContext());
    assert.deepEqual(modbusJoints.modbus.ambient_sensor, { slave_id: 'sl21', channel: 1 });
    assert.ok(modbusJoints.zones.every((z) => !z.ambient_sensor));
    assert.ok(modbusJoints.joints.every((j) => !j.ambient_sensor));
  });

  test('sets a zone-level override when every joint in a zone shares a different ambientSlaveID', () => {
    const legacy = legacyContext();
    for (const j of legacy.joint_master_zone_A) {
      if (j.zone_id === 'Z3') j.ambientSlaveID = 5; // Zone3 uses Sensor5 as its own ambient reference
    }
    const { modbusJoints } = migrateLegacyConfig(legacy);
    const z3 = modbusJoints.zones.find((z) => z.zone_id === 'z3');
    assert.deepEqual(z3.ambient_sensor, { slave_id: 'sl05', channel: 1 });
    assert.ok(modbusJoints.joints.filter((j) => j.zone_id === 'z3').every((j) => !j.ambient_sensor));
  });

  test('sets a joint-level override for a single outlier joint within an otherwise-uniform zone', () => {
    const legacy = legacyContext();
    legacy.joint_master_zone_A[0].ambientSlaveID = 5; // just J01, still in zone Z1 with everyone else on 101
    const { modbusJoints } = migrateLegacyConfig(legacy);
    const j01 = modbusJoints.joints.find((j) => j.joint_id === 'J01');
    assert.deepEqual(j01.ambient_sensor, { slave_id: 'sl05', channel: 1 });
    const z1 = modbusJoints.zones.find((z) => z.zone_id === 'z1');
    assert.ok(!z1.ambient_sensor);
  });
});

describe('migrateLegacyConfig - alarms / persistence ordering (A2)', () => {
  test('carries the legacy A2 violation through as-is when no override is given, and warns', () => {
    const { alarms, warnings } = migrateLegacyConfig(legacyContext());
    assert.deepEqual(alarms.profiles.default.persistence, { watchMin: 1, warningMin: 1, criticalMin: 5 });
    assert.ok(warnings.some((w) => w.includes('violates A2')));
    const result = validateAlarms(alarms);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.rule === 'A2'));
  });

  test('applies the human-approved persistence override when given', () => {
    const override = { watchMin: 5, warningMin: 2, criticalMin: 1 };
    const { alarms, warnings } = migrateLegacyConfig(legacyContext(), { persistenceOverride: override });
    assert.deepEqual(alarms.profiles.default.persistence, override);
    assert.ok(warnings.some((w) => w.includes('replaced with human-approved')));
    const result = validateAlarms(alarms);
    assert.equal(result.valid, true);
  });

  test('never includes notifications (legacy recipients are personal data)', () => {
    const { alarms, warnings } = migrateLegacyConfig(legacyContext());
    assert.equal(alarms.notifications, undefined);
    assert.ok(warnings.some((w) => w.includes('personal data')));
  });
});

describe('migrateLegacyConfig - end-to-end schema validation', () => {
  test('produces a schema-valid cfg/modbus+joints document', () => {
    const { modbusJoints } = migrateLegacyConfig(legacyContext());
    const result = validateModbusJoints(modbusJoints);
    assert.deepEqual(result.errors, []);
    assert.equal(result.valid, true);
  });

  test('produces a schema-valid cfg/alarms document once the persistence override is applied', () => {
    const { modbusJoints, alarms } = migrateLegacyConfig(legacyContext(), {
      persistenceOverride: { watchMin: 5, warningMin: 2, criticalMin: 1 },
    });
    const result = validateAlarms(alarms, { jointsDoc: modbusJoints, modbusDoc: modbusJoints });
    assert.deepEqual(result.errors, []);
    assert.equal(result.valid, true);
  });
});
