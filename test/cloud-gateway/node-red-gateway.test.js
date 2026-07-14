'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createGateway,
  getGateway,
  resolveTopic,
  ingestKpiTap,
  ingestAlarmActiveTap,
  ingestAlarmClearedTap,
  flushTelemetry,
  sendHeartbeat,
} = require('../../src/cloud-gateway/node-red');

function tmpGateway() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-gw-test-'));
  const gateway = createGateway({ outboxDir: dir });
  gateway.outbox.stop(); // tests drain explicitly
  return gateway;
}

function jointKpi(overrides = {}) {
  return {
    topic: 'joint',
    payload: {
      joint_id: 'J01',
      val: 42.3,
      ror: 3.2,
      deltaT: { raw: 11.2, ema: 10.9 },
      ambient: { slaveID: 101, val: 31.0, age_sec: 0.8 },
      timestamp: '2026-07-14T10:00:00.000Z',
      ...overrides,
    },
  };
}

describe('node-red gateway - wiring', () => {
  test('getGateway returns the same instance across calls (batch/dedupe state must survive)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-gw-singleton-'));
    const a = getGateway({ outboxDir: dir });
    const b = getGateway({ outboxDir: '/somewhere/else/ignored' });
    assert.equal(a, b);
    a.outbox.stop();
  });

  test('resolves topics from the identity per the edge config templates', () => {
    assert.equal(
      resolveTopic('dt/{customer_id}/{site_id}/{panel_id}/tel', { customer_id: 'c1024', site_id: 's17', panel_id: 'p03' }),
      'dt/c1024/s17/p03/tel'
    );
    const gw = tmpGateway();
    assert.equal(gw.topics.telemetry, 'dt/c0000/s0000/p0000/tel');
    assert.equal(gw.topics.alarm, 'dt/c0000/s0000/p0000/alarm');
  });
});

describe('node-red gateway - KPI tap to telemetry batch', () => {
  test('joint KPIs accumulate and flush into one outbox telemetry payload with aggregates', () => {
    const gw = tmpGateway();
    ingestKpiTap(gw, jointKpi({ val: 40, ror: 1, deltaT: { raw: 10, ema: 9 } }));
    ingestKpiTap(gw, jointKpi({ val: 44, ror: 5, deltaT: { raw: 12, ema: 11 } }));
    ingestKpiTap(gw, jointKpi({ joint_id: 'J02', val: 50, ror: 2, deltaT: { raw: 8, ema: 8 } }));

    const status = flushTelemetry(gw, 10);
    assert.equal(status.flushed_chunks, 1);
    assert.equal(status.outbox.telemetry, 1);

    const queued = gw.outbox.peekAll ? gw.outbox.peekAll('telemetry') : null;
    // drain through the loopback instead of relying on internals
    return gw.outbox.drain().then(() => {
      assert.equal(gw.transport.published.length, 1);
      const { topic, payload } = gw.transport.published[0];
      assert.equal(topic, 'dt/c0000/s0000/p0000/tel');
      assert.equal(payload.interval_min, 10);
      assert.equal(payload.joints.J01.dt_min, 9);
      assert.equal(payload.joints.J01.dt_max, 11);
      assert.equal(payload.joints.J01.t_max, 44);
      assert.equal(payload.joints.J01.ror_max, 5);
      assert.equal(payload.joints.J02.t_max, 50);
      assert.ok(queued === null || queued.length === 1);
    });
  });

  test('ignores non-joint messages (ambient/unassigned streams, malformed payloads)', () => {
    const gw = tmpGateway();
    ingestKpiTap(gw, { topic: 'ambient', payload: { joint_id: 'AMBIENT_101', val: 31 } });
    ingestKpiTap(gw, { topic: 'unassigned', payload: { slaveID: 9 } });
    ingestKpiTap(gw, { topic: 'joint', payload: null });
    ingestKpiTap(gw, null);
    const status = flushTelemetry(gw, 10);
    assert.equal(status.flushed_chunks, 0);
  });
});

describe('node-red gateway - alarm taps to publisher', () => {
  const alarm = (instanceId, overrides = {}) => ({
    instanceId,
    category: 'PROCESS',
    joint_id: 'J01',
    alarm_type: 'DELTA_T',
    level: 'WARNING',
    status: 'ACTIVE_NACK',
    raisedTs: '2026-07-14T10:00:00.000Z',
    description: 'ΔT 29.48 >= 25',
    value: 29.48,
    threshold: 25,
    persistence_min: 15,
    absolute_temp_c: 55.2,
    ...overrides,
  });

  test('active tap RAISEs only genuinely new alarms; cleared tap CLEARs', async () => {
    const gw = tmpGateway();
    const a1 = alarm('PROCESS|J01|DELTA_T|WARNING');
    ingestAlarmActiveTap(gw, { payload: [a1] });
    ingestAlarmActiveTap(gw, { payload: [a1] }); // full-array refire, no new alarm
    ingestAlarmClearedTap(gw, { payload: [{ ...a1, status: 'CLEARED', clearedTs: '2026-07-14T11:00:00.000Z' }] });

    await gw.outbox.drain();
    const actions = gw.transport.published.map((p) => [p.topic.endsWith('/alarm'), p.payload.action]);
    assert.deepEqual(actions, [[true, 'RAISE'], [true, 'CLEAR']]);
  });

  test('non-array payloads are ignored', () => {
    const gw = tmpGateway();
    ingestAlarmActiveTap(gw, { payload: { not: 'an array' } });
    ingestAlarmClearedTap(gw, {});
    assert.equal(gw.outbox.counts().alarm, 0);
  });
});

describe('node-red gateway - heartbeat', () => {
  test('queues a telemetry-class heartbeat carrying fw/config versions', async () => {
    const gw = tmpGateway();
    const status = sendHeartbeat(gw, {
      fwVersion: '23022026',
      configVersions: { modbus: 4, joints: 4, alarms: 2 },
    });
    assert.equal(status.heartbeat, 'queued');
    await gw.outbox.drain();
    const hb = gw.transport.published[0];
    assert.equal(hb.topic, 'dt/c0000/s0000/p0000/tel');
    assert.equal(hb.payload.fwVersion, '23022026');
    assert.deepEqual(hb.payload.configVersions, { modbus: 4, joints: 4, alarms: 2 });
  });
});

describe('LoopbackTransport publish cap', () => {
  test('drops oldest published records beyond maxPublished', async () => {
    const { LoopbackTransport } = require('../../src/cloud-gateway/transport');
    const t = new LoopbackTransport({ maxPublished: 3 });
    for (let i = 0; i < 5; i++) await t.publish('t', { i });
    assert.equal(t.published.length, 3);
    assert.deepEqual(t.published.map((p) => p.payload.i), [2, 3, 4]);
  });
});
