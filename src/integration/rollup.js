'use strict';

/**
 * Slice 11 — BMS rollup semantics (pure).
 *
 * Turns the live joint KPIs + the active-alarm list into the aggregate
 * numbers the register image needs: panel/zone/joint levels, per-level
 * counts, panel and per-zone maxima, and the LATCHED worst joint.
 *
 * Worst-joint latching (workplan §11.4): once a joint holds the worst
 * (highest) level it keeps the "worst joint" point until its alarm clears,
 * even if another joint later reaches the same level — first-raised wins.
 * Reassign only on clear. Without this the point oscillates when two joints
 * sit at the same level. The latch is stateful, so it lives in a small
 * class held as a process singleton by the flow handler (never in Node-RED
 * context, which would serialise away its methods).
 */

const LEVEL_ORD = { WATCH: 1, WARNING: 2, CRITICAL: 3 };
const PROCESS_LEVELS = new Set(Object.keys(LEVEL_ORD));

function levelOrd(level) {
  return LEVEL_ORD[String(level || '').toUpperCase()] || 0;
}

/** State ordinal for the register image. */
const STATE_ORD = { LIVE: 0, STALE: 1, OFFLINE: 2 };

class WorstJointLatch {
  constructor() {
    this._current = null; // { joint_id, level, raisedTs }
  }

  /**
   * @param {Array<{joint_id, level, raisedTs}>} jointPeaks - one entry per
   *   alarmed joint: its highest active level (ordinal) and the earliest
   *   raisedTs among that joint's alarms at that level.
   * @returns {{joint_id: string|null, level: number}}
   */
  update(jointPeaks) {
    const peaks = (jointPeaks || []).filter((p) => p.level > 0);
    if (peaks.length === 0) {
      this._current = null;
      return { joint_id: null, level: 0 };
    }
    const maxLevel = Math.max(...peaks.map((p) => p.level));

    // Hold the current worst if it's still active at the top level.
    if (this._current) {
      const still = peaks.find((p) => p.joint_id === this._current.joint_id);
      if (still && still.level === maxLevel) {
        this._current = { ...still };
        return { joint_id: this._current.joint_id, level: maxLevel };
      }
    }

    // Otherwise (re)assign: among joints at the top level, first-raised wins;
    // tiebreak by joint_id so it's fully deterministic.
    const contenders = peaks.filter((p) => p.level === maxLevel);
    contenders.sort((a, b) => {
      const ta = a.raisedTs || '';
      const tb = b.raisedTs || '';
      if (ta !== tb) return ta < tb ? -1 : 1;
      return a.joint_id < b.joint_id ? -1 : a.joint_id > b.joint_id ? 1 : 0;
    });
    this._current = { ...contenders[0] };
    return { joint_id: this._current.joint_id, level: maxLevel };
  }

  get current() {
    return this._current ? { ...this._current } : null;
  }
}

/**
 * Per-joint highest active PROCESS level + earliest raisedTs at that level.
 * SYSTEM alarms (COMM/BLACKLIST) are excluded here — they drive joint
 * STATE + system_health, not the process alarm level.
 */
