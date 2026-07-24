'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { BlacklistTracker } = require('../../src/config-service/blacklist-tracker');

const T0 = 1_000_000; // arbitrary base epoch ms
const opts = { blacklistAfterFailures: 3, probeBackoffS: [30, 60, 120, 300], restoreAfterGoodReads: 3 };

describe('BlacklistTracker — blacklist decision', () => {
  test('blacklists a slave after N consecutive failures, not before (AC1)', () => {
    const bt = new BlacklistTracker(opts);
    assert.equal(bt.recordResult('sl05', false, T0), null); // 1
    assert.equal(bt.recordResult('sl05', false, T0 + 5000), null); // 2
    assert.equal(bt.status('sl05'), 'active', 'still active at 2 failures');
    const ev = bt.recordResult('sl05', false, T0 + 10000); // 3 -> blacklist
    assert.equal(ev.type, 'blacklisted');
    assert.equal(ev.slaveId, 'sl05');
    assert.equal(ev.nextProbeMs, T0 + 10000 + 30 * 1000); // first backoff = 30s
    assert.equal(bt.status('sl05'), 'blacklisted');
  });

  test('a single good read resets the failure count (tolerates transients)', () => {
    const bt = new BlacklistTracker(opts);
    bt.recordResult('sl05', false, T0);
    bt.recordResult('sl05', false, T0 + 1000);
    bt.recordResult('sl05', true, T0 + 2000); // recovered
    bt.recordResult('sl05', false, T0 + 3000);
    bt.recordResult('sl05', false, T0 + 4000);
    assert.equal(bt.status('sl05'), 'active', 'never 3 consecutive -> not blacklisted');
  });

  test('a blacklisted slave is omitted from the active set; scan drops', () => {
    const bt = new BlacklistTracker(opts);
    for (let i = 0; i < 3; i++) bt.recordResult('sl05', false, T0 + i * 1000);
    assert.deepEqual(bt.blacklistedSlaveIds(), ['sl05']);
    assert.deepEqual(bt.activeSlaveIds(['sl04', 'sl05', 'sl06']), ['sl04', 'sl06']);
    assert.equal(bt.isMeasurable('sl05'), false);
    assert.equal(bt.isMeasurable('sl04'), true);
  });
});

describe('BlacklistTracker — probing & recovery', () => {
  function blacklist(bt, id, at = T0) {
    for (let i = 0; i < 3; i++) bt.recordResult(id, false, at + i);
  }

  test('probe becomes due only after the backoff; tick() promotes it to probing', () => {
    const bt = new BlacklistTracker(opts);
    blacklist(bt, 'sl05', T0);
    const probeAt = T0 + 2 + 30 * 1000;
    assert.deepEqual(bt.tick(probeAt - 1), [], 'not yet due');
    const evs = bt.tick(probeAt);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].type, 'probing');
    assert.equal(bt.status('sl05'), 'probing');
    // while probing the slave is re-included in the scan
    assert.deepEqual(bt.activeSlaveIds(['sl05']), ['sl05']);
  });

  test('restores only after M consecutive good reads (hysteresis)', () => {
    const bt = new BlacklistTracker(opts);
    blacklist(bt, 'sl05', T0);
    bt.tick(T0 + 30 * 1000 + 2); // -> probing
    assert.equal(bt.recordResult('sl05', true, T0 + 40000), null); // good 1
    assert.equal(bt.recordResult('sl05', true, T0 + 40500), null); // good 2
    assert.equal(bt.status('sl05'), 'probing', 'still probing at 2 good');
    const ev = bt.recordResult('sl05', true, T0 + 41000); // good 3 -> restore
    assert.equal(ev.type, 'restored');
    assert.equal(bt.status('sl05'), 'active');
    assert.equal(bt.isMeasurable('sl05'), true);
  });

  test('a device failing every other probe never flaps: stays blacklisted (AC5)', () => {
    const bt = new BlacklistTracker(opts);
    blacklist(bt, 'sl05', T0);
    let now = T0 + 30 * 1000 + 2;
    for (let round = 0; round < 5; round++) {
      bt.tick(now); // due -> probing
      assert.equal(bt.status('sl05'), 'probing');
      bt.recordResult('sl05', true, now + 100); // good
      const ev = bt.recordResult('sl05', false, now + 200); // then bad -> back to blacklisted
      assert.equal(ev.type, 'probe_failed');
      assert.equal(bt.status('sl05'), 'blacklisted');
      now = ev.nextProbeMs; // wait the (growing) backoff
    }
    assert.equal(bt.status('sl05'), 'blacklisted', 'never restored');
  });

  test('probe-fail backoff grows and caps at the last step', () => {
    const bt = new BlacklistTracker(opts);
    blacklist(bt, 'sl05', T0);
    const seen = [];
    let now = T0 + 30 * 1000 + 2;
    for (let i = 0; i < 6; i++) {
      bt.tick(now);
      const ev = bt.recordResult('sl05', false, now + 10); // fail the probe immediately
      seen.push(ev.backoffS);
      now = ev.nextProbeMs;
    }
    assert.deepEqual(seen, [60, 120, 300, 300, 300, 300]); // grows then caps
  });
});

describe('BlacklistTracker — snapshot', () => {
  test('snapshot exposes per-slave state for HMI/audit', () => {
    const bt = new BlacklistTracker(opts);
    for (let i = 0; i < 3; i++) bt.recordResult('sl05', false, T0 + i);
    const snap = bt.snapshot();
    assert.equal(snap.sl05.status, 'blacklisted');
    assert.equal(snap.sl05.blacklistedAtMs, T0 + 2);
    assert.equal(typeof snap.sl05.nextProbeMs, 'number');
  });
});
