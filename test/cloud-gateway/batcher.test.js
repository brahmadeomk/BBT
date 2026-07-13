'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Batcher } = require('../../src/cloud-gateway/batcher');
const { Outbox } = require('../../src/cloud-gateway/outbox');
const { LoopbackTransport } = require('../../src/cloud-gateway/transport');

function freshOutbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-batcher-test-'));
  return new Outbox({ dir, transport: new LoopbackTransport() });
}

function jointKpi(overrides = {}) {
  return {
    joint_id: 'J01',
    val: 40,
    emaTemp: 40,
    ror: 2,
    deltaT: { raw: 10, ema: 10 },
    ambient: { slaveID: 101, val: 30, age_sec: 1 },
    ...overrides,
  };
}

describe('Batcher - aggregation math', () => {
  test('computes dt_min/dt_max/dt_avg from deltaT.ema over the interval', () => {
    const outbox = freshOutbox();
    const batcher = new Batcher({ outbox, topic: 'dt/tel' });

    batcher.ingestJointKpi(jointKpi({ deltaT: { raw: 5, ema: 5 } }));
    batcher.ingestJointKpi(jointKpi({ deltaT: { raw: 15, ema: 15 } }));
    batcher.ingestJointKpi(jointKpi({ deltaT: { raw: 10, ema: 10 } }));

    batcher.flush(10);
    const payload = outbox.queues.telemetry[0].payload;
    assert.equal(payload.joints.J01.dt_min, 5);
    assert.equal(payload.joints.J01.dt_max, 15);
    assert.equal(payload.joints.J01.dt_avg, 10);
  });

  test('computes ror_max as the peak rate-of-rise over the interval', () => {
    const outbox = freshOutbox();
    const batcher = new Batcher({ outbox, topic: 'dt/tel' });

    batcher.ingestJointKpi(jointKpi({ ror: 1 }));
    batcher.ingestJointKpi(jointKpi({ ror: 8 }));
    batcher.ingestJointKpi(jointKpi({ ror: 3 }));

    batcher.flush(10);
    assert.equal(outbox.queues.telemetry[0].payload.joints.J01.ror_max, 8);
  });

  test('computes t_max as the peak raw temperature over the interval', () => {
    const outbox = freshOutbox();
    const batcher = new Batcher({ outbox, topic: 'dt/tel' });

    batcher.ingestJointKpi(jointKpi({ val: 38 }));
    batcher.ingestJointKpi(jointKpi({ val: 45 }));
    batcher.ingestJointKpi(jointKpi({ val: 41 }));

    batcher.flush(10);
    assert.equal(outbox.queues.telemetry[0].payload.joints.J01.t_max, 45);
  });

  test('includes average ambient when include_ambient is true (default)', () => {
    const outbox = freshOutbox();
    const batcher = new Batcher({ outbox, topic: 'dt/tel' });

    batcher.ingestJointKpi(jointKpi({ ambient: { slaveID: 101, val: 28 } }));
    batcher.ingestJointKpi(jointKpi({ ambient: { slaveID: 101, val: 32 } }));

    batcher.flush(10);
    assert.equal(outbox.queues.telemetry[0].payload.joints.J01.ambient, 30);
  });

  test('omits ambient when include_ambient is false', () => {
    const outbox = freshOutbox();
    const batcher = new Batcher({ outbox, topic: 'dt/tel', includeAmbient: false });

    batcher.ingestJointKpi(jointKpi());
    batcher.flush(10);
    assert.equal(outbox.queues.telemetry[0].payload.joints.J01.ambient, undefined);
  });

  test('handles multiple joints independently', () => {
    const outbox = freshOutbox();
    const batcher = new Batcher({ outbox, topic: 'dt/tel' });

    batcher.ingestJointKpi(jointKpi({ joint_id: 'J01', val: 40 }));
    batcher.ingestJointKpi(jointKpi({ joint_id: 'J02', val: 60 }));

    batcher.flush(10);
    const { joints } = outbox.queues.telemetry[0].payload;
    assert.equal(joints.J01.t_max, 40);
    assert.equal(joints.J02.t_max, 60);
  });

  test('a joint with no ambient reading yet is not given an ambient field', () => {
    const outbox = freshOutbox();
    const batcher = new Batcher({ outbox, topic: 'dt/tel' });
    batcher.ingestJointKpi(jointKpi({ ambient: null, deltaT: null }));
    batcher.flush(10);
    const entry = outbox.queues.telemetry[0].payload.joints.J01;
    assert.equal(entry.ambient, undefined);
    assert.equal(entry.dt_min, undefined);
    assert.equal(entry.t_max, 40); // val is still tracked independent of ambient/deltaT
  });
});

