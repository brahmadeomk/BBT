'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { resolveAmbient, median } = require('../../src/config-service/ambient-resolver');

// 4 ambient sensors: 101,102 in zone z1; 103,104 in zone z2
const zoneOf = { 101: 'z1', 102: 'z1', 103: 'z2', 104: 'z2' };

describe('resolveAmbient', () => {
  test('uses the configured sensor when its reading is plausible', () => {
    const r = resolveAmbient({ configuredId: 101, zoneId: 'z1', readings: { 101: 31.2, 102: 31.0 }, zoneOf });
    assert.deepEqual(r, { val: 31.2, source: 'configured', ambient_id: 101, rejected: false });
  });

  test('rejects an out-of-band configured reading and falls back to the zone median', () => {
    // 101 reads 250 (sensor fault) -> reject -> zone median of the other plausible z1 sensor(s)
    const r = resolveAmbient({ configuredId: 101, zoneId: 'z1', readings: { 101: 250, 102: 31.0, 103: 40 }, zoneOf });
    assert.equal(r.source, 'zone_median');
    assert.equal(r.val, 31.0); // only 102 is plausible in z1
    assert.equal(r.rejected, true);
  });

  test('zone median is the median of all plausible zone ambients', () => {
    const r = resolveAmbient({ configuredId: 101, zoneId: 'z1', readings: { 101: 999, 102: 30, 105: 34 }, zoneOf: { ...zoneOf, 105: 'z1' } });
    assert.equal(r.source, 'zone_median');
    assert.equal(r.val, 32); // median(30, 34)
  });

  test('falls back to panel median when no plausible ambient in the joint zone', () => {
    // configured 103 (z2) faulty and 104 (z2) also faulty -> no z2 plausible -> panel median of z1 sensors
    const r = resolveAmbient({ configuredId: 103, zoneId: 'z2', readings: { 101: 30, 102: 34, 103: -99, 104: 500 }, zoneOf });
    assert.equal(r.source, 'panel_median');
    assert.equal(r.val, 32); // median(30, 34)
    assert.equal(r.rejected, true);
  });

  test('returns none when nothing is plausible', () => {
    const r = resolveAmbient({ configuredId: 101, zoneId: 'z1', readings: { 101: 999, 102: -999 }, zoneOf });
    assert.deepEqual(r, { val: null, source: 'none', rejected: true });
  });

  test('no configured ambient (null) still resolves via zone/panel median', () => {
    const r = resolveAmbient({ configuredId: null, zoneId: 'z1', readings: { 101: 30, 102: 32 }, zoneOf });
    assert.equal(r.source, 'zone_median');
    assert.equal(r.val, 31);
    assert.equal(r.rejected, false); // nothing configured -> nothing rejected
  });

  test('a healthy configured reading is preferred even if zone peers differ', () => {
    const r = resolveAmbient({ configuredId: 102, zoneId: 'z1', readings: { 101: 20, 102: 45, 105: 25 }, zoneOf: { ...zoneOf, 105: 'z1' } });
    assert.equal(r.source, 'configured');
    assert.equal(r.val, 45);
  });
});

describe('median', () => {
  test('odd and even length', () => {
    assert.equal(median([5, 1, 3]), 3);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(median([]), null);
  });
});
