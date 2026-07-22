'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  RANGES,
  buildTrendQuery,
  resultsToCharts,
  sensorOptionsFromTagValues,
} = require('../../src/historian/trend-query');

describe('buildTrendQuery', () => {
  test('raw range queries the 7-day full-resolution tier with sample columns', () => {
    const q = buildTrendQuery('J01', 'raw7d');
    assert.match(q, /FROM "raw"\."bt_kpi"/);
    assert.match(q, /"sensor_id" = 'J01'/);
    assert.match(q, /time > now\(\) - 7d/);
    assert.match(q, /"temp_c"/);
    assert.match(q, /"ror_c_hr"/);
    assert.match(q, /ORDER BY time ASC/);
  });

  test('rollup ranges query the aggregate tiers/measurements', () => {
    assert.match(buildTrendQuery('J01', 'day30'), /FROM "rollup_1h"\."bt_kpi_1h" .*now\(\) - 30d/);
    assert.match(buildTrendQuery('J01', 'week90'), /FROM "rollup_1h"\."bt_kpi_1h" .*now\(\) - 90d/);
    assert.match(buildTrendQuery('J01', 'month1y'), /FROM "rollup_1d"\."bt_kpi_1d" .*now\(\) - 365d/);
    assert.match(buildTrendQuery('J01', 'year5'), /FROM "rollup_1d"\."bt_kpi_1d" .*now\(\) - 1825d/);
    // aggregate columns, not raw sample columns
    assert.match(buildTrendQuery('J01', 'day30'), /"temp_c_mean"/);
    assert.match(buildTrendQuery('J01', 'day30'), /"temp_c_max"/);
  });

  test('unknown range falls back to the raw default', () => {
    assert.match(buildTrendQuery('J01', 'nope'), /FROM "raw"\."bt_kpi"/);
    assert.match(buildTrendQuery('J01', undefined), /FROM "raw"\."bt_kpi"/);
  });

  test('escapes a single quote in the sensor id (no InfluxQL break-out)', () => {
    const q = buildTrendQuery("J'01", 'raw7d');
    assert.match(q, /'J\\'01'/);
  });

  test('rejects a missing/empty sensor id', () => {
    assert.throws(() => buildTrendQuery('', 'raw7d'), /sensorId is required/);
    assert.throws(() => buildTrendQuery(null, 'raw7d'), /sensorId is required/);
    assert.throws(() => buildTrendQuery(undefined, 'raw7d'), /sensorId is required/);
  });
});

describe('resultsToCharts (split charts)', () => {
  test('null/missing field values are dropped (gap stays a gap)', () => {
    const rows = [
      { time: '2026-07-20T10:00:00Z', temp_c: 42.1, ambient_c: null },
      { time: '2026-07-20T10:10:00Z', temp_c: null, ambient_c: 31.2 },
    ];
    const { temp } = resultsToCharts(rows, 'raw7d');
    assert.equal(temp[0].data[0].length, 1); // temp_c: one valid
    assert.equal(temp[0].data[1].length, 1); // ambient_c: one valid
  });

  test('rows with an unparseable time are skipped', () => {
    const rows = [{ time: 'not-a-date', temp_c: 42.1 }, { time: '2026-07-20T10:10:00Z', temp_c: 42.4 }];
    const { temp } = resultsToCharts(rows, 'raw7d');
    assert.equal(temp[0].data[0].length, 1);
  });

  test('raw rows split into temp+ambient / ΔT / RoR chart payloads', () => {
    const rows = [
      { time: '2026-07-20T10:00:00Z', temp_c: 42.1, ambient_c: 31.0, delta_t_c: 11.1, delta_t_raw_c: 11.4, ror_c_hr: 2.2 },
    ];
    const charts = resultsToCharts(rows, 'raw7d');
    assert.deepEqual(charts.temp[0].series, ['Temp °C', 'Ambient °C']);
    assert.deepEqual(charts.delta[0].series, ['ΔT °C', 'ΔT raw °C']);
    assert.deepEqual(charts.ror[0].series, ['RoR °C/hr']);
    // values land in the right chart
    assert.deepEqual(charts.temp[0].data[0][0], { x: Date.parse('2026-07-20T10:00:00Z'), y: 42.1 });
    assert.deepEqual(charts.temp[0].data[1][0], { x: Date.parse('2026-07-20T10:00:00Z'), y: 31.0 });
    assert.deepEqual(charts.ror[0].data[0][0], { x: Date.parse('2026-07-20T10:00:00Z'), y: 2.2 });
  });

  test('rollup ranges group the aggregate columns the same way', () => {
    const t = Date.parse('2026-07-20T10:00:00Z');
    const charts = resultsToCharts([{ time: t, temp_c_mean: 40, temp_c_max: 44, ambient_c_mean: 30, delta_t_c_max: 12, ror_c_hr_max: 3 }], 'day30');
    assert.deepEqual(charts.temp[0].series, ['Temp mean °C', 'Temp max °C', 'Ambient mean °C']);
    assert.deepEqual(charts.delta[0].series, ['ΔT max °C']);
    assert.deepEqual(charts.ror[0].series, ['RoR max °C/hr']);
    assert.equal(charts.ror[0].data[0][0].y, 3);
  });

  test('empty input yields three chart-clearing payloads', () => {
    const charts = resultsToCharts([], 'raw7d');
    for (const g of ['temp', 'delta', 'ror']) {
      assert.equal(charts[g][0].data.every((d) => d.length === 0), true);
      assert.deepEqual(charts[g][0].labels, ['']);
    }
  });
});

describe('sensorOptionsFromTagValues', () => {
  test('turns SHOW TAG VALUES rows into a sorted, de-duped scalar option list', () => {
    const rows = [
      { key: 'sensor_id', value: 'J02' },
      { key: 'sensor_id', value: 'J01' },
      { key: 'sensor_id', value: 'J01' },
      { key: 'sensor_id', value: 'AMBIENT_101' },
    ];
    assert.deepEqual(sensorOptionsFromTagValues(rows), ['AMBIENT_101', 'J01', 'J02']);
  });

  test('tolerates empty/missing input and blank values', () => {
    assert.deepEqual(sensorOptionsFromTagValues([]), []);
    assert.deepEqual(sensorOptionsFromTagValues(null), []);
    assert.deepEqual(sensorOptionsFromTagValues([{ key: 'sensor_id', value: '' }, {}]), []);
  });

  test('RANGES exposes the five documented tiers in order', () => {
    assert.deepEqual(RANGES.map((r) => r.key), ['raw7d', 'day30', 'week90', 'month1y', 'year5']);
  });
});
