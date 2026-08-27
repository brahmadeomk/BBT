'use strict';

const { MESSAGE_TYPES } = require('../message-types');

const { CertRotator } = require('../cert-rotation');

/**
 * Certificate rotation channel wiring (Readiness Workplan Phase 1),
 * following the same two-half receipt/apply split as the remote config
 * channel (remote-config.js) - and for the same reason: the subscribe
 * callback is long-lived/detached, so it does nothing but queue the raw
 * message; a flow tick drains and applies in normal message context.
 *
 * The channel is a dedicated cmd/{c}/{s}/{p}/cert topic (ack on
 * .../cert/ack), separate from the config channel: rotation is a rarer,
 * connection-affecting, higher-privilege operation and shouldn't share
 * the fast config drain. It's only enabled when the gateway runs on a
 * transport that can reload credentials (the AWS/MQTT-TLS transport) -
 * on the loopback/bench transport it reports disabled.
 *
 * Envelope (published by the cloud, QoS 1):
 *   {
 *     "request_id":     "opaque string echoed in the ack",
 *     "user":           "who/what pushed (audit trail)",
 *     "certificate":    "<new operational cert, PEM>",
 *     "private_key":    "<new operational key, PEM>",
 *     "ca":             "<new root CA, PEM - optional, usually omitted>",
 *     "certificate_id": "AWS cert id (optional, for audit only)"
 *   }
 *
 * Ack (on cmd/.../cert/ack, QoS 1 via the outbox alarm class):
 *   { request_id, domain: "cert", result: "applied"|"rejected",
 *     certificate_id?, rolled_back?, errors?: [{rule, message}], timestamp }
 */

function setupCertRotation({ gateway }) {
  // OFF by default. Subscribing to cmd/.../cert before the panel's AWS IoT
  // policy grants that topic makes AWS IoT Core drop the ENTIRE connection
  // (unauthorized subscribe = disconnect), taking live telemetry down with
  // it - which is exactly the "a rotation problem must never take down local
  // monitoring" rule. Enable only AFTER updating the device policy to grant
  // the cert topics (docs/aws/README.md Part F): set BUSDUCT_CERT_ROTATION=1
  // in Node-RED's environment and restart.
  const flag = process.env.BUSDUCT_CERT_ROTATION;
  if (flag !== '1' && flag !== 'true') {
    return {
      enabled: false,
      reason: 'cert rotation disabled - grant the cmd/.../cert topic in the AWS IoT policy, then set BUSDUCT_CERT_ROTATION=1',
    };
  }

  const cmdTopic = gateway.topics.cmd_cert;
  const ackTopic = gateway.topics.cmd_cert_ack;
  if (!cmdTopic || !ackTopic) {
    return { enabled: false, reason: 'no cert cmd topics resolved (no edge config) - cert rotation disabled' };
  }
  const t = gateway.transport;
  if (typeof t.reloadCredentials !== 'function' || !t.certPath) {
    return { enabled: false, reason: 'transport cannot reload credentials (loopback/bench) - cert rotation disabled' };
  }

  if (!gateway._certRotationInbox) gateway._certRotationInbox = [];
  if (!gateway._certRotator) {
    gateway._certRotator = new CertRotator({
      certPath: t.certPath,
      keyPath: t.keyPath,
      caPath: t.caPath,
      reconnectAndVerify: (verifyTimeoutSec) => t.reloadCredentials({ verifyTimeoutSec }),
    });
  }
  if (gateway._certRotationSubscribed) {
    return { enabled: true, topic: cmdTopic, reason: 'already subscribed' };
  }
  gateway._certRotationSubscribed = true;
  gateway.transport.subscribe(cmdTopic, (payload) => {
    gateway._certRotationInbox.push(payload);
  });
  return { enabled: true, topic: cmdTopic };
}

/**
 * Drains queued cert-rotation messages, rotating one at a time (the
 * CertRotator's own _busy guard also protects against overlap). Async:
 * each rotation reconnects the transport and waits for the broker to
 * accept (or reject) the new cert before moving on. Returns send-arrays
 * for the tick function node.
 *
 * @param {object} gateway
 * @param {object} configService - global.get('busductConfigService') (for the audit trail)
 * @param {{get: Function, set: Function}} globalContext - the tick function node's `global`
 * @returns {Promise<Array>}
 */
async function drainCertRotation(gateway, configService, globalContext) {
  const inbox = gateway._certRotationInbox;
  if (!inbox || inbox.length === 0) return [];
  const rotator = gateway._certRotator;
  const ackTopic = gateway.topics.cmd_cert_ack;
  const sends = [];

  let payload;
  while ((payload = inbox.shift()) !== undefined) {
    const requestId = typeof payload?.request_id === 'string' ? payload.request_id : null;
    const user = typeof payload?.user === 'string' ? `remote:${payload.user}` : 'remote';

    let outcome;
    try {
      outcome = await rotator.rotate(payload);
    } catch (err) {
      outcome = { ok: false, rolledBack: false, error: String(err?.message ?? err) };
    }

    const ack = {
      type: MESSAGE_TYPES.CERT_ACK,
      request_id: requestId,
      domain: 'cert',
      result: outcome.ok ? 'applied' : 'rejected',
      certificate_id: outcome.certificate_id ?? null,
      rolled_back: outcome.rolledBack || undefined,
      errors: outcome.ok ? undefined : [{ rule: 'CERT', message: outcome.error }],
      timestamp: new Date().toISOString(),
    };
    if (ackTopic) gateway.outbox.enqueue('alarm', ackTopic, ack, 1);

    // Audit trail - runs in message context (fresh global), so the
    // write lands (unlike the detached subscribe callback).
    try {
      configService.appendLegacyAudit(globalContext, 'joint_config_audit_log', {
        timestamp: new Date().toISOString(),
        user,
        action: 'CERT_ROTATION',
        details: outcome.ok
          ? `REMOTE: operational certificate rotated${outcome.certificate_id ? ` (${outcome.certificate_id})` : ''}`
          : `REMOTE REJECTED: cert rotation - ${outcome.error}`,
      });
    } catch {
      /* audit is best-effort; never let it fail the rotation ack */
    }

    gateway.soak?.flushStatus({ cert_rotation: ack });
    sends.push([{ payload: { cert_rotation: ack } }]);
  }

  return sends;
}

module.exports = { setupCertRotation, drainCertRotation };
