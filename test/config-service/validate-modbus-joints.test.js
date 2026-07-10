'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { validateModbusJoints } = require('../../src/config-service/validate-modbus-joints');
const { validModbusJointsDoc, validAlarmsDoc } = require('./fixtures');

function errorsFor(rule, result) {
  return result.errors.filter((e) => e.rule === rule);
}

describe('validateModbusJoints - baseline', () => {
  test('accepts a fully valid document', () => {
    const result = validateModbusJoints(validModbusJointsDoc());
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  test('rejects a document that fails JSON Schema', () => {
    const doc = validModbusJointsDoc();
    delete doc.modbus.slaves;
    const result = validateModbusJoints(doc);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.rule === 'schema'));
  });
});

describe('R1 - joint references unknown slave_id', () => {
  test('accepts joint with a valid slave_id', () => {
    const result = validateModbusJoints(validModbusJointsDoc());
    assert.equal(errorsFor('R1', result).length, 0);
  });

  test('rejects joint with unknown slave_id', () => {
    const doc = validModbusJointsDoc();
    doc.joints[0].slave_id = 'sl99';
    const result = validateModbusJoints(doc);
    assert.equal(result.valid, false);
    assert.equal(errorsFor('R1', result).length, 1);
  });
});

describe('R2 - joint references unknown zone_id', () => {
  test('accepts joint with a valid zone_id', () => {
    const result = validateModbusJoints(validModbusJointsDoc());
    assert.equal(errorsFor('R2', result).length, 0);
  });

  test('rejects joint with unknown zone_id', () => {
    const doc = validModbusJointsDoc();
    doc.joints[0].zone_id = 'z99';
    const result = validateModbusJoints(doc);
    assert.equal(result.valid, false);
    assert.equal(errorsFor('R2', result).length, 1);
  });
});

describe('R3 - slave references unknown bus_id', () => {
  test('accepts slave with a valid bus_id', () => {
    const result = validateModbusJoints(validModbusJointsDoc());
    assert.equal(errorsFor('R3', result).length, 0);
  });

  test('rejects slave with unknown bus_id', () => {
    const doc = validModbusJointsDoc();
    doc.modbus.slaves[0].bus_id = 'bus9';
    const result = validateModbusJoints(doc);
    assert.equal(result.valid, false);
    assert.equal(errorsFor('R3', result).length, 1);
  });
});

describe('R4 - duplicate (bus_id, unit_address)', () => {
  test('accepts unique unit addresses per bus', () => {
    const result = validateModbusJoints(validModbusJointsDoc());
    assert.equal(errorsFor('R4', result).length, 0);
  });

  test('rejects duplicate unit_address on the same bus', () => {
    const doc = validModbusJointsDoc();
    doc.modbus.slaves[1].unit_address = doc.modbus.slaves[0].unit_address;
    const result = validateModbusJoints(doc);
    assert.equal(result.valid, false);
    assert.equal(errorsFor('R4', result).length, 1);
  });
});

describe('R5 - uniqueness of slave_id/joint_id/zone_id', () => {
  test('accepts unique ids', () => {
    const result = validateModbusJoints(validModbusJointsDoc());
    assert.equal(errorsFor('R5', result).length, 0);
  });

  test('rejects duplicate joint_id', () => {
    const doc = validModbusJointsDoc();
    doc.joints[1].joint_id = doc.joints[0].joint_id;
    const result = validateModbusJoints(doc);
    assert.equal(result.valid, false);
    assert.equal(errorsFor('R5', result).length, 1);
  });
});

describe('R6 - joint channel exceeds slave channel count', () => {
  test('accepts channel within range', () => {
    const result = validateModbusJoints(validModbusJointsDoc());
    assert.equal(errorsFor('R6', result).length, 0);
  });

  test('rejects channel beyond the slave channel count', () => {
    const doc = validModbusJointsDoc();
    // schema allows channel up to 8; this slave only has 4 channels
    doc.joints[0].channel = 6;
    const result = validateModbusJoints(doc);
    assert.equal(result.valid, false);
    assert.equal(errorsFor('R6', result).length, 1);
  });
});

