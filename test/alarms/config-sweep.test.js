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

describe('config sweep - SYSTEM alarms scoped to a JOINT, not a slave', () => {
  // Regression, found live 2026-08-31. The per-sensor fault alarms the Alarm
  // Manager raises are keyed `SYSTEM|{joint_id}|COMMUNICATION` and
  // `SYSTEM|{joint_id}|SENSOR_FAULT` - category SYSTEM, but a JOINT id in the
  // scope position where a blacklist alarm carries a slave_id. The first cut of
  // this sweep checked only the slave list, so it cleared these the instant they
  // were raised: on the reporting panel a removed sensor produced a
  // raise/auto-clear pair - and a pair of e-mails - on every blacklist probe
  // cycle (visible as history entries exactly 5 minutes apart, the max backoff).
  const commAlarm = (jointId) => system_(jointId, 'COMMUNICATION', {
    joint_id: jointId, description: 'Sensor communication failure',
  });
  const faultAlarm = (jointId) => system_(jointId, 'SENSOR_FAULT', {
    joint_id: jointId, description: 'Sensor fault',
  });

  test('LEAVES a per-sensor comm/fault alarm for a joint that is still configured', () => {
    assert.deepEqual(sweepDecommissionedAlarms(byKey([commAlarm('J02'), faultAlarm('J01')]), doc()), []);
  });

  test('a still-configured joint keeps its comm alarm even while its slave is blacklisted', () => {
    // The exact live case: sl01 blacklisted (correctly, sensor unplugged) while
    // J02 - still in the configuration - holds its communication alarm.
    const alarms = byKey([system_('sl01'), commAlarm('J02')]);
    assert.deepEqual(sweepDecommissionedAlarms(alarms, doc()), []);
  });

  test('but DOES sweep one whose joint has been deleted from the configuration', () => {
    const out = sweepDecommissionedAlarms(byKey([commAlarm('J99'), faultAlarm('J98')]), doc());
    assert.deepEqual(out.map((o) => o.instanceId).sort(),
      ['SYSTEM|J98|SENSOR_FAULT', 'SYSTEM|J99|COMMUNICATION']);
  });

  test('a scope naming neither a slave nor a joint is still swept', () => {
    // The sweep is not "anything unrecognised is kept" - that would resurrect
    // gap 2, the deleted device whose blacklist alarm can never clear.
    const out = sweepDecommissionedAlarms(byKey([system_('sl99'), commAlarm('J99')]), doc());
    assert.equal(out.length, 2);
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

describe('config sweep - SYSTEM alarms scoped to an AMBIENT sensor (2026-09-16)', () => {
  // Live report: unplugging the ambient raised its comm alarm, the sweep cleared
  // it as "device no longer in configuration", ProcessLogic re-raised it on the
  // next sample - a raise/auto-clear loop, with e-mails, for as long as the
  // sensor stayed disconnected. The scope is ProcessLogic's `AMBIENT_<unit>`,
  // which is neither a slave_id nor a joint_id, so the SYSTEM branch had nothing
  // to match it against. (The PROCESS branch had skipped AMBIENT_ from day one.)
  const ambientComm = (scope) => system_(scope, 'COMMUNICATION', {
    joint_id: scope, alarm_type: 'COMMUNICATION', description: 'Sensor communication failure',
  });

  test('LEAVES a comm alarm for an ambient whose unit is still commissioned', () => {
    // unit 101 is sl21 in the fixture
    assert.deepEqual(sweepDecommissionedAlarms(byKey([ambientComm('AMBIENT_101')]), doc()), []);
  });

  test('matches by unit address, since the scope carries no slave_id', () => {
    const d = doc();
    d.modbus.slaves = d.modbus.slaves.map((s) => (s.slave_id === 'sl21' ? { ...s, slave_id: 'sl77' } : s));
    assert.deepEqual(sweepDecommissionedAlarms(byKey([ambientComm('AMBIENT_101')]), d), []);
  });

  test('a multi-channel ambient (AMBIENT_<unit>_<ch>) is kept while the channel exists', () => {
    const d = doc();
    d.modbus.slaves.push({ slave_id: 'sl30', unit_address: 30, channels: 4 });
    assert.deepEqual(sweepDecommissionedAlarms(byKey([ambientComm('AMBIENT_30_3')]), d), []);
  });

  test('but DOES sweep one whose ambient unit has been deleted from the configuration', () => {
    // Not a blanket skip: a deleted ambient must still clear, or its alarm is
    // stuck forever - the exact stuck-alarm class the sweep exists to fix.
    const d = doc();
    d.modbus.slaves = d.modbus.slaves.filter((s) => s.unit_address !== 101);
    const out = sweepDecommissionedAlarms(byKey([ambientComm('AMBIENT_101')]), d);
    assert.equal(out.length, 1);
    assert.equal(out[0].reason, 'CONFIG_REMOVED');
  });

  test('and a channel the unit no longer has', () => {
    const d = doc();
    d.modbus.slaves.push({ slave_id: 'sl30', unit_address: 30, channels: 2 });
    assert.equal(sweepDecommissionedAlarms(byKey([ambientComm('AMBIENT_30_3')]), d).length, 1);
  });

  test('the sensor-fault key on an ambient is treated the same way', () => {
    const fault = system_('AMBIENT_101', 'SENSOR_FAULT', { joint_id: 'AMBIENT_101' });
    assert.deepEqual(sweepDecommissionedAlarms(byKey([fault]), doc()), []);
  });
});

describe('a joint switched off in the table (2026-09-22)', () => {
  // The Active checkbox takes a joint out of service without deleting its row.
  // buildProcessLogicJoints stops sampling it, so any alarm it was holding can
  // never clear on its own - the same dead end as a deleted joint, and the same
  // remedy.
  const withDisabled = () => {
    const d = doc();
    d.joints = [{ ...d.joints[0] }, { ...d.joints[1], enabled: false }];
    return d;
  };

  test('its PROCESS alarm is cleared rather than left hanging', () => {
    const out = sweepDecommissionedAlarms(byKey([process_('J02')]), withDisabled());
    assert.equal(out.length, 1);
    assert.equal(out[0].joint_id, 'J02');
  });

  test('and says it was switched off, not deleted', () => {
    // One is reversible from the table and the other is not; the cleared-alarm
    // history should not make the operator guess which happened.
    const [cleared] = sweepDecommissionedAlarms(byKey([process_('J02')]), withDisabled());
    assert.equal(cleared.reason, 'CONFIG_DISABLED');
    assert.match(cleared.description, /switched off/);
  });

  test('a deleted joint still reads as deleted', () => {
    const d = withDisabled();
    d.joints = [d.joints[0]];
    const [cleared] = sweepDecommissionedAlarms(byKey([process_('J02')]), d);
    assert.equal(cleared.reason, 'CONFIG_REMOVED');
    assert.match(cleared.description, /no longer in configuration/);
  });

  test('its per-sensor comm alarm clears too', () => {
    // Keyed SYSTEM|<joint_id>|COMMUNICATION. A joint that is not polled cannot
    // produce the reading that would clear it.
    const comm = system_('J02', 'COMMUNICATION', { joint_id: 'J02' });
    assert.equal(sweepDecommissionedAlarms(byKey([comm]), withDisabled()).length, 1);
  });

  test('an ENABLED joint is untouched, however sick', () => {
    assert.deepEqual(sweepDecommissionedAlarms(byKey([process_('J01')]), withDisabled()), []);
  });

  test('a joint with no `enabled` field at all is monitored, not swept', () => {
    // Every document applied before the column existed. Absent means enabled -
    // reading it as off would auto-clear every alarm on the panel at once.
    assert.deepEqual(sweepDecommissionedAlarms(byKey([process_('J01'), process_('J02')]), doc()), []);
  });
});

describe('a device switched off in Modbus Settings (2026-09-24)', () => {
  // Nothing polls it, so neither its own alarms nor those of the joints mapped
  // to it can ever clear on their own.
  const offDoc = () => {
    const d = doc();
    d.modbus.slaves = d.modbus.slaves.map((s) => (s.slave_id === 'sl01' ? { ...s, enabled: false } : s));
    return d;
  };

  test("its joints' PROCESS alarms clear, as switched off", () => {
    const out = sweepDecommissionedAlarms(byKey([process_('J01')]), offDoc());
    assert.equal(out.length, 1);
    assert.equal(out[0].reason, 'CONFIG_DISABLED');
  });

  test('its own BLACKLIST alarm clears', () => {
    // A device nobody is talking to produces neither an ok nor an err, so the
    // tracker can never emit the `restored` that would clear this.
    assert.equal(sweepDecommissionedAlarms(byKey([system_('sl01')]), offDoc()).length, 1);
  });

  test('a device still in service keeps its alarm', () => {
    assert.deepEqual(sweepDecommissionedAlarms(byKey([system_('sl21')]), offDoc()), []);
  });

  test('EVERY joint on that device is swept, not just the first', () => {
    // J01 and J02 are both on sl01 (channels 1 and 2) - switching the device
    // off darkens the whole unit, since the Nano reads its channels in one
    // transaction.
    const out = sweepDecommissionedAlarms(byKey([process_('J01'), process_('J02')]), offDoc());
    assert.deepEqual(out.map((c) => c.joint_id).sort(), ['J01', 'J02']);
  });

  test('a joint on a device still in service keeps its alarm', () => {
    const d = offDoc();
    d.joints = [...d.joints, { joint_id: 'J09', slave_id: 'sl21', channel: 1, zone_id: 'z1' }];
    assert.deepEqual(sweepDecommissionedAlarms(byKey([process_('J09')]), d), []);
  });
});
