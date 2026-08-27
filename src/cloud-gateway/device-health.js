'use strict';

const { MESSAGE_TYPES } = require('./message-types');

/**
 * Device health as a published message (design review EC-2).
 *
 * WHY. Blacklist state, per-joint LIVE/STALE/OFFLINE and per-segment bus
 * liveness are all computed on the panel and were going no further than the
 * HMI's Device Health tab. A fleet view could see temperatures and alarms but
 * not *whether the panel could still measure* - a blind spot exactly where
 * central monitoring beats standing in front of the panel. Alarms alone do not
 * close it: an alarm stream tells you about transitions, so a consumer that
 * starts late, drops a message, or restarts cannot know the CURRENT set of
 * blacklisted devices without replaying history.
 *
 * SHAPE. This is a STATE snapshot, not an event: every message is complete and
 * self-contained, so the newest one always wins and a missed message never
 * leaves the fleet view wrong for longer than the resync interval.
 *
 * CADENCE (see DeviceHealthPublisher): on change, plus a periodic resync. On
 * a healthy panel that is one message an hour; the interesting case - a device
 * dropping out - is reported within a tick. Change detection compares the
 * payload with `timestamp` excluded, or every resend would look like a change.
 */

/** A bus with no frame for this long is reported `silent`. Matches the flow's watchdogs. */
const DEFAULT_BUS_SILENCE_SEC = 30;

/**
 * Builds the device_health payload.
 *
 * Everything here is derived from state the panel already keeps - this adds no
 * new measurement path, it only stops throwing the existing one away.
 *
 * @param {object} args
 * @param {object} args.summary - summarizeBlacklist() output (blacklist-handler.js)
 * @param {object} [args.doc] - applied cfg/modbus+joints, for bus and joint totals
 * @param {object} [args.busSeen] - { [bus_id]: epoch ms of last frame } from the tracker
 * @param {object} [args.power] - summarizePower() output (power-health.js)
 * @param {number} [args.nowMs]
 * @param {number} [args.busSilenceSec]
 */
function buildDeviceHealth({ summary, doc, busSeen = {}, power, nowMs = Date.now(), busSilenceSec = DEFAULT_BUS_SILENCE_SEC } = {}) {
  const counts = summary?.counts ?? { blacklisted: 0, probing: 0, stale: 0, offline: 0 };
  const jointsTotal = (doc?.joints ?? []).filter((j) => j.enabled !== false).length;

  return {
    type: MESSAGE_TYPES.DEVICE_HEALTH,
    timestamp: new Date(nowMs).toISOString(),
    counts: {
      joints_total: jointsTotal,
      // LIVE is the residual: a joint is measurable unless it is stale or dark.
      joints_live: Math.max(0, jointsTotal - (counts.stale ?? 0) - (counts.offline ?? 0)),
      joints_stale: counts.stale ?? 0,
      joints_offline: counts.offline ?? 0,
      devices_blacklisted: counts.blacklisted ?? 0,
      devices_probing: counts.probing ?? 0,
    },
    // Only the devices that are NOT healthy, so a 110-device panel in good
    // health sends an almost empty message. Named by commissioned address, not
    // internal slave_id - the fleet view is read by people who wired the panel.
    devices: (summary?.slaves ?? []).map((s) => ({
      slave_id: s.slave_id,
      unit_address: s.unit_address ?? null,
      display: s.display ?? null,
      status: s.status,
      next_probe_in_sec: s.next_probe_in_sec ?? null,
      joints: s.joints ?? [],
      ambient_for_joints: s.ambient_for_joints ?? [],
    })),
    joints: {
      stale: summary?.staleJoints ?? [],
      offline: summary?.offlineJoints ?? [],
    },
    buses: buildBusHealth({ doc, busSeen, summary, nowMs, busSilenceSec }),
    ...(power ? { power: powerBlock(power) } : {}),
  };
}

/**
 * Per-RS-485-segment health. A two-segment panel where one Nano is dead still
 * publishes telemetry for the other half, so "the panel is reporting" is not
 * evidence that both segments are. That is the failure the first panel drill
 * found locally (a dead segment rendering all-green); this makes it visible
 * centrally too.
 */
