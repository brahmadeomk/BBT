'use strict';

/**
 * Aggregates ProcessLogic's KPI stream ("joint" messages - see
 * docs/internal-message-contracts.md) into one batched telemetry
 * payload per panel per interval, matching
 * busduct_edge_config.yaml's publish.telemetry policy exactly:
 * batch_aggregate mode (never per-joint, never per-sample), computed
 * per joint over the interval: dt_min/dt_max/dt_avg (from
 * deltaT.ema), ror_max (from ror), t_max (from val, the raw reading -
 * distinct from dt_max, which tracks delta-T not absolute
 * temperature), plus each joint's average ambient reading when
 * include_ambient is set.
 *
 * "One message per panel per interval" is the normal case, but a
 * panel with enough joints could exceed max_payload_bytes (the 5KB
 * AWS metering block) in a single message - rather than silently
 * dropping joints to fit, flush() splits into multiple chunk payloads
 * for the same interval so nothing is lost.
 */
class Batcher {
  /**
   * @param {object} opts
   * @param {import('./outbox').Outbox} opts.outbox
   * @param {string} opts.topic - telemetry topic to enqueue to (e.g. resolved from busduct_edge_config.yaml's topics.telemetry)
   * @param {number} [opts.maxPayloadBytes] - default 4800, matching publish.telemetry.max_payload_bytes
   * @param {boolean} [opts.includeAmbient] - default true, matching publish.telemetry.include_ambient
   */
  constructor({ outbox, topic, maxPayloadBytes = 4800, includeAmbient = true }) {
    this.outbox = outbox;
    this.topic = topic;
    this.maxPayloadBytes = maxPayloadBytes;
    this.includeAmbient = includeAmbient;
    this.accumulators = new Map(); // joint_id -> { dtValues, rorValues, tValues, ambientValues }
  }

  _accumulatorFor(jointId) {
    if (!this.accumulators.has(jointId)) {
      this.accumulators.set(jointId, { dtValues: [], rorValues: [], tValues: [], ambientValues: [] });
    }
    return this.accumulators.get(jointId);
  }

  /** Feed one ProcessLogic "joint" output message (msg.topic === "joint") into the current interval's accumulator. */
  ingestJointKpi(kpi) {
    const acc = this._accumulatorFor(kpi.joint_id);
    if (typeof kpi.deltaT?.ema === 'number') acc.dtValues.push(kpi.deltaT.ema);
    if (typeof kpi.ror === 'number') acc.rorValues.push(kpi.ror);
    if (typeof kpi.val === 'number') acc.tValues.push(kpi.val);
    if (this.includeAmbient && typeof kpi.ambient?.val === 'number') acc.ambientValues.push(kpi.ambient.val);
  }

  _buildJointAggregates() {
    const joints = {};
    for (const [jointId, acc] of this.accumulators) {
      const entry = {};
      if (acc.dtValues.length) {
        entry.dt_min = Math.min(...acc.dtValues);
        entry.dt_max = Math.max(...acc.dtValues);
        entry.dt_avg = acc.dtValues.reduce((a, b) => a + b, 0) / acc.dtValues.length;
      }
      if (acc.rorValues.length) entry.ror_max = Math.max(...acc.rorValues);
      if (acc.tValues.length) entry.t_max = Math.max(...acc.tValues);
      if (this.includeAmbient && acc.ambientValues.length) {
        entry.ambient = acc.ambientValues.reduce((a, b) => a + b, 0) / acc.ambientValues.length;
      }
      if (Object.keys(entry).length) joints[jointId] = entry;
    }
    return joints;
  }

  /**
   * Ends the current interval: builds the aggregate payload(s) (split
   * into multiple chunks only if needed to fit max_payload_bytes),
   * enqueues each to the outbox as telemetry (QoS 0 per policy), and
   * resets accumulators for the next interval.
   *
   * @param {number} intervalMin
   * @returns {number} number of payload chunks emitted
   */
  flush(intervalMin) {
    const jointEntries = Object.entries(this._buildJointAggregates());
    this.accumulators.clear();

    if (jointEntries.length === 0) return 0;

    const nowIso = new Date().toISOString(); // edge_utc, per buffer.timestamp_source
    const chunks = this._packIntoChunks(jointEntries, intervalMin, nowIso);
    for (const chunk of chunks) {
      this.outbox.enqueue('telemetry', this.topic, chunk, 0); // qos 0, per publish.telemetry.qos
    }
    return chunks.length;
  }

  _packIntoChunks(jointEntries, intervalMin, timestamp) {
    const envelope = (joints) => ({ timestamp, interval_min: intervalMin, joints });
    const fitsBudget = (joints) => Buffer.byteLength(JSON.stringify(envelope(joints)), 'utf8') <= this.maxPayloadBytes;

    if (fitsBudget(Object.fromEntries(jointEntries))) {
      return [envelope(Object.fromEntries(jointEntries))];
    }

    // Doesn't fit in one message - split greedily so no joint's data is dropped.
    const chunks = [];
    let current = {};
    for (const [jointId, entry] of jointEntries) {
      const candidate = { ...current, [jointId]: entry };
      if (Object.keys(current).length > 0 && !fitsBudget(candidate)) {
        chunks.push(envelope(current));
        current = { [jointId]: entry };
      } else {
        current = candidate;
      }
    }
    if (Object.keys(current).length > 0) chunks.push(envelope(current));
    return chunks;
  }
}

module.exports = { Batcher };
