'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const bh = require('../../src/config-service/node-red/blacklist-handler');

const T0 = 1_000_000;
const trackerOpts = { blacklistAfterFailures: 3, probeBackoffS: [30, 60, 120, 300], restoreAfterGoodReads: 3 };

// sl05 (addr 5) carries joints J10, J11; sl06 (addr 6) carries J12
const doc = {
  modbus: { slaves: [{ slave_id: 'sl05', unit_address: 5 }, { slave_id: 'sl06', unit_address: 6 }] },
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
