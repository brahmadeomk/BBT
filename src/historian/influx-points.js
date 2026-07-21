'use strict';

/**
 * Local historian ingestion (InfluxDB 1.x on the Pi). Turns a
 * ProcessLogic KPI-stream message (the same internal-bus taps the
 * Cloud Gateway consumes - see docs/internal-message-contracts.md)
 * into InfluxDB points for the node-red-contrib-influxdb *batch* node.
 *
 * One measurement, `bt_kpi`, carries every configured sensor:
 *   tags   sensor_id (joint_id, or "AMBIENT_<n>" for ambient probes),
 *          zone_id, slave_id, kind ("joint" | "ambient")
 *   fields temp_c (absolute reading, always), and for joints the
 *          derived KPIs ema_temp_c, delta_t_c, delta_t_raw_c,
 *          ror_c_hr, ambient_c
 *   time   the message's edge UTC timestamp (ms)
 *
 * Tag cardinality is bounded (≈ sensors × zones), which is what
 * InfluxDB wants. The retention/downsampling tiers (raw 7d, 1h rollup
 * 90d, 1d rollup ~5y) live in the continuous queries, not here - see
 * tools/influx-setup.influxql and docs/historian.md.
 *
 * Design choices (flagged for the design chat):
 *  - Points are written only when sensor_status === "OK". A faulty or
 *    stale reading would poison trend aggregates; the gap in the
 *    historian marks the outage, and the alarm/audit trail already
 *    records the fault itself.
 *  - "unassigned" sensors (topic "unassigned") are NOT historised -
 *    they aren't configured joints/ambient references. Easy to add
 *    later if wanted.
 *
 * @param {object} msg - Node-RED msg from a KPI tap (msg.topic "joint" | "ambient")
 * @param {object} [opts]
 * @param {string} [opts.measurement]
 * @returns {Array<{measurement: string, fields: object, tags: object, timestamp: number}>}
 *   0 or 1 points, shaped for the influxdb batch node
 */
function toInfluxPoints(msg, { measurement = 'bt_kpi' } = {}) {
  const p = msg?.payload;
  if (!p || typeof p !== 'object') return [];
  if (msg.topic !== 'joint' && msg.topic !== 'ambient') return [];
  if (p.sensor_status && p.sensor_status !== 'OK') return [];
  if (typeof p.val !== 'number' || !Number.isFinite(p.val)) return [];

  const timestamp = Number.isFinite(Date.parse(p.timestamp)) ? Date.parse(p.timestamp) : Date.now();

  const tags = {
    sensor_id: String(p.joint_id),
    zone_id: p.zone_id != null ? String(p.zone_id) : 'UNKNOWN',
    kind: msg.topic,
  };
  if (p.slaveID != null) tags.slave_id = String(p.slaveID);

  const fields = { temp_c: p.val };
  if (msg.topic === 'joint') {
    if (Number.isFinite(p.emaTemp)) fields.ema_temp_c = p.emaTemp;
    if (Number.isFinite(p.ror)) fields.ror_c_hr = p.ror;
    if (p.deltaT && Number.isFinite(p.deltaT.ema)) fields.delta_t_c = p.deltaT.ema;
    if (p.deltaT && Number.isFinite(p.deltaT.raw)) fields.delta_t_raw_c = p.deltaT.raw;
    if (p.ambient && Number.isFinite(p.ambient.val)) fields.ambient_c = p.ambient.val;
  }

  return [{ measurement, fields, tags, timestamp }];
}

module.exports = { toInfluxPoints };
