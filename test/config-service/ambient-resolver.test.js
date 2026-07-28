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

// Slice 10 live fix (2026-07-28): a dead ambient sensor read a plausible 0 °C
// for minutes and raised false ΔT alarms. Readings now carry {val, age_sec,
// status}; a stale or faulted reading must be rejected even when in-band.
describe('resolveAmbient — staleness + status (live 2026-07-28 regression)', () => {
  test('a stale-but-in-band configured reading (0 °C, old) is rejected -> none when it is the only ambient', () => {
    const r = resolveAmbient({
      configuredId: 101, zoneId: 'z1',
      readings: { 101: { val: 0, age_sec: 166, status: 'OK' } },
      zoneOf: { 101: 'z1' }, maxAgeSec: 60,
    });
    assert.deepEqual(r, { val: null, source: 'none', rejected: true });
  });

  test('a faulted (non-OK status) configured reading is rejected even if fresh and in-band', () => {
    const r = resolveAmbient({
      configuredId: 101, zoneId: 'z1',
      readings: { 101: { val: 0, age_sec: 1, status: 'Communication_Error' } },
      zoneOf: { 101: 'z1' }, maxAgeSec: 60,
    });
    assert.equal(r.source, 'none');
    assert.equal(r.rejected, true);
  });

  test('a dead configured ambient falls back to a healthy zone peer', () => {
    const r = resolveAmbient({
      configuredId: 101, zoneId: 'z1',
      readings: {
        101: { val: 0, age_sec: 200, status: 'OK' },        // stale -> unusable
        102: { val: 30.5, age_sec: 1, status: 'OK' },        // healthy peer
      },
      zoneOf: { 101: 'z1', 102: 'z1' }, maxAgeSec: 60,
    });
    assert.equal(r.source, 'zone_median');
    assert.equal(r.val, 30.5);
    assert.equal(r.rejected, true);
  });

  test('a fresh, healthy object reading is used as configured', () => {
    const r = resolveAmbient({
      configuredId: 101, zoneId: 'z1',
      readings: { 101: { val: 31.2, age_sec: 2, status: 'OK' } },
      zoneOf: { 101: 'z1' }, maxAgeSec: 60,
    });
    assert.deepEqual(r, { val: 31.2, source: 'configured', ambient_id: 101, rejected: false });
  });

  test('with maxAgeSec null (default), age is ignored — plain-number back-compat', () => {
    const r = resolveAmbient({ configuredId: 101, zoneId: 'z1', readings: { 101: { val: 30, age_sec: 9999, status: 'OK' } }, zoneOf: { 101: 'z1' } });
    assert.equal(r.source, 'configured');
  });

  // The decisive live case (2026-07-28): the disconnected transmitter kept
  // answering with a FRESH, in-band, status-OK 0.0 degC for ~20 min.
  test('a fresh, status-OK, in-band 0 degC (Modbus no-data sentinel) is rejected', () => {
    const r = resolveAmbient({
      configuredId: 101, zoneId: 'z1',
      readings: { 101: { val: 0, age_sec: 2, status: 'OK' } },
      zoneOf: { 101: 'z1' }, maxAgeSec: 60,
    });
    assert.deepEqual(r, { val: null, source: 'none', rejected: true }, 'ΔT must not be computed against a fabricated 0');
  });

  test('a sentinel 0 configured ambient falls back to a healthy peer', () => {
    const r = resolveAmbient({
      configuredId: 101, zoneId: 'z1',
      readings: { 101: { val: 0, age_sec: 2, status: 'OK' }, 102: { val: 31, age_sec: 1, status: 'OK' } },
      zoneOf: { 101: 'z1', 102: 'z1' }, maxAgeSec: 60,
    });
    assert.equal(r.source, 'zone_median');
    assert.equal(r.val, 31);
  });

  test('a real reading just above the zero epsilon is still used', () => {
    const r = resolveAmbient({ configuredId: 101, zoneId: 'z1', readings: { 101: { val: 0.2, age_sec: 1, status: 'OK' } }, zoneOf: { 101: 'z1' }, maxAgeSec: 60 });
    assert.equal(r.source, 'configured');
  });

  test('zeroEps:null lets a genuine 0 through (cold-site opt-out)', () => {
    const r = resolveAmbient({ configuredId: 101, zoneId: 'z1', readings: { 101: { val: 0, age_sec: 1, status: 'OK' } }, zoneOf: { 101: 'z1' }, maxAgeSec: 60, zeroEps: null });
    assert.equal(r.source, 'configured');
    assert.equal(r.val, 0);
  });
});

describe('isUsable', () => {
  const { isUsable, DEFAULT_BAND } = require('../../src/config-service/ambient-resolver');
  test('bare number in band is usable; out of band is not', () => {
    assert.equal(isUsable(30, DEFAULT_BAND, null), true);
    assert.equal(isUsable(250, DEFAULT_BAND, null), false);
  });
  test('object reading: stale or faulted is unusable', () => {
    assert.equal(isUsable({ val: 30, age_sec: 5, status: 'OK' }, DEFAULT_BAND, 60), true);
    assert.equal(isUsable({ val: 30, age_sec: 120, status: 'OK' }, DEFAULT_BAND, 60), false);
    assert.equal(isUsable({ val: 30, age_sec: 5, status: 'Sensor_Error' }, DEFAULT_BAND, 60), false);
  });
});
