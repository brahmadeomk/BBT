'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildRegisterMap } = require('../../src/integration/register-map');
const { decodeAck, ACK_ALL, ACK_JOINT_BASE } = require('../../src/integration/ack');
const { validIntegrationDoc, jointsDocTwoZones } = require('./fixtures');

const map = buildRegisterMap(validIntegrationDoc({ exposure_tier: 3 }), jointsDocTwoZones());

describe('ack — decode BMS writes to the control register', () => {
  test('value 1 is a summary ACK (all active)', () => {
    assert.deepEqual(decodeAck(map, map.control.ack, ACK_ALL), { scope: 'all', source: 'bms' });
  });

  test('value 1000+index acks a specific joint', () => {
    const r = decodeAck(map, map.control.ack, ACK_JOINT_BASE + 2);
    assert.equal(r.scope, 'joint');
    assert.equal(r.joint_id, 'J03', 'Tier-3 index 2');
  });

  test('an out-of-range joint index reports the error but stays scoped', () => {
    const r = decodeAck(map, map.control.ack, ACK_JOINT_BASE + 99);
    assert.equal(r.scope, 'joint');
    assert.equal(r.joint_id, null);
    assert.match(r.error, /index 99/);
  });

  test('value 0 (idle/reset) and unknown small values are no-ops', () => {
    assert.equal(decodeAck(map, map.control.ack, 0), null);
    assert.equal(decodeAck(map, map.control.ack, 5), null);
  });

  test('a write to any other register is ignored', () => {
    assert.equal(decodeAck(map, 8, ACK_ALL), null);
  });
});
