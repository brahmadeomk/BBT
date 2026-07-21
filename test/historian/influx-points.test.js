'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { toInfluxPoints } = require('../../src/historian/influx-points');

const jointMsg = (over = {}) => ({
  topic: 'joint',
  payload: {
    joint_id: 'J01',
    zone_id: 'Z1',
    slaveID: 1,
    val: 42.3,
    emaTemp: 42.1,
    ror: 3.256,
    deltaT: { raw: 11.2, ema: 10.9 },
    ambient: { slaveID: 101, val: 31.06, age_sec: 0.8 },
    timestamp: '2026-07-20T10:45:56.454Z',
    sensor_status: 'OK',
    ...over,
  },
});

describe('toInfluxPoints', () => {
  test('a joint KPI message becomes one bt_kpi point with absolute temp + derived KPIs', () => {
    const [pt] = toInfluxPoints(jointMsg());
    assert.equal(pt.measurement, 'bt_kpi');
    assert.deepEqual(pt.tags, { sensor_id: 'J01', zone_id: 'Z1', kind: 'joint', slave_id: '1' });
    assert.deepEqual(pt.fields, {
      temp_c: 42.3,
      ema_temp_c: 42.1,
      ror_c_hr: 3.256,
      delta_t_c: 10.9,
      delta_t_raw_c: 11.2,
      ambient_c: 31.06,
    });
    assert.equal(pt.timestamp, Date.parse('2026-07-20T10:45:56.454Z'));
  });

  test('an ambient message writes only temp_c, tagged kind=ambient', () => {
    const [pt] = toInfluxPoints({
      topic: 'ambient',
      payload: { joint_id: 'AMBIENT_101', zone_id: 'AMBIENT', slaveID: 101, val: 31.06, sensor_status: 'OK', timestamp: '2026-07-20T10:45:56.454Z' },
    });
    assert.deepEqual(pt.tags, { sensor_id: 'AMBIENT_101', zone_id: 'AMBIENT', kind: 'ambient', slave_id: '101' });
    assert.deepEqual(pt.fields, { temp_c: 31.06 });
  });

  test('missing optional KPIs are simply omitted (no null fields)', () => {
    const [pt] = toInfluxPoints(jointMsg({ deltaT: null, ambient: null, ror: undefined, emaTemp: undefined }));
    assert.deepEqual(pt.fields, { temp_c: 42.3 });
  });

  test('skips non-OK sensor readings (no poisoned aggregates)', () => {
    assert.deepEqual(toInfluxPoints(jointMsg({ sensor_status: 'Communication_Error' })), []);
    assert.deepEqual(toInfluxPoints(jointMsg({ sensor_status: 'Sensor_Error' })), []);
  });

  test('skips a non-finite / missing absolute reading', () => {
    assert.deepEqual(toInfluxPoints(jointMsg({ val: undefined })), []);
    assert.deepEqual(toInfluxPoints(jointMsg({ val: NaN })), []);
  });

  test('ignores non-KPI streams and malformed messages', () => {
    assert.deepEqual(toInfluxPoints({ topic: 'unassigned', payload: { sensor_id: 55, val: 24 } }), []);
    assert.deepEqual(toInfluxPoints({ topic: 'joint', payload: null }), []);
    assert.deepEqual(toInfluxPoints(null), []);
  });

  test('falls back to now() when the message has no parseable timestamp', () => {
    const before = Date.now();
    const [pt] = toInfluxPoints(jointMsg({ timestamp: 'not-a-date' }));
    assert.ok(pt.timestamp >= before && pt.timestamp <= Date.now() + 5);
  });
});
