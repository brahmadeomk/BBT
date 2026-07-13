'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AlarmPublisher } = require('../../src/cloud-gateway/alarm-publisher');
const { Outbox } = require('../../src/cloud-gateway/outbox');
const { LoopbackTransport } = require('../../src/cloud-gateway/transport');

function freshOutbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-alarmpub-test-'));
  return new Outbox({ dir, transport: new LoopbackTransport() });
}

function alarm(overrides = {}) {
  return {
    instanceId: 'PROCESS|J01|DELTA_T|WARNING',
    category: 'PROCESS',
    joint_id: 'J01',
    zone_id: 'z1',
    zone_name: 'Zone1',
    alarm_type: 'DELTA_T',
    level: 'WARNING',
    status: 'ACTIVE_NACK',
    raisedTs: '2026-07-10T10:00:00.000Z',
    description: 'ΔT 29.48 ≥ 25',
    value: 29.48,
    threshold: 25,
    persistence_min: 15,
    ...overrides,
  };
}

describe('AlarmPublisher - RAISE (state transition, no repeats)', () => {
  test('publishes a RAISE for a newly active alarm', () => {
    const outbox = freshOutbox();
    const publisher = new AlarmPublisher({ outbox, topic: 'dt/alarm' });

    publisher.ingestActiveAlarms([alarm()]);

    assert.equal(outbox.counts().alarm, 1);
    const event = outbox.queues.alarm[0].payload;
    assert.equal(event.action, 'RAISE');
    assert.equal(event.joint_id, 'J01');
    assert.equal(event.level, 'WARNING');
    assert.equal(event.kpi, 'delta_t');
    assert.equal(event.value, 29.48);
    assert.equal(event.threshold, 25);
    assert.equal(event.persistence_min, 15);
  });

  test('does not re-publish an alarm that is still active and unchanged', () => {
    const outbox = freshOutbox();
    const publisher = new AlarmPublisher({ outbox, topic: 'dt/alarm' });

    publisher.ingestActiveAlarms([alarm()]);
    publisher.ingestActiveAlarms([alarm()]); // fires again e.g. because a different alarm also changed
    publisher.ingestActiveAlarms([alarm(), alarm({ instanceId: 'PROCESS|J02|ROR|WATCH', joint_id: 'J02', alarm_type: 'ROR' })]);

    assert.equal(outbox.counts().alarm, 2); // J01 raised once, J02 raised once - not 3 or 4
  });

  test('maps ROR alarm_type to kpi "rate_of_rise"', () => {
    const outbox = freshOutbox();
    const publisher = new AlarmPublisher({ outbox, topic: 'dt/alarm' });
    publisher.ingestActiveAlarms([alarm({ alarm_type: 'ROR' })]);
    assert.equal(outbox.queues.alarm[0].payload.kpi, 'rate_of_rise');
  });

  test('enqueues with QoS 1 (must not be lost)', () => {
    const outbox = freshOutbox();
    const publisher = new AlarmPublisher({ outbox, topic: 'dt/alarm' });
    publisher.ingestActiveAlarms([alarm()]);
    assert.equal(outbox.queues.alarm[0].qos, 1);
  });
});

describe('AlarmPublisher - CLEAR', () => {
  test('publishes a CLEAR for a cleared alarm', () => {
    const outbox = freshOutbox();
    const publisher = new AlarmPublisher({ outbox, topic: 'dt/alarm' });

    publisher.ingestActiveAlarms([alarm()]);
    publisher.ingestClearedAlarms([alarm({ status: 'CLEARED', clearedTs: '2026-07-10T11:00:00.000Z' })]);

    const events = outbox.queues.alarm.map((item) => item.payload);
    assert.equal(events.length, 2);
    assert.equal(events[1].action, 'CLEAR');
    assert.equal(events[1].timestamp, '2026-07-10T11:00:00.000Z');
  });

  test('a cleared-then-reraised alarm is treated as a new RAISE', () => {
    const outbox = freshOutbox();
    const publisher = new AlarmPublisher({ outbox, topic: 'dt/alarm' });

    publisher.ingestActiveAlarms([alarm()]);
    publisher.ingestClearedAlarms([alarm({ status: 'CLEARED' })]);
    publisher.ingestActiveAlarms([alarm()]); // same instanceId, raised again

    const actions = outbox.queues.alarm.map((item) => item.payload.action);
    assert.deepEqual(actions, ['RAISE', 'CLEAR', 'RAISE']);
  });
});

describe('AlarmPublisher - structured value/threshold/persistence_min', () => {
  test('promotes value/threshold/persistence_min to the top-level event for a PROCESS alarm', () => {
    const outbox = freshOutbox();
    const publisher = new AlarmPublisher({ outbox, topic: 'dt/alarm' });
    publisher.ingestActiveAlarms([alarm({ value: 29.48, threshold: 25, persistence_min: 15 })]);
    const event = outbox.queues.alarm[0].payload;
    assert.equal(event.value, 29.48);
    assert.equal(event.threshold, 25);
    assert.equal(event.persistence_min, 15);
    // the full alarm (including description) is still passed through for context
    assert.equal(event.alarm.description, 'ΔT 29.48 ≥ 25');
  });

  test('does not fabricate value/threshold/persistence_min for a SYSTEM alarm that has none', () => {
    const outbox = freshOutbox();
    const publisher = new AlarmPublisher({ outbox, topic: 'dt/alarm' });
    publisher.ingestActiveAlarms([
      alarm({
        instanceId: 'SYSTEM|MODULE|COMM_FAILURE',
        category: 'SYSTEM',
        alarm_type: 'COMM_MODULE',
        description: 'No data received from communication module for 60 seconds',
        value: undefined,
        threshold: undefined,
        persistence_min: undefined,
      }),
    ]);
    const event = outbox.queues.alarm[0].payload;
    assert.equal(event.value, undefined);
    assert.equal(event.threshold, undefined);
    assert.equal(event.persistence_min, undefined);
  });
});
