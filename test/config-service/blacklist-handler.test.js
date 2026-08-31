'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const bh = require('../../src/config-service/node-red/blacklist-handler');

const T0 = 1_000_000;
const trackerOpts = { blacklistAfterFailures: 3, probeBackoffS: [30, 60, 120, 300], restoreAfterGoodReads: 3 };

// sl05 (addr 5) carries joints J10, J11; sl06 (addr 6) carries J12
const doc = {
  modbus: { slaves: [{ slave_id: 'sl05', unit_address: 5, label: 'Riser A' }, { slave_id: 'sl06', unit_address: 6 }] },
  joints: [
    { joint_id: 'J10', slave_id: 'sl05' },
    { joint_id: 'J11', slave_id: 'sl05' },
    { joint_id: 'J12', slave_id: 'sl06' },
  ],
};

function fail3(tracker, unitAddr) {
  let last;
  for (let i = 0; i < 3; i++) last = bh.processReadResult(tracker, { t: 'r', id: unitAddr, st: 'err' }, { doc, nowMs: T0 + i });
  return last;
}

describe('blacklist-handler — read results drive exclusion + alarms', () => {
  test('maps unit address to slave_id and blacklists after 3 failures', () => {
    const tracker = bh.newTracker(trackerOpts);
    const r = fail3(tracker, 5);
    assert.deepEqual(r.excludeSlaveIds, ['sl05']);
    assert.equal(r.resendNeeded, true, 'job must be resent without sl05');
    assert.equal(r.alarms.length, 1);
    assert.equal(r.alarms[0].action, 'raise');
    assert.equal(r.alarms[0].slave_id, 'sl05');
    assert.deepEqual(r.alarms[0].joints, ['J10', 'J11']);
    assert.match(r.alarms[0].description, /J10, J11 not measurable/);
    // operator-facing identity: the commissioned unit address + label, not 'sl05'
    assert.match(r.alarms[0].description, /Slave 5 \(Riser A\)/);
    assert.equal(r.alarms[0].unit_address, 5);
  });

  test('an ok read on an active slave produces no alarm and no resend', () => {
    const tracker = bh.newTracker(trackerOpts);
    const r = bh.processReadResult(tracker, { t: 'r', id: 6, st: 'ok' }, { doc, nowMs: T0, prevExcludeKey: '' });
    assert.deepEqual(r.alarms, []);
    assert.equal(r.resendNeeded, false);
    assert.deepEqual(r.excludeSlaveIds, []);
  });

  test('restore clears the alarm but does NOT resend (slave already polled while probing)', () => {
    const tracker = bh.newTracker(trackerOpts);
    fail3(tracker, 5); // blacklisted, exclude=['sl05']
    const promote = bh.processTick(tracker, { doc, nowMs: T0 + 30 * 1000 + 5, prevExcludeKey: 'sl05' });
    assert.deepEqual(promote.excludeSlaveIds, [], 'probing -> included again');
    assert.equal(promote.resendNeeded, true, 'resend to re-include the probe slave');
    // 3 good probe reads -> restore
    let r;
    for (let i = 0; i < 3; i++) r = bh.processReadResult(tracker, { t: 'r', id: 5, st: 'ok' }, { doc, nowMs: T0 + 40000 + i, prevExcludeKey: '' });
    assert.equal(r.alarms.length, 1);
    assert.equal(r.alarms[0].action, 'clear');
    assert.equal(r.alarms[0].slave_id, 'sl05');
    assert.equal(r.resendNeeded, false, 'restore does not change the read set');
    // step 6: the restored slave's joints are flagged for EMA/deltaT reset
    assert.deepEqual(r.emaResetJoints, ['J10', 'J11']);
  });

  test('no EMA reset is requested outside a restore', () => {
    const tracker = bh.newTracker(trackerOpts);
    const r = fail3(tracker, 5); // a blacklist event, not a restore
    assert.deepEqual(r.emaResetJoints, []);
  });

  test('unknown unit address is ignored (no slave mapping)', () => {
    const tracker = bh.newTracker(trackerOpts);
    const r = bh.processReadResult(tracker, { t: 'r', id: 99, st: 'err' }, { doc, nowMs: T0, prevExcludeKey: '' });
    assert.deepEqual(r.events, []);
    assert.deepEqual(r.excludeSlaveIds, []);
  });

  test('non-read frames (boot text, write acks) are ignored', () => {
    const tracker = bh.newTracker(trackerOpts);
    assert.deepEqual(bh.processReadResult(tracker, { t: 'w', id: 5, st: 'ok' }, { doc, nowMs: T0, prevExcludeKey: '' }).events, []);
    assert.deepEqual(bh.processReadResult(tracker, 'Ready to receive JSON...', { doc, nowMs: T0, prevExcludeKey: '' }).events, []);
  });
});

