'use strict';

/**
 * Auto-clear alarms whose subject no longer exists in the applied configuration.
 *
 * The Alarm Manager has always had a "CLEANUP DELETED SENSORS" sweep, but it
 * had two gaps that left alarms stuck on the panel after a config change:
 *
 * 1. IT READ THE WRONG SOURCE. It compared against `global.joint_master_zone_A`
 *    — the legacy DRAFT the dashboard edits — rather than the APPLIED
 *    cfg/modbus+joints document. A draft can disagree with what is actually
 *    running (mid-edit, after a remote config push, or on a panel whose draft
 *    was never rebuilt), so alarms for genuinely-removed joints survived and,
 *    worse, alarms for joints that only existed in a draft could be cleared.
 *
 * 2. IT SKIPPED EVERY SYSTEM ALARM. That skip exists for a good reason — a
 *    blacklisted device must not clear its own alarm — but it also means a
 *    `SYSTEM|<slave>|BLACKLIST` alarm for a device that has since been DELETED
 *    from the configuration can never clear. The device is gone, so it is never
 *    polled, so the tracker never emits `restored`, so nothing ever clears it.
 *
 * The distinction this module draws is between "unhealthy" and "not configured
 * any more". Only the second is swept. A device that is still commissioned
 * keeps its alarm however sick it is; that is the blacklist tracker's business,
 * not this one's.
 *
 * SAFETY: if the applied document cannot be read or looks empty, this returns
 * NOTHING. The old code's `|| []` fallback meant a missing global made every
 * joint look deleted and would have auto-cleared every PROCESS alarm on the
 * panel at once. Refusing to act on absent information is the only safe
 * behaviour for a sweep that deletes alarms.
 */

/** Panel-level SYSTEM alarms that belong to no configured device, and are never swept. */
const PANEL_SCOPES = new Set(['MODULE', 'PI', 'BUS1', 'BUS2', 'SYSTEM', 'PANEL']);

/**
 * @param {object} activeAlarms - keyed by instanceId (global busbartherm.activeAlarms)
 * @param {object} doc - the APPLIED cfg/modbus+joints document
 * @returns {Array<{instanceId, joint_id, slave_id, reason, description}>} alarms to clear
 */
function sweepDecommissionedAlarms(activeAlarms, doc) {
  const alarms = activeAlarms && typeof activeAlarms === 'object' ? activeAlarms : {};
  const joints = Array.isArray(doc?.joints) ? doc.joints : null;
  const slaves = Array.isArray(doc?.modbus?.slaves) ? doc.modbus.slaves : null;

  // No readable config, or a config with no joints at all: do nothing. An empty
  // joints array is indistinguishable from "could not read it", and clearing
  // every alarm on the panel is far worse than leaving a stale one.
  if (!joints || joints.length === 0) return [];

  const validJointIds = new Set(joints.map((j) => j.joint_id));
  const validSlaveIds = new Set((slaves || []).map((s) => s.slave_id));

  const out = [];
  for (const [key, alarm] of Object.entries(alarms)) {
    if (!alarm || typeof alarm !== 'object') continue;

    if (alarm.category === 'SYSTEM') {
      // Only device-scoped SYSTEM alarms are sweepable, and only when we could
      // actually read the slave list.
      if (!slaves) continue;
      const scope = String(key).split('|')[1];
      if (!scope || PANEL_SCOPES.has(scope)) continue;      // COMM, PI POWER, per-bus: not a device
      if (validSlaveIds.has(scope)) continue;               // still commissioned - leave it alone
      out.push({
        instanceId: key,
        slave_id: scope,
        joint_id: alarm.joint_id ?? 'SYSTEM',
        reason: 'CONFIG_REMOVED',
        description: `${alarm.description || key} (auto-cleared: device no longer in configuration)`,
      });
      continue;
    }

    // PROCESS alarms are keyed to a joint. Ambient pseudo-joints are not in
    // joints[] and were never swept by the original code either.
    const jointId = alarm.joint_id;
    if (!jointId || String(jointId).startsWith('AMBIENT_')) continue;
    if (validJointIds.has(jointId)) continue;
    out.push({
      instanceId: key,
      joint_id: jointId,
      slave_id: alarm.slave_id ?? null,
      reason: 'CONFIG_REMOVED',
      description: `${alarm.description || key} (auto-cleared: joint no longer in configuration)`,
    });
  }
  return out;
}

module.exports = { sweepDecommissionedAlarms, PANEL_SCOPES };
