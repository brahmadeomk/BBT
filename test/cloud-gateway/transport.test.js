'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { LoopbackTransport } = require('../../src/cloud-gateway/transport');

describe('LoopbackTransport', () => {
  test('starts connected', () => {
    const t = new LoopbackTransport();
    assert.equal(t.isConnected(), true);
  });

  test('publish records the message and delivers to subscribers', async () => {
    const t = new LoopbackTransport();
    const received = [];
    t.subscribe('dt/tel', (payload) => received.push(payload));

    await t.publish('dt/tel', { hello: 'world' }, 0);

    assert.equal(t.published.length, 1);
    assert.equal(t.published[0].topic, 'dt/tel');
    assert.deepEqual(t.published[0].payload, { hello: 'world' });
    assert.deepEqual(received, [{ hello: 'world' }]);
  });

  test('publish rejects while disconnected', async () => {
    const t = new LoopbackTransport();
    t.setConnected(false);
    await assert.rejects(() => t.publish('dt/tel', {}, 0));
    assert.equal(t.published.length, 0);
  });

  test('publish works again after reconnecting', async () => {
    const t = new LoopbackTransport();
    t.setConnected(false);
    await assert.rejects(() => t.publish('dt/tel', {}, 0));
    t.setConnected(true);
    await t.publish('dt/tel', {}, 0);
    assert.equal(t.published.length, 1);
  });

  test('onConnectionChange fires only on an actual transition', () => {
    const t = new LoopbackTransport();
    const events = [];
    t.onConnectionChange((connected) => events.push(connected));

    t.setConnected(true); // already connected - no-op
    t.setConnected(false);
    t.setConnected(false); // already disconnected - no-op
    t.setConnected(true);

    assert.deepEqual(events, [false, true]);
  });
});
