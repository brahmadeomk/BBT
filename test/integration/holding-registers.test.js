'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildRegisterMap } = require('../../src/integration/register-map');
const { WorstJointLatch, computeRollup } = require('../../src/integration/rollup');
const { buildImage, toWireRegisters, encode, NO_DATA } = require('../../src/integration/holding-registers');
const { validIntegrationDoc, jointsDocTwoZones, activeAlarm } = require('./fixtures');

function mapAndImage(overrides, joints, alarms, heartbeat) {
  const map = buildRegisterMap(validIntegrationDoc(overrides), jointsDocTwoZones());
  const rollup = computeRollup(joints, alarms, new WorstJointLatch());
  return { map, image: buildImage(map, rollup, { heartbeat }) };
}

const liveJoints = [
  { joint_id: 'J01', zone_id: 'Z1', temp_c: 60.4, deltaT: 27.2, ror: 4.1, state: 'LIVE' },
  { joint_id: 'J02', zone_id: 'Z1', temp_c: 45, deltaT: 12, ror: 1, state: 'LIVE' },
  { joint_id: 'J03', zone_id: 'Z2', temp_c: null, deltaT: null, ror: null, state: 'OFFLINE' },
];

describe('holding-registers — encoding', () => {
  test('x10 scale rounds, unscaled passes through, null -> NO_DATA', () => {
    assert.equal(encode(60.44, 10), 604);
    assert.equal(encode(3, 1), 3);
    assert.equal(encode(null, 10), NO_DATA);
    assert.equal(encode(undefined, 10), NO_DATA);
  });

  test('clamps beyond int16 range', () => {
    assert.equal(encode(99999, 10), 32767);
    assert.equal(encode(-99999, 10), -32768);
  });
});

describe('holding-registers — image from rollup', () => {
  test('Tier-1 summary reflects the rollup and heartbeat', () => {
    const alarms = [activeAlarm({ joint_id: 'J01', level: 'CRITICAL' })];
    const { map, image } = mapAndImage({ exposure_tier: 3 }, liveJoints, alarms, 7);
    const at = (key) => image[map.tier1.points.find((p) => p.key === key).addr];
    assert.equal(at('heartbeat'), 7);
    assert.equal(at('highest_alarm_level'), 3);
    assert.equal(at('active_alarm_count'), 1);
    assert.equal(at('count_critical'), 1);
    assert.equal(at('panel_max_temp'), 604, '60.4C x10');
    assert.equal(at('live_joint_count'), 2);
  });

  test('worst_joint_index resolves to the Tier-3 index', () => {
    const alarms = [activeAlarm({ joint_id: 'J02', level: 'WARNING' })];
    const { map, image } = mapAndImage({ exposure_tier: 3 }, liveJoints, alarms, 1);
    const idx = image[map.tier1.points.find((p) => p.key === 'worst_joint_index').addr];
    assert.equal(idx, 1, 'J02 is Tier-3 index 1');
  });

  test('an OFFLINE joint reads NO_DATA for its measurements and state=2', () => {
    const { map, image } = mapAndImage({ exposure_tier: 3 }, liveJoints, [], 1);
    const j3 = map.tier3.joints.find((j) => j.joint_id === 'J03');
    const val = (key) => image[j3.points.find((p) => p.key === key).addr];
    assert.equal(val('temp'), NO_DATA);
    assert.equal(val('state'), 2, 'OFFLINE');
  });

  test('heartbeat wraps at 32768', () => {
    const { map, image } = mapAndImage({ exposure_tier: 1 }, liveJoints, [], 32768);
    assert.equal(image[map.tier1.points.find((p) => p.key === 'heartbeat').addr], 0);
  });

  test('severity bitmap packs per-joint level bits', () => {
    const alarms = [activeAlarm({ joint_id: 'J02', level: 'CRITICAL' })];
    const { map, image } = mapAndImage({ severity_bitmap: { enabled: true } }, liveJoints, alarms, 1);
    // J02 is index 1 -> shift 2, level 3 (0b11) -> bits 0b1100 = 12
    assert.equal(image[map.bitmap.base] & (0x3 << 2), 3 << 2);
  });

  test('toWireRegisters produces an unsigned array of length extent; -1 wraps to 0xFFFF', () => {
    const map = buildRegisterMap(validIntegrationDoc({ exposure_tier: 3 }), jointsDocTwoZones());
    const rollup = computeRollup(liveJoints, [], new WorstJointLatch()); // no alarms -> worst_joint_index -1
    const image = buildImage(map, rollup, { heartbeat: 1 });
    const wire = toWireRegisters(map, image);
    assert.equal(wire.length, map.extent);
    const wjAddr = map.tier1.points.find((p) => p.key === 'worst_joint_index').addr;
    assert.equal(wire[wjAddr], 0xffff, '-1 as unsigned 16-bit');
  });
});
