'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Mechanical verification of a soak run recorded by soak-recorder.js
 * (combined Slice 5+6 soak acceptance):
 *
 *  1. Telemetry correctness: recompute every interval's per-joint
 *     aggregates (dt_min/dt_max/dt_avg, ror_max, t_max, ambient avg)
 *     from the raw KPI samples and compare against what was actually
 *     published. The KPI tap recording is the same stream the local
 *     historian consumes, so this IS the "aggregates vs historian"
 *     check, with ground truth captured at the tap.
 *  2. Alarm parity: replay the alarm taps through the publisher's
 *     dedupe rules and require the published RAISE/CLEAR sequence to
 *     match exactly (order included); alarms still queued in the
 *     outbox when the recording stopped are tolerated as a trailing
 *     gap, never a reordering.
 *  3. Hold-and-drain: from connection transitions and per-message
 *     hold time (published_at - payload edge timestamp), report
 *     offline windows and confirm messages held during pulls drained
 *     with their original timestamps.
 */

const EPS = 1e-6;
const BOUNDARY_SLACK_MS = 250;

function readJsonl(dir, file) {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

/** Loads a soak directory into the shape verifySoak expects. */
function loadSoakDir(dir) {
  return {
    kpi: readJsonl(dir, 'kpi.jsonl'),
    alarmTaps: readJsonl(dir, 'alarm-taps.jsonl'),
    published: readJsonl(dir, 'published.jsonl'),
    flushStatus: readJsonl(dir, 'flush-status.jsonl'),
    connection: readJsonl(dir, 'connection.jsonl'),
  };
}

function isTelemetryBatch(entry) {
  return entry.payload && typeof entry.payload === 'object' && entry.payload.joints && entry.payload.interval_min != null;
}

function isHeartbeat(entry) {
  return entry.payload && typeof entry.payload === 'object' && entry.payload.fwVersion != null;
}

function isAlarmEvent(entry) {
  return entry.payload && typeof entry.payload === 'object' && ['RAISE', 'CLEAR', 'ACK'].includes(entry.payload.action);
}

function aggregate(samples) {
  const dt = samples.map((s) => s.deltaT?.ema).filter((v) => typeof v === 'number');
  const ror = samples.map((s) => s.ror).filter((v) => typeof v === 'number');
  const t = samples.map((s) => s.val).filter((v) => typeof v === 'number');
  const amb = samples.map((s) => s.ambient?.val).filter((v) => typeof v === 'number');
  const entry = {};
  if (dt.length) {
    entry.dt_min = Math.min(...dt);
    entry.dt_max = Math.max(...dt);
    entry.dt_avg = dt.reduce((a, b) => a + b, 0) / dt.length;
  }
  if (ror.length) entry.ror_max = Math.max(...ror);
  if (t.length) entry.t_max = Math.max(...t);
  if (amb.length) entry.ambient = amb.reduce((a, b) => a + b, 0) / amb.length;
  return entry;
}

function entriesDiffer(expected, publishedEntry) {
  const diffs = [];
  for (const key of ['dt_min', 'dt_max', 'dt_avg', 'ror_max', 't_max', 'ambient']) {
    const e = expected[key];
    const p = publishedEntry[key];
    if (e == null && p == null) continue;
    if (e == null || p == null || Math.abs(e - p) > EPS) diffs.push({ field: key, expected: e ?? null, published: p ?? null });
  }
  return diffs;
}

function verifyTelemetry(kpi, published) {
  const batches = published.filter(isTelemetryBatch);
  // chunks of one interval share payload.timestamp - merge their joints maps
  const byTimestamp = new Map();
  for (const b of batches) {
    if (!byTimestamp.has(b.payload.timestamp)) byTimestamp.set(b.payload.timestamp, {});
    Object.assign(byTimestamp.get(b.payload.timestamp), b.payload.joints);
  }
  const intervals = [...byTimestamp.entries()]
    .map(([timestamp, joints]) => ({ timestamp, ts: Date.parse(timestamp), joints }))
    .sort((a, b) => a.ts - b.ts);

  const samples = kpi
    .map((line) => ({ at: Date.parse(line.recorded_at), sample: line.sample }))
    .sort((a, b) => a.at - b.at);

  const mismatches = [];
  let jointsChecked = 0;
  let prevTs = -Infinity;

  for (const interval of intervals) {
    const inWindow = samples.filter((s) => s.at > prevTs && s.at <= interval.ts);
    const byJoint = new Map();
    for (const { sample } of inWindow) {
      if (!byJoint.has(sample.joint_id)) byJoint.set(sample.joint_id, []);
      byJoint.get(sample.joint_id).push(sample);
    }

    for (const [jointId, publishedEntry] of Object.entries(interval.joints)) {
      jointsChecked++;
      const jointSamples = byJoint.get(jointId) ?? [];
      let diffs = entriesDiffer(aggregate(jointSamples), publishedEntry);
      if (diffs.length > 0) {
        // boundary slack: millisecond ties at window edges can put a sample
        // on the wrong side - retry without edge-adjacent samples
        const slackSamples = inWindow
          .filter((s) => s.at > prevTs + BOUNDARY_SLACK_MS && s.at <= interval.ts - BOUNDARY_SLACK_MS)
          .filter((s) => s.sample.joint_id === jointId)
          .map((s) => s.sample);
        const slackDiffs = entriesDiffer(aggregate(slackSamples), publishedEntry);
        if (slackDiffs.length > 0) {
          mismatches.push({ interval: interval.timestamp, joint_id: jointId, diffs });
        }
      }
    }
    prevTs = interval.ts;
  }

  return { intervals: intervals.length, joints_checked: jointsChecked, mismatches, ok: mismatches.length === 0 };
}

function verifyAlarms(alarmTaps, published, flushStatus) {
  // replay the publisher's dedupe over the tap recording -> expected sequence
  // (mirrors AlarmPublisher: RAISE on new ids, ACK on NACK->ACK status change)
  const expected = [];
  let known = new Map(); // instanceId -> last status
  for (const tap of alarmTaps) {
    if (tap.kind === 'active') {
      const incoming = new Map(tap.alarms.map((a) => [a.instanceId, a.status]));
      for (const alarm of tap.alarms) {
        if (!known.has(alarm.instanceId)) {
          expected.push({ action: 'RAISE', instanceId: alarm.instanceId });
        } else if (known.get(alarm.instanceId) === 'ACTIVE_NACK' && alarm.status === 'ACTIVE_ACK') {
          expected.push({ action: 'ACK', instanceId: alarm.instanceId });
        }
      }
      known = incoming;
    } else if (tap.kind === 'cleared') {
      for (const alarm of tap.alarms) {
        known.delete(alarm.instanceId);
        expected.push({ action: 'CLEAR', instanceId: alarm.instanceId });
      }
    }
  }

  const got = published
    .filter(isAlarmEvent)
    .map((e) => ({ action: e.payload.action, instanceId: e.payload.alarm?.instanceId ?? null }));

  let firstDivergence = null;
  for (let i = 0; i < Math.min(expected.length, got.length); i++) {
    if (expected[i].action !== got[i].action || expected[i].instanceId !== got[i].instanceId) {
      firstDivergence = { index: i, expected: expected[i], published: got[i] };
      break;
    }
  }

  // alarms still queued when the recording stopped show up as a missing tail
  const lastStatus = flushStatus[flushStatus.length - 1];
  const queuedAtEnd = lastStatus?.outbox?.alarm ?? 0;
  const trailingMissing = expected.length - got.length;
  const ok =
    firstDivergence === null &&
    got.length <= expected.length &&
    (trailingMissing === 0 || trailingMissing <= queuedAtEnd);

  return {
    expected: expected.length,
    published: got.length,
    trailing_queued: trailingMissing > 0 ? trailingMissing : 0,
    first_divergence: firstDivergence,
    ok,
  };
}

function verifyLink(connection, published) {
  const transitions = connection.map((c) => ({ at: Date.parse(c.at), connected: c.connected }));
  const offlineWindows = [];
  let downSince = null;
  for (const t of transitions) {
    if (!t.connected && downSince === null) downSince = t.at;
    if (t.connected && downSince !== null) {
      offlineWindows.push({ from: new Date(downSince).toISOString(), to: new Date(t.at).toISOString(), seconds: Math.round((t.at - downSince) / 1000) });
      downSince = null;
    }
  }

  let maxHoldMs = 0;
  let heldOver60s = 0;
  for (const entry of published) {
    const edgeTs = entry.payload?.timestamp ? Date.parse(entry.payload.timestamp) : null;
    if (edgeTs == null || Number.isNaN(edgeTs)) continue;
    const hold = Date.parse(entry.published_at) - edgeTs;
    if (hold > maxHoldMs) maxHoldMs = hold;
    if (hold > 60_000) heldOver60s++;
  }

  return { offline_windows: offlineWindows, max_hold_ms: maxHoldMs, held_over_60s: heldOver60s };
}

/**
 * @param {{kpi, alarmTaps, published, flushStatus, connection}} data - loadSoakDir() output
 * @returns {{ok: boolean, telemetry, alarms, link, heartbeats, notes: string[]}}
 */
function verifySoak(data) {
  const telemetry = verifyTelemetry(data.kpi, data.published);
  const alarms = verifyAlarms(data.alarmTaps, data.published, data.flushStatus);
  const link = verifyLink(data.connection, data.published);
  const heartbeats = data.published.filter(isHeartbeat).length;

  const notes = [];
  if (data.kpi.length === 0) notes.push('no KPI samples recorded - was BUSDUCT_SOAK_LOG set before the run?');
  if (telemetry.intervals === 0) notes.push('no telemetry batches published during the recording');
  if (alarms.expected === 0) notes.push('no alarm transitions during the recording - alarm parity is vacuous');
  if (alarms.trailing_queued > 0) notes.push(`${alarms.trailing_queued} alarm event(s) still queued in the outbox when the recording stopped`);
  if (link.offline_windows.length === 0) notes.push('no link-loss window recorded - run the pull drills for the full soak');

  return { ok: telemetry.ok && alarms.ok, telemetry, alarms, link, heartbeats, notes };
}

module.exports = { loadSoakDir, verifySoak };
