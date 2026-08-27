'use strict';

/**
 * The device -> cloud wire contract: EVERY published message says what it is.
 *
 * This exists because four different shapes used to share the telemetry topic
 * (interval aggregate, heartbeat, positional manifest, LWT) and only the
 * manifest carried a `type`. A cloud consumer had to discriminate by sniffing
 * field presence, which decodes today and mis-routes silently the first time
 * anyone adds a field. These tests are the guard: a new publish path that
 * forgets its `type` fails here rather than in a customer's IoT Rule.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Batcher } = require('../../src/cloud-gateway/batcher');
const { Heartbeat } = require('../../src/cloud-gateway/heartbeat');
const { AlarmPublisher } = require('../../src/cloud-gateway/alarm-publisher');
const { Outbox } = require('../../src/cloud-gateway/outbox');
const { LoopbackTransport } = require('../../src/cloud-gateway/transport');
const { MESSAGE_TYPES, TELEMETRY_ENCODINGS } = require('../../src/cloud-gateway/message-types');
const { processRemoteConfig } = require('../../src/config-service/node-red/remote-config-handler');

function freshOutbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-discriminator-test-'));
  return new Outbox({ dir, transport: new LoopbackTransport() });
}

// The outbox holds one queue per priority class; read back everything that
// would go on the wire, in the order it was enqueued.
const queued = (outbox) => Object.values(outbox.queues).flat();

const jointKpi = (jointId, over = {}) => ({
  joint_id: jointId,
  val: 40,
  emaTemp: 40,
  ror: 2,
  deltaT: { raw: 10, ema: 10 },
  ambient: { slaveID: 101, val: 30, age_sec: 1 },
  ...over,
});

const alarm = (over = {}) => ({
  instanceId: 'PROCESS|J01|DELTA_T',
  joint_id: 'J01',
  level: 'WARNING',
  alarm_type: 'DELTA_T',
  status: 'ACTIVE_NACK',
  raisedTs: '2026-08-27T10:00:00.000Z',
  ...over,
});

describe('wire contract - every message declares its type', () => {
  test('keyed telemetry', () => {
    const outbox = freshOutbox();
    const b = new Batcher({ outbox, topic: 'tel' });
    b.ingestJointKpi(jointKpi('J01'));
    b.flush(10);
    const [msg] = queued(outbox);
    assert.equal(msg.payload.type, MESSAGE_TYPES.TELEMETRY);
    assert.equal(msg.payload.encoding, TELEMETRY_ENCODINGS.KEYED);
  });

  test('positional telemetry, and the manifest that decodes it', () => {
    const outbox = freshOutbox();
    const b = new Batcher({ outbox, topic: 'tel', positional: true });
    b.ingestJointKpi(jointKpi('J01'));
    b.flush(10);
    const msgs = queued(outbox);
    // manifest is published first, so the cloud can always decode what follows
    assert.equal(msgs[0].payload.type, MESSAGE_TYPES.MANIFEST);
    assert.equal(msgs[1].payload.type, MESSAGE_TYPES.TELEMETRY);
    assert.equal(msgs[1].payload.encoding, TELEMETRY_ENCODINGS.POSITIONAL);
  });

  test('both encodings are type:telemetry, so a consumer need not know which the panel uses', () => {
    const flushOne = (positional) => {
      const outbox = freshOutbox();
      const b = new Batcher({ outbox, topic: 'tel', positional });
      b.ingestJointKpi(jointKpi('J01'));
      b.flush(10);
      return queued(outbox).find((m) => m.payload.type === MESSAGE_TYPES.TELEMETRY).payload;
    };
    const keyed = flushOne(false);
    const positional = flushOne(true);
    assert.equal(keyed.type, positional.type, 'same type...');
    assert.notEqual(keyed.encoding, positional.encoding, '...different encoding');
  });

  test('heartbeat', () => {
    const outbox = freshOutbox();
    new Heartbeat({ outbox, topic: 'tel' }).send({ fwVersion: '1.2.3', configVersions: { modbus: 4 } });
    assert.equal(queued(outbox)[0].payload.type, MESSAGE_TYPES.HEARTBEAT);
  });

  test('alarm RAISE, ACK and CLEAR', () => {
    const outbox = freshOutbox();
    const p = new AlarmPublisher({ outbox, topic: 'alarm' });
    p.ingestActiveAlarms([alarm()]);
    p.ingestActiveAlarms([alarm({ status: 'ACTIVE_ACK', ackTs: '2026-08-27T10:05:00.000Z' })]);
    p.ingestClearedAlarms([alarm({ clearedTs: '2026-08-27T10:10:00.000Z' })]);
    const msgs = queued(outbox);
    assert.deepEqual(msgs.map((m) => m.payload.action), ['RAISE', 'ACK', 'CLEAR']);
    for (const m of msgs) assert.equal(m.payload.type, MESSAGE_TYPES.ALARM);
  });

  test('config ack, accepted and rejected alike', () => {
    const rejected = processRemoteConfig({ request_id: 'r1', domain: 'nonsense' }, { store: null });
    assert.equal(rejected.ack.type, MESSAGE_TYPES.CONFIG_ACK);
    assert.equal(rejected.ack.result, 'rejected');

    const accepted = processRemoteConfig(
      { request_id: 'r2', domain: 'edge', doc: { telemetry_interval_min: 5 } },
      { store: null, telemetryInterval: { apply: () => null } }
    );
    assert.equal(accepted.ack.type, MESSAGE_TYPES.CONFIG_ACK);
    assert.equal(accepted.ack.result, 'applied');
  });
});

describe('wire contract - the discriminator is actually unambiguous', () => {
  test('no two message types share a type value', () => {
    const values = Object.values(MESSAGE_TYPES);
    assert.equal(new Set(values).size, values.length);
  });

  test('a single switch on `type` routes every shape the panel can publish', () => {
    // This is the property the cloud rule depends on: reading ONE field is
    // enough. If a future message shape needs a second field to be understood,
    // it needs its own type value instead.
    const outbox = freshOutbox();
    const b = new Batcher({ outbox, topic: 'tel', positional: true });
    b.ingestJointKpi(jointKpi('J01'));
    b.flush(10);
    new Heartbeat({ outbox, topic: 'tel' }).send({ fwVersion: '1', configVersions: {} });
    new AlarmPublisher({ outbox, topic: 'alarm' }).ingestActiveAlarms([alarm()]);

    const seen = new Set();
    for (const m of queued(outbox)) {
      assert.equal(typeof m.payload.type, 'string', `untyped payload on ${m.topic}`);
      assert.ok(Object.values(MESSAGE_TYPES).includes(m.payload.type),
        `unknown type "${m.payload.type}" - add it to message-types.js`);
      seen.add(m.payload.type);
    }
    assert.deepEqual([...seen].sort(),
      [MESSAGE_TYPES.ALARM, MESSAGE_TYPES.HEARTBEAT, MESSAGE_TYPES.MANIFEST, MESSAGE_TYPES.TELEMETRY].sort());
  });

  test('keyed and positional name their fields IDENTICALLY (CR-OPEN-5)', () => {
    // The two encodings drifted: keyed emitted `ambient` where positional
    // emitted `amb_avg` for the same number, and the design proposal showed a
    // third name (`t_avg`) for a field the code computes as `t_max`. A cloud
    // parser written against either one would be wrong for the other, and the
    // panel can be switched between encodings at any time. One set, frozen:
    const FIELDS = ['dt_min', 'dt_max', 'dt_avg', 'ror_max', 't_max', 'amb_avg'];

    const keyedBox = freshOutbox();
    const bk = new Batcher({ outbox: keyedBox, topic: 'tel' });
    bk.ingestJointKpi(jointKpi('J01'));
    bk.flush(10);
    const keyedEntry = queued(keyedBox)[0].payload.joints.J01;
    assert.deepEqual(Object.keys(keyedEntry).sort(), [...FIELDS].sort());

    const posBox = freshOutbox();
    const bp = new Batcher({ outbox: posBox, topic: 'tel', positional: true });
    bp.ingestJointKpi(jointKpi('J01'));
    bp.flush(10);
    const posPayload = queued(posBox).find((m) => m.payload.type === MESSAGE_TYPES.TELEMETRY).payload;
    for (const f of FIELDS) {
      assert.ok(Array.isArray(posPayload[f]), `positional is missing the ${f} column`);
      // ...and the same joint's value agrees across encodings
      assert.equal(posPayload[f][0], Math.round(keyedEntry[f] * 100) / 100, `${f} differs between encodings`);
    }
    // no stray columns with other names
    const extra = Object.keys(posPayload).filter((k) => Array.isArray(posPayload[k]) && !FIELDS.includes(k));
    assert.deepEqual(extra, [], `positional has columns keyed does not: ${extra}`);
  });

  test('`type` is the FIRST key, so a truncated payload in a log is still identifiable', () => {
    const outbox = freshOutbox();
    const b = new Batcher({ outbox, topic: 'tel' });
    b.ingestJointKpi(jointKpi('J01'));
    b.flush(10);
    assert.equal(Object.keys(queued(outbox)[0].payload)[0], 'type');
  });
});
