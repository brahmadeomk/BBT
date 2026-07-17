'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createGateway } = require('../../src/cloud-gateway/node-red');
const { ingestKpiTap, ingestAlarmActiveTap, ingestAlarmClearedTap, flushTelemetry } = require('../../src/cloud-gateway/node-red');
const { loadSoakDir, verifySoak } = require('../../src/cloud-gateway/soak-verify');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

afterEach(() => {
  delete process.env.BUSDUCT_SOAK_LOG;
});

const kpiMsg = (jointId, val, dtEma, ror) => ({
  topic: 'joint',
  payload: { joint_id: jointId, val, ror, deltaT: { raw: dtEma + 0.3, ema: dtEma }, ambient: { slaveID: 101, val: 31, age_sec: 1 } },
});

const alarm = (instanceId) => ({
  instanceId,
  category: 'PROCESS',
  joint_id: instanceId.split('|')[1],
  alarm_type: 'DELTA_T',
  level: 'WARNING',
  status: 'ACTIVE_NACK',
  raisedTs: new Date().toISOString(),
});

describe('soak recorder wired through the gateway', () => {
  test('records KPI samples, alarm taps, flush status, publishes, and connection transitions', async () => {
    const soakDir = tmpdir('busduct-soak-rec-');
    process.env.BUSDUCT_SOAK_LOG = soakDir;
    const gw = createGateway({ outboxDir: tmpdir('busduct-soak-outbox-') });
    gw.outbox.stop();

    ingestKpiTap(gw, kpiMsg('J01', 40, 9, 1));
    ingestKpiTap(gw, kpiMsg('J01', 44, 11, 5));
    ingestAlarmActiveTap(gw, { payload: [alarm('PROCESS|J01|DELTA_T|WARNING')] });
    ingestAlarmClearedTap(gw, { payload: [{ ...alarm('PROCESS|J01|DELTA_T|WARNING'), status: 'CLEARED', clearedTs: new Date().toISOString() }] });
    flushTelemetry(gw, 10);
    await gw.outbox.drain();
    gw.transport.setConnected(false);
    gw.transport.setConnected(true);

    const data = loadSoakDir(soakDir);
    assert.equal(data.kpi.length, 2);
    assert.equal(data.kpi[0].sample.joint_id, 'J01');
    assert.deepEqual(data.alarmTaps.map((t) => t.kind), ['active', 'cleared']);
    assert.equal(data.flushStatus.length, 1);
    assert.equal(data.flushStatus[0].flushed_chunks, 1);
    // 3 publishes: alarm RAISE + CLEAR (alarm class drains first) + telemetry batch
    assert.equal(data.published.length, 3);
    assert.deepEqual(data.connection.map((c) => c.connected), [false, true]);
  });

  test('recorder is inert without BUSDUCT_SOAK_LOG', async () => {
    const gw = createGateway({ outboxDir: tmpdir('busduct-nosoak-outbox-') });
    gw.outbox.stop();
    assert.equal(gw.soak, null);
    ingestKpiTap(gw, kpiMsg('J01', 40, 9, 1)); // must not throw
  });
});

