'use strict';

const { LoopbackTransport } = require('../transport');
const { Outbox } = require('../outbox');
const { Batcher } = require('../batcher');
const { AlarmPublisher } = require('../alarm-publisher');
const { Heartbeat } = require('../heartbeat');
const { createSoakRecorder, wrapTransportForSoak } = require('../soak-recorder');
const { RuntimeSettings } = require('../runtime-settings');
const handlers = require('./gateway-handler');
const { setupRemoteConfig, drainRemoteConfig } = require('./remote-config');
const { setupCertRotation, drainCertRotation } = require('./cert-rotation');

/**
 * Entry point exposed to Node-RED function nodes via
 * functionGlobalContext (busductCloudGateway - see
 * src/config-service/node-red/settings.js.example) so the Cloud
 * Gateway tab's function nodes stay thin one-liners.
 *
 * The transport is the LOOPBACK implementation until Slice 6's AWS
 * adapter lands: messages drain from the disk-backed outbox into an
 * in-memory record (capped) instead of MQTT. Everything upstream -
 * batcher, alarm publisher, heartbeat, outbox - runs exactly as it
 * will in production, per the workplan's "no MQTT yet" Slice 5 scope
 * and the cloud-agnostic rule (no AWS SDK outside src/adapters/aws).
 *
 * Identity placeholders: topic templates come from
 * docs/busduct_edge_config.yaml (topics.telemetry / topics.alarm) and
 * resolve {customer_id}/{site_id}/{panel_id} from the identity block.
 * Until Slice 6's provisioning writes a real identity, defaults keep
 * the topics well-formed for the loopback. The heartbeat publishes on
 * the telemetry topic (the yaml defines no separate heartbeat topic;
 * its payload is distinguishable by shape).
 */

const TOPIC_TEMPLATES = {
  telemetry: 'dt/{customer_id}/{site_id}/{panel_id}/tel',
  alarm: 'dt/{customer_id}/{site_id}/{panel_id}/alarm',
};

const DEFAULT_IDENTITY = { customer_id: 'c0000', site_id: 's0000', panel_id: 'p0000' };
const DEFAULT_OUTBOX_DIR = '/var/busduct/outbox';

function resolveTopic(template, identity) {
  return template
    .replace('{customer_id}', identity.customer_id)
    .replace('{site_id}', identity.site_id)
    .replace('{panel_id}', identity.panel_id);
}

/**
 * Builds a fresh gateway service object. Exported for tests; Node-RED
 * function nodes should use getGateway() below so batching/dedupe
 * state survives across messages.
 *
 * @param {object} [opts]
 * @param {string} [opts.outboxDir]
 * @param {{customer_id: string, site_id: string, panel_id: string}} [opts.identity]
 * @param {{telemetry: string, alarm: string}} [opts.topics] - pre-resolved topics (override identity templates)
 * @param {object} [opts.transport] - custom transport (tests); default capped LoopbackTransport
 */
function createGateway({ outboxDir = DEFAULT_OUTBOX_DIR, identity = DEFAULT_IDENTITY, topics, transport, positional = false } = {}) {
  let t = transport ?? new LoopbackTransport({ maxPublished: 500 });

  // Soak evidence collection (combined Slice 5+6 soak) - inert unless
  // BUSDUCT_SOAK_LOG is set in Node-RED's environment.
  const soak = createSoakRecorder();
  if (soak) {
    t.onConnectionChange((connected) => soak.connection(connected));
    t = wrapTransportForSoak(t, soak);
  }

  const outbox = new Outbox({ dir: outboxDir, transport: t });
  const telemetryTopic = topics?.telemetry ?? resolveTopic(TOPIC_TEMPLATES.telemetry, identity);
  const alarmTopic = topics?.alarm ?? resolveTopic(TOPIC_TEMPLATES.alarm, identity);

  const gateway = {
    transport: t,
    soak,
    outbox,
    batcher: new Batcher({ outbox, topic: telemetryTopic, positional }),
    alarmPublisher: new AlarmPublisher({ outbox, topic: alarmTopic }),
    heartbeat: new Heartbeat({ outbox, topic: telemetryTopic }),
    settings: new RuntimeSettings({ dir: outboxDir }),
    topics: {
      telemetry: telemetryTopic,
      alarm: alarmTopic,
      ...(topics?.cmd_config ? { cmd_config: topics.cmd_config, cmd_config_ack: topics.cmd_config_ack } : {}),
      ...(topics?.cmd_cert ? { cmd_cert: topics.cmd_cert, cmd_cert_ack: topics.cmd_cert_ack } : {}),
    },
    mode: transport ? 'custom' : 'loopback', // createGatewayFromEdgeConfig overwrites with 'aws'
  };
  outbox.start(); // drain loop (5 msg/s); harmless with the loopback, required with a real transport
  return gateway;
}

