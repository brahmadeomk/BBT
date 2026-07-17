'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { provisionOverMqtt, writeCredentials, CREATE_TOPIC } = require('../../../src/adapters/aws/provisioning');

/**
 * Transport stand-in scripted like the AWS side of Fleet Provisioning:
 * responds to publishes on the create/provision topics via the
 * handlers registered with subscribe().
 */
function fakeAwsTransport({ rejectCreate = false, rejectRegister = false } = {}) {
  const handlers = new Map();
  const published = [];
  return {
    published,
    subscribe(topic, handler) {
      handlers.set(topic, handler);
    },
    publish(topic, payload) {
      published.push({ topic, payload });
      queueMicrotask(() => {
        if (topic === CREATE_TOPIC) {
          if (rejectCreate) {
            handlers.get(`${CREATE_TOPIC}/rejected`)?.({ statusCode: 403, errorMessage: 'claim not authorized' });
          } else {
            handlers.get(`${CREATE_TOPIC}/accepted`)?.({
              certificateId: 'cert123',
              certificatePem: 'PEM CERT',
              privateKey: 'PEM KEY',
              certificateOwnershipToken: 'token-abc',
            });
          }
        } else if (topic.endsWith('/provision/json')) {
          if (rejectRegister) {
            handlers.get(`${topic}/rejected`)?.({ statusCode: 400, errorMessage: 'invalid parameters' });
          } else {
            handlers.get(`${topic}/accepted`)?.({ thingName: 'bt-c1024-s02-p07', deviceConfiguration: {} });
          }
        }
      });
      return Promise.resolve();
    },
  };
}

const identity = { customer_id: 'c1024', site_id: 's02', panel_id: 'p07', hw_serial: 'BT26-000317' };

describe('provisionOverMqtt', () => {
  test('happy path: creates a certificate, registers the thing with identity parameters', async () => {
    const transport = fakeAwsTransport();
    const result = await provisionOverMqtt({ transport, templateName: 'bt-panel-provisioning', identity });

    assert.equal(result.thingName, 'bt-c1024-s02-p07');
    assert.equal(result.certificateId, 'cert123');
    assert.equal(result.certificatePem, 'PEM CERT');
    assert.equal(result.privateKey, 'PEM KEY');

    const register = transport.published.find((p) => p.topic.includes('/provision/json'));
    assert.equal(register.topic, '$aws/provisioning-templates/bt-panel-provisioning/provision/json');
    assert.equal(register.payload.certificateOwnershipToken, 'token-abc');
    assert.deepEqual(register.payload.parameters, {
      CustomerId: 'c1024',
      SiteId: 's02',
      PanelId: 'p07',
      SerialNumber: 'BT26-000317',
    });
  });

  test('surfaces a rejected certificate create with the AWS reason', async () => {
    const transport = fakeAwsTransport({ rejectCreate: true });
    await assert.rejects(
      () => provisionOverMqtt({ transport, templateName: 't', identity }),
      /certificate create rejected.*claim not authorized/
    );
  });

  test('surfaces a rejected registration with the AWS reason', async () => {
    const transport = fakeAwsTransport({ rejectRegister: true });
    await assert.rejects(
      () => provisionOverMqtt({ transport, templateName: 't', identity }),
      /register thing rejected.*invalid parameters/
    );
  });

  test('publishes each request only after BOTH response subscriptions are SUBACKed (the live race)', async () => {
    const events = [];
    const handlers = new Map();
    const transport = {
      subscribeAsync(topic, handler) {
        handlers.set(topic, handler);
        return new Promise((resolve) =>
          setImmediate(() => {
            events.push(`suback:${topic}`);
            resolve();
          })
        );
      },
      publish(topic, payload) {
        events.push(`publish:${topic}`);
        queueMicrotask(() => {
          if (topic === CREATE_TOPIC) {
            handlers.get(`${CREATE_TOPIC}/accepted`)({
              certificateId: 'c',
              certificatePem: 'p',
              privateKey: 'k',
              certificateOwnershipToken: 'tok',
            });
          } else {
            handlers.get(`${topic}/accepted`)({ thingName: 'bt-x' });
          }
        });
        return Promise.resolve();
      },
    };

    await provisionOverMqtt({ transport, templateName: 't', identity });

    const createPublishIdx = events.indexOf(`publish:${CREATE_TOPIC}`);
    assert.ok(events.indexOf(`suback:${CREATE_TOPIC}/accepted`) < createPublishIdx, 'accepted SUBACK before publish');
    assert.ok(events.indexOf(`suback:${CREATE_TOPIC}/rejected`) < createPublishIdx, 'rejected SUBACK before publish');
    const provisionPublishIdx = events.findIndex((e) => e.startsWith('publish:$aws/provisioning-templates'));
    assert.ok(events.indexOf('suback:$aws/provisioning-templates/t/provision/json/accepted') < provisionPublishIdx);
  });

  test('times out with a clear message when AWS never answers', async () => {
    const silent = { subscribe() {}, publish: () => Promise.resolve() };
    await assert.rejects(
      () => provisionOverMqtt({ transport: silent, templateName: 't', identity, timeoutMs: 20 }),
      /certificate create: no response/
    );
  });
});

describe('writeCredentials', () => {
  test('writes cert and key to the configured paths, key locked to 0600', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-prov-test-'));
    const certPath = path.join(dir, 'certs', 'device.pem.crt');
    const keyPath = path.join(dir, 'certs', 'private.pem.key');
    writeCredentials({ certPath, keyPath, certificatePem: 'PEM CERT', privateKey: 'PEM KEY' });
    assert.equal(fs.readFileSync(certPath, 'utf8'), 'PEM CERT');
    assert.equal(fs.readFileSync(keyPath, 'utf8'), 'PEM KEY');
    assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
  });
});