describe('Batcher - interval / envelope behavior', () => {
  test('emits nothing on an interval with no readings', () => {
    const outbox = freshOutbox();
    const batcher = new Batcher({ outbox, topic: 'dt/tel' });
    const chunksEmitted = batcher.flush(10);
    assert.equal(chunksEmitted, 0);
    assert.equal(outbox.counts().telemetry, 0);
  });

  test('resets accumulators after flush - the next interval starts clean', () => {
    const outbox = freshOutbox();
    const batcher = new Batcher({ outbox, topic: 'dt/tel' });

    batcher.ingestJointKpi(jointKpi({ val: 100 }));
    batcher.flush(10);
    batcher.ingestJointKpi(jointKpi({ val: 20 }));
    batcher.flush(10);

    assert.equal(outbox.queues.telemetry[1].payload.joints.J01.t_max, 20);
  });

  test('enqueues to the outbox as telemetry class, QoS 0', () => {
    const outbox = freshOutbox();
    const batcher = new Batcher({ outbox, topic: 'dt/tel' });
    batcher.ingestJointKpi(jointKpi());
    batcher.flush(10);
    assert.equal(outbox.queues.telemetry[0].qos, 0);
    assert.equal(outbox.queues.telemetry[0].topic, 'dt/tel');
  });

  test('payload includes interval_min and an edge timestamp', () => {
    const outbox = freshOutbox();
    const batcher = new Batcher({ outbox, topic: 'dt/tel' });
    batcher.ingestJointKpi(jointKpi());
    batcher.flush(10);
    const payload = outbox.queues.telemetry[0].payload;
    assert.equal(payload.interval_min, 10);
    assert.ok(!Number.isNaN(Date.parse(payload.timestamp)));
  });
});

describe('Batcher - payload budget', () => {
  test('a single interval fits in one payload under normal joint counts', () => {
    const outbox = freshOutbox();
    const batcher = new Batcher({ outbox, topic: 'dt/tel' }); // default 4800 byte budget
    for (let i = 1; i <= 20; i++) {
      batcher.ingestJointKpi(jointKpi({ joint_id: `J${String(i).padStart(2, '0')}` }));
    }
    const chunks = batcher.flush(10);
    assert.equal(chunks, 1);
    assert.equal(outbox.counts().telemetry, 1);
  });

  test('splits into multiple chunks rather than dropping joints when over budget', () => {
    const outbox = freshOutbox();
    const batcher = new Batcher({ outbox, topic: 'dt/tel', maxPayloadBytes: 200 }); // tiny budget forces splitting
    for (let i = 1; i <= 10; i++) {
      batcher.ingestJointKpi(jointKpi({ joint_id: `J${String(i).padStart(2, '0')}` }));
    }
    const chunks = batcher.flush(10);
    assert.ok(chunks > 1);

    // every joint must appear exactly once, across all chunks combined
    const allJointIds = outbox.queues.telemetry.flatMap((item) => Object.keys(item.payload.joints));
    assert.equal(new Set(allJointIds).size, 10);
    assert.equal(allJointIds.length, 10);

    // every chunk actually fits the budget
    for (const item of outbox.queues.telemetry) {
      assert.ok(Buffer.byteLength(JSON.stringify(item.payload), 'utf8') <= 200);
    }
  });
});
