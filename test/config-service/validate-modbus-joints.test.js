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

describe('R15 - per-channel register integrity (channel_addrs / channel_labels)', () => {
  test('accepts valid channel_addrs and channel_labels (length == channels, unique, spaced, min == base)', () => {
    const doc = validModbusJointsDoc();
    doc.modbus.slaves[0].registers.channel_addrs = [100, 105, 110, 115]; // sl01 has 4 channels, base 100
    doc.modbus.slaves[0].registers.channel_labels = ['A', 'B', 'C', 'D'];
    const result = validateModbusJoints(doc);
    assert.equal(errorsFor('R15', result).length, 0);
  });

  test('rejects channel_addrs whose length differs from channels', () => {
    const doc = validModbusJointsDoc();
    doc.modbus.slaves[0].registers.channel_addrs = [100, 105]; // sl01 has 4 channels
    const result = validateModbusJoints(doc);
    assert.equal(result.valid, false);
    assert.match(errorsFor('R15', result)[0].message, /2 entries but channels is 4/);
  });

  test('rejects overlapping channel addresses (spacing < temp_word_count)', () => {
    const doc = validModbusJointsDoc();
    doc.modbus.slaves[0].registers.temp_word_count = 2;
    doc.modbus.slaves[0].registers.channel_addrs = [100, 101, 104, 106]; // 100+2 words overlaps 101
    const result = validateModbusJoints(doc);
    assert.equal(result.valid, false);
    assert.match(errorsFor('R15', result)[0].message, /overlap/);
  });

  test('rejects duplicate channel addresses', () => {
    const doc = validModbusJointsDoc();
    doc.modbus.slaves[0].registers.channel_addrs = [100, 100, 110, 115];
    const result = validateModbusJoints(doc);
    assert.equal(result.valid, false);
    assert.equal(errorsFor('R15', result).length, 1);
  });

  test('rejects temp_base_addr that is not the lowest channel address', () => {
    const doc = validModbusJointsDoc();
    doc.modbus.slaves[0].registers.channel_addrs = [102, 105, 110, 115]; // base stays 100
    const result = validateModbusJoints(doc);
    assert.equal(result.valid, false);
    assert.match(errorsFor('R15', result)[0].message, /temp_base_addr 100 must equal the lowest channel address 102/);
  });

  test('rejects channel_labels whose length differs from channels', () => {
    const doc = validModbusJointsDoc();
    doc.modbus.slaves[0].registers.channel_labels = ['only one'];
    const result = validateModbusJoints(doc);
    assert.equal(result.valid, false);
    assert.match(errorsFor('R15', result)[0].message, /channel_labels has 1 entries but channels is 4/);
  });
});

describe('R10 - worst-case bus scan time must fit poll interval', () => {
  test('accepts a light bus load at the default poll interval', () => {
    const result = validateModbusJoints(validModbusJointsDoc());
    assert.equal(errorsFor('R10', result).length, 0);
  });

  test('accepts a real 21-slave deployment (9600 baud, 1s timeout, 2 retries, 30s poll)', () => {
    // Regression fixture from an actual production panel: this worst-case
    // formula must not reject a config that's deployed and working.
    const doc = validModbusJointsDoc();
    doc.modbus.buses[0].baud = 9600;
    doc.modbus.buses[0].timeout_ms = 1000;
    doc.modbus.buses[0].retries = 2;
    doc.modbus.buses[0].inter_frame_ms = 10;
    doc.modbus.slaves = [];
    for (let i = 1; i <= 21; i++) {
      doc.modbus.slaves.push({
        slave_id: `sl${String(i).padStart(2, '0')}`,
        bus_id: 'bus1',
        unit_address: i,
        model: 'LEGACY-1CH',
        channels: 1,
        poll_interval_s: 30,
        registers: { function_code: 3, temp_base_addr: 3, temp_word_count: 1, temp_scale: 0.1 },
      });
    }
    doc.joints = [{ joint_id: 'J01', slave_id: 'sl01', channel: 1, zone_id: 'z1' }];
    doc.modbus.ambient_sensor = { slave_id: 'sl21', channel: 1 };
    const result = validateModbusJoints(doc);
    assert.equal(errorsFor('R10', result).length, 0);
  });

  test('rejects a bus whose single straggler allowance alone exceeds the poll interval', () => {
    const doc = validModbusJointsDoc();
    doc.modbus.buses[0].timeout_ms = 5000; // schema max
    doc.modbus.buses[0].retries = 5; // schema max
    for (const slave of doc.modbus.slaves) slave.poll_interval_s = 5; // schema min
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

describe('joint_id format (widened 2026-08-31 to 6 characters)', () => {
  // Sites name joints to their own convention (riser/floor coding), not
  // J01..J999. The old pattern ^J[0-9]{2,3}$ capped ids at 4 characters and
  // forced a literal J prefix; this is now 2-6 chars of letters, digits and
  // underscore. Nothing derives an index from a joint_id, so the shape is free.
  const withId = (id) => {
    const d = validModbusJointsDoc();
    d.joints[0].joint_id = id;
    return validateModbusJoints(d);
  };
  const patternError = (r) => (r.errors || []).some((e) => /joint_id/.test(e.message || ''));

  test('every id that was legal before is still legal', () => {
    // The whole installed base is J01..J999; widening must not orphan it.
    for (const id of ['J01', 'J99', 'J001', 'J999']) {
      assert.equal(withId(id).valid, true, `${id} used to be valid and must stay valid`);
    }
  });

  test('accepts the 5- and 6-character ids the old pattern rejected', () => {
    for (const id of ['J0001', 'J00001', 'BD101', 'TR1A01', 'AB_123']) {
      assert.equal(withId(id).valid, true, `${id} should now be accepted`);
    }
  });

  test('still rejects anything longer than 6', () => {
    assert.ok(patternError(withId('ABCDEFG')), '7 characters must be rejected');
  });

  test('still rejects a single character', () => {
    // A 1-char id is almost certainly a typo, and reads badly on the heat map.
    assert.ok(patternError(withId('X')));
  });

  test('rejects a pipe, because it would break the alarm instanceId', () => {
    // Alarm keys are PROCESS|{joint}|{type}|{level}; a pipe inside the joint id
    // would make that key ambiguous to split.
    assert.ok(patternError(withId('J|01')));
  });

  test('rejects a hyphen, because the BACnet description field forbids it', () => {
    // MGate manual v1.4 p61 strips `- " \' # * , [ ]` from bacnetDescription, so
    // "R1-J12" would reach the BMS as "R1 J12" - a different string from the one
    // on the HMI. Excluding it keeps the id identical on every surface.
    assert.ok(patternError(withId('R1-J12')));
  });

  test('rejects a leading underscore', () => {
    assert.ok(patternError(withId('_J01')));
  });

  test('R5 uniqueness still applies to the widened ids', () => {
    const d = validModbusJointsDoc();
    d.joints[0].joint_id = 'TR1A01';
    d.joints[1].joint_id = 'TR1A01';
    const r = validateModbusJoints(d);
    assert.equal(r.valid, false);
    assert.ok(errorsFor('R5', r).length > 0, 'duplicate joint ids must still fail R5');
  });
});