describe('blacklist-handler — getTracker singleton', () => {
  test('returns the same live instance across calls (must not go through serialised context)', () => {
    const a = bh.getTracker();
    const b = bh.getTracker();
    assert.equal(a, b, 'same process-wide instance');
    assert.equal(typeof a.tick, 'function', 'methods intact (not a JSON-stripped plain object)');
    assert.equal(typeof a.recordResult, 'function');
  });
});

describe('blacklist-handler — summarizeBlacklist (HMI view)', () => {
  const state = {
    updatedTs: '2026-07-24T12:00:00Z',
    slaves: {
      sl05: { status: 'blacklisted', fails: 3, goods: 0, nextProbeMs: 200000 },
      sl06: { status: 'probing', fails: 0, goods: 1, nextProbeMs: null },
      sl07: { status: 'active', fails: 0 },
    },
    joints: {
      J10: { state: 'STALE', slave_id: 'sl05' },
      J11: { state: 'OFFLINE', slave_id: 'sl05' },
      J12: { state: 'OFFLINE', slave_id: 'sl06' },
      J13: { state: 'LIVE', slave_id: 'sl07' },
    },
  };

  test('lists only non-active slaves with countdown + affected joints', () => {
    const v = bh.summarizeBlacklist(state, 170000); // 30s before sl05's probe
    assert.equal(v.slaves.length, 2);
    const sl05 = v.slaves.find((r) => r.slave_id === 'sl05');
    assert.equal(sl05.status, 'blacklisted');
    assert.equal(sl05.next_probe_in_sec, 30);
    assert.deepEqual(sl05.joints, ['J10', 'J11']);
    const sl06 = v.slaves.find((r) => r.slave_id === 'sl06');
    assert.equal(sl06.status, 'probing');
    assert.equal(sl06.next_probe_in_sec, null); // no countdown while probing
  });

  test('reports counts and STALE/OFFLINE joint lists', () => {
    const v = bh.summarizeBlacklist(state, 170000);
    assert.deepEqual(v.counts, { blacklisted: 1, probing: 1, stale: 1, offline: 2 });
    assert.deepEqual(v.staleJoints, ['J10']);
    assert.deepEqual(v.offlineJoints, ['J11', 'J12']);
  });

  test('empty/missing state is a clean all-clear summary', () => {
    const v = bh.summarizeBlacklist(undefined);
    assert.deepEqual(v.slaves, []);
    assert.deepEqual(v.counts, { blacklisted: 0, probing: 0, stale: 0, offline: 0 });
  });
});

describe('blacklist-handler — joint states (step 5)', () => {
  test('LIVE when the slave is active', () => {
    const tracker = bh.newTracker(trackerOpts);
    const js = bh.deriveJointStates(doc, tracker);
    assert.equal(js.J10.state, 'LIVE');
    assert.equal(js.J12.state, 'LIVE');
  });

  test('blacklisted slave: joint with an active alarm is STALE (held), others OFFLINE', () => {
    const tracker = bh.newTracker(trackerOpts);
    fail3(tracker, 5); // sl05 blacklisted -> J10, J11 not measurable
    const js = bh.deriveJointStates(doc, tracker, new Set(['J10']), { J10: '2026-07-24T10:00:00Z' });
    assert.equal(js.J10.state, 'STALE', 'had an active alarm -> held');
    assert.equal(js.J10.last_valid_ts, '2026-07-24T10:00:00Z');
    assert.equal(js.J11.state, 'OFFLINE', 'no active alarm -> offline');
    assert.equal(js.J12.state, 'LIVE', 'unaffected slave stays live');
  });
});

