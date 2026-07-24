'use strict';

const { BlacklistTracker } = require('../blacklist-tracker');

/**
 * Slice 9 steps 5 + 7 — the pure orchestration between the BlacklistTracker
 * and the Node-RED flow. Turns Nano per-slave read results into: the set of
 * slaves to exclude from the compiled job (resend when it changes), SYSTEM
 * blacklist alarm raise/clear commands for the Alarm Manager, and per-joint
 * LIVE/STALE/OFFLINE states for the HMI/cloud/BMS.
 *
 * Step 6 (freeze/reset EMA + persistence timers in ProcessLogic on restore)
 * is deliberately NOT here — it's held pending the RoR/EMA live check.
 * Consequence until it lands: a slave restored after a long blackout can
 * still produce one spurious RoR sample; acceptable and understood.
 *
 * Everything here is pure and timing-injected; the flow supplies the applied
 * cfg/modbus+joints doc, the current time, and which joints currently hold an
 * active process alarm.
 */

function newTracker(opts) {
  return new BlacklistTracker(opts);
}

function unitToSlaveId(doc, unitAddress) {
  const s = (doc?.modbus?.slaves || []).find((x) => x.unit_address === unitAddress);
  return s ? s.slave_id : null;
}

function jointsForSlave(doc, slaveId) {
  return (doc?.joints || []).filter((j) => j.slave_id === slaveId).map((j) => j.joint_id);
}

/**
 * A blacklisted/restored event -> a command for the Alarm Manager's blacklist
 * section (mirrors its commTimeout raise/clear). Probing/probe_failed events
 * don't change the alarm.
 */
function blacklistAlarmCommand(event, doc) {
  const joints = jointsForSlave(doc, event.slaveId);
  if (event.type === 'blacklisted') {
    return {
      action: 'raise',
      slave_id: event.slaveId,
      joints,
      description:
        `Slave ${event.slaveId} blacklisted after ${event.failures} consecutive read failures; ` +
        `joint(s) ${joints.length ? joints.join(', ') : '(none mapped)'} not measurable`,
    };
  }
  if (event.type === 'restored') {
    return { action: 'clear', slave_id: event.slaveId, joints };
  }
  return null;
}

/**
 * Step 5: per-joint LIVE / STALE / OFFLINE.
 * - active slave        -> LIVE
 * - not-measurable slave (blacklisted or probing), joint HAS an active
 *   process alarm -> STALE (held, carries last_valid_ts)
 * - not-measurable slave, no active alarm -> OFFLINE
 *
 * @param {Set<string>|string[]} activeAlarmJointIds - joints with an active PROCESS alarm
 * @param {object} [lastValidTs] - { [joint_id]: iso } last good sample time
 */
function deriveJointStates(doc, tracker, activeAlarmJointIds = new Set(), lastValidTs = {}) {
  const active = activeAlarmJointIds instanceof Set ? activeAlarmJointIds : new Set(activeAlarmJointIds);
  const out = {};
  for (const j of doc?.joints || []) {
    const status = tracker.status(j.slave_id);
    if (status === 'active') {
      out[j.joint_id] = { state: 'LIVE', slave_id: j.slave_id };
    } else {
      const held = active.has(j.joint_id);
      out[j.joint_id] = {
        state: held ? 'STALE' : 'OFFLINE',
        slave_id: j.slave_id,
        not_measurable: true,
        last_valid_ts: lastValidTs[j.joint_id] ?? null,
      };
    }
  }
  return out;
}

/** Shared post-processing after a result or a tick changes tracker state. */
function _finalize(tracker, events, { doc, prevExcludeKey, activeAlarmJointIds, lastValidTs }) {
  const excludeSlaveIds = tracker.blacklistedSlaveIds().sort();
  const excludeKey = excludeSlaveIds.join(',');
  // The compiled job's read set = configured minus blacklisted. Resend only
  // when that set actually changes (blacklist, probe-promote, probe-fail) -
  // a restore doesn't change it (the slave was already polled while probing).
  const resendNeeded = prevExcludeKey === undefined ? excludeSlaveIds.length > 0 : excludeKey !== prevExcludeKey;
  const alarms = events.map((e) => blacklistAlarmCommand(e, doc)).filter(Boolean);
  // Step 6: on restore, the joints whose ProcessLogic EMA/deltaT baseline
  // must be reset so RoR starts from 0 (no spurious rate after a blackout).
  const emaResetJoints = [];
  for (const e of events) {
    if (e.type === 'restored') emaResetJoints.push(...jointsForSlave(doc, e.slaveId));
  }
  return {
    events,
    excludeSlaveIds,
    excludeKey,
    resendNeeded,
    alarms,
    emaResetJoints,
    jointStates: deriveJointStates(doc, tracker, activeAlarmJointIds, lastValidTs),
  };
}

/**
 * Record one Nano read result ({t:'r', id:unit_address, st:'ok'|'err'}).
 * @returns {{events, excludeSlaveIds, excludeKey, resendNeeded, alarms, jointStates}}
 */
function processReadResult(tracker, payload, ctx = {}) {
  const events = [];
  if (payload && payload.t === 'r' && payload.id != null) {
    const slaveId = unitToSlaveId(ctx.doc, payload.id);
    if (slaveId) {
      const ev = tracker.recordResult(slaveId, payload.st === 'ok', ctx.nowMs ?? Date.now());
      if (ev) events.push(ev);
    }
  }
  return _finalize(tracker, events, ctx);
}

/** Periodic tick: promote any due probes, then report side effects. */
function processTick(tracker, ctx = {}) {
  const events = tracker.tick(ctx.nowMs ?? Date.now());
  return _finalize(tracker, events, ctx);
}

module.exports = {
  newTracker,
  unitToSlaveId,
  jointsForSlave,
  blacklistAlarmCommand,
  deriveJointStates,
  processReadResult,
  processTick,
};
