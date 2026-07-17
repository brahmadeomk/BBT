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
 * Hourly liveness ping with firmware + applied config versions.
 * Returns a status summary for the debug sidebar.
 */
function sendHeartbeat(gateway, { fwVersion, configVersions }) {
  gateway.heartbeat.send({ fwVersion, configVersions });
  return {
    heartbeat: 'queued',
    fwVersion,
    configVersions,
    outbox: gateway.outbox.counts(),
  };
}

module.exports = { ingestKpiTap, ingestAlarmActiveTap, ingestAlarmClearedTap, flushTelemetry, sendHeartbeat };
