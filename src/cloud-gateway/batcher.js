'use strict';

const { MESSAGE_TYPES, TELEMETRY_ENCODINGS } = require('./message-types');

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
  /**
   * @param {boolean} [opts.positional] - default false (keyed JSON). When
   *   true, flush emits a compact COLUMN-oriented positional payload keyed by
   *   a versioned manifest (index -> joint_id), so the whole 100-joint panel
   *   fits in ~one message instead of several 5KB metering blocks (Slice 10).
   *   OFF by default: the live keyed format is unchanged until the cloud
   *   pipeline is built to consume positional (see docs/slice10-design-proposals.md).
   */
  constructor({ outbox, topic, maxPayloadBytes = 4800, includeAmbient = true, positional = false }) {
    this.outbox = outbox;
    this.topic = topic;
    this.maxPayloadBytes = maxPayloadBytes;
    this.includeAmbient = includeAmbient;
    this.positional = positional;
    this.accumulators = new Map(); // joint_id -> { dtValues, rorValues, tValues, ambientValues }
    this.manifest = []; // stable ordered joint_ids; index -> joint_id
    this.manifestVersion = 0;
    this._manifestDirty = false;
  }

  /**
   * Set the stable joint order (called on config apply). Appending keeps
   * existing indices stable; a reorder/removal bumps the version so the
   * cloud re-fetches. Positional payloads always reference this order.
   */
  setManifest(jointIds) {
    const next = jointIds.slice();
    if (JSON.stringify(next) === JSON.stringify(this.manifest)) return;
    this.manifest = next;
    this.manifestVersion += 1;
    this._manifestDirty = true;
  }

  _ensureManifestFrom(jointIds) {
    // self-heal: append any reporting joint not yet in the manifest (stable
    // indices) so positional works even before setManifest is called at boot.
    let changed = false;
    for (const id of jointIds) {
      if (!this.manifest.includes(id)) {
        this.manifest.push(id);
        changed = true;
      }
    }
    if (changed) {
      this.manifestVersion += 1;
      this._manifestDirty = true;
    }
  }

  manifestMessage() {
    return {
      type: MESSAGE_TYPES.MANIFEST,
      manifest_version: this.manifestVersion,
      joints: this.manifest.slice(),
      timestamp: new Date().toISOString(),
    };
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
        // amb_avg, not "ambient": every wire field names its statistic
        // (dt_min/dt_max/dt_avg/ror_max/t_max), this value IS an interval
        // average, and the positional encoding already called it amb_avg.
        // The INPUT kpi.ambient is an object {slaveID, val, age_sec}; reusing
        // that name for a bare number on the wire was the drift (CR-OPEN-5).
        entry.amb_avg = acc.ambientValues.reduce((a, b) => a + b, 0) / acc.ambientValues.length;
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
    const agg = this._buildJointAggregates();
    this.accumulators.clear();

    const reporting = Object.keys(agg);
    if (reporting.length === 0) return 0;

    const nowIso = new Date().toISOString(); // edge_utc, per buffer.timestamp_source

    if (!this.positional) {
      const chunks = this._packIntoChunks(Object.entries(agg), intervalMin, nowIso);
      for (const chunk of chunks) {
        this.outbox.enqueue('telemetry', this.topic, chunk, 0); // qos 0, per publish.telemetry.qos
      }
      return chunks.length;
    }

    // Positional mode: publish the manifest first when it changed (QoS 1 so
    // the cloud can always decode), then the compact column payload(s).
    this._ensureManifestFrom(reporting);
    if (this._manifestDirty) {
      this.outbox.enqueue('telemetry', this.topic, this.manifestMessage(), 1);
      this._manifestDirty = false;
    }
    const chunks = this._packPositional(agg, intervalMin, nowIso);
    for (const chunk of chunks) {
      this.outbox.enqueue('telemetry', this.topic, chunk, 0);
    }
    return chunks.length;
  }

  _columns() {
    const cols = ['dt_min', 'dt_max', 'dt_avg', 'ror_max', 't_max'];
    if (this.includeAmbient) cols.push('amb_avg');
    return cols;
  }

  // Map an aggregate entry field to its positional column value (rounded to
  // 0.01; null when the joint had no data for that column this interval).
  _cell(entry, col) {
    if (!entry) return null;
    // Keyed and positional now use identical field names, so no mapping is
    // needed here - that mapping was where the two encodings drifted apart.
    const v = entry[col];
    return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  }

  _buildPositionalChunk(agg, cols, intervalMin, timestamp, start, end) {
    const slice = this.manifest.slice(start, end);
    const chunk = {
      type: MESSAGE_TYPES.TELEMETRY,
      encoding: TELEMETRY_ENCODINGS.POSITIONAL,
      timestamp,
      interval_min: intervalMin,
      manifest_version: this.manifestVersion,
      start_index: start,
      count: slice.length,
    };
    for (const col of cols) chunk[col] = slice.map((jointId) => this._cell(agg[jointId], col));
    return chunk;
  }

  _packPositional(agg, intervalMin, timestamp) {
    const cols = this._columns();
    const n = this.manifest.length;
    const fits = (chunk) => Buffer.byteLength(JSON.stringify(chunk), 'utf8') <= this.maxPayloadBytes;

    const full = this._buildPositionalChunk(agg, cols, intervalMin, timestamp, 0, n);
    if (fits(full)) return [full]; // the common case: whole panel in one message

    // Too big - split into contiguous index ranges, each carrying start_index.
    const chunks = [];
    let start = 0;
    while (start < n) {
      let end = start + 1;
      while (end < n && fits(this._buildPositionalChunk(agg, cols, intervalMin, timestamp, start, end + 1))) end++;
      chunks.push(this._buildPositionalChunk(agg, cols, intervalMin, timestamp, start, end));
      start = end;
    }
    return chunks;
  }

  _packIntoChunks(jointEntries, intervalMin, timestamp) {
    const envelope = (joints) => ({
      type: MESSAGE_TYPES.TELEMETRY,
      encoding: TELEMETRY_ENCODINGS.KEYED,
      timestamp,
      interval_min: intervalMin,
      joints,
    });
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