describe('R7 - double mapping of (slave_id, channel)', () => {
  test('accepts distinct (slave_id, channel) mappings', () => {
    const result = validateModbusJoints(validModbusJointsDoc());
    assert.equal(errorsFor('R7', result).length, 0);
  });

  test('rejects two joints mapped to the same (slave_id, channel)', () => {
    const doc = validModbusJointsDoc();
    doc.joints[1].slave_id = doc.joints[0].slave_id;
    doc.joints[1].channel = doc.joints[0].channel;
    const result = validateModbusJoints(doc);
    assert.equal(result.valid, false);
    assert.equal(errorsFor('R7', result).length, 1);
  });

  test('rejects panel ambient_sensor colliding with a joint mapping', () => {
    const doc = validModbusJointsDoc();
    doc.modbus.ambient_sensor = { slave_id: doc.joints[0].slave_id, channel: doc.joints[0].channel };
    const result = validateModbusJoints(doc);
    assert.equal(result.valid, false);
    assert.equal(errorsFor('R7', result).length, 1);
  });

  test('rejects a zone-level ambient_sensor colliding with a joint mapping', () => {
    const doc = validModbusJointsDoc();
    doc.zones[0].ambient_sensor = { slave_id: doc.joints[0].slave_id, channel: doc.joints[0].channel };
    const result = validateModbusJoints(doc);
    assert.equal(result.valid, false);
    assert.equal(errorsFor('R7', result).length, 1);
  });

  test('rejects a joint-level ambient_sensor override colliding with another joint mapping', () => {
    const doc = validModbusJointsDoc();
    doc.joints[3].ambient_sensor = { slave_id: doc.joints[0].slave_id, channel: doc.joints[0].channel };
    const result = validateModbusJoints(doc);
    assert.equal(result.valid, false);
    assert.equal(errorsFor('R7', result).length, 1);
  });
});

describe('R8 - bus type field consistency', () => {
  test('accepts a well-formed RTU bus', () => {
    const result = validateModbusJoints(validModbusJointsDoc());
    assert.equal(errorsFor('R8', result).length, 0);
  });

  test('rejects RTU bus missing port/baud', () => {
    const doc = validModbusJointsDoc();
    delete doc.modbus.buses[0].port;
    const result = validateModbusJoints(doc);
    assert.equal(result.valid, false);
    assert.equal(errorsFor('R8', result).length, 1);
  });

  test('rejects RTU bus with a TCP-only host field set', () => {
    const doc = validModbusJointsDoc();
    doc.modbus.buses[0].host = '10.0.0.5';
    const result = validateModbusJoints(doc);
    assert.equal(result.valid, false);
    assert.equal(errorsFor('R8', result).length, 1);
  });
});

describe('R9 - ambient sensor required when alarms use deltaT', () => {
  test('accepts when ambient_sensor is configured and alarms are in use', () => {
    const doc = validModbusJointsDoc();
    const result = validateModbusJoints(doc, { alarmsDoc: validAlarmsDoc() });
    assert.equal(errorsFor('R9', result).length, 0);
  });

  test('rejects when no joint can resolve an ambient sensor at any level', () => {
    const doc = validModbusJointsDoc();
    delete doc.modbus.ambient_sensor; // no panel default, no zone/joint overrides in the base fixture
    const result = validateModbusJoints(doc, { alarmsDoc: validAlarmsDoc() });
    assert.equal(result.valid, false);
    assert.equal(errorsFor('R9', result).length, doc.joints.length);
  });

  test('a zone-level override satisfies R9 for every joint in that zone, even with no panel default', () => {
    const doc = validModbusJointsDoc();
    delete doc.modbus.ambient_sensor;
    doc.zones[0].ambient_sensor = { slave_id: 'sl02', channel: 2 }; // all base-fixture joints are in zone z1
    const result = validateModbusJoints(doc, { alarmsDoc: validAlarmsDoc() });
    assert.equal(errorsFor('R9', result).length, 0);
  });

  test('a joint-level override satisfies R9 for that joint alone', () => {
    const doc = validModbusJointsDoc();
    delete doc.modbus.ambient_sensor;
    doc.joints[0].ambient_sensor = { slave_id: 'sl02', channel: 2 };
    const result = validateModbusJoints(doc, { alarmsDoc: validAlarmsDoc() });
    // the other 3 joints still have nothing to fall back on
    assert.equal(errorsFor('R9', result).length, doc.joints.length - 1);
    assert.ok(!errorsFor('R9', result).some((e) => e.message.includes(doc.joints[0].joint_id)));
  });

  test('is not evaluated when no alarms context is supplied', () => {
    const doc = validModbusJointsDoc();
    delete doc.modbus.ambient_sensor;
    const result = validateModbusJoints(doc);
    assert.equal(errorsFor('R9', result).length, 0);
  });
});

