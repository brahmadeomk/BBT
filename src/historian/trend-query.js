'use strict';

// Trend viewer logic for the in-HMI historian screen.
//
// Pure, unit-testable helpers the Node-RED "Trends" tab calls through the
// busductHistorian global:
//   - buildTrendQuery(sensorId, rangeKey) -> InfluxQL string for the
//     influxdb query node (msg.query).
//   - resultsToChart(rows, rangeKey)      -> a node-red-dashboard ui_chart
//     "load historic data" payload.
//   - sensorOptionsFromTagValues(rows)    -> ui_dropdown option list built
//     from SHOW TAG VALUES output.
//
// The read side deliberately mirrors the write side (influx-points.js) and
// the retention tiers set up by tools/influx-setup.influxql: raw for the
// 7-day full-resolution view, rollup_1h for daily/weekly, rollup_1d for
// monthly/yearly.

// Each range picks a retention policy + measurement (matching
// influx-setup.influxql) and the columns to chart. Raw carries the sample
// values; the rollups carry mean/max aggregates produced by the continuous
// queries. Every series is in degrees C except rate-of-rise (C/hr) - the
// operator can toggle a series off via the chart legend if the scales
// clash.
const RAW_FIELDS = [
  { col: 'temp_c', series: 'Temp °C' },
  { col: 'ambient_c', series: 'Ambient °C' },
  { col: 'delta_t_c', series: 'ΔT °C' },
  { col: 'ror_c_hr', series: 'RoR °C/hr' },
];

const ROLLUP_FIELDS = [
  { col: 'temp_c_mean', series: 'Temp mean °C' },
  { col: 'temp_c_max', series: 'Temp max °C' },
  { col: 'ambient_c_mean', series: 'Ambient mean °C' },
  { col: 'delta_t_c_max', series: 'ΔT max °C' },
  { col: 'ror_c_hr_max', series: 'RoR max °C/hr' },
];

const RANGES = [
  { key: 'raw7d', label: 'Live · 7 days (full)', rp: 'raw', measurement: 'bt_kpi', duration: '7d', fields: RAW_FIELDS },
  { key: 'day30', label: 'Daily · 30 days', rp: 'rollup_1h', measurement: 'bt_kpi_1h', duration: '30d', fields: ROLLUP_FIELDS },
  { key: 'week90', label: 'Weekly · 90 days', rp: 'rollup_1h', measurement: 'bt_kpi_1h', duration: '90d', fields: ROLLUP_FIELDS },
  { key: 'month1y', label: 'Monthly · 1 year', rp: 'rollup_1d', measurement: 'bt_kpi_1d', duration: '365d', fields: ROLLUP_FIELDS },
  { key: 'year5', label: 'Yearly · 5 years', rp: 'rollup_1d', measurement: 'bt_kpi_1d', duration: '1825d', fields: ROLLUP_FIELDS },
];

const DEFAULT_RANGE = 'raw7d';

function rangeFor(rangeKey) {
  return RANGES.find((r) => r.key === rangeKey) || RANGES.find((r) => r.key === DEFAULT_RANGE);
}

// InfluxQL string literals escape a single quote with a backslash. The
// sensor id comes from a dropdown populated off the DB's own tag values, so
// injection risk is low, but escape defensively all the same.
function escapeLiteral(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function buildTrendQuery(sensorId, rangeKey) {
  if (sensorId === undefined || sensorId === null || String(sensorId) === '') {
    throw new Error('buildTrendQuery: sensorId is required');
  }
  const r = rangeFor(rangeKey);
  const cols = r.fields.map((f) => `"${f.col}"`).join(', ');
  return (
    `SELECT ${cols} FROM "${r.rp}"."${r.measurement}" ` +
    `WHERE "sensor_id" = '${escapeLiteral(sensorId)}' AND time > now() - ${r.duration} ` +
    `ORDER BY time ASC`
  );
}

function parseTime(t) {
  if (typeof t === 'number' && Number.isFinite(t)) return t;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

// node-red-dashboard ui_chart accepts a complete historic dataset as
// [{ series:[...], data:[[{x,y}...],...], labels:[''] }]. One data array
// per series, x = epoch ms, y = value; null/missing points are dropped so a
// gap shows as a gap.
function resultsToChart(rows, rangeKey) {
  const r = rangeFor(rangeKey);
  const series = r.fields.map((f) => f.series);
  const data = r.fields.map(() => []);
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const x = parseTime(row.time);
    if (x === null) continue;
    r.fields.forEach((f, i) => {
      const y = row[f.col];
      if (typeof y === 'number' && Number.isFinite(y)) {
        data[i].push({ x, y });
      }
    });
  }
  return [{ series, data, labels: [''] }];
}

// SHOW TAG VALUES FROM bt_kpi WITH KEY = "sensor_id" returns rows shaped
// { key: 'sensor_id', value: 'J01' }. Turn them into a sorted, de-duped
// ui_dropdown option list (scalar values double as labels).
function sensorOptionsFromTagValues(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const seen = new Set();
  for (const row of list) {
    const v = row && (row.value !== undefined ? row.value : row.sensor_id);
    if (v !== undefined && v !== null && String(v) !== '') seen.add(String(v));
  }
  return Array.from(seen).sort();
}

module.exports = {
  RANGES,
  DEFAULT_RANGE,
  buildTrendQuery,
  resultsToChart,
  sensorOptionsFromTagValues,
};