// Live 2026-07-28: the ambient slave (sl21/unit 101) carries NO joints, so a
// restore reset nothing and J01/J02 kept decaying their ΔT EMA from a value
// built against the dead ambient — a stale ΔT alarm looked stuck for a full tau.
describe('blacklist-handler — restoring an ambient slave resets its dependent joints', () => {
  const ambDoc = {
    modbus: {
      slaves: [{ slave_id: 'sl01', unit_address: 1 }, { slave_id: 'sl21', unit_address: 101 }],
      ambient_sensor: { slave_id: 'sl21', channel: 1 },
    },
    zones: [{ zone_id: 'Z1' }],
    joints: [
      { joint_id: 'J01', slave_id: 'sl01', zone_id: 'Z1' },
      { joint_id: 'J02', slave_id: 'sl01', zone_id: 'Z1' },
    ],
  };

  test('ambientSlaveForJoint follows the joint -> zone -> panel override chain', () => {
    const doc = {
      modbus: { ambient_sensor: { slave_id: 'slPANEL' } },
      zones: [{ zone_id: 'Z1', ambient_sensor: { slave_id: 'slZONE' } }, { zone_id: 'Z2' }],
      joints: [
        { joint_id: 'A', zone_id: 'Z1', ambient_sensor: { slave_id: 'slJOINT' } },
        { joint_id: 'B', zone_id: 'Z1' },
        { joint_id: 'C', zone_id: 'Z2' },
      ],
    };
    assert.equal(bh.ambientSlaveForJoint(doc, doc.joints[0]), 'slJOINT', 'joint override wins');
    assert.equal(bh.ambientSlaveForJoint(doc, doc.joints[1]), 'slZONE', 'else the zone override');
    assert.equal(bh.ambientSlaveForJoint(doc, doc.joints[2]), 'slPANEL', 'else the panel default');
  });

  test('jointsUsingAmbientSlave finds joints that reference the slave (not carried by it)', () => {
    assert.deepEqual(bh.jointsUsingAmbientSlave(ambDoc, 'sl21'), ['J01', 'J02']);
    assert.deepEqual(bh.jointsForSlave(ambDoc, 'sl21'), [], 'the ambient slave carries no joints of its own');
  });

  // Live 2026-07-28: the alarm read "Slave sl21 ... joint(s) (none mapped) not
  // measurable" — an internal id the operator never typed, and an impact line
  // that understated a fault which actually disables ΔT for every joint.
  test('the blacklist alarm names the unit address/label and the ambient impact', () => {
    const withLabel = JSON.parse(JSON.stringify(ambDoc));
    withLabel.modbus.slaves[1].label = 'AMBIENT_101';
    const tracker = bh.newTracker(trackerOpts);
    let r;
    for (let i = 0; i < 3; i++) r = bh.processReadResult(tracker, { t: 'r', id: 101, st: 'err' }, { doc: withLabel, nowMs: T0 + i });
    const a = r.alarms[0];
    assert.match(a.description, /Slave 101 \(AMBIENT_101\)/, 'operator-facing address, not sl21');
    assert.ok(!a.description.includes('sl21'), 'the internal slave_id is not shown to the operator');
    assert.match(a.description, /ambient reference for joint\(s\) J01, J02/);
    assert.ok(!a.description.includes('none mapped'), 'no misleading "(none mapped)" for an ambient slave');
    assert.equal(a.unit_address, 101);
    assert.deepEqual(a.ambient_for_joints, ['J01', 'J02']);
  });

  test('summarizeBlacklist exposes the unit address when given the config doc', () => {
    const withLabel = JSON.parse(JSON.stringify(ambDoc));
    withLabel.modbus.slaves[1].label = 'AMBIENT_101';
    const state = { slaves: { sl21: { status: 'blacklisted', fails: 3, nextProbeMs: null } }, joints: {} };
    const v = bh.summarizeBlacklist(state, T0, { doc: withLabel });
    assert.equal(v.slaves[0].display, '101 (AMBIENT_101)');
    assert.equal(v.slaves[0].unit_address, 101);
    assert.deepEqual(v.slaves[0].ambient_for_joints, ['J01', 'J02']);
  });

  test('summarizeBlacklist without a doc still works (display falls back to slave_id)', () => {
    const state = { slaves: { sl21: { status: 'blacklisted', fails: 3, nextProbeMs: null } }, joints: {} };
    const v = bh.summarizeBlacklist(state, T0);
    assert.equal(v.slaves[0].display, 'sl21');
    assert.equal(v.slaves[0].unit_address, null);
  });

  test('restoring the ambient slave flags the dependent joints for EMA reset', () => {
    const tracker = bh.newTracker(trackerOpts);
    for (let i = 0; i < 3; i++) bh.processReadResult(tracker, { t: 'r', id: 101, st: 'err' }, { doc: ambDoc, nowMs: T0 + i });
    bh.processTick(tracker, { doc: ambDoc, nowMs: T0 + 30 * 1000 + 5, prevExcludeKey: 'sl21' });
    let r;
    for (let i = 0; i < 3; i++) r = bh.processReadResult(tracker, { t: 'r', id: 101, st: 'ok' }, { doc: ambDoc, nowMs: T0 + 40000 + i, prevExcludeKey: '' });
    assert.equal(r.alarms[0].action, 'clear');
    assert.deepEqual(r.emaResetJoints, ['J01', 'J02'], 'ΔT baselines built against the dead ambient must re-init');
  });

  test('a joint both carried by and referencing the slave is listed once', () => {
    const doc = {
      modbus: { slaves: [{ slave_id: 'sl05', unit_address: 5 }], ambient_sensor: { slave_id: 'sl05' } },
      joints: [{ joint_id: 'J10', slave_id: 'sl05' }],
    };
    const tracker = bh.newTracker(trackerOpts);
    for (let i = 0; i < 3; i++) bh.processReadResult(tracker, { t: 'r', id: 5, st: 'err' }, { doc, nowMs: T0 + i });
    bh.processTick(tracker, { doc, nowMs: T0 + 30 * 1000 + 5, prevExcludeKey: 'sl05' });
    let r;
    for (let i = 0; i < 3; i++) r = bh.processReadResult(tracker, { t: 'r', id: 5, st: 'ok' }, { doc, nowMs: T0 + 40000 + i, prevExcludeKey: '' });
    assert.deepEqual(r.emaResetJoints, ['J10'], 'no duplicate');
  });
});

