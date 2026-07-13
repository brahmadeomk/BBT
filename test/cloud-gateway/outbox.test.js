'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { Outbox } = require('../../src/cloud-gateway/outbox');
const { LoopbackTransport } = require('../../src/cloud-gateway/transport');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-outbox-test-'));
}

describe('Outbox - basic enqueue/drain', () => {
  test('enqueues and drains a telemetry message', async () => {
    const transport = new LoopbackTransport();
    const outbox = new Outbox({ dir: tmpDir(), transport });
    outbox.enqueue('telemetry', 'dt/tel', { t_max: 42 }, 0);
    assert.deepEqual(outbox.counts(), { alarm: 0, telemetry: 1 });

    const published = await outbox.drain();
    assert.equal(published, 1);
    assert.deepEqual(outbox.counts(), { alarm: 0, telemetry: 0 });
    assert.equal(transport.published.length, 1);
    assert.deepEqual(transport.published[0].payload, { t_max: 42 });
  });

  test('drains alarms before telemetry', async () => {
    const transport = new LoopbackTransport();
    const outbox = new Outbox({ dir: tmpDir(), transport });
    outbox.enqueue('telemetry', 'dt/tel', { a: 1 }, 0);
    outbox.enqueue('alarm', 'dt/alarm', { b: 2 }, 1);

    await outbox.drain(1); // only budget for one message
    assert.equal(transport.published.length, 1);
    assert.equal(transport.published[0].topic, 'dt/alarm');
    assert.deepEqual(outbox.counts(), { alarm: 0, telemetry: 1 });
  });

  test('drain respects the message budget', async () => {
    const transport = new LoopbackTransport();
    const outbox = new Outbox({ dir: tmpDir(), transport });
    for (let i = 0; i < 10; i++) outbox.enqueue('telemetry', 'dt/tel', { i }, 0);

    const published = await outbox.drain(5);
    assert.equal(published, 5);
    assert.equal(outbox.counts().telemetry, 5);
  });
});

describe('Outbox - link loss / recovery', () => {
  test('does not drain while disconnected, and does not lose messages', async () => {
    const transport = new LoopbackTransport();
    const outbox = new Outbox({ dir: tmpDir(), transport });
    outbox.enqueue('telemetry', 'dt/tel', { i: 1 }, 0);
    transport.setConnected(false);

    const published = await outbox.drain();
    assert.equal(published, 0);
    assert.equal(outbox.counts().telemetry, 1);
  });

  test('resumes draining once reconnected', async () => {
    const transport = new LoopbackTransport();
    const outbox = new Outbox({ dir: tmpDir(), transport });
    transport.setConnected(false);
    for (let i = 0; i < 3; i++) outbox.enqueue('telemetry', 'dt/tel', { i }, 0);

    assert.equal(await outbox.drain(), 0);
    transport.setConnected(true);
    assert.equal(await outbox.drain(), 3);
    assert.equal(outbox.counts().telemetry, 0);
  });

  test('a queue built up over a simulated 24h link loss drains cleanly at the controlled rate', async () => {
    const transport = new LoopbackTransport();
    const outbox = new Outbox({ dir: tmpDir(), transport, drainRateMsgsPerSec: 5 });
    transport.setConnected(false);

    // 24h of telemetry at 10 min intervals = 144 messages
    for (let i = 0; i < 144; i++) outbox.enqueue('telemetry', 'dt/tel', { interval: i }, 0);
    assert.equal(outbox.counts().telemetry, 144);

    transport.setConnected(true);
    let totalDrained = 0;
    let ticks = 0;
    while (outbox.counts().telemetry > 0 && ticks < 100) {
      totalDrained += await outbox.drain(); // one "second" of drain budget per tick
      ticks++;
    }
    assert.equal(totalDrained, 144);
    assert.equal(ticks, Math.ceil(144 / 5));
    // messages arrive in original order - oldest interval first
    assert.equal(transport.published[0].payload.interval, 0);
    assert.equal(transport.published[143].payload.interval, 143);
  });
});

