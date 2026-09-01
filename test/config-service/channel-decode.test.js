'use strict';

/**
 * Recovering the channel from a Nano read frame.
 *
 * The node upstream of ProcessLogic was `validateValue(msg.payload.val / 100)`
 * and `val` is an ARRAY: [2543]/100 coerces via toString to 25.43 and worked by
 * accident, but [2543,2601]/100 is NaN, which became 0 - so a multi-channel
 * slave read 0 degC and presented as a COLD JOINT rather than a fault.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { decodeFrame, decodeFirstChannel, LEGACY_SCALE } = require('../../src/config-service/channel-decode');

const slave = (over = {}) => ({
  slave_id: 'sl01', bus_id: 'bus1', unit_address: 3, channels: 1,
  registers: { function_code: 3, temp_base_addr: 100, temp_scale: 0.01 },
  ...over,
});
const doc = (slaves) => ({ modbus: { buses: [{ bus_id: 'bus1' }], slaves }, joints: [] });
const frame = (over = {}) => ({ t: 'r', id: 3, sa: 100, len: 1, val: [2543], st: 'ok', ...over });

describe('the bug: an array coerced through toString', () => {
  test('the old expression really did yield 0 for two or more channels', () => {
    // Pinned so nobody reintroduces it as a "simplification".
    const old = (v) => (isNaN(v / 100) ? 0 : v / 100);
    assert.equal(old([2543]), 25.43, 'single channel worked by accident');
    assert.equal(old([2543, 2601]), 0, 'two channels became a plausible zero');
  });

  test('a 4-channel slave now decodes all four values', () => {
    const s = slave({ channels: 4, registers: { function_code: 3, temp_base_addr: 100, temp_scale: 0.01 } });
    const { readings } = decodeFrame(frame({ len: 4, val: [2543, 2601, 2488, 2550] }), doc([s]));
    assert.deepEqual(readings.map((r) => r.channel), [1, 2, 3, 4]);
    assert.deepEqual(readings.map((r) => r.val), [25.43, 26.01, 24.88, 25.5]);
  });
});

describe('channel indexing - both layouts invert readSpan', () => {
  test('consecutive channels are word_count apart from the base', () => {
    const s = slave({ channels: 3 });
    const { readings } = decodeFrame(frame({ len: 3, val: [100, 200, 300] }), doc([s]));
    assert.deepEqual(readings.map((r) => r.val), [1, 2, 3]);
  });

  test('sparse channel_addrs index by address offset, not by position', () => {
    // The whole point of channel_addrs: a module whose channels are not
    // consecutive. Reading positionally would attribute the wrong register.
    const s = slave({
      channels: 3,
      registers: { function_code: 3, temp_base_addr: 100, temp_scale: 0.01, channel_addrs: [100, 104, 108] },
    });
    const val = [2500, 0, 0, 0, 2600, 0, 0, 0, 2700];
    const { readings } = decodeFrame(frame({ len: 9, val }), doc([s]));
    assert.deepEqual(readings.map((r) => r.val), [25, 26, 27]);
  });

  test('two-word channels combine big-endian, matching the Modbus wire order', () => {
    const s = slave({
      channels: 2,
      registers: { function_code: 3, temp_base_addr: 100, temp_scale: 0.01, temp_word_count: 2 },
    });
    const { readings } = decodeFrame(frame({ len: 4, val: [0, 2543, 0, 2601] }), doc([s]));
    assert.deepEqual(readings.map((r) => r.val), [25.43, 26.01]);
  });
});

describe('scale comes from the slave, not a hardcoded divisor', () => {
  test('temp_scale 0.1 is honoured', () => {
    const s = slave({ registers: { function_code: 3, temp_base_addr: 100, temp_scale: 0.1 } });
    assert.equal(decodeFrame(frame({ val: [254] }), doc([s])).readings[0].val, 25.4);
  });

  test('temp_scale 1 is honoured - a module reporting whole degrees', () => {
    const s = slave({ registers: { function_code: 3, temp_base_addr: 100, temp_scale: 1 } });
    assert.equal(decodeFrame(frame({ val: [25] }), doc([s])).readings[0].val, 25);
  });

  test('temp_offset is applied after scaling', () => {
    const s = slave({ registers: { function_code: 3, temp_base_addr: 100, temp_scale: 0.01, temp_offset: -1.5 } });
    assert.equal(decodeFrame(frame(), doc([s])).readings[0].val, 23.93);
  });
});

describe('a frame that disagrees with the configuration', () => {
  test('warns that the Nano is running a stale job', () => {
    // The window between a config apply and the resend landing. Decoding it
    // against the NEW config would silently mis-attribute values.
    const s = slave({ channels: 2 });
    const { warnings } = decodeFrame(frame({ sa: 100, len: 1, val: [2543] }), doc([s]));
    assert.match(warnings[0], /stale job/);
    assert.match(warnings[0], /expects sa=100 len=2/);
  });

  test('a short frame yields null for the missing channel, never a stale value', () => {
    const s = slave({ channels: 2 });
    const { readings } = decodeFrame(frame({ len: 2, val: [2543] }), doc([s]));
    assert.equal(readings[0].val, 25.43);
    assert.equal(readings[1].val, null, 'absent, not zero and not the previous channel');
  });
});

describe('fail-safe behaviour', () => {
  test('an uncommissioned unit still yields a reading on the legacy scale', () => {
    // A monitoring panel must not go blind because the config has not converged.
    const { readings, warnings } = decodeFrame(frame({ id: 99 }), doc([slave()]));
    assert.equal(readings[0].val, 2543 * LEGACY_SCALE);
    assert.equal(readings[0].scale_source, 'legacy');
    assert.match(warnings[0], /not in the applied configuration/);
  });

  test('an error frame carries its status through rather than a value', () => {
    const { readings } = decodeFrame(frame({ st: 'err', val: [] }), doc([slave()]));
    assert.equal(readings[0].st, 'err');
    assert.equal(readings[0].val, null);
  });

  test('a non-read frame is ignored, not misdecoded', () => {
    for (const f of [{ t: 'w', id: 3 }, { t: 'x', id: 3 }, null, {}]) {
      assert.deepEqual(decodeFrame(f, doc([slave()])).readings, []);
    }
  });

  test('a missing document falls back rather than throwing', () => {
    assert.doesNotThrow(() => decodeFrame(frame(), null));
    assert.equal(decodeFrame(frame(), null).readings[0].scale_source, 'legacy');
  });
});

describe('decodeFirstChannel - what the flow uses until fan-out lands', () => {
  test('single-channel behaviour is unchanged from the old line', () => {
    const r = decodeFirstChannel(frame(), doc([slave()]));
    assert.equal(r.reading.val, 25.43);
    assert.equal(r.channels, 1);
  });

  test('reports the channel count so the flow can say only ch1 is used', () => {
    const s = slave({ channels: 4 });
    const r = decodeFirstChannel(frame({ len: 4, val: [2543, 2601, 2488, 2550] }), doc([s]));
    assert.equal(r.reading.val, 25.43);
    assert.equal(r.channels, 4, 'the other three are decoded but not yet delivered');
  });
});