function buildBusHealth({ doc, busSeen = {}, summary, nowMs, busSilenceSec = DEFAULT_BUS_SILENCE_SEC }) {
  const buses = doc?.modbus?.buses ?? [];
  const slaves = doc?.modbus?.slaves ?? [];
  const unhealthy = new Set((summary?.slaves ?? []).map((s) => s.slave_id));

  return buses.map((bus) => {
    const onBus = slaves.filter((s) => s.bus_id === bus.bus_id);
    const lastMs = busSeen[bus.bus_id];
    const ageSec = typeof lastMs === 'number' ? Math.max(0, Math.round((nowMs - lastMs) / 100) / 10) : null;
    return {
      bus_id: bus.bus_id,
      port: bus.port ?? null,
      // `unknown` (never seen a frame) is deliberately distinct from `silent`
      // (seen one, then went quiet): at boot every bus is briefly unknown, and
      // reporting that as a fault would alarm the fleet view on every restart.
      status: ageSec === null ? 'unknown' : ageSec <= busSilenceSec ? 'ok' : 'silent',
      last_frame_age_sec: ageSec,
      devices_total: onBus.length,
      devices_unhealthy: onBus.filter((s) => unhealthy.has(s.slave_id)).length,
    };
  });
}

/**
 * Pi supply health. `under_voltage_since_boot` is the forensic bit that catches
 * an intermittent brown-out after it has recovered - the symptom that cost days
 * of misdiagnosis in 2026-07 (see CLAUDE.md's firmware note).
 */
function powerBlock(power) {
  return {
    state: power.state ?? null,
    under_voltage_now: power.low_voltage_now ?? null,
    under_voltage_since_boot: power.low_voltage_since_boot ?? null,
    throttled_now: power.throttled_now ?? null,
  };
}

/**
 * The SEMANTIC content of a snapshot: two snapshots taken a tick apart on a
 * calm panel must compare equal, or "publish on change" silently degrades into
 * "publish every tick".
 *
 * Three fields are continuous and must be excluded, not just the timestamp:
 * `last_frame_age_sec` grows every second a bus is quiet, and
 * `next_probe_in_sec` counts down on every blacklisted device. They stay IN the
 * payload - a human reading one message wants them - but they carry no state
 * the fleet view acts on. The state is `buses[].status` and `devices[].status`,
 * which is what this compares.
 */
function healthFingerprint(payload) {
  const { timestamp, buses = [], devices = [], ...rest } = payload;
  return JSON.stringify({
    ...rest,
    buses: buses.map(({ last_frame_age_sec, ...b }) => b),
    devices: devices.map(({ next_probe_in_sec, ...d }) => d),
  });
}

/**
 * Publishes device_health on change, with a periodic resync so a consumer that
 * missed a message (QoS 1 protects delivery, not a late subscriber) converges
 * within a bounded time rather than staying wrong indefinitely.
 */
class DeviceHealthPublisher {
  /**
   * @param {object} opts
   * @param {import('./outbox').Outbox} opts.outbox
   * @param {string} opts.topic
   * @param {number} [opts.resyncSec] - resend an unchanged snapshot after this long (default 1h, matching the heartbeat)
   */
  constructor({ outbox, topic, resyncSec = 3600 }) {
    this.outbox = outbox;
    this.topic = topic;
    this.resyncSec = resyncSec;
    this.lastFingerprint = null;
    this.lastPublishMs = null;
  }

  /**
   * @param {object} payload - buildDeviceHealth() output
   * @param {number} [nowMs]
   * @returns {{published: boolean, reason: 'changed'|'resync'|'unchanged'}}
   */
  publish(payload, nowMs = Date.now()) {
    const fingerprint = healthFingerprint(payload);
    const changed = fingerprint !== this.lastFingerprint;
    const dueResync = this.lastPublishMs === null || (nowMs - this.lastPublishMs) / 1000 >= this.resyncSec;
    if (!changed && !dueResync) return { published: false, reason: 'unchanged' };

    // QoS 1: losing a "device recovered" would leave the fleet view showing a
    // fault that no longer exists, until the next resync. Telemetry class, so
    // that under a long outage alarms are still evicted last.
    this.outbox.enqueue('telemetry', this.topic, payload, 1);
    this.lastFingerprint = fingerprint;
    this.lastPublishMs = nowMs;
    return { published: true, reason: changed ? 'changed' : 'resync' };
  }
}

module.exports = {
  buildDeviceHealth,
  buildBusHealth,
  healthFingerprint,
  DeviceHealthPublisher,
  DEFAULT_BUS_SILENCE_SEC,
};