describe('blacklist-handler — bus-tagged slave resolution (Slice 10)', () => {
  test('unitToSlaveId resolves within a bus (addresses are unique per bus, not globally)', () => {
    const doc = { modbus: { slaves: [
      { slave_id: 'sl01', unit_address: 5, bus_id: 'bus1' },
      { slave_id: 'sl09', unit_address: 5, bus_id: 'bus2' },
    ] } };
    assert.equal(bh.unitToSlaveId(doc, 5, 'bus1'), 'sl01');
    assert.equal(bh.unitToSlaveId(doc, 5, 'bus2'), 'sl09');
    assert.equal(bh.unitToSlaveId(doc, 5), 'sl01'); // no bus tag -> first match (single-bus)
  });

  test('a bus-tagged read result records against the right slave', () => {
    const doc = { modbus: { slaves: [
      { slave_id: 'sl01', unit_address: 5, bus_id: 'bus1' },
      { slave_id: 'sl09', unit_address: 5, bus_id: 'bus2' },
    ] }, joints: [{ joint_id: 'J50', slave_id: 'sl09' }] };
    const tracker = bh.newTracker(trackerOpts);
    let r;
    for (let i = 0; i < 3; i++) r = bh.processReadResult(tracker, { t: 'r', id: 5, st: 'err', bus_id: 'bus2' }, { doc, nowMs: T0 + i });
    assert.deepEqual(r.excludeSlaveIds, ['sl09'], 'blacklisted the bus2 slave, not bus1');
  });
});