function jointPeaks(activeAlarms) {
  const byJoint = {};
  for (const a of activeAlarms || []) {
    if (a.category === 'SYSTEM') continue;
    const ord = levelOrd(a.level);
    if (ord === 0) continue;
    const jid = a.joint_id;
    const cur = byJoint[jid];
    if (!cur || ord > cur.level || (ord === cur.level && (a.raisedTs || '') < (cur.raisedTs || ''))) {
      byJoint[jid] = { joint_id: jid, level: ord, raisedTs: a.raisedTs || '' };
    }
  }
  return byJoint;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function maxOrNull(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

/**
 * Compute the whole rollup.
 *
 * @param {Array} liveJoints - per-joint live state:
 *   { joint_id, zone_id, temp_c, deltaT, ror, state:'LIVE'|'STALE'|'OFFLINE' }
 * @param {Array} activeAlarms - active-alarm objects (Alarm Manager output 1)
 * @param {WorstJointLatch} latch
 * @param {object} [opts]
 * @param {boolean} [opts.systemFault] - a device blacklisted/comm fault (-> DEGRADED)
 */
function computeRollup(liveJoints, activeAlarms, latch, opts = {}) {
  const peaksByJoint = jointPeaks(activeAlarms);

  // Per-level INSTANCE counts (a joint at WARNING with two warning alarms
  // counts twice) — so a Warning isn't masked when a Critical appears.
  const counts = { watch: 0, warning: 0, critical: 0 };
  let activeAlarmCount = 0;
  for (const a of activeAlarms || []) {
    if (a.category === 'SYSTEM') continue;
    const ord = levelOrd(a.level);
    if (ord === 1) counts.watch++;
    else if (ord === 2) counts.warning++;
    else if (ord === 3) counts.critical++;
    else continue;
    activeAlarmCount++;
  }
  const highestLevel = counts.critical ? 3 : counts.warning ? 2 : counts.watch ? 1 : 0;

  // Per joint + per zone
  const perJoint = {};
  const perZone = {};
  let panelMaxTemp = null, panelMaxDelta = null, panelMaxRor = null, liveCount = 0;

  for (const j of liveJoints || []) {
    const level = peaksByJoint[j.joint_id]?.level || 0;
    const state = j.state || 'LIVE';
    const temp = num(j.temp_c);
    const dt = num(j.deltaT);
    const ror = num(j.ror);
    perJoint[j.joint_id] = { level, state, temp, deltaT: dt, ror };
    if (state === 'LIVE') liveCount++;

    // Only measurable (LIVE) joints contribute to maxima — a stale/offline
    // joint's last value must not masquerade as a live panel max.
    if (state === 'LIVE') {
      panelMaxTemp = maxOrNull(panelMaxTemp, temp);
      panelMaxDelta = maxOrNull(panelMaxDelta, dt);
      panelMaxRor = maxOrNull(panelMaxRor, ror);
    }

    const zid = j.zone_id;
    if (zid != null) {
      const z = (perZone[zid] ||= { highest_level: 0, active_count: 0, max_temp: null, max_deltaT: null, max_ror: null, count_warning: 0, count_critical: 0 });
      if (level > z.highest_level) z.highest_level = level;
      if (state === 'LIVE') {
        z.max_temp = maxOrNull(z.max_temp, temp);
        z.max_deltaT = maxOrNull(z.max_deltaT, dt);
        z.max_ror = maxOrNull(z.max_ror, ror);
      }
    }
  }

  // Per-zone instance counts from the alarm list (zone_id on the alarm).
  for (const a of activeAlarms || []) {
    if (a.category === 'SYSTEM') continue;
    const ord = levelOrd(a.level);
    if (ord === 0) continue;
    const zid = a.zone_id;
    if (zid == null) continue;
    const z = (perZone[zid] ||= { highest_level: 0, active_count: 0, max_temp: null, max_deltaT: null, max_ror: null, count_warning: 0, count_critical: 0 });
    z.active_count++;
    if (ord === 2) z.count_warning++;
    else if (ord === 3) z.count_critical++;
    if (ord > z.highest_level) z.highest_level = ord;
  }

  const worst = latch ? latch.update(Object.values(peaksByJoint)) : { joint_id: null, level: 0 };

  const systemHealth = liveCount === 0 ? 2 : opts.systemFault ? 1 : 0;

  return {
    highest_level: highestLevel,
    active_alarm_count: activeAlarmCount,
    counts,
    worst_joint_id: worst.joint_id,
    worst_joint_level: worst.level,
    panel_max_temp: panelMaxTemp,
    panel_max_deltaT: panelMaxDelta,
    panel_max_ror: panelMaxRor,
    live_joint_count: liveCount,
    system_health: systemHealth,
    perJoint,
    perZone,
  };
}

module.exports = { WorstJointLatch, computeRollup, jointPeaks, levelOrd, LEVEL_ORD, STATE_ORD, PROCESS_LEVELS };
