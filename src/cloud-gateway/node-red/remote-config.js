'use strict';

const { setTelemetryInterval } = require('./gateway-handler');
const { MIN_INTERVAL, MAX_INTERVAL } = require('../runtime-settings');

/**
 * Slice 7 wiring, split into two halves on purpose:
 *
 *   setupRemoteConfig() - runs once at boot. Subscribes the transport
 *     to cmd/{c}/{s}/{p}/config with a callback that does NOTHING but
 *     push the raw cloud message onto an in-memory inbox on the
 *     gateway singleton. It must NOT touch Node-RED context or
 *     node.send from here: this callback is long-lived and detached
 *     (it was captured from a single boot execution of the setup
 *     function node); after a redeploy those `global`/`node` handles
 *     go stale and context writes from them silently fail to land -
 *     which showed up live as "ack applied + store updated, but the
 *     running Alarm Manager kept the old thresholds".
 *
 *   drainRemoteConfig() - called by a fast flow tick, so it runs in a
 *     normal Node-RED message execution with a FRESH `global`. It
 *     drains the inbox, runs the pure handler per message, and applies
 *     every side effect (context writes, outbox ack, audits) here,
 *     where the context writes are guaranteed to persist. Returns the
 *     per-message send arrays for the tick function node to emit.
 *
 * This is the same decoupling the outbox uses (async receipt ->
 * queue -> drained by a tick in message context).
 */

function setupRemoteConfig({ gateway }) {
  const cmdTopic = gateway.topics.cmd_config;
  const ackTopic = gateway.topics.cmd_config_ack;
  if (!cmdTopic || !ackTopic) {
    return { enabled: false, reason: 'no cmd topics resolved (no edge config) - remote config disabled' };
  }
  if (!gateway._remoteConfigInbox) gateway._remoteConfigInbox = [];
  if (gateway._remoteConfigSubscribed) {
    return { enabled: true, topic: cmdTopic, reason: 'already subscribed' };
  }
  gateway._remoteConfigSubscribed = true;
  gateway.transport.subscribe(cmdTopic, (payload) => {
    gateway._remoteConfigInbox.push(payload);
  });
  return { enabled: true, topic: cmdTopic };
}

/**
 * Drains queued remote-config messages and applies them in the caller's
 * (message-context) global scope. Returns an array of send-arrays -
 * one per processed message - for the flow node to node.send().
 *
 * @param {object} gateway
 * @param {object} configService - global.get('busductConfigService')
 * @param {{get: Function, set: Function}} globalContext - the tick function node's `global`
 */
function drainRemoteConfig(gateway, configService, globalContext) {
  const inbox = gateway._remoteConfigInbox;
  if (!inbox || inbox.length === 0) return [];
  const store = configService.createStore();
  const ackTopic = gateway.topics.cmd_config_ack;
  const sends = [];

  let payload;
  while ((payload = inbox.shift()) !== undefined) {
    let result;
    try {
      result = configService.processRemoteConfig(payload, {
        store,
        maintenanceMode: globalContext.get('maintenanceMode') === true,
        telemetryInterval: {
          min: MIN_INTERVAL,
          max: MAX_INTERVAL,
          apply: (min) => setTelemetryInterval(gateway, min),
        },
      });
    } catch (err) {
      result = {
        ack: {
          request_id: typeof payload?.request_id === 'string' ? payload.request_id : null,
          domain: payload?.domain ?? null,
          result: 'rejected',
          errors: [{ rule: 'INTERNAL', message: String(err?.message ?? err) }],
          timestamp: new Date().toISOString(),
        },
        applied: false,
      };
    }

    // A10: the running Alarm Manager evaluates every sample against this
    // global (store "default", matching how it reads it). Written HERE,
    // in message context - see the module comment.
    let runtimeWritten = null;
    if (result.runtimeConfig) {
      globalContext.set('busbartherm_system_config', result.runtimeConfig, 'default');
      runtimeWritten = globalContext.get('busbartherm_system_config', 'default'); // readback for the debug
    }

    let paraRaw = null;
    if (result.applied && result.domain === 'modbus_joints') {
      const legacy = configService.deriveLegacyBridge(result.newDoc, globalContext.get('SlaveIDList') || []);
      configService.writeLegacyModbusGlobals(globalContext, legacy);
      paraRaw = legacy.paraRaw;
      globalContext.set('joint_master_zone_A', result.drafts.joints);
      globalContext.set('zone_master', result.drafts.zones);
      globalContext.set('modbus_settings_draft', null);
    }

    for (const audit of result.audits ?? []) {
      configService.appendLegacyAudit(globalContext, audit.key, audit.entry);
    }

    if (ackTopic) gateway.outbox.enqueue('alarm', ackTopic, result.ack, 1);
    gateway.soak?.flushStatus({ remote_config: result.ack });

    sends.push([
      {
        payload: {
          remote_config: {
            domain: result.ack.domain,
            result: result.ack.result,
            request_id: result.ack.request_id,
            errors: result.ack.errors,
            live_thresholds_written: runtimeWritten ? true : undefined,
          },
        },
      },
      result.resendNeeded ? { payload: 'remote-apply' } : null,
      paraRaw ? { payload: paraRaw } : null,
    ]);
  }

  return sends;
}

module.exports = { setupRemoteConfig, drainRemoteConfig };