describe('blacklist-handler — per-bus resend (Slice 10 two-segment)', () => {
  // Two segments, each with its own Nano. Addresses are unique panel-wide (the
  // commissioning UI enforces it), but the resend must still be per-bus.
  const twoBus = {
    modbus: {
      buses: [{ bus_id: 'bus1' }, { bus_id: 'bus2' }],
      slaves: [
        { slave_id: 'sl01', unit_address: 5, bus_id: 'bus1' },
        { slave_id: 'sl09', unit_address: 60, bus_id: 'bus2' },
      ],
    },
    joints: [
      { joint_id: 'J10', slave_id: 'sl01' },
      { joint_id: 'J50', slave_id: 'sl09' },
    ],
  };

  test('a bus2 device failing resends ONLY bus2', () => {
    const tracker = bh.newTracker(trackerOpts);
    let r;
    for (let i = 0; i < 3; i++) {
      r = bh.processReadResult(tracker, { t: 'r', id: 60, st: 'err' }, { doc: twoBus, nowMs: T0 + i, prevExcludeKey: '' });
    }
    assert.equal(r.resendNeeded, true);
    assert.deepEqual(r.resendBusIds, ['bus2'], 'bus1 must keep polling undisturbed');
  });

  test('a probe promotion resends only the probing slave\'s bus', () => {
    const tracker = bh.newTracker(trackerOpts);
    for (let i = 0; i < 3; i++) {
      bh.processReadResult(tracker, { t: 'r', id: 60, st: 'err' }, { doc: twoBus, nowMs: T0 + i, prevExcludeKey: '' });
    }
    const promote = bh.processTick(tracker, { doc: twoBus, nowMs: T0 + 30 * 1000 + 5, prevExcludeKey: 'sl09' });
    assert.equal(promote.resendNeeded, true);
    assert.deepEqual(promote.resendBusIds, ['bus2']);
  });

  test('devices failing on both segments resend both', () => {
    const tracker = bh.newTracker(trackerOpts);
    let r;
    for (let i = 0; i < 3; i++) {
      bh.processReadResult(tracker, { t: 'r', id: 5, st: 'err' }, { doc: twoBus, nowMs: T0 + i, prevExcludeKey: '' });
      r = bh.processReadResult(tracker, { t: 'r', id: 60, st: 'err' }, { doc: twoBus, nowMs: T0 + i, prevExcludeKey: '' });
    }
    assert.deepEqual(r.resendBusIds.sort(), ['bus1', 'bus2']);
  });

  test('no state change -> no bus is resent', () => {
    const tracker = bh.newTracker(trackerOpts);
    const r = bh.processReadResult(tracker, { t: 'r', id: 5, st: 'ok' }, { doc: twoBus, nowMs: T0, prevExcludeKey: '' });
    assert.equal(r.resendNeeded, false);
    assert.deepEqual(r.resendBusIds, []);
  });

  test('a single-bus panel still names its one bus, so the lone Send node accepts it', () => {
    const tracker = bh.newTracker(trackerOpts);
    let r;
    for (let i = 0; i < 3; i++) r = bh.processReadResult(tracker, { t: 'r', id: 5, st: 'err' }, { doc, nowMs: T0 + i });
    // `doc` (top of file) predates multi-bus: no bus_id, no buses array
    assert.deepEqual(r.resendBusIds, ['bus1']);
  });
});