/**
 * Composition root for the real panel (Slice 6): if a provisioned
 * edge config + operational certs exist, build the gateway on the AWS
 * IoT transport; otherwise fall back to the loopback (bench mode,
 * exactly as Slice 5 ran). This is the ONE place allowed to reach
 * into src/adapters/aws - the gateway logic itself still only sees
 * the transport interface (cloud-agnostic rule; the require is lazy
 * so bench setups never load mqtt at all).
 *
 * Returns { gateway, mode, reason } - reason says why loopback was
 * chosen, for the status debug in the flow.
 */
function createGatewayFromEdgeConfig() {
  const fs = require('node:fs');
  let cfg;
  try {
    const { loadEdgeConfig } = require('../../adapters/aws/edge-config');
    cfg = loadEdgeConfig();
  } catch (err) {
    return { gateway: createGateway(), mode: 'loopback', reason: `no usable edge config: ${err.message}` };
  }

  const missing = [cfg.mqtt.cert_path, cfg.mqtt.key_path, cfg.mqtt.root_ca_path].filter((p) => !fs.existsSync(p));
  if (missing.length > 0) {
    return {
      gateway: createGateway({ outboxDir: cfg.buffer.path, identity: cfg.identity, topics: cfg.topics }),
      mode: 'loopback',
      reason: `panel not provisioned yet - missing ${missing.join(', ')} (run tools/provision-panel.js)`,
    };
  }

  const { AwsIotTransport } = require('../../adapters/aws/aws-iot-transport');
  const transport = new AwsIotTransport({
    endpoint: cfg.mqtt.endpoint,
    port: cfg.mqtt.port,
    certPath: cfg.mqtt.cert_path,
    keyPath: cfg.mqtt.key_path,
    caPath: cfg.mqtt.root_ca_path,
    clientId: cfg.identity.thing_name,
    keepAliveSec: cfg.mqtt.keep_alive_sec,
    backoff: { initialSec: cfg.mqtt.reconnect_backoff.initial_sec, maxSec: cfg.mqtt.reconnect_backoff.max_sec },
    will: { topic: cfg.topics.telemetry, payload: { lwt: true, thing_name: cfg.identity.thing_name } },
  });
  transport.connect();
  // Positional telemetry is opt-in via publish.telemetry.encoding: 'positional'
  // in the edge config - OFF (keyed) by default until the cloud pipeline is
  // built to consume it (Slice 10, docs/slice10-design-proposals.md).
  const positional = cfg.publish?.telemetry?.encoding === 'positional';
  const gateway = createGateway({ outboxDir: cfg.buffer.path, identity: cfg.identity, topics: cfg.topics, transport, positional });
  gateway.mode = 'aws';
  return { gateway, mode: 'aws', cfg, reason: `connected as ${cfg.identity.thing_name} to ${cfg.mqtt.endpoint}` };
}

let singleton = null;
let singletonInfo = null;

/**
 * The process-wide gateway instance the Cloud Gateway tab's function
 * nodes share. On first call, picks the AWS transport when the panel
 * is provisioned (edge config + certs present), else loopback.
 */
function getGateway(opts) {
  if (!singleton) {
    if (opts) {
      singleton = createGateway(opts);
      singletonInfo = { mode: singleton.mode, reason: 'explicit options', identity: (opts && opts.identity) || null };
    } else {
      const { gateway, mode, reason, cfg } = createGatewayFromEdgeConfig();
      singleton = gateway;
      // identity is surfaced here (not re-read from the edge config elsewhere)
      // because this is the composition root - the one place allowed to require
      // from src/adapters/aws. The alarm mailer wants panel_id for its subject
      // line and must not reach into the adapter itself.
      singletonInfo = { mode, reason, identity: (cfg && cfg.identity) || null };
    }
  }
  return singleton;
}

/** Why the singleton is on the transport it's on - surfaced by the flow's status debug. */
function getGatewayInfo() {
  return singletonInfo;
}

// Local Pi power/throttling alarm (2026-07-29). Exposed on the EXISTING
// busductCloudGateway global rather than a new functionGlobalContext entry, so
// enabling it needs no settings.js change on deployed panels - it lives here
// because collectPiHealth() (its only input) already does.
const { derivePowerAlarm, summarizePower, initialState: initialPowerState, POWER_KEY } = require('../power-health');
const { collectPiHealth } = require('../pi-health');

module.exports = { createGateway, createGatewayFromEdgeConfig, getGateway, getGatewayInfo, resolveTopic, setupRemoteConfig, drainRemoteConfig, setupCertRotation, drainCertRotation, collectPiHealth, derivePowerAlarm, summarizePower, initialPowerState, POWER_KEY, ...handlers };
