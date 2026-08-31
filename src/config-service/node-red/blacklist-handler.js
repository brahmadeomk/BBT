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

// Process-wide singleton (like the cloud-gateway's getGateway). The tracker
// MUST NOT be stored in Node-RED flow/global context: the Pi's context store
// is localfilesystem-backed, which JSON-serialises values and strips the
// class prototype -> "tracker.tick is not a function". Holding it in this
// module (loaded once at startup) keeps the live instance with its methods.
let _tracker = null;
function getTracker(opts) {
  if (!_tracker) _tracker = new BlacklistTracker(opts);
  return _tracker;
}

// unit_address is only unique WITHIN a bus, so a bus-tagged response (Slice 10
// two-segment) must resolve within its bus. busId omitted -> single-bus panel
// (match on unit_address alone, as before).
function unitToSlaveId(doc, unitAddress, busId) {
  const slaves = doc?.modbus?.slaves || [];
  const s = slaves.find((x) => x.unit_address === unitAddress && (busId == null || x.bus_id === busId));
  return s ? s.slave_id : null;
}

function jointsForSlave(doc, slaveId) {
  return (doc?.joints || []).filter((j) => j.slave_id === slaveId).map((j) => j.joint_id);
}

// Which RS-485 segment a slave sits on. Pre-multi-bus documents carry no
// bus_id; those panels have exactly one bus, so fall back to its id (and to
// 'bus1' if the document predates the buses array entirely).
function busForSlave(doc, slaveId) {
  const s = (doc?.modbus?.slaves || []).find((x) => x.slave_id === slaveId);
  if (s?.bus_id) return s.bus_id;
  const buses = doc?.modbus?.buses || [];
  return buses.length === 1 ? buses[0].bus_id : 'bus1';
}

/**
 * Which slave provides a joint's ambient reference, via the R14 3-level
 * override chain: joints[].ambient_sensor -> that joint's zone -> panel default.
 */
function ambientSlaveForJoint(doc, joint) {
  if (joint?.ambient_sensor?.slave_id != null) return joint.ambient_sensor.slave_id;
  const zone = (doc?.zones || []).find((z) => z.zone_id === joint?.zone_id);
  if (zone?.ambient_sensor?.slave_id != null) return zone.ambient_sensor.slave_id;
  return doc?.modbus?.ambient_sensor?.slave_id ?? null;
}

/**
 * Joints that USE this slave as their ambient reference (not joints carried by
 * it). A dedicated ambient slave carries no joints of its own, so without this
 * a restored ambient would reset nothing — and every joint referencing it would
 * keep decaying its ΔT EMA from a value built against the dead reference,
 * taking a full tau (e.g. 20 min) before a stale ΔT alarm could clear.
 */
function jointsUsingAmbientSlave(doc, slaveId) {
  return (doc?.joints || [])
    .filter((j) => ambientSlaveForJoint(doc, j) === slaveId)
    .map((j) => j.joint_id);
}

/**
 * How an OPERATOR identifies a device: the Modbus unit address they typed into
 * the Modbus Settings table (plus its display label), not the internal schema
 * `slave_id`. `sl21` is meaningless on the panel; "101 (AMBIENT_101)" is what
 * was commissioned. Falls back to the slave_id if the device isn't in the doc.
 */
function slaveDisplayName(doc, slaveId) {
  const s = (doc?.modbus?.slaves || []).find((x) => x.slave_id === slaveId);
  if (!s) return String(slaveId);
  const addr = s.unit_address != null ? String(s.unit_address) : String(slaveId);
  return s.label ? `${addr} (${s.label})` : addr;
}

/**
 * A blacklisted/restored event -> a command for the Alarm Manager's blacklist
 * section (mirrors its commTimeout raise/clear). Probing/probe_failed events
 * don't change the alarm.
 *
 * The description names the device by unit address/label and distinguishes the
 * two ways a dead device hurts: joints it CARRIES stop being measurable, and
 * joints that merely REFERENCE it as their ambient lose ΔT. A dedicated ambient
 * slave carries no joints, so the old text read "(none mapped) not measurable",
 * which understated a fault that actually disables ΔT panel-wide.
 */
