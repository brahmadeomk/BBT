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
/**
 * Coerce a KPI value to a finite number. The internal-bus contract
 * documents these as numbers, but the live ProcessLogic pipeline emits
 * them as numeric STRINGS ("31.39"); accept those. Returns null for
 * anything that isn't a real reading (null/""/bool/NaN/non-numeric) so
 * the caller drops it rather than recording a bogus 0.
 */
function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toInfluxPoints(msg, { measurement = 'bt_kpi' } = {}) {
  const p = msg?.payload;
  if (!p || typeof p !== 'object') return [];
  if (msg.topic !== 'joint' && msg.topic !== 'ambient') return [];
  // Live ProcessLogic emits sensor_status lowercase ("ok"); the contract
  // doc shows "OK". Compare case-insensitively (and trim) so a healthy
  // reading isn't dropped, while real faults ("Sensor_Error", etc.) still
  // skip.
  if (p.sensor_status && String(p.sensor_status).trim().toUpperCase() !== 'OK') return [];

  const val = num(p.val); // absolute reading (may arrive as a numeric string)
  if (val === null) return [];

  const timestamp = Number.isFinite(Date.parse(p.timestamp)) ? Date.parse(p.timestamp) : Date.now();

  const tags = {
    sensor_id: String(p.joint_id),
    zone_id: p.zone_id != null ? String(p.zone_id) : 'UNKNOWN',
    kind: msg.topic,
  };
  if (p.slaveID != null) tags.slave_id = String(p.slaveID);

  const fields = { temp_c: val };
  if (msg.topic === 'joint') {
    const ema = num(p.emaTemp);
    if (ema !== null) fields.ema_temp_c = ema;
    const ror = num(p.ror);
    if (ror !== null) fields.ror_c_hr = ror;
    const dtEma = p.deltaT ? num(p.deltaT.ema) : null;
    if (dtEma !== null) fields.delta_t_c = dtEma;
    const dtRaw = p.deltaT ? num(p.deltaT.raw) : null;
    if (dtRaw !== null) fields.delta_t_raw_c = dtRaw;
    const amb = p.ambient ? num(p.ambient.val) : null;
    if (amb !== null) fields.ambient_c = amb;
  }

  return [{ measurement, fields, tags, timestamp }];
}

module.exports = { toInfluxPoints };
