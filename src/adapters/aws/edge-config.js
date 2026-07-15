'use strict';

const fs = require('node:fs');
const yaml = require('js-yaml');

/**
 * Loads and resolves the per-panel edge node configuration
 * (docs/busduct_edge_config.yaml is the spec; the live file is written
 * at commissioning, identity immutable after provisioning).
 *
 * Lives under adapters/aws because only the AWS transport and the
 * provisioning helper consume it - the cloud-gateway core stays
 * config-file-agnostic and receives plain {identity, topics, ...}
 * objects (CLAUDE.md's cloud-agnostic rule).
 */

const DEFAULT_CONFIG_PATH = '/etc/busduct/edge-config.yaml';

function resolveTopic(template, identity) {
  return template
    .replace('{customer_id}', identity.customer_id)
    .replace('{site_id}', identity.site_id)
    .replace('{panel_id}', identity.panel_id);
}

/**
 * @param {string} [configPath]
 * @returns {{identity, mqtt, topics, publish, buffer, raw}} resolved config
 * @throws when the file is missing/malformed or required fields are absent
 */
function loadEdgeConfig(configPath = process.env.BUSDUCT_EDGE_CONFIG || DEFAULT_CONFIG_PATH) {
  const raw = yaml.load(fs.readFileSync(configPath, 'utf8'));

  for (const [section, fields] of [
    ['identity', ['customer_id', 'site_id', 'panel_id', 'thing_name']],
    ['mqtt', ['endpoint', 'cert_path', 'key_path', 'root_ca_path']],
    ['topics', ['telemetry', 'alarm']],
  ]) {
    if (!raw?.[section]) throw new Error(`edge config ${configPath}: missing section '${section}'`);
    for (const f of fields) {
      if (raw[section][f] == null) throw new Error(`edge config ${configPath}: missing ${section}.${f}`);
    }
  }

  const identity = raw.identity;
  const useBasicIngest = raw.topics.use_basic_ingest === true;
  if (useBasicIngest && !raw.topics.telemetry_basic_ingest) {
    throw new Error(`edge config ${configPath}: use_basic_ingest is true but telemetry_basic_ingest template is missing`);
  }

  const topics = {
    // Basic Ingest rewrites only what the panel PUBLISHES for telemetry
    // ($aws/rules/... bypasses the message broker for cost); the alarm
    // topic keeps broker delivery so subscribers/tests can listen.
    telemetry: resolveTopic(useBasicIngest ? raw.topics.telemetry_basic_ingest : raw.topics.telemetry, identity),
    alarm: resolveTopic(raw.topics.alarm, identity),
    use_basic_ingest: useBasicIngest,
  };

  return {
    identity,
    mqtt: {
      endpoint: raw.mqtt.endpoint,
      port: raw.mqtt.port ?? 8883,
      cert_path: raw.mqtt.cert_path,
      key_path: raw.mqtt.key_path,
      root_ca_path: raw.mqtt.root_ca_path,
      keep_alive_sec: raw.mqtt.keep_alive_sec ?? 300,
      reconnect_backoff: {
        initial_sec: raw.mqtt.reconnect_backoff?.initial_sec ?? 2,
        max_sec: raw.mqtt.reconnect_backoff?.max_sec ?? 300,
      },
    },
    topics,
    publish: raw.publish ?? {},
    buffer: { path: raw.buffer?.path ?? '/var/busduct/outbox' },
    raw,
  };
}

module.exports = { loadEdgeConfig, resolveTopic, DEFAULT_CONFIG_PATH };
