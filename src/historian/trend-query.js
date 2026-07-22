'use strict';

// Trend viewer logic for the in-HMI historian screen.
//
// Pure, unit-testable helpers the Node-RED "Trends" tab calls through the
// busductHistorian global:
//   - buildTrendQuery(sensorId, rangeKey) -> InfluxQL string for the
//     influxdb query node (msg.query).
//   - resultsToCharts(rows, rangeKey)     -> node-red-dashboard ui_chart
//     "load historic data" payloads, split into temp / delta / ror charts.
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
// `group` routes each field to its own chart in the Trends tab:
//   temp  -> absolute temperature + ambient (shared °C axis)
//   delta -> ΔT (°C, separate chart)
//   ror   -> rate-of-rise (°C/hr, separate chart)
const RAW_FIELDS = [
  { col: 'temp_c', series: 'Temp °C', group: 'temp' },
  { col: 'ambient_c', series: 'Ambient °C', group: 'temp' },
  { col: 'delta_t_c', series: 'ΔT °C', group: 'delta' },
  { col: 'delta_t_raw_c', series: 'ΔT raw °C', group: 'delta' },
  { col: 'ror_c_hr', series: 'RoR °C/hr', group: 'ror' },
];

const ROLLUP_FIELDS = [
  { col: 'temp_c_mean', series: 'Temp mean °C', group: 'temp' },
  { col: 'temp_c_max', series: 'Temp max °C', group: 'temp' },
  { col: 'ambient_c_mean', series: 'Ambient mean °C', group: 'temp' },
  { col: 'delta_t_c_max', series: 'ΔT max °C', group: 'delta' },
  { col: 'ror_c_hr_max', series: 'RoR max °C/hr', group: 'ror' },
];

// The three charts the Trends tab renders, in order.
const CHART_GROUPS = ['temp', 'delta', 'ror'];

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
// [{ series:[...], data:[[{x,y}...],...], labels:[''] }] - one data array per
// series, x = epoch ms, y = value; null/missing points are dropped so a gap
// shows as a gap. resultsToCharts splits the range's fields into one such
// payload per group (temp / delta / ror) so the Trends tab shows three charts
// from a single query. Returns { temp: [payload], delta: [payload],
// ror: [payload] }.
function resultsToCharts(rows, rangeKey) {
  const r = rangeFor(rangeKey);
  const list = Array.isArray(rows) ? rows : [];
  const out = {};
  for (const group of CHART_GROUPS) {
    const fields = r.fields.filter((f) => f.group === group);
    const series = fields.map((f) => f.series);
    const data = fields.map(() => []);
    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      const x = parseTime(row.time);
      if (x === null) continue;
      fields.forEach((f, i) => {
        const y = row[f.col];
        if (typeof y === 'number' && Number.isFinite(y)) data[i].push({ x, y });
      });
    }
    out[group] = [{ series, data, labels: [''] }];
  }
  return out;
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
  CHART_GROUPS,
  buildTrendQuery,
  resultsToCharts,
  sensorOptionsFromTagValues,
};
