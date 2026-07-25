'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildRegisterMap, mapExtent, constants } = require('../../src/integration/register-map');
const { validIntegrationDoc, jointsDocTwoZones } = require('./fixtures');

describe('register-map — tiers + fixed layout', () => {
  test('Tier 1 summary block occupies the fixed base with 12 points', () => {
    const m = buildRegisterMap(validIntegrationDoc({ exposure_tier: 1 }), jointsDocTwoZones());
    assert.equal(m.tier1.base, 0);
    assert.equal(m.tier1.points.length, 12);
    assert.equal(m.tier1.points.find((p) => p.key === 'heartbeat').addr, 0);
    assert.equal(m.tier1.points.find((p) => p.key === 'worst_joint_index').addr, 7);
    assert.equal(m.control.ack, constants.ACK_ADDR);
    assert.equal(m.tier2, null, 'tier 1 exposes no per-zone block');
    assert.equal(m.tier3, null);
  });

  test('Tier 2 adds a per-zone block per zone, fixed stride', () => {
    const m = buildRegisterMap(validIntegrationDoc({ exposure_tier: 2 }), jointsDocTwoZones());
    assert.equal(m.tier2.zones.length, 2);
    assert.equal(m.tier2.zones[0].zone_id, 'Z1');
    assert.equal(m.tier2.zones[0].base, constants.TIER2_BASE);
    assert.equal(m.tier2.zones[1].base, constants.TIER2_BASE + constants.TIER2_STRIDE);
    assert.equal(m.tier3, null);
  });

  test('Tier 3 adds a per-joint block per joint, in cfg/joints order', () => {
    const m = buildRegisterMap(validIntegrationDoc({ exposure_tier: 3 }), jointsDocTwoZones());
    assert.equal(m.tier3.joints.length, 3);
    assert.deepEqual(m.tier3.joints.map((j) => j.joint_id), ['J01', 'J02', 'J03']);
    assert.equal(m.tier3.joints[0].base, constants.TIER3_BASE);
    assert.equal(m.tier3.joints[2].base, constants.TIER3_BASE + 2 * constants.TIER3_STRIDE);
    const tempPoint = m.tier3.joints[0].points.find((p) => p.key === 'temp');
    assert.equal(tempPoint.scale, 10, 'temperature is x10 scaled');
  });

  test('append-only: adding a joint does not move existing joint/zone bases', () => {
    const before = buildRegisterMap(validIntegrationDoc(), jointsDocTwoZones());
    const doc = jointsDocTwoZones();
    doc.joints.push({ joint_id: 'J04', slave_id: 'sl02', channel: 1, zone_id: 'Z2', enabled: true, threshold_profile: 'default' });
    const after = buildRegisterMap(validIntegrationDoc(), doc);
    for (const jid of ['J01', 'J02', 'J03']) {
      const b = before.tier3.joints.find((j) => j.joint_id === jid).base;
      const a = after.tier3.joints.find((j) => j.joint_id === jid).base;
      assert.equal(a, b, `${jid} base unchanged`);
    }
    assert.equal(after.tier3.joints.find((j) => j.joint_id === 'J04').base, constants.TIER3_BASE + 3 * constants.TIER3_STRIDE, 'new joint appended after existing ones');
  });

  test('severity bitmap packs 8 joints per register (2 bits each)', () => {
    const m = buildRegisterMap(validIntegrationDoc({ severity_bitmap: { enabled: true } }), jointsDocTwoZones());
    assert.equal(m.bitmap.registers, 1);
    assert.equal(m.bitmap.joints[0].register, constants.BITMAP_BASE);
    assert.equal(m.bitmap.joints[0].shift, 0);
    assert.equal(m.bitmap.joints[1].shift, 2);
  });

  test('mapExtent returns a number for a buildable map', () => {
    const e = mapExtent(validIntegrationDoc(), jointsDocTwoZones());
    assert.equal(typeof e, 'number');
    assert.ok(e >= constants.TIER3_BASE);
  });

  test('too many zones for the fixed Tier-2 region is an error', () => {
    const doc = jointsDocTwoZones();
    doc.zones = [];
    for (let i = 0; i < 60; i++) doc.zones.push({ zone_id: `Z${i}`, name: `z${i}` });
    doc.joints = doc.joints.map((j, i) => ({ ...j, zone_id: `Z${i}` }));
    const m = buildRegisterMap(validIntegrationDoc({ exposure_tier: 2 }), doc);
    assert.match(m.error, /zone/i);
  });
});
