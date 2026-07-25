'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { WorstJointLatch, computeRollup } = require('../../src/integration/rollup');
const { activeAlarm } = require('./fixtures');

const liveJoints = [
  { joint_id: 'J01', zone_id: 'Z1', temp_c: 60, deltaT: 27, ror: 4, state: 'LIVE' },
  { joint_id: 'J02', zone_id: 'Z1', temp_c: 45, deltaT: 12, ror: 1, state: 'LIVE' },
  { joint_id: 'J03', zone_id: 'Z2', temp_c: 50, deltaT: 18, ror: 2, state: 'LIVE' },
];

describe('WorstJointLatch — first-raised holds, reassign only on clear', () => {
  test('picks the earliest-raised joint at the top level', () => {
    const latch = new WorstJointLatch();
    const r = latch.update([
      { joint_id: 'J02', level: 3, raisedTs: '2026-07-25T10:05:00Z' },
      { joint_id: 'J01', level: 3, raisedTs: '2026-07-25T10:00:00Z' },
    ]);
    assert.equal(r.joint_id, 'J01');
  });

  test('a later joint reaching the same level does NOT steal the point', () => {
    const latch = new WorstJointLatch();
    latch.update([{ joint_id: 'J01', level: 2, raisedTs: '2026-07-25T10:00:00Z' }]);
    const r = latch.update([
      { joint_id: 'J01', level: 2, raisedTs: '2026-07-25T10:00:00Z' },
      { joint_id: 'J03', level: 2, raisedTs: '2026-07-25T10:10:00Z' },
    ]);
    assert.equal(r.joint_id, 'J01', 'incumbent holds at equal level');
  });

  test('reassigns when the incumbent clears', () => {
    const latch = new WorstJointLatch();
    latch.update([{ joint_id: 'J01', level: 2, raisedTs: 'a' }]);
    const r = latch.update([{ joint_id: 'J03', level: 2, raisedTs: 'b' }]);
    assert.equal(r.joint_id, 'J03');
  });

  test('a higher level overrides the incumbent', () => {
    const latch = new WorstJointLatch();
    latch.update([{ joint_id: 'J01', level: 2, raisedTs: 'a' }]);
    const r = latch.update([
      { joint_id: 'J01', level: 2, raisedTs: 'a' },
      { joint_id: 'J03', level: 3, raisedTs: 'b' },
    ]);
    assert.equal(r.joint_id, 'J03');
    assert.equal(r.level, 3);
  });

  test('no active alarms clears the latch', () => {
    const latch = new WorstJointLatch();
    latch.update([{ joint_id: 'J01', level: 2, raisedTs: 'a' }]);
    const r = latch.update([]);
    assert.equal(r.joint_id, null);
    assert.equal(r.level, 0);
  });
});

describe('computeRollup — panel/zone/joint aggregates + counts', () => {
  test('per-level instance counts and highest level', () => {
    const alarms = [
      activeAlarm({ joint_id: 'J01', zone_id: 'Z1', level: 'WARNING' }),
      activeAlarm({ joint_id: 'J03', zone_id: 'Z2', level: 'CRITICAL', instanceId: 'PROCESS|J03|ROR|CRITICAL' }),
    ];
    const r = computeRollup(liveJoints, alarms, new WorstJointLatch());
    assert.equal(r.highest_level, 3);
    assert.equal(r.active_alarm_count, 2);
    assert.deepEqual(r.counts, { watch: 0, warning: 1, critical: 1 });
    assert.equal(r.worst_joint_id, 'J03', 'the CRITICAL joint is worst');
  });

  test('panel maxima come only from LIVE joints', () => {
    const joints = [
      { joint_id: 'J01', zone_id: 'Z1', temp_c: 99, deltaT: 40, ror: 9, state: 'OFFLINE' },
      { joint_id: 'J02', zone_id: 'Z1', temp_c: 45, deltaT: 12, ror: 1, state: 'LIVE' },
    ];
    const r = computeRollup(joints, [], new WorstJointLatch());
    assert.equal(r.panel_max_temp, 45, 'offline joint 99C excluded');
    assert.equal(r.live_joint_count, 1);
  });

  test('SYSTEM alarms do not add to process level/counts but a dark device -> DEGRADED', () => {
    const alarms = [activeAlarm({ category: 'SYSTEM', joint_id: 'J01', level: 'INFO', alarm_type: 'COMMUNICATION' })];
    const r = computeRollup(liveJoints, alarms, new WorstJointLatch(), { systemFault: true });
    assert.equal(r.highest_level, 0);
    assert.equal(r.active_alarm_count, 0);
    assert.equal(r.system_health, 1, 'DEGRADED');
  });

  test('no live joints -> system_health FAULT', () => {
    const dark = liveJoints.map((j) => ({ ...j, state: 'OFFLINE' }));
    const r = computeRollup(dark, [], new WorstJointLatch());
    assert.equal(r.system_health, 2);
  });

  test('per-zone rollup carries max + counts', () => {
    const alarms = [activeAlarm({ joint_id: 'J01', zone_id: 'Z1', level: 'WARNING' })];
    const r = computeRollup(liveJoints, alarms, new WorstJointLatch());
    assert.equal(r.perZone.Z1.highest_level, 2);
    assert.equal(r.perZone.Z1.count_warning, 1);
    assert.equal(r.perZone.Z1.max_temp, 60);
    assert.equal(r.perZone.Z2.max_temp, 50);
  });
});
