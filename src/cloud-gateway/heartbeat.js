'use strict';

const { MESSAGE_TYPES, SCHEMA_VERSION } = require('./message-types');

/**
 * Hourly liveness ping (busduct_edge_config.yaml: publish.heartbeat,
 * interval_min: 60, qos: 0) so the cloud can mark a panel offline
 * after 2 missed heartbeats. Carries firmware/config versions so the
 * cloud always knows what's actually running without a separate poll.
 */
class Heartbeat {
  /**
   * @param {object} opts
   * @param {import('./outbox').Outbox} opts.outbox
   * @param {string} opts.topic
   */
  constructor({ outbox, topic }) {
    this.outbox = outbox;
    this.topic = topic;
  }

  /**
   * @param {object} status
   * @param {string} status.fwVersion - reported firmware version (busduct_edge_config.yaml identity.fw_version)
   * @param {object} status.configVersions - e.g. { modbus, joints, alarms } from ConfigStore.getAppliedVersions
   * @param {object} [status.system] - edge hardware health snapshot (see pi-health.js):
   *   cpu_temp_c, mac_id, ram_free_mb, ram_available_mb, low_voltage
   */
  send(status) {
    const payload = {
      type: MESSAGE_TYPES.HEARTBEAT,
      v: SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      fwVersion: status.fwVersion,
      configVersions: status.configVersions,
      ...(status.system ? { system: status.system } : {}),
    };
    this.outbox.enqueue('telemetry', this.topic, payload, 0); // qos 0, per publish.heartbeat.qos
  }
}

module.exports = { Heartbeat };
