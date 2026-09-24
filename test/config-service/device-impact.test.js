'use strict';

/**
 * The two-sentence summary of what losing one device costs.
 *
 * EXTRACTED 2026-09-24 from blacklist-handler.js so a second surface - the
 * Configuration Status banner, for a device deliberately SWITCHED OFF - could
 * use the identical wording the blacklist alarm uses for a device that FAILED.
 * These tests pin the wording itself, because "identical" is the whole point:
 * two surfaces describing the same loss in different words is the bug.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  jointsForSlave, ambientSlaveForJoint, jointsUsingAmbientSlave, slaveDisplayName, impactFor,
} = require('../../src/config-service/device-impact');

const doc = () => ({
  modbus: {
    ambient_sensor: { slave_id: 'sl21', channel: 1 },
    slaves: [
      { slave_id: 'sl01', unit_address: 1, label: 'Sensor1', channels: 2 },
      { slave_id: 'sl02', unit_address: 2 },
      { slave_id: 'sl21', unit_address: 101, label: 'AmbientPanel' },
      { slave_id: 'sl22', unit_address: 102, label: 'AmbientZone' },
    ],
  },
  zones: [
    { zone_id: 'z1', name: 'Zone1' },
    { zone_id: 'z2', name: 'Riser', ambient_sensor: { slave_id: 'sl22', channel: 1 } },
  ],
  joints: [
    { joint_id: 'J01', slave_id: 'sl01', channel: 1, zone_id: 'z1' },
    { joint_id: 'J02', slave_id: 'sl01', channel: 2, zone_id: 'z1' },
    { joint_id: 'J03', slave_id: 'sl02', channel: 1, zone_id: 'z2' },
  ],
});

describe('slaveDisplayName - how an OPERATOR identifies a device', () => {
  test('unit address and label, never the internal slave_id', () => {
    // `sl21` is meaningless on the panel; 101 is what was typed into the table.
    assert.equal(slaveDisplayName(doc(), 'sl21'), '101 (AmbientPanel)');
  });

  test('bare unit address when the device has no label', () => {
    assert.equal(slaveDisplayName(doc(), 'sl02'), '2');
  });

  test('falls back to the slave_id for a device not in the document', () => {
    assert.equal(slaveDisplayName(doc(), 'sl99'), 'sl99');
  });
});

describe('the R14 ambient chain: joint -> zone -> panel', () => {
  const d = doc();

  test('panel default when nothing overrides it', () => {
    assert.equal(ambientSlaveForJoint(d, d.joints[0]), 'sl21');
  });

  test("the joint's zone overrides the panel default", () => {
    assert.equal(ambientSlaveForJoint(d, d.joints[2]), 'sl22');
  });

  test('the joint overrides its zone', () => {
    const j = { ...d.joints[2], ambient_sensor: { slave_id: 'sl21', channel: 1 } };
    assert.equal(ambientSlaveForJoint(d, j), 'sl21');
  });
});

describe('impactFor - the two ways losing a device hurts', () => {
  test('joints it CARRIES stop being measurable', () => {
    assert.equal(impactFor(doc(), 'sl01').text, 'joint(s) J01, J02 not measurable');
  });

  test('joints that merely REFERENCE it as ambient lose ΔT', () => {
    // The understatement this wording exists to fix: a dedicated ambient slave
    // carries no joints of its own, so counting only carried joints reported
    // "no joints affected" for a fault that disables ΔT across the panel.
    assert.equal(
      impactFor(doc(), 'sl21').text,
      'ambient reference for joint(s) J01, J02 - ΔT unavailable'
    );
  });

  test('a device that is both reports both, and never double-counts a joint', () => {
    const d = doc();
    // sl01 now carries J01/J02 AND is the panel ambient. J04 sits in z1, which
    // sets no ambient of its own, so it falls through to sl01; J03 is in z2,
    // which overrides with sl22, so it is untouched.
    d.modbus.ambient_sensor = { slave_id: 'sl01', channel: 2 };
    d.joints.push({ joint_id: 'J04', slave_id: 'sl02', channel: 2, zone_id: 'z1' });
    const { text, joints, ambientFor } = impactFor(d, 'sl01');
    assert.deepEqual(joints, ['J01', 'J02']);
    assert.deepEqual(ambientFor, ['J04'], 'J01/J02 are carried, so not listed twice');
    assert.equal(text, 'joint(s) J01, J02 not measurable; ambient reference for joint(s) J04 - ΔT unavailable');
  });

  test('a spare wired to nothing says so plainly', () => {
    assert.equal(impactFor(doc(), 'sl99').text, 'no joints affected');
  });

  test('a malformed document yields no impact rather than throwing', () => {
    // This text is built on the live alarm path and, now, on the banner tick.
    assert.equal(impactFor(null, 'sl01').text, 'no joints affected');
    assert.deepEqual(jointsForSlave(undefined, 'sl01'), []);
    assert.deepEqual(jointsUsingAmbientSlave({}, 'sl01'), []);
  });
});
