'use strict';

const { setTelemetryInterval } = require('./gateway-handler');
const { MIN_INTERVAL, MAX_INTERVAL } = require('../runtime-settings');

/**
 * Slice 7 wiring: subscribes the gateway's transport to the remote
 * config topic (cmd/{c}/{s}/{p}/config) and, per message, runs the
 * pure handler (config-service processRemoteConfig) then applies its
 * side effects:
 *
 *   - ack -> outbox alarm class (QoS 1, survives link drops, ordered)
 *   - runtimeConfig -> busbartherm_system_config global (A10 live
 *     re-evaluation by the running Alarm Manager)
 *   - accepted modbus_joints doc -> legacy decode-pipeline bridge +
 *     rebuilt dashboard drafts (same as a local Modbus Settings apply)
 *   - audits -> the legacy audit viewer globals
 *   - accepted edge knob -> gateway telemetry interval
 *   - node.send(...) -> flow outputs (status debug, Nano resend
 *     trigger, paraRaw sync), emitted asynchronously per message
 *
 * Works over any transport implementing subscribe() - on the loopback
 * this makes the whole channel bench-testable (publish into the
 * loopback = a simulated cloud push); on AWS the subscription rides
 * the real broker and is replayed on every reconnect.
 *
 * @param {object} opts
 * @param {object} opts.gateway - getGateway() result
 * @param {object} opts.configService - global.get('busductConfigService')
 * @param {{get: Function, set: Function}} opts.globalContext - the function node's `global`
 * @param {{send: Function, warn?: Function}} opts.node - the function node (async sends)
 * @returns {{enabled: boolean, topic?: string, reason?: string}}
 */
function setupRemoteConfig({ gateway, configService, globalContext, node }) {
  const cmdTopic = gateway.topics.cmd_config;
  const ackTopic = gateway.topics.cmd_config_ack;
  if (!cmdTopic || !ackTopic) {
    return { enabled: false, reason: 'no cmd topics resolved (no edge config) - remote config disabled' };
  }
  if (gateway._remoteConfigSetup) {
    return { enabled: true, topic: cmdTopic, reason: 'already subscribed' };
  }
  gateway._remoteConfigSetup = true;

  const store = configService.createStore();

  gateway.transport.subscribe(cmdTopic, (payload) => {
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

    try {
      // A10: the running Alarm Manager reads this global on every sample
      if (result.runtimeConfig) {
        globalContext.set('busbartherm_system_config', result.runtimeConfig, 'default');
      }
      // accepted remote modbus change behaves exactly like a local apply:
      // decode-pipeline globals + dashboard drafts follow the new document
      let paraRaw = null;
      if (result.applied && result.domain === 'modbus_joints') {
        const legacy = configService.deriveLegacyBridge(result.newDoc, globalContext.get('SlaveIDList') || []);
        configService.writeLegacyModbusGlobals(globalContext, legacy);
        paraRaw = legacy.paraRaw;
        globalContext.set('joint_master_zone_A', result.drafts.joints);
        globalContext.set('zone_master', result.drafts.zones);
        globalContext.set('modbus_settings_draft', null); // next dashboard load rebuilds from the store
      }
      for (const audit of result.audits ?? []) {
        configService.appendLegacyAudit(globalContext, audit.key, audit.entry);
      }

      gateway.outbox.enqueue('alarm', ackTopic, result.ack, 1);
      gateway.soak?.flushStatus({ remote_config: result.ack });

      node.send([
        { payload: { remote_config: { domain: result.ack.domain, result: result.ack.result, request_id: result.ack.request_id, errors: result.ack.errors } } },
        result.resendNeeded ? { payload: 'remote-apply' } : null,
        paraRaw ? { payload: paraRaw } : null,
      ]);
    } catch (err) {
      node.warn?.(`remote config side effects failed: ${err.message}`);
    }
  });

  return { enabled: true, topic: cmdTopic };
}

module.exports = { setupRemoteConfig };