describe('R14 - ambient_sensor references must be valid, at any level', () => {
  test('accepts valid ambient_sensor references at every level', () => {
    const doc = validModbusJointsDoc();
    doc.zones[0].ambient_sensor = { slave_id: 'sl02', channel: 2 };
    doc.joints[0].ambient_sensor = { slave_id: 'sl02', channel: 3 };
    const result = validateModbusJoints(doc);
    assert.equal(errorsFor('R14', result).length, 0);
  });

  test('rejects a panel ambient_sensor referencing an unknown slave', () => {
    const doc = validModbusJointsDoc();
    doc.modbus.ambient_sensor = { slave_id: 'sl99', channel: 1 };
    const result = validateModbusJoints(doc);
    assert.equal(result.valid, false);
    assert.equal(errorsFor('R14', result).length, 1);
  });

  test('rejects a zone-level ambient_sensor with an out-of-range channel', () => {
    const doc = validModbusJointsDoc();
    doc.zones[0].ambient_sensor = { slave_id: 'sl01', channel: 6 }; // sl01 only has 4 channels
    const result = validateModbusJoints(doc);
    assert.equal(result.valid, false);
    assert.equal(errorsFor('R14', result).length, 1);
  });

  test('rejects a joint-level ambient_sensor override referencing an unknown slave', () => {
    const doc = validModbusJointsDoc();
    doc.joints[0].ambient_sensor = { slave_id: 'sl99', channel: 1 };
    const result = validateModbusJoints(doc);
    assert.equal(result.valid, false);
    assert.equal(errorsFor('R14', result).length, 1);
  });

  test('is checked even without an alarms context (independent of R9)', () => {
    const doc = validModbusJointsDoc();
    doc.modbus.ambient_sensor = { slave_id: 'sl99', channel: 1 };
    const result = validateModbusJoints(doc); // no alarmsDoc
    assert.equal(errorsFor('R14', result).length, 1);
  });
});

describe('R10 - worst-case bus scan time must fit poll interval', () => {
  test('accepts a light bus load at the default poll interval', () => {
    const result = validateModbusJoints(validModbusJointsDoc());
    assert.equal(errorsFor('R10', result).length, 0);
  });

  test('rejects an overloaded bus at a tight poll interval', () => {
    const doc = validModbusJointsDoc();
    for (const slave of doc.modbus.slaves) slave.poll_interval_s = 5;
    for (let i = 3; i <= 5; i++) {
      doc.modbus.slaves.push({
        slave_id: `sl0${i}`,
        bus_id: 'bus1',
        unit_address: i,
        model: 'BT-SCM-4',
        channels: 4,
        poll_interval_s: 5,
        registers: { function_code: 4, temp_base_addr: 100, temp_word_count: 1, temp_scale: 0.1 },
      });
    }
    const result = validateModbusJoints(doc);
    assert.equal(result.valid, false);
    assert.equal(errorsFor('R10', result).length, 1);
  });
});

describe('R11 - version monotonicity', () => {
  test('accepts a version greater than the currently applied one', () => {
    const doc = validModbusJointsDoc();
    const result = validateModbusJoints(doc, { appliedVersions: { modbus: 2, joints: 4 } });
    assert.equal(errorsFor('R11', result).length, 0);
  });

  test('rejects a version not greater than the currently applied one', () => {
    const doc = validModbusJointsDoc();
    const result = validateModbusJoints(doc, { appliedVersions: { modbus: 3, joints: 5 } });
    assert.equal(result.valid, false);
    assert.equal(errorsFor('R11', result).length, 2);
  });
});

describe('R12 - maintenance-mode gate for remote changes', () => {
  test('accepts a remote change while in maintenance mode', () => {
    const doc = validModbusJointsDoc();
    const result = validateModbusJoints(doc, { source: 'remote', maintenanceMode: true });
    assert.equal(errorsFor('R12', result).length, 0);
  });

  test('accepts a local change regardless of maintenance mode', () => {
    const doc = validModbusJointsDoc();
    const result = validateModbusJoints(doc, { source: 'local', maintenanceMode: false });
    assert.equal(errorsFor('R12', result).length, 0);
  });

  test('rejects a remote change outside maintenance mode', () => {
    const doc = validModbusJointsDoc();
    const result = validateModbusJoints(doc, { source: 'remote', maintenanceMode: false });
    assert.equal(result.valid, false);
    assert.equal(errorsFor('R12', result).length, 1);
  });
});
