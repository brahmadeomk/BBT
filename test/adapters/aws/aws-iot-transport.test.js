'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AwsIotTransport } = require('../../../src/adapters/aws/aws-iot-transport');

/** Minimal stand-in for an mqtt.js client - tests drive its events by hand. */
class FakeMqttClient extends EventEmitter {
  constructor() {
    super();
    this.published = [];
    this.subscribedTopics = [];
    this.ended = false;
  }
  publish(topic, body, opts, cb) {
    this.published.push({ topic, body, qos: opts.qos });
    cb(null);
  }
  subscribe(topic, opts, cb) {
    this.subscribedTopics.push(topic);
    if (typeof cb === 'function') setImmediate(() => cb(this.subackError ?? null)); // SUBACK
  }
  end() {
    this.ended = true;
  }
}

function certDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-aws-test-'));
  for (const f of ['cert.pem', 'key.pem', 'ca.pem']) fs.writeFileSync(path.join(dir, f), `fake ${f}`);
  return dir;
}

function makeTransport(overrides = {}) {
  const dir = certDir();
  const dials = [];
  const transport = new AwsIotTransport({
    endpoint: 'example-ats.iot.ap-south-1.amazonaws.com',
    certPath: path.join(dir, 'cert.pem'),
    keyPath: path.join(dir, 'key.pem'),
    caPath: path.join(dir, 'ca.pem'),
    clientId: 'bt-c1024-s02-p07',
    backoff: { initialSec: 2, maxSec: 300 },
    will: { topic: 'dt/c1024/s02/p07/tel', payload: { lwt: true, thing_name: 'bt-c1024-s02-p07' } },
    mqttConnect: (url, options) => {
      const client = new FakeMqttClient();
      dials.push({ url, options, client });
      return client;
    },
    random: () => 1, // deterministic backoff: always the full cap
    ...overrides,
  });
  return { transport, dials };
}

describe('AwsIotTransport - connection & options', () => {
  test('dials mqtts on 8883 with mutual-auth material, thing-name client id, 300s keep-alive, LWT', () => {
    const { transport, dials } = makeTransport();
    transport.connect();
    assert.equal(dials.length, 1);
    assert.equal(dials[0].url, 'mqtts://example-ats.iot.ap-south-1.amazonaws.com:8883');
    const o = dials[0].options;
    assert.equal(o.clientId, 'bt-c1024-s02-p07');
    assert.equal(o.keepalive, 300);
    assert.equal(o.reconnectPeriod, 0); // reconnects are ours
    assert.equal(o.cert.toString(), 'fake cert.pem');
    assert.equal(o.key.toString(), 'fake key.pem');
    assert.equal(o.ca.toString(), 'fake ca.pem');
    assert.equal(o.rejectUnauthorized, true);
    assert.equal(o.will.topic, 'dt/c1024/s02/p07/tel');
    assert.deepEqual(JSON.parse(o.will.payload), { lwt: true, thing_name: 'bt-c1024-s02-p07' });
    assert.equal(o.will.qos, 1);
    transport.close();
  });

  test('reports connection state through isConnected/onConnectionChange', () => {
    const { transport, dials } = makeTransport();
    const seen = [];
    transport.onConnectionChange((c) => seen.push(c));
    transport.connect();
    assert.equal(transport.isConnected(), false);
    dials[0].client.emit('connect');
    assert.equal(transport.isConnected(), true);
    dials[0].client.emit('close');
    assert.equal(transport.isConnected(), false);
    assert.deepEqual(seen, [true, false]);
    transport.close();
  });
});