function blacklistAlarmCommand(event, doc) {
  const joints = jointsForSlave(doc, event.slaveId);
  const ambientFor = jointsUsingAmbientSlave(doc, event.slaveId).filter((j) => !joints.includes(j));
  if (event.type === 'blacklisted') {
    const impact = [];
    if (joints.length) impact.push(`joint(s) ${joints.join(', ')} not measurable`);
    if (ambientFor.length) impact.push(`ambient reference for joint(s) ${ambientFor.join(', ')} - ΔT unavailable`);
    if (!impact.length) impact.push('no joints affected');
    return {
      action: 'raise',
      slave_id: event.slaveId,
      unit_address: (doc?.modbus?.slaves || []).find((x) => x.slave_id === event.slaveId)?.unit_address ?? null,
      joints,
      ambient_for_joints: ambientFor,
      description:
        `Slave ${slaveDisplayName(doc, event.slaveId)} blacklisted after ${event.failures} consecutive read failures; ` +
        impact.join('; '),
    };
  }
  if (event.type === 'restored') {
    return {
      action: 'clear',
      slave_id: event.slaveId,
      unit_address: (doc?.modbus?.slaves || []).find((x) => x.slave_id === event.slaveId)?.unit_address ?? null,
      joints,
      ambient_for_joints: ambientFor,
      description: `Slave ${slaveDisplayName(doc, event.slaveId)} restored`,
    };
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
  // Slice 10 two-segment: each bus is a separate Nano with its own job, and the
  // firmware re-inits its Modbus timeout on every job update - so a device
  // failing on bus2 must not glitch bus1's live polling. Resend only the buses
  // whose read set actually changed, i.e. the buses of the slaves that entered
  // or left the exclude set. Single-bus panels get ['bus1'] (or the sole bus's
  // id), which the one Send Nano Job node accepts as before.
  const prevExcluded = prevExcludeKey ? prevExcludeKey.split(',') : [];
  const changedSlaveIds = resendNeeded
    ? [...new Set([...prevExcluded, ...excludeSlaveIds])].filter(
        (id) => prevExcluded.includes(id) !== excludeSlaveIds.includes(id)
      )
    : [];
  const resendBusIds = [...new Set(changedSlaveIds.map((id) => busForSlave(doc, id)))];
  const alarms = events.map((e) => blacklistAlarmCommand(e, doc)).filter(Boolean);
  // Step 6: on restore, the joints whose ProcessLogic EMA/deltaT baseline
  // must be reset so RoR starts from 0 (no spurious rate after a blackout).
  // Both the joints carried by the restored slave AND the joints that merely
  // REFERENCE it as their ambient - the latter's ΔT baseline is just as invalid.
  const emaResetJoints = [];
  for (const e of events) {
    if (e.type !== 'restored') continue;
    for (const jid of [...jointsForSlave(doc, e.slaveId), ...jointsUsingAmbientSlave(doc, e.slaveId)]) {
      if (!emaResetJoints.includes(jid)) emaResetJoints.push(jid);
    }
  }
  return {
    events,
    excludeSlaveIds,
    excludeKey,
    resendNeeded,
    resendBusIds,
    alarms,
    emaResetJoints,
    jointStates: deriveJointStates(doc, tracker, activeAlarmJointIds, lastValidTs),
  };
}

/**
 * Record one Nano read result ({t:'r', id:unit_address, st:'ok'|'err'}).
 * @returns {{events, excludeSlaveIds, excludeKey, resendNeeded, resendBusIds, alarms, jointStates}}
 */
function processReadResult(tracker, payload, ctx = {}) {
  const events = [];
  if (payload && payload.t === 'r' && payload.id != null) {
    // ctx.busId (or payload.bus_id) tags which segment the response came from
    const slaveId = unitToSlaveId(ctx.doc, payload.id, ctx.busId ?? payload.bus_id);
    if (slaveId) {
      const nowMs = ctx.nowMs ?? Date.now();
      // Segment liveness (EC-2): ANY frame from a slave proves its bus is
      // alive, including an error response - the Nano answered, so the serial
      // link is up even if that one device is not.
      tracker.recordBusSeen(busForSlave(ctx.doc, slaveId), nowMs);
      const ev = tracker.recordResult(slaveId, payload.st === 'ok', nowMs);
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

/**
 * Turn the `busduct_blacklist_state` global into a display summary for the
 * HMI Device Health panel: which slaves are blacklisted/probing, their
 * recovery countdown, and the STALE/OFFLINE joints. Pure + testable.
 *
 * @param {object} [opts.doc] - applied cfg/modbus+joints; when supplied each row
 *   also carries the operator-facing `unit_address`/`display` (the address the
 *   device was commissioned with) instead of only the internal `slave_id`.
 */
function summarizeBlacklist(state, nowMs = Date.now(), opts = {}) {
  const slaves = state?.slaves || {};
  const joints = state?.joints || {};
  const doc = opts.doc;

  const jointsBySlave = {};
  for (const [jid, j] of Object.entries(joints)) {
    (jointsBySlave[j.slave_id] ||= []).push(jid);
  }

  const rows = [];
  for (const [slaveId, s] of Object.entries(slaves)) {
    if (s.status === 'active') continue;
    const cfg = (doc?.modbus?.slaves || []).find((x) => x.slave_id === slaveId);
    rows.push({
      slave_id: slaveId,
      unit_address: cfg?.unit_address ?? null,
      display: doc ? slaveDisplayName(doc, slaveId) : String(slaveId),
      status: s.status, // 'blacklisted' | 'probing'
      fails: s.fails ?? 0,
      goods: s.goods ?? 0,
      next_probe_in_sec:
        s.status === 'blacklisted' && s.nextProbeMs != null ? Math.max(0, Math.round((s.nextProbeMs - nowMs) / 1000)) : null,
      joints: (jointsBySlave[slaveId] || []).slice().sort(),
      ambient_for_joints: doc ? jointsUsingAmbientSlave(doc, slaveId).filter((j) => !(jointsBySlave[slaveId] || []).includes(j)) : [],
    });
  }
  rows.sort((a, b) => a.slave_id.localeCompare(b.slave_id));

  const staleJoints = Object.entries(joints).filter(([, j]) => j.state === 'STALE').map(([id]) => id).sort();
  const offlineJoints = Object.entries(joints).filter(([, j]) => j.state === 'OFFLINE').map(([id]) => id).sort();

  return {
    updatedTs: state?.updatedTs || null,
    counts: {
      blacklisted: rows.filter((r) => r.status === 'blacklisted').length,
      probing: rows.filter((r) => r.status === 'probing').length,
      stale: staleJoints.length,
      offline: offlineJoints.length,
    },
    slaves: rows,
    staleJoints,
    offlineJoints,
  };
}

/**
 * Reconcile blacklist ALARMS against the tracker's actual state.
 *
 * WHY THIS IS NEEDED. The two halves of the blacklist feature live in places
 * with different lifetimes:
 *   - the tracker is a process-wide, IN-MEMORY singleton (see getTracker) and
 *     is therefore EMPTY after every Node-RED restart;
 *   - the alarm lives in the Alarm Manager's context, which on the Pi is
 *     localfilesystem-backed and SURVIVES a restart.
 * A blacklist alarm clears only when the tracker emits a `restored` event. So
 * if a device is blacklisted and Node-RED is restarted before it recovers, the
 * tracker forgets the device was ever bad, never emits `restored`, and the
 * CRITICAL alarm stays active forever - while the device is polled normally
 * and shows up healthy everywhere else. That is a stuck alarm, not a fault.
 *
 * The tracker is the single source of truth for "who is blacklisted right
 * now". Any active blacklist alarm naming a slave the tracker considers
 * healthy is stale and is cleared here.
 *
 * Run this ONCE at boot, after polling has resumed (~20 s), not on every tick:
 * by then a genuinely dead device has already failed its 3 reads and been
 * re-blacklisted, so its alarm is correctly left alone. Running it continuously
 * would race the raise path.
 *
 * @param {object} activeAlarms - global busbartherm.activeAlarms (keyed by instanceId)
 * @param {object} tracker
 * @param {object} [doc] - applied cfg/modbus+joints, for the display name
 * @returns {Array<object>} clear commands, in the shape the Alarm Manager expects
 */
function reconcileBlacklistAlarms(activeAlarms, tracker, doc) {
  const clears = [];
  for (const key of Object.keys(activeAlarms || {})) {
    const m = /^SYSTEM\|(.+)\|BLACKLIST$/.exec(key);
    if (!m) continue;
    const slaveId = m[1];
    // 'blacklisted' and 'probing' are both live states the tracker is managing;
    // only a slave it considers fully active can have a stale alarm.
    if (tracker.status(slaveId) !== 'active') continue;
    clears.push({
      action: 'clear',
      slave_id: slaveId,
      unit_address: (doc?.modbus?.slaves || []).find((x) => x.slave_id === slaveId)?.unit_address ?? null,
      joints: jointsForSlave(doc, slaveId),
      ambient_for_joints: jointsUsingAmbientSlave(doc, slaveId),
      description: `Slave ${slaveDisplayName(doc, slaveId)} restored (stale alarm cleared at startup)`,
    });
  }
  return clears;
}


/**
 * Reconcile the PERSISTED exclude set against the tracker's actual state.
 *
 * Sibling of reconcileBlacklistAlarms, for the other half of the same lifetime
 * mismatch - and the more dangerous half.
 *
 * `global.busduct_blacklist_exclude` is what `Send Nano Job` subtracts from the
 * compiled read job. It is written to the DEFAULT context store, which on the
 * Pi is localfilesystem-backed, so it SURVIVES a restart. The tracker does not.
 * Worse, the Blacklist Engine only rewrites that global when `resendNeeded` is
 * true, and after a restart `_finalize` computes
 *   resendNeeded = prevExcludeKey === undefined ? excludeSlaveIds.length > 0 : ...
 * which with a fresh tracker is `[] .length > 0` = false. So the stale exclude
 * list is never rewritten and the affected slaves stay out of the scan forever.
 *
 * The symptom is silent: the tracker reports every device `active` and the HMI
 * says "all responding", because a slave that is not polled produces neither an
 * ok nor an err for the tracker to count. The device simply goes quiet -
 * Diagnostics ages it out to "No Data" and its last value freezes. And because
 * the tracker calls it active, reconcileBlacklistAlarms clears its alarm, which
 * removes the last visible sign.
 *
 * There is also a deadlock here that makes this unrecoverable on its own: an
 * excluded slave is never polled, so it can never fail a read, so it can never
 * be re-blacklisted OR restored. Only putting it back in the scan breaks that.
 *
 * So on boot the tracker is authoritative: anything it does not consider
 * blacklisted must not be excluded. Devices that really are dead re-fail their
 * 3 reads within a few poll cycles and are blacklisted again properly.
 *
 * @returns {{excludeSlaveIds: string[], removed: string[], resendBusIds: string[]}}
 */
function reconcileExcludeSet(persistedExclude, tracker, doc) {
  const persisted = Array.isArray(persistedExclude) ? persistedExclude : [];
  const excludeSlaveIds = persisted.filter((id) => tracker.status(id) === 'blacklisted').sort();
  const removed = persisted.filter((id) => !excludeSlaveIds.includes(id));
  // Resend only the segments whose read set actually changes - the firmware
  // re-inits its Modbus timeout on every job update, so an unnecessary resend
  // briefly disrupts live polling on a healthy bus.
  const resendBusIds = [...new Set(removed.map((id) => busForSlave(doc, id)).filter(Boolean))];
  return { excludeSlaveIds, removed, resendBusIds };
}

module.exports = {
  newTracker,
  getTracker,
  unitToSlaveId,
  jointsForSlave,
  busForSlave,
  ambientSlaveForJoint,
  jointsUsingAmbientSlave,
  slaveDisplayName,
  blacklistAlarmCommand,
  deriveJointStates,
  processReadResult,
  processTick,
  summarizeBlacklist,
  reconcileBlacklistAlarms,
  reconcileExcludeSet,
};