/** Measures one real enqueued item's size from the outbox itself, rather than hand-estimating JSON size (fragile - id/timestamp lengths vary). */
function measureItemBytes(cls, topic, qos) {
  const probe = new Outbox({ dir: tmpDir(), transport: new LoopbackTransport(), maxSizeBytes: Number.MAX_SAFE_INTEGER });
  probe.enqueue(cls, topic, { v: 1 }, qos);
  return probe.totalSizeBytes();
}

describe('Outbox - overflow policy', () => {
  test('telemetry drops oldest when the size cap is exceeded', () => {
    const transport = new LoopbackTransport();
    const itemBytes = measureItemBytes('telemetry', 'dt/tel', 0);
    const outbox = new Outbox({ dir: tmpDir(), transport, maxSizeBytes: itemBytes * 3 });

    for (let i = 0; i < 5; i++) outbox.enqueue('telemetry', 'dt/tel', { v: i }, 0);

    assert.ok(outbox.counts().telemetry <= 3);
    // the oldest entries (v:0, v:1) should have been dropped, not the newest
    const remainingValues = outbox.queues.telemetry.map((item) => item.payload.v);
    assert.ok(!remainingValues.includes(0));
    assert.ok(remainingValues.includes(4));
  });

  test('alarms are never dropped, even over the size cap', () => {
    const transport = new LoopbackTransport();
    const itemBytes = measureItemBytes('alarm', 'dt/alarm', 1);
    const outbox = new Outbox({ dir: tmpDir(), transport, maxSizeBytes: itemBytes * 2 });

    for (let i = 0; i < 10; i++) outbox.enqueue('alarm', 'dt/alarm', { v: i }, 1);

    assert.equal(outbox.counts().alarm, 10); // none dropped
  });

  test('an alarm evicts telemetry to make room instead of being dropped itself', () => {
    const transport = new LoopbackTransport();
    const itemBytes = measureItemBytes('telemetry', 'dt/tel', 0);
    const outbox = new Outbox({ dir: tmpDir(), transport, maxSizeBytes: itemBytes * 2 });

    outbox.enqueue('telemetry', 'dt/tel', { v: 1 }, 0);
    outbox.enqueue('telemetry', 'dt/tel', { v: 2 }, 0);
    assert.equal(outbox.counts().telemetry, 2);

    outbox.enqueue('alarm', 'dt/alarm', { v: 3 }, 1);
    assert.equal(outbox.counts().alarm, 1);
    assert.ok(outbox.counts().telemetry < 2); // at least one telemetry entry evicted to make room
  });
});

describe('Outbox - disk persistence', () => {
  test('reloads queued messages from disk after being reconstructed (survives a restart)', () => {
    const dir = tmpDir();
    const transport = new LoopbackTransport();
    const outbox1 = new Outbox({ dir, transport });
    outbox1.enqueue('telemetry', 'dt/tel', { v: 1 }, 0);
    outbox1.enqueue('alarm', 'dt/alarm', { v: 2 }, 1);

    const outbox2 = new Outbox({ dir, transport });
    assert.deepEqual(outbox2.counts(), { alarm: 1, telemetry: 1 });
  });

  test('removes drained messages from disk too', async () => {
    const dir = tmpDir();
    const transport = new LoopbackTransport();
    const outbox1 = new Outbox({ dir, transport });
    outbox1.enqueue('telemetry', 'dt/tel', { v: 1 }, 0);
    await outbox1.drain();

    const outbox2 = new Outbox({ dir, transport });
    assert.deepEqual(outbox2.counts(), { alarm: 0, telemetry: 0 });
  });
});

describe('Outbox - drain stops cleanly on publish failure', () => {
  test('a message that fails to publish stays queued and stops further draining that pass', async () => {
    const transport = new LoopbackTransport();
    const outbox = new Outbox({ dir: tmpDir(), transport });
    outbox.enqueue('telemetry', 'dt/tel', { v: 1 }, 0);
    outbox.enqueue('telemetry', 'dt/tel', { v: 2 }, 0);

    // simulate a mid-drain disconnect
    const originalPublish = transport.publish.bind(transport);
    let calls = 0;
    transport.publish = (...args) => {
      calls++;
      if (calls === 1) return originalPublish(...args);
      return Promise.reject(new Error('boom'));
    };

    const published = await outbox.drain();
    assert.equal(published, 1);
    assert.equal(outbox.counts().telemetry, 1); // the failed one stays queued
  });
});