describe('stale blacklist alarms after a restart (reconcileBlacklistAlarms)', () => {
  // The failure this guards, seen on the panel 2026-08-31: the tracker is an
  // in-memory singleton and is EMPTY after a Node-RED restart, while the alarm
  // lives in localfilesystem-backed context and SURVIVES. A device blacklisted
  // before the restart never gets its `restored` event, so its CRITICAL alarm
  // stays active forever while the device is polled normally and reads fine.
  const rdoc = {
    modbus: {
      slaves: [
        { slave_id: 'sl01', unit_address: 1, label: 'Sensor1' },
        { slave_id: 'sl21', unit_address: 101, label: 'AmbientT' },
      ],
    },
    joints: [{ joint_id: 'J01', slave_id: 'sl01', channel: 1, zone_id: 'z1', enabled: true }],
    zones: [{ zone_id: 'z1', ambient_sensor: { slave_id: 'sl21', channel: 1 } }],
  };
  const blacklistAlarm = (slaveId) => ({
    [`SYSTEM|${slaveId}|BLACKLIST`]: {
      instanceId: `SYSTEM|${slaveId}|BLACKLIST`, category: 'SYSTEM',
      alarm_type: 'DEVICE_BLACKLIST', level: 'CRITICAL', status: 'ACTIVE_NACK', slave_id: slaveId,
    },
  });

  test('clears an alarm the fresh tracker has no record of', () => {
    const tracker = bh.newTracker(trackerOpts);            // as after a restart
    const clears = bh.reconcileBlacklistAlarms(blacklistAlarm('sl21'), tracker, rdoc);
    assert.equal(clears.length, 1);
    assert.equal(clears[0].action, 'clear');
    assert.equal(clears[0].slave_id, 'sl21');
    assert.equal(clears[0].unit_address, 101);
    assert.match(clears[0].description, /101/, 'names the device as commissioned');
    assert.match(clears[0].description, /stale alarm/i, 'and says why it cleared');
  });

  test('names the joints the stale alarm was blaming', () => {
    const [c] = bh.reconcileBlacklistAlarms(blacklistAlarm('sl21'), bh.newTracker(trackerOpts), rdoc);
    assert.deepEqual(c.ambient_for_joints, ['J01'], "sl21 is J01's ambient reference");
  });

  test('LEAVES a genuinely blacklisted device alone', () => {
    // The whole risk of this function is clearing an alarm that is still true.
    const tracker = bh.newTracker(trackerOpts);
    for (let i = 0; i < 3; i++) tracker.recordResult('sl21', false, T0);
    assert.equal(tracker.status('sl21'), 'blacklisted');
    assert.deepEqual(bh.reconcileBlacklistAlarms(blacklistAlarm('sl21'), tracker, rdoc), []);
  });

  test('leaves a device mid-probe alone too', () => {
    const tracker = bh.newTracker(trackerOpts);
    for (let i = 0; i < 3; i++) tracker.recordResult('sl21', false, T0);
    tracker.tick(T0 + 60_000);                              // backoff elapsed -> probing
    assert.equal(tracker.status('sl21'), 'probing');
    assert.deepEqual(bh.reconcileBlacklistAlarms(blacklistAlarm('sl21'), tracker, rdoc), []);
  });

  test('ignores every other kind of alarm', () => {
    const others = {
      'SYSTEM|MODULE|COMM_FAILURE': { instanceId: 'SYSTEM|MODULE|COMM_FAILURE', category: 'SYSTEM' },
      'PROCESS|J01|DELTA_T': { instanceId: 'PROCESS|J01|DELTA_T', category: 'PROCESS' },
      'SYSTEM|PI|POWER': { instanceId: 'SYSTEM|PI|POWER', category: 'SYSTEM' },
    };
    assert.deepEqual(bh.reconcileBlacklistAlarms(others, bh.newTracker(trackerOpts), rdoc), []);
  });

  test('empty or missing alarm set is not an error', () => {
    assert.deepEqual(bh.reconcileBlacklistAlarms({}, bh.newTracker(trackerOpts), rdoc), []);
    assert.deepEqual(bh.reconcileBlacklistAlarms(undefined, bh.newTracker(trackerOpts), rdoc), []);
  });
});
