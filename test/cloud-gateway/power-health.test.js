'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { derivePowerAlarm, summarizePower, initialState, POWER_KEY } = require('../../src/cloud-gateway/power-health');

const lv = (o) => ({ low_voltage: { now: false, since_boot: false, throttled_now: false, throttled_since_boot: false, raw: '0x0', ...o } });

describe('derivePowerAlarm — raise/clear', () => {
  test('raises CRITICAL immediately on the first under-voltage sample', () => {
    const r = derivePowerAlarm(lv({ now: true, raw: '0x50005' }), initialState());
    assert.equal(r.alarm.action, 'raise');
    assert.equal(r.alarm.level, 'CRITICAL');
    assert.equal(r.alarm.key, POWER_KEY);
    assert.match(r.alarm.description, /UNDER-VOLTAGE/);
    assert.match(r.alarm.description, /0x50005/, 'raw flags help diagnosis');
    assert.equal(r.state.active, true);
  });

  test('throttling without under-voltage is only WARNING (may be thermal)', () => {
    const r = derivePowerAlarm(lv({ throttled_now: true }), initialState());
    assert.equal(r.alarm.level, 'WARNING');
    assert.match(r.alarm.description, /THROTTLED/);
  });

  test('does not re-raise while the same condition persists', () => {
    let s = derivePowerAlarm(lv({ now: true }), initialState()).state;
    const again = derivePowerAlarm(lv({ now: true }), s);
    assert.equal(again.alarm, null, 'one alarm, not one per sample');
    assert.equal(again.state.active, true);
  });

  test('escalating throttled -> under-voltage re-raises at the higher level', () => {
    const s = derivePowerAlarm(lv({ throttled_now: true }), initialState()).state;
    const esc = derivePowerAlarm(lv({ now: true, throttled_now: true }), s);
    assert.equal(esc.alarm.action, 'raise');
    assert.equal(esc.alarm.level, 'CRITICAL');
  });

  test('clears only after the configured run of good samples', () => {
    let s = derivePowerAlarm(lv({ now: true }), initialState()).state;
    let r = derivePowerAlarm(lv(), s); s = r.state;
    assert.equal(r.alarm, null, 'one good sample is not enough');
    r = derivePowerAlarm(lv(), s); s = r.state;
    assert.equal(r.alarm, null);
    r = derivePowerAlarm(lv(), s);
    assert.equal(r.alarm.action, 'clear');
    assert.equal(r.state.active, false);
  });

  test('a flapping supply does not clear (good streak resets on each bad sample)', () => {
    let s = derivePowerAlarm(lv({ now: true }), initialState()).state;
    for (let i = 0; i < 5; i++) {
      s = derivePowerAlarm(lv(), s).state;            // good
      const bad = derivePowerAlarm(lv({ now: true }), s); // bad again
      s = bad.state;
      assert.equal(bad.alarm, null, 'still the same active alarm');
      assert.equal(s.active, true, 'never cleared while flapping');
    }
  });

  test('no alarm is emitted when nothing was ever wrong', () => {
    const r = derivePowerAlarm(lv(), initialState());
    assert.equal(r.alarm, null);
    assert.equal(r.state.active, false);
  });
});

describe('derivePowerAlarm — non-Pi / probe unavailable', () => {
  test('a missing low_voltage probe asserts nothing (never a fabricated "healthy")', () => {
    for (const h of [null, undefined, {}, { low_voltage: null }]) {
      const r = derivePowerAlarm(h, initialState());
      assert.equal(r.alarm, null);
      assert.equal(r.state.supported, false);
      assert.equal(r.status.ok, null, 'unknown, not OK');
    }
  });
});

describe('summarizePower — HMI tile', () => {
  test('reports OK when all flags are clear', () => {
    const v = summarizePower(lv());
    assert.equal(v.ok, true);
    assert.equal(v.text, 'power: OK');
  });

  test('surfaces the since-boot bits — an intermittent fault that already recovered', () => {
    const v = summarizePower(lv({ since_boot: true, throttled_since_boot: true }));
    assert.equal(v.ok, true, 'not currently failing');
    assert.match(v.text, /under-voltage since boot/);
    assert.equal(v.under_voltage_since_boot, true);
  });

  test('names the live condition', () => {
    const v = summarizePower(lv({ now: true, throttled_now: true }));
    assert.equal(v.ok, false);
    assert.match(v.text, /UNDER-VOLTAGE NOW/);
    assert.match(v.text, /THROTTLED NOW/);
  });

  test('unsupported probe reads unknown', () => {
    assert.deepEqual(summarizePower(null), { supported: false, ok: null, text: 'power: unknown (no vcgencmd)' });
  });
});
