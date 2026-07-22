'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { setupCertRotation, drainCertRotation } = require('../../src/cloud-gateway/node-red/cert-rotation');

function fakeOutbox() {
  return { enqueued: [], enqueue(cls, topic, payload, qos) { this.enqueued.push({ cls, topic, payload, qos }); } };
}
function fakeConfigService() {
  return { audits: [], appendLegacyAudit(_g, key, entry) { this.audits.push({ key, entry }); } };
}
function fakeGlobal() {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) };
}

const TOPICS = { cmd_cert: 'cmd/c1/s1/p1/cert', cmd_cert_ack: 'cmd/c1/s1/p1/cert/ack' };

describe('setupCertRotation', () => {
  const orig = process.env.BUSDUCT_CERT_ROTATION;
  beforeEach(() => { process.env.BUSDUCT_CERT_ROTATION = '1'; }); // enabled for the topic/transport tests
  afterEach(() => {
    if (orig === undefined) delete process.env.BUSDUCT_CERT_ROTATION;
    else process.env.BUSDUCT_CERT_ROTATION = orig;
  });

  test('disabled by default until BUSDUCT_CERT_ROTATION is set (never breaks the AWS connection)', () => {
    delete process.env.BUSDUCT_CERT_ROTATION;
    const gateway = {
      topics: TOPICS,
      transport: { certPath: '/c', keyPath: '/k', caPath: '/a', reloadCredentials: async () => true, subscribe() {} },
    };
    const res = setupCertRotation({ gateway });
    assert.equal(res.enabled, false);
    assert.match(res.reason, /BUSDUCT_CERT_ROTATION/);
    assert.equal(gateway._certRotationSubscribed, undefined, 'must not subscribe when disabled');
  });

  test('disabled without cert cmd topics', () => {
    const res = setupCertRotation({ gateway: { topics: {}, transport: {} } });
    assert.equal(res.enabled, false);
    assert.match(res.reason, /no cert cmd topics/);
  });

  test('disabled on a transport that cannot reload credentials (loopback/bench)', () => {
    const res = setupCertRotation({ gateway: { topics: TOPICS, transport: { subscribe() {} } } });
    assert.equal(res.enabled, false);
    assert.match(res.reason, /cannot reload credentials/);
  });

  test('subscribes once and builds a rotator when enabled and the transport supports reload', () => {
    const subscribed = [];
    const gateway = {
      topics: TOPICS,
      transport: {
        certPath: '/c', keyPath: '/k', caPath: '/a',
        reloadCredentials: async () => true,
        subscribe: (t, cb) => subscribed.push({ t, cb }),
      },
    };
    const res = setupCertRotation({ gateway });
    assert.deepEqual({ enabled: res.enabled, topic: res.topic }, { enabled: true, topic: TOPICS.cmd_cert });
    assert.ok(gateway._certRotator, 'rotator built');
    assert.equal(subscribed.length, 1);
    // idempotent: a second setup does not re-subscribe
    const res2 = setupCertRotation({ gateway });
    assert.match(res2.reason, /already subscribed/);
    assert.equal(subscribed.length, 1);
  });
});

describe('drainCertRotation', () => {
  function gatewayWith(rotateImpl) {
    return {
      topics: TOPICS,
      outbox: fakeOutbox(),
      _certRotationInbox: [],
      _certRotator: { rotate: rotateImpl },
    };
  }

  test('applied rotation: acks applied on the cert-ack topic and writes an audit', async () => {
    const gateway = gatewayWith(async (msg) => ({ ok: true, rolledBack: false, certificate_id: msg.certificate_id }));
    const cs = fakeConfigService();
    gateway._certRotationInbox.push({ request_id: 'r1', user: 'ops', certificate: 'x', private_key: 'y', certificate_id: 'cid9' });

    const sends = await drainCertRotation(gateway, cs, fakeGlobal());

    assert.equal(gateway.outbox.enqueued.length, 1);
    const q = gateway.outbox.enqueued[0];
    assert.equal(q.cls, 'alarm');
    assert.equal(q.topic, TOPICS.cmd_cert_ack);
    assert.equal(q.qos, 1);
    assert.deepEqual(
      { request_id: q.payload.request_id, domain: q.payload.domain, result: q.payload.result, certificate_id: q.payload.certificate_id },
      { request_id: 'r1', domain: 'cert', result: 'applied', certificate_id: 'cid9' }
    );
    assert.equal(q.payload.errors, undefined);
    assert.equal(cs.audits[0].key, 'joint_config_audit_log');
    assert.equal(cs.audits[0].entry.action, 'CERT_ROTATION');
    assert.match(cs.audits[0].entry.details, /rotated \(cid9\)/);
    assert.equal(cs.audits[0].entry.user, 'remote:ops');
    assert.deepEqual(sends[0][0].payload.cert_rotation.result, 'applied');
  });

  test('rejected rotation: acks rejected with errors + rolled_back flag', async () => {
    const gateway = gatewayWith(async () => ({ ok: false, rolledBack: true, error: 'new certificate failed to connect within 60s - rolled back to the previous certificate' }));
    const cs = fakeConfigService();
    gateway._certRotationInbox.push({ request_id: 'r2', certificate: 'x', private_key: 'y' });

    await drainCertRotation(gateway, cs, fakeGlobal());

    const ack = gateway.outbox.enqueued[0].payload;
    assert.equal(ack.result, 'rejected');
    assert.equal(ack.rolled_back, true);
    assert.match(ack.errors[0].message, /failed to connect/);
    assert.equal(ack.errors[0].rule, 'CERT');
    assert.match(cs.audits[0].entry.details, /REMOTE REJECTED/);
  });

  test('a rotator throw becomes a rejected ack, not an unhandled rejection', async () => {
    const gateway = gatewayWith(async () => { throw new Error('disk full'); });
    gateway._certRotationInbox.push({ request_id: 'r3', certificate: 'x', private_key: 'y' });
    const sends = await drainCertRotation(gateway, fakeConfigService(), fakeGlobal());
    assert.equal(gateway.outbox.enqueued[0].payload.result, 'rejected');
    assert.match(gateway.outbox.enqueued[0].payload.errors[0].message, /disk full/);
    assert.equal(sends.length, 1);
  });

  test('empty inbox is a no-op', async () => {
    const gateway = gatewayWith(async () => ({ ok: true }));
    assert.deepEqual(await drainCertRotation(gateway, fakeConfigService(), fakeGlobal()), []);
  });
});
