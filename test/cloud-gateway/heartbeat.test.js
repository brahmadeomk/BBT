'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Heartbeat } = require('../../src/cloud-gateway/heartbeat');
const { Outbox } = require('../../src/cloud-gateway/outbox');
const { LoopbackTransport } = require('../../src/cloud-gateway/transport');

function freshOutbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-heartbeat-test-'));
  return new Outbox({ dir, transport: new LoopbackTransport() });
}

describe('Heartbeat', () => {
  test('sends a liveness payload with fw/config versions', () => {
    const outbox = freshOutbox();
    const heartbeat = new Heartbeat({ outbox, topic: 'dt/tel' });

    heartbeat.send({ fwVersion: '2.4.1', configVersions: { modbus: 3, joints: 5, alarms: 12 } });

    assert.equal(outbox.counts().telemetry, 1);
    const payload = outbox.queues.telemetry[0].payload;
    assert.equal(payload.fwVersion, '2.4.1');
    assert.deepEqual(payload.configVersions, { modbus: 3, joints: 5, alarms: 12 });
    assert.ok(!Number.isNaN(Date.parse(payload.timestamp)));
  });

  test('enqueues with QoS 0 (tiny liveness ping, loss-tolerant)', () => {
    const outbox = freshOutbox();
    const heartbeat = new Heartbeat({ outbox, topic: 'dt/tel' });
    heartbeat.send({ fwVersion: '2.4.1', configVersions: {} });
    assert.equal(outbox.queues.telemetry[0].qos, 0);
  });

  test('each send is independent - multiple heartbeats queue separately', () => {
    const outbox = freshOutbox();
    const heartbeat = new Heartbeat({ outbox, topic: 'dt/tel' });
    heartbeat.send({ fwVersion: '2.4.1', configVersions: { modbus: 1 } });
    heartbeat.send({ fwVersion: '2.4.1', configVersions: { modbus: 2 } });
    assert.equal(outbox.counts().telemetry, 2);
    assert.equal(outbox.queues.telemetry[1].payload.configVersions.modbus, 2);
  });
});
