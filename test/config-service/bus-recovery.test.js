'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { planRecovery, COOLDOWN_MS, FIRST_RESET_DELAY_MS } = require('../../src/config-service/bus-recovery');

const T0 = 1_700_000_000_000;
const BUS1_COMM = { instanceId: 'SYSTEM|MODULE|COMM_FAILURE' };
const BUS2_COMM = { instanceId: 'SYSTEM|BUS2|COMM_FAILURE' };
const PORTS = { bus2: '1-2' };

/** Run the ladder far enough to get the first power-cycle for a set of alarms. */
function toFirstReset(alarms, ports = PORTS) {
  const seen = planRecovery({ alarms, states: {}, nowMs: T0, ports });
  return planRecovery({ alarms, states: seen.states, nowMs: T0 + FIRST_RESET_DELAY_MS + 1, ports });
}

describe('bus-recovery — escalation ladder', () => {
  test('a fresh COMM alarm is noted, not acted on', () => {
    const r = planRecovery({ alarms: [BUS1_COMM], states: {}, nowMs: T0, ports: PORTS });
    assert.deepEqual(r.resets, []);
    assert.equal(r.states.bus1.firstSeen, T0);
  });

  test('nothing happens until the alarm has stood for 90s', () => {
    const first = planRecovery({ alarms: [BUS1_COMM], states: {}, nowMs: T0, ports: PORTS });
    const soon = planRecovery({ alarms: [BUS1_COMM], states: first.states, nowMs: T0 + 89_000, ports: PORTS });
    assert.deepEqual(soon.resets, []);
  });

  test('after 90s the bus is power-cycled and an INFO reset event is raised', () => {
    const r = toFirstReset([BUS1_COMM]);
    assert.deepEqual(r.resets, [{ busId: 'bus1', port: null }]);
    assert.equal(r.alarmEvents.length, 1);
    // bus1 keeps its original instanceId so its alarm history stays continuous
    assert.equal(r.alarmEvents[0].instanceId, 'SYSTEM|MODULE|RESET_1');
    assert.equal(r.alarmEvents[0].level, 'INFO');
  });

  test('a second attempt waits out the 60s cooldown', () => {
    const first = toFirstReset([BUS1_COMM]);
    const tooSoon = planRecovery({
      alarms: [BUS1_COMM], states: first.states, nowMs: T0 + FIRST_RESET_DELAY_MS + 30_000, ports: PORTS,
    });
    assert.deepEqual(tooSoon.resets, []);
    const later = planRecovery({
      alarms: [BUS1_COMM], states: first.states, nowMs: T0 + FIRST_RESET_DELAY_MS + COOLDOWN_MS + 1, ports: PORTS,
    });
    assert.deepEqual(later.resets, [{ busId: 'bus1', port: null }]);
    assert.equal(later.alarmEvents[0].instanceId, 'SYSTEM|MODULE|RESET_2');
  });

  test('after 3 attempts it stops cycling and emails once', () => {
    let states = { bus1: { firstSeen: T0, lastReset: T0, retries: 3, emailSent: false, warned: false } };
    const r = planRecovery({ alarms: [BUS1_COMM], states, nowMs: T0 + 10 * COOLDOWN_MS, ports: PORTS });
    assert.deepEqual(r.resets, [], 'no fourth power-cycle');
    assert.equal(r.emails.length, 1);
    assert.match(r.emails[0].subject, /USB Module Failure \(bus1\)/);

    const again = planRecovery({ alarms: [BUS1_COMM], states: r.states, nowMs: T0 + 20 * COOLDOWN_MS, ports: PORTS });
    assert.deepEqual(again.emails, [], 'email is sent once, not every tick');
  });

  test('the alarm clearing resets the ladder', () => {
    const first = toFirstReset([BUS1_COMM]);
    assert.equal(first.states.bus1.retries, 1);
    const cleared = planRecovery({ alarms: [], states: first.states, nowMs: T0 + 200_000, ports: PORTS });
    assert.equal(cleared.states.bus1.retries, 0);
    assert.equal(cleared.states.bus1.firstSeen, 0);
  });
});

describe('bus-recovery — the segments are independent', () => {
  test('a dead bus2 is cycled without touching bus1', () => {
    const r = toFirstReset([BUS2_COMM]);
    assert.deepEqual(r.resets, [{ busId: 'bus2', port: '1-2' }]);
    assert.equal(r.alarmEvents[0].instanceId, 'SYSTEM|BUS2|RESET_1');
  });

  test('both segments down cycles both, each on its own port', () => {
    const r = toFirstReset([BUS1_COMM, BUS2_COMM]);
    assert.deepEqual(r.resets, [
      { busId: 'bus1', port: null },
      { busId: 'bus2', port: '1-2' },
    ]);
    assert.equal(r.alarmEvents.length, 2);
  });

  test('bus1 exhausting its retries does not stop bus2 from being cycled', () => {
    const states = {
      bus1: { firstSeen: T0, lastReset: T0, retries: 3, emailSent: true, warned: false },
      bus2: { firstSeen: T0, lastReset: 0, retries: 0, emailSent: false, warned: false },
    };
    const r = planRecovery({
      alarms: [BUS1_COMM, BUS2_COMM], states, nowMs: T0 + FIRST_RESET_DELAY_MS + 1, ports: PORTS,
    });
    assert.deepEqual(r.resets, [{ busId: 'bus2', port: '1-2' }]);
  });
});

describe('bus-recovery — bus2 hub port', () => {
  test('with no port configured it warns once and never cycles', () => {
    const r = toFirstReset([BUS2_COMM], {});
    assert.deepEqual(r.resets, []);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /no hub port configured/);

    const again = planRecovery({
      alarms: [BUS2_COMM], states: r.states, nowMs: T0 + 10 * COOLDOWN_MS, ports: {},
    });
    assert.deepEqual(again.warnings, [], 'warned once per episode, not every tick');
  });

  test('a port that is not a uhubctl location is refused, not run', () => {
    const r = toFirstReset([BUS2_COMM], { bus2: '1-2; rm -rf /' });
    assert.deepEqual(r.resets, []);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /refusing to run it/);
  });

  test('a hub-chained location like 1-1.4 is accepted', () => {
    const r = toFirstReset([BUS2_COMM], { bus2: '1-1.4' });
    assert.deepEqual(r.resets, [{ busId: 'bus2', port: '1-1.4' }]);
  });
});
