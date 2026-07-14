'use strict';

const { LoopbackTransport } = require('../transport');
const { Outbox } = require('../outbox');
const { Batcher } = require('../batcher');
const { AlarmPublisher } = require('../alarm-publisher');
const { Heartbeat } = require('../heartbeat');
const handlers = require('./gateway-handler');

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
 * @param {object} [opts.transport] - custom transport (tests); default capped LoopbackTransport
 */
function createGateway({ outboxDir = DEFAULT_OUTBOX_DIR, identity = DEFAULT_IDENTITY, transport } = {}) {
  const t = transport ?? new LoopbackTransport({ maxPublished: 500 });
  const outbox = new Outbox({ dir: outboxDir, transport: t });
  const telemetryTopic = resolveTopic(TOPIC_TEMPLATES.telemetry, identity);
  const alarmTopic = resolveTopic(TOPIC_TEMPLATES.alarm, identity);

  const gateway = {
    transport: t,
    outbox,
    batcher: new Batcher({ outbox, topic: telemetryTopic }),
    alarmPublisher: new AlarmPublisher({ outbox, topic: alarmTopic }),
    heartbeat: new Heartbeat({ outbox, topic: telemetryTopic }),
    topics: { telemetry: telemetryTopic, alarm: alarmTopic },
  };
  outbox.start(); // drain loop (5 msg/s); harmless with the loopback, required with a real transport
  return gateway;
}

let singleton = null;

/** The process-wide gateway instance the Cloud Gateway tab's function nodes share. */
function getGateway(opts) {
  if (!singleton) singleton = createGateway(opts);
  return singleton;
}

module.exports = { createGateway, getGateway, resolveTopic, ...handlers };
