'use strict';

/**
 * Auto-clearing alarms whose subject left the configuration.
 *
 * Reported from the panel 2026-08-31: after changing the joint configuration,
 * alarms for the old setup stayed in Active Alarms. The Alarm Manager's existing
 * sweep compared against the legacy DRAFT global rather than the applied
 * document, and skipped every SYSTEM alarm — so a blacklist alarm for a deleted
 * device could never clear.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { sweepDecommissionedAlarms } = require('../../src/alarms/config-sweep');

const doc = () => ({
  modbus: {
    slaves: [
      { slave_id: 'sl01', unit_address: 1, label: 'Sensor1' },
      { slave_id: 'sl21', unit_address: 101, label: 'AmbientT' },
    ],
  },
  joints: [
    { joint_id: 'J01', slave_id: 'sl01', channel: 1, zone_id: 'z1' },
    { joint_id: 'J02', slave_id: 'sl01', channel: 2, zone_id: 'z1' },
  ],
});

const process_ = (jointId, over = {}) => ({
  instanceId: `PROCESS|${jointId}|DELTA_T|WARNING`,
  category: 'PROCESS', joint_id: jointId, alarm_type: 'DELTA_T',
  level: 'WARNING', status: 'ACTIVE_NACK', description: `${jointId} deltaT high`, ...over,
});
const system_ = (scope, type = 'BLACKLIST', over = {}) => ({
  instanceId: `SYSTEM|${scope}|${type}`,
  category: 'SYSTEM', joint_id: 'SYSTEM', alarm_type: `DEVICE_${type}`,
  level: 'CRITICAL', status: 'ACTIVE_NACK', description: `${scope} ${type}`, ...over,
});
const byKey = (list) => Object.fromEntries(list.map((a) => [a.instanceId, a]));

describe('config sweep - PROCESS alarms', () => {
  test('clears an alarm for a joint that is no longer configured', () => {
    const out = sweepDecommissionedAlarms(byKey([process_('J99')]), doc());
    assert.equal(out.length, 1);
    assert.equal(out[0].joint_id, 'J99');
    assert.equal(out[0].reason, 'CONFIG_REMOVED');
    assert.match(out[0].description, /no longer in configuration/);
  });

  test('leaves alarms for joints that are still configured', () => {
    assert.deepEqual(sweepDecommissionedAlarms(byKey([process_('J01'), process_('J02')]), doc()), []);
  });

  test('a RENAMED joint clears under its old id and is untouched under the new one', () => {
    // This is what the user actually did: edited the config, and the alarm
    // raised against the previous id had nothing left to belong to.
    const renamed = { ...doc(), joints: [{ joint_id: 'J00001', slave_id: 'sl01', channel: 1, zone_id: 'z1' }] };
    const out = sweepDecommissionedAlarms(byKey([process_('J01'), process_('J00001')]), renamed);
    assert.deepEqual(out.map((o) => o.joint_id), ['J01']);
  });

  test('never sweeps an ambient pseudo-joint', () => {
    // AMBIENT_* alarms are not keyed to joints[] and never were swept.
    assert.deepEqual(sweepDecommissionedAlarms(byKey([process_('AMBIENT_101')]), doc()), []);
  });
});

describe('config sweep - SYSTEM alarms', () => {
  test('clears a blacklist alarm for a device deleted from the configuration', () => {
    // The gap that made this unrecoverable: a deleted device is never polled, so
    // the tracker never emits `restored`, so nothing ever cleared its alarm.
    const out = sweepDecommissionedAlarms(byKey([system_('sl99')]), doc());
    assert.equal(out.length, 1);
    assert.equal(out[0].slave_id, 'sl99');
    assert.match(out[0].description, /device no longer in configuration/);
  });

  test('LEAVES a blacklist alarm for a device that is still commissioned', () => {
    // However sick it is, that is the tracker's business, not the sweep's.
    assert.deepEqual(sweepDecommissionedAlarms(byKey([system_('sl21')]), doc()), []);
  });

  test('never sweeps panel-level SYSTEM alarms', () => {
    // These belong to no configured device, so "not in the config" is meaningless.
    const panel = byKey([
      system_('MODULE', 'COMM_FAILURE'),
      system_('BUS2', 'COMM_FAILURE'),
      system_('PI', 'POWER'),
    ]);
    assert.deepEqual(sweepDecommissionedAlarms(panel, doc()), []);
  });
});

describe('config sweep - refuses to act on absent information', () => {
  // The original code did `global.get(...) || []`, so a missing global made
  // every joint look deleted and would have cleared every PROCESS alarm at once.
  const alarms = byKey([process_('J01'), process_('J99'), system_('sl99')]);

  test('no document at all sweeps nothing', () => {
    for (const bad of [undefined, null, {}, 'nonsense', 42]) {
      assert.deepEqual(sweepDecommissionedAlarms(alarms, bad), [], `doc=${JSON.stringify(bad)}`);
    }
  });

  test('a document with an empty joints array sweeps nothing', () => {
    // Indistinguishable from "could not read it" - and clearing every alarm on
    // the panel is far worse than leaving a stale one.
    assert.deepEqual(sweepDecommissionedAlarms(alarms, { ...doc(), joints: [] }), []);
  });

  test('a document with no slave list leaves SYSTEM alarms alone but still sweeps joints', () => {
    const out = sweepDecommissionedAlarms(alarms, { joints: doc().joints });
    assert.deepEqual(out.map((o) => o.instanceId), ['PROCESS|J99|DELTA_T|WARNING']);
  });

  test('no active alarms, or a malformed set, is not an error', () => {
    for (const bad of [{}, undefined, null, []]) {
      assert.deepEqual(sweepDecommissionedAlarms(bad, doc()), []);
    }
    assert.deepEqual(sweepDecommissionedAlarms({ 'PROCESS|X|Y': null }, doc()), []);
  });
});
