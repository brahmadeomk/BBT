'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadEdgeConfig } = require('../../../src/adapters/aws/edge-config');

const BASE_YAML = `
config_version: 1
identity:
  customer_id: c1024
  site_id: s02
  panel_id: p07
  thing_name: bt-c1024-s02-p07
  hw_serial: BT26-000317
mqtt:
  endpoint: example-ats.iot.ap-south-1.amazonaws.com
  port: 8883
  cert_path: /etc/busduct/certs/device.pem.crt
  key_path: /etc/busduct/certs/private.pem.key
  root_ca_path: /etc/busduct/certs/AmazonRootCA1.pem
  keep_alive_sec: 300
  reconnect_backoff:
    initial_sec: 2
    max_sec: 300
topics:
  telemetry: dt/{customer_id}/{site_id}/{panel_id}/tel
  alarm: dt/{customer_id}/{site_id}/{panel_id}/alarm
  telemetry_basic_ingest: $aws/rules/btTelemetry/dt/{customer_id}/{site_id}/{panel_id}/tel
  use_basic_ingest: false
buffer:
  path: /var/busduct/outbox
`;

function writeConfig(yamlText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-edgecfg-test-'));
  const p = path.join(dir, 'edge-config.yaml');
  fs.writeFileSync(p, yamlText);
  return p;
}

describe('loadEdgeConfig', () => {
  test('resolves topics from the identity and carries mqtt/backoff/buffer through', () => {
    const cfg = loadEdgeConfig(writeConfig(BASE_YAML));
    assert.equal(cfg.identity.thing_name, 'bt-c1024-s02-p07');
    assert.equal(cfg.topics.telemetry, 'dt/c1024/s02/p07/tel');
    assert.equal(cfg.topics.alarm, 'dt/c1024/s02/p07/alarm');
    assert.equal(cfg.topics.use_basic_ingest, false);
    assert.equal(cfg.mqtt.endpoint, 'example-ats.iot.ap-south-1.amazonaws.com');
    assert.equal(cfg.mqtt.keep_alive_sec, 300);
    assert.deepEqual(cfg.mqtt.reconnect_backoff, { initial_sec: 2, max_sec: 300 });
    assert.equal(cfg.buffer.path, '/var/busduct/outbox');
  });

  test('basic ingest flag rewrites only the telemetry publish topic', () => {
    const cfg = loadEdgeConfig(writeConfig(BASE_YAML.replace('use_basic_ingest: false', 'use_basic_ingest: true')));
    assert.equal(cfg.topics.telemetry, '$aws/rules/btTelemetry/dt/c1024/s02/p07/tel');
    assert.equal(cfg.topics.alarm, 'dt/c1024/s02/p07/alarm'); // untouched
  });

  test('rejects a config missing a required identity field', () => {
    assert.throws(() => loadEdgeConfig(writeConfig(BASE_YAML.replace('  thing_name: bt-c1024-s02-p07\n', ''))), /identity\.thing_name/);
  });

  test('rejects basic ingest without its template', () => {
    const noTemplate = BASE_YAML.replace('  telemetry_basic_ingest: $aws/rules/btTelemetry/dt/{customer_id}/{site_id}/{panel_id}/tel\n', '').replace(
      'use_basic_ingest: false',
      'use_basic_ingest: true'
    );
    assert.throws(() => loadEdgeConfig(writeConfig(noTemplate)), /telemetry_basic_ingest/);
  });

  test('rejects a missing file with a useful error', () => {
    assert.throws(() => loadEdgeConfig('/nonexistent/edge-config.yaml'), /ENOENT/);
  });
});

describe('gateway composition from edge config', () => {
  test('falls back to loopback with a reason when the panel is not provisioned (certs missing)', () => {
    const p = writeConfig(BASE_YAML.replace('path: /var/busduct/outbox', `path: ${path.join(os.tmpdir(), 'busduct-edgecfg-outbox-' + Date.now())}`));
    process.env.BUSDUCT_EDGE_CONFIG = p;
    try {
      const { createGatewayFromEdgeConfig } = require('../../../src/cloud-gateway/node-red');
      const { gateway, mode, reason } = createGatewayFromEdgeConfig();
      assert.equal(mode, 'loopback');
      assert.match(reason, /not provisioned.*provision-panel/);
      // identity/topics still come from the config so the loopback record matches future AWS topics
      assert.equal(gateway.topics.telemetry, 'dt/c1024/s02/p07/tel');
      gateway.outbox.stop();
    } finally {
      delete process.env.BUSDUCT_EDGE_CONFIG;
    }
  });

  test('falls back to loopback with defaults when no edge config exists at all', () => {
    process.env.BUSDUCT_EDGE_CONFIG = '/nonexistent/edge-config.yaml';
    try {
      const { createGatewayFromEdgeConfig } = require('../../../src/cloud-gateway/node-red');
      const { gateway, mode, reason } = createGatewayFromEdgeConfig();
      assert.equal(mode, 'loopback');
      assert.match(reason, /no usable edge config/);
      assert.equal(gateway.topics.telemetry, 'dt/c0000/s0000/p0000/tel');
      gateway.outbox.stop();
    } finally {
      delete process.env.BUSDUCT_EDGE_CONFIG;
    }
  });
});
