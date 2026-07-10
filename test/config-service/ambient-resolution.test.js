'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { resolveAmbientChain, mode } = require('../../src/config-service/ambient-resolution');

describe('mode', () => {
  test('returns the most frequent value', () => {
    assert.equal(mode([1, 2, 2, 3, 2]), 2);
  });

  test('returns the only value for a uniform list', () => {
    assert.equal(mode([101, 101, 101]), 101);
  });
});

describe('resolveAmbientChain', () => {
  const legacyIdToNewSlaveId = new Map([
    [1, 'sl01'],
    [5, 'sl05'],
    [101, 'sl21'],
  ]);

  test('resolves a single panel-wide default when every joint agrees', () => {
    const joints = [
      { joint_id: 'J01', zone_id: 'z1', legacyAmbientId: 101 },
      { joint_id: 'J02', zone_id: 'z2', legacyAmbientId: 101 },
    ];
    const zones = [{ zone_id: 'z1' }, { zone_id: 'z2' }];
    const { panelDefaultSlaveId, zoneOverrides, jointOverrides } = resolveAmbientChain(joints, zones, legacyIdToNewSlaveId);
    assert.equal(panelDefaultSlaveId, 'sl21');
    assert.equal(zoneOverrides.size, 0);
    assert.equal(jointOverrides.size, 0);
  });

  test('gives a zone-level override when every joint in a zone shares a different id', () => {
    const joints = [
      { joint_id: 'J01', zone_id: 'z1', legacyAmbientId: 101 },
      { joint_id: 'J02', zone_id: 'z1', legacyAmbientId: 101 },
      { joint_id: 'J03', zone_id: 'z2', legacyAmbientId: 5 },
      { joint_id: 'J04', zone_id: 'z2', legacyAmbientId: 5 },
    ];
    const zones = [{ zone_id: 'z1' }, { zone_id: 'z2' }];
    const { panelDefaultSlaveId, zoneOverrides, jointOverrides } = resolveAmbientChain(joints, zones, legacyIdToNewSlaveId);
    assert.equal(panelDefaultSlaveId, 'sl21');
    assert.equal(zoneOverrides.get('z2'), 'sl05');
    assert.equal(jointOverrides.size, 0);
  });

  test('gives a joint-level override for a lone outlier in an otherwise-uniform zone', () => {
    const joints = [
      { joint_id: 'J01', zone_id: 'z1', legacyAmbientId: 5 },
      { joint_id: 'J02', zone_id: 'z1', legacyAmbientId: 101 },
      { joint_id: 'J03', zone_id: 'z1', legacyAmbientId: 101 },
    ];
    const zones = [{ zone_id: 'z1' }];
    const { zoneOverrides, jointOverrides } = resolveAmbientChain(joints, zones, legacyIdToNewSlaveId);
    assert.equal(zoneOverrides.size, 0);
    assert.equal(jointOverrides.get('J01'), 'sl05');
    assert.equal(jointOverrides.size, 1);
  });

  test('never overrides for an id that does not map to a known slave', () => {
    const joints = [
      { joint_id: 'J01', zone_id: 'z1', legacyAmbientId: 999 },
      { joint_id: 'J02', zone_id: 'z1', legacyAmbientId: 101 },
      { joint_id: 'J03', zone_id: 'z1', legacyAmbientId: 101 },
    ];
    const zones = [{ zone_id: 'z1' }];
    const { jointOverrides } = resolveAmbientChain(joints, zones, legacyIdToNewSlaveId);
    assert.equal(jointOverrides.has('J01'), false);
  });
});