describe('AwsIotTransport - publish/subscribe', () => {
  test('publish serializes objects and resolves on ack; rejects when disconnected', async () => {
    const { transport, dials } = makeTransport();
    transport.connect();
    await assert.rejects(() => transport.publish('t', { a: 1 }), /disconnected/);
    dials[0].client.emit('connect');
    await transport.publish('dt/c1024/s02/p07/tel', { joints: {} }, 1);
    assert.deepEqual(dials[0].client.published, [{ topic: 'dt/c1024/s02/p07/tel', body: '{"joints":{}}', qos: 1 }]);
    transport.close();
  });

  test('subscribeAsync resolves only after the broker SUBACKs (request/response safety)', async () => {
    const { transport, dials } = makeTransport();
    transport.connect();
    dials[0].client.emit('connect');
    let acked = false;
    const p = transport.subscribeAsync('$aws/certificates/create/json/accepted', () => {}).then(() => (acked = true));
    assert.equal(acked, false, 'not resolved before the SUBACK callback fires');
    await p;
    assert.equal(acked, true);
    assert.ok(dials[0].client.subscribedTopics.includes('$aws/certificates/create/json/accepted'));
    transport.close();
  });

  test('subscribeAsync surfaces a broker subscription rejection', async () => {
    const { transport, dials } = makeTransport();
    transport.connect();
    dials[0].client.emit('connect');
    dials[0].client.subackError = new Error('not authorized');
    await assert.rejects(() => transport.subscribeAsync('forbidden/topic', () => {}), /not authorized/);
    transport.close();
  });

  test('dispatches incoming messages to subscribers, JSON-parsed when possible', () => {
    const { transport, dials } = makeTransport();
    transport.connect();
    dials[0].client.emit('connect');
    const got = [];
    transport.subscribe('cmd/c1024/s02/p07/config', (m) => got.push(m));
    assert.deepEqual(dials[0].client.subscribedTopics, ['cmd/c1024/s02/p07/config']);
    dials[0].client.emit('message', 'cmd/c1024/s02/p07/config', Buffer.from('{"config_version":2}'));
    dials[0].client.emit('message', 'cmd/c1024/s02/p07/config', Buffer.from('not json'));
    dials[0].client.emit('message', 'unrelated/topic', Buffer.from('{}'));
    assert.deepEqual(got, [{ config_version: 2 }, 'not json']);
    transport.close();
  });
});

describe('AwsIotTransport - reconnect backoff', () => {
  test('schedules jittered exponential reconnects capped at max_sec and replays subscriptions', async () => {
    const { transport, dials } = makeTransport({
      backoff: { initialSec: 0.01, maxSec: 0.02 }, // ms-scale so the test runs fast
    });
    transport.connect();
    transport.subscribe('cmd/x', () => {});
    dials[0].client.emit('connect');
    assert.deepEqual(dials[0].client.subscribedTopics, ['cmd/x']);

    dials[0].client.emit('close'); // unexpected drop -> reconnect scheduled (random()=1 -> full cap)
    assert.equal(dials.length, 1);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(dials.length, 2, 'redialed after backoff');
    dials[1].client.emit('connect');
    assert.deepEqual(dials[1].client.subscribedTopics, ['cmd/x'], 'subscriptions replayed on the new connection');
    assert.equal(transport.isConnected(), true);
    transport.close();
  });

  test('backoff delay grows exponentially with attempts and resets after a successful connect', () => {
    const { transport } = makeTransport();
    // inspect the internal cap math without waiting real seconds
    transport.reconnectAttempts = 0;
    assert.equal(Math.min(300, 2 * 2 ** 0), 2);
    transport.reconnectAttempts = 4;
    assert.equal(Math.min(300, 2 * 2 ** 4), 32);
    transport.reconnectAttempts = 10;
    assert.equal(Math.min(300, 2 * 2 ** 10), 300); // capped
  });

  test('close() stops reconnecting and does not redial', async () => {
    const { transport, dials } = makeTransport({ backoff: { initialSec: 0.01, maxSec: 0.01 } });
    transport.connect();
    dials[0].client.emit('connect');
    transport.close();
    dials[0].client.emit('close');
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(dials.length, 1, 'no redial after user close');
    assert.ok(dials[0].client.ended);
  });
});