describe('soak verifier', () => {
  /** Builds a consistent 2-interval recording via the real gateway, then lets tests corrupt it. */
  async function recordScenario() {
    const soakDir = tmpdir('busduct-soak-ver-');
    process.env.BUSDUCT_SOAK_LOG = soakDir;
    const gw = createGateway({ outboxDir: tmpdir('busduct-soak-ver-outbox-') });
    gw.outbox.stop();

    ingestKpiTap(gw, kpiMsg('J01', 40, 9, 1));
    ingestKpiTap(gw, kpiMsg('J01', 44, 11, 5));
    ingestKpiTap(gw, kpiMsg('J02', 50, 8, 2));
    ingestAlarmActiveTap(gw, { payload: [alarm('PROCESS|J01|DELTA_T|WARNING')] });
    flushTelemetry(gw, 10);
    await gw.outbox.drain();

    await new Promise((r) => setTimeout(r, 5)); // separate the intervals in time
    ingestKpiTap(gw, kpiMsg('J01', 42, 10, 2));
    ingestAlarmClearedTap(gw, { payload: [{ ...alarm('PROCESS|J01|DELTA_T|WARNING'), status: 'CLEARED', clearedTs: new Date().toISOString() }] });
    flushTelemetry(gw, 10);
    await gw.outbox.drain();

    // simulate a link pull that got recorded
    gw.transport.setConnected(false);
    gw.transport.setConnected(true);
    return soakDir;
  }

  test('passes a clean recording and reports its shape', async () => {
    const dir = await recordScenario();
    const report = verifySoak(loadSoakDir(dir));
    assert.equal(report.ok, true, JSON.stringify(report, null, 2));
    assert.equal(report.telemetry.intervals, 2);
    assert.equal(report.telemetry.joints_checked, 3); // J01+J02 then J01
    assert.equal(report.alarms.expected, 2);
    assert.equal(report.alarms.published, 2);
    assert.equal(report.link.offline_windows.length, 1);
  });

  test('flags a corrupted published aggregate', async () => {
    const dir = await recordScenario();
    const p = path.join(dir, 'published.jsonl');
    const lines = fs.readFileSync(p, 'utf8').trim().split('\n').map(JSON.parse);
    const batch = lines.find((l) => l.payload.joints?.J01);
    batch.payload.joints.J01.t_max = 999; // tamper
    fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const report = verifySoak(loadSoakDir(dir));
    assert.equal(report.ok, false);
    assert.equal(report.telemetry.mismatches.length, 1);
    assert.equal(report.telemetry.mismatches[0].joint_id, 'J01');
    assert.equal(report.telemetry.mismatches[0].diffs[0].field, 't_max');
  });

  test('flags an out-of-order alarm sequence', async () => {
    const dir = await recordScenario();
    const p = path.join(dir, 'published.jsonl');
    const lines = fs.readFileSync(p, 'utf8').trim().split('\n').map(JSON.parse);
    const alarms = lines.filter((l) => l.payload.action);
    [alarms[0].payload, alarms[1].payload] = [alarms[1].payload, alarms[0].payload]; // swap RAISE/CLEAR
    fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const report = verifySoak(loadSoakDir(dir));
    assert.equal(report.alarms.ok, false);
    assert.equal(report.alarms.first_divergence.index, 0);
  });

  test('tolerates alarms still queued at recording end (trailing gap), not reordering', async () => {
    const dir = await recordScenario();
    const p = path.join(dir, 'published.jsonl');
    const lines = fs.readFileSync(p, 'utf8').trim().split('\n').map(JSON.parse);
    const withoutLastAlarm = [];
    let dropped = false;
    for (const l of [...lines].reverse()) {
      if (!dropped && l.payload.action === 'CLEAR') {
        dropped = true;
        continue;
      }
      withoutLastAlarm.unshift(l);
    }
    fs.writeFileSync(p, withoutLastAlarm.map((l) => JSON.stringify(l)).join('\n') + '\n');
    // pretend the flush status saw it still queued
    const fp = path.join(dir, 'flush-status.jsonl');
    fs.appendFileSync(fp, JSON.stringify({ recorded_at: new Date().toISOString(), flushed_chunks: 0, outbox: { alarm: 1, telemetry: 0 } }) + '\n');

    const report = verifySoak(loadSoakDir(dir));
    assert.equal(report.alarms.ok, true);
    assert.equal(report.alarms.trailing_queued, 1);
  });

  test('reports hold times for messages drained after a link pull', () => {
    // synthetic: telemetry built at T, drained 90s later
    const dir = tmpdir('busduct-soak-hold-');
    const t0 = Date.parse('2026-07-17T10:00:00.000Z');
    fs.writeFileSync(
      path.join(dir, 'published.jsonl'),
      JSON.stringify({
        published_at: new Date(t0 + 90_000).toISOString(),
        topic: 'dt/C000/S000/P000/tel',
        qos: 0,
        payload: { timestamp: new Date(t0).toISOString(), interval_min: 10, joints: {} },
      }) + '\n'
    );
    fs.writeFileSync(
      path.join(dir, 'connection.jsonl'),
      [
        JSON.stringify({ at: new Date(t0 - 10_000).toISOString(), connected: false }),
        JSON.stringify({ at: new Date(t0 + 85_000).toISOString(), connected: true }),
      ].join('\n') + '\n'
    );
    const report = verifySoak(loadSoakDir(dir));
    assert.equal(report.link.offline_windows.length, 1);
    assert.equal(report.link.offline_windows[0].seconds, 95);
    assert.equal(report.link.held_over_60s, 1);
    assert.ok(report.link.max_hold_ms >= 90_000);
  });
});
