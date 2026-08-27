'use strict';

/**
 * Thin, unit-testable handlers behind the Cloud Gateway tab's function
 * nodes (Slice 5). Each takes the gateway service object built by
 * ./index.js's getGateway() and a Node-RED msg (or plain args), does
 * one thing, and returns whatever the function node should emit -
 * keeping the function nodes themselves one-liners per CLAUDE.md.
 *
 * Message shapes come from docs/internal-message-contracts.md:
 * - KPI tap: ProcessLogic output 1 (msg.topic === 'joint'). The
 *   batcher gets each joint's ambient from *inside* the joint message
 *   (kpi.ambient.val), so the separate 'ambient' stream (output 2) is
 *   not consumed at all.
 * - Alarm taps: Alarm Manager output 1 (active - the full current
 *   array, publisher dedupes) and output 2 (clearedNow - a delta).
 */

/** ProcessLogic joint tap -> batcher. Ignores anything that isn't a joint KPI. */
function ingestKpiTap(gateway, msg) {
  if (msg?.topic !== 'joint' || !msg.payload || typeof msg.payload !== 'object') return;
  gateway.soak?.kpi(msg.payload);
  gateway.batcher.ingestJointKpi(msg.payload);
}

/** Alarm Manager 'active' tap -> alarm publisher (RAISE on genuinely-new instanceIds only). */
function ingestAlarmActiveTap(gateway, msg) {
  if (!Array.isArray(msg?.payload)) return;
  gateway.soak?.alarmTap('active', msg.payload);
  gateway.alarmPublisher.ingestActiveAlarms(msg.payload);
}

/** Alarm Manager 'clearedNow' tap -> alarm publisher (every item is a CLEAR). */
function ingestAlarmClearedTap(gateway, msg) {
  if (!Array.isArray(msg?.payload)) return;
  gateway.soak?.alarmTap('cleared', msg.payload);
  gateway.alarmPublisher.ingestClearedAlarms(msg.payload);
}

/**
 * Ends the current telemetry interval: batches the accumulated KPIs
 * into the outbox. Called by the tab's interval inject - intervalMin
 * must match that inject's period (see the flow: 600s / 10 min,
 * matching busduct_edge_config.yaml publish.telemetry.interval_min).
 * Returns a status summary for the debug sidebar.
 */
function flushTelemetry(gateway, intervalMin) {
  const chunks = gateway.batcher.flush(intervalMin);
  const status = {
    flushed_chunks: chunks,
    outbox: gateway.outbox.counts(),
    outbox_bytes: gateway.outbox.totalSizeBytes(),
    transport_mode: gateway.mode,
    connected: gateway.transport.isConnected(),
    // loopback only - the AWS transport keeps no publish record (the cloud does)
    ...(gateway.transport.published ? { published_total: gateway.transport.published.length } : {}),
  };
  gateway.soak?.flushStatus(status);
  return status;
}

/**
 * Due-based telemetry flush (Slice 7): called by a fast tick inject
 * (60s) instead of a fixed-interval one, so the batch interval can be
 * changed at runtime (locally or from the cloud) without editing the
 * flow. Returns null when nothing is due - the function node emits
 * nothing. The interval comes from the gateway's persisted runtime
 * settings (default 10 min per publish.telemetry.interval_min);
 * setTelemetryInterval() below changes it and reschedules.
 */
function flushIfDue(gateway, now = Date.now()) {
  const intervalMs = gateway.settings.telemetryIntervalMin * 60_000;
  if (!gateway._nextFlushAt) gateway._nextFlushAt = now + intervalMs;
  if (now < gateway._nextFlushAt) return null;
  gateway._nextFlushAt = now + intervalMs;
  return flushTelemetry(gateway, gateway.settings.telemetryIntervalMin);
}

/**
 * Applies + persists a new telemetry interval and reschedules the next
 * flush from now. Returns an error string (bounds come from
 * runtime-settings.js) or null on success.
 */
function setTelemetryInterval(gateway, intervalMin, now = Date.now()) {
  const error = gateway.settings.setTelemetryIntervalMin(intervalMin);
  if (error) return error;
  gateway._nextFlushAt = now + intervalMin * 60_000;
  return null;
}

/**
 * Hourly liveness ping with firmware + applied config versions, plus
 * the Pi health snapshot (CPU temp, MAC id, free/available RAM,
 * low-voltage state - see pi-health.js; fields are null off-Pi).
 * Collected here, once per heartbeat, so the flow stays unchanged.
 * Returns a status summary for the debug sidebar.
 */
function sendHeartbeat(gateway, { fwVersion, configVersions }) {
  const { collectPiHealth } = require('../pi-health');
  const system = collectPiHealth();
  gateway.heartbeat.send({ fwVersion, configVersions, system });
  return {
    heartbeat: 'queued',
    fwVersion,
    configVersions,
    system,
    outbox: gateway.outbox.counts(),
  };
}

/**
 * Publishes the panel's device_health snapshot (EC-2), on change or on the
 * publisher's resync schedule. The flow node passes the state the panel
 * already keeps - it computes nothing new here.
 *
 * @param {object} gateway
 * @param {object} args
 * @param {object} args.summary - summarizeBlacklist(global.busduct_blacklist_state, now, {doc})
 * @param {object} [args.doc] - applied cfg/modbus+joints
 * @param {object} [args.busSeen] - tracker.busSeen (per-segment last-frame stamps)
 * @param {object} [args.power] - summarizePower(global.busduct_power_health)
 */
function publishDeviceHealth(gateway, { summary, doc, busSeen, power } = {}, now = Date.now()) {
  const { buildDeviceHealth } = require('../device-health');
  const payload = buildDeviceHealth({ summary, doc, busSeen, power, nowMs: now });
  const result = gateway.deviceHealth.publish(payload, now);
  return {
    device_health: result.published ? result.reason : 'unchanged',
    counts: payload.counts,
    buses: payload.buses.map((b) => `${b.bus_id}:${b.status}`),
    outbox: gateway.outbox.counts(),
  };
}

module.exports = { ingestKpiTap, ingestAlarmActiveTap, ingestAlarmClearedTap, flushTelemetry, flushIfDue, setTelemetryInterval, sendHeartbeat, publishDeviceHealth };
