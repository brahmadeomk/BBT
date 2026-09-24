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
 * The THIRD id space a SYSTEM scope can come from (2026-09-16, live report).
 *
 * ProcessLogic names an ambient reading `AMBIENT_<unit>` (channel 1) or
 * `AMBIENT_<unit>_<ch>`, and the Alarm Manager keys per-sensor faults as
 * `SYSTEM|{that name}|COMMUNICATION` / `|SENSOR_FAULT`. So a disconnected
 * ambient raises `SYSTEM|AMBIENT_101|COMMUNICATION` - a scope that is neither a
 * slave_id nor a joint_id, which this sweep read as "not in the configuration"
 * and cleared on the next tick. ProcessLogic then re-raised it on the next
 * sample, and the panel showed a raise/auto-clear pair, with e-mails, for as
 * long as the sensor stayed unplugged. The PROCESS branch below had skipped
 * `AMBIENT_` from the start; this branch never got the same treatment.
 *
 * Resolved against the applied slaves by UNIT ADDRESS and channel, not skipped
 * wholesale: an ambient that has genuinely been deleted from the configuration
 * must still sweep, or its alarm can never clear (gap 2 all over again).
 */
const AMBIENT_SCOPE = /^AMBIENT_(\d+)(?:_(\d+))?$/;

function ambientStillConfigured(scope, slaves) {
  const m = AMBIENT_SCOPE.exec(scope);
  if (!m) return null; // not an ambient scope at all
  const unit = Number(m[1]);
  const channel = m[2] ? Number(m[2]) : 1;
  return slaves.some((s) => s.unit_address === unit && channel <= (s.channels ?? 1));
}

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

  // MONITORED, not merely present (2026-09-22, with the Active checkbox).
  // `buildProcessLogicJoints` drops `enabled === false` joints, so a joint
  // switched off in the table gets no further samples - and therefore can never
  // clear an alarm it was holding when it was switched off. Treating it as
  // decommissioned for sweeping purposes is the same judgement the sweep
  // already makes for a deleted joint: it is not being watched, so an alarm
  // saying it is unhealthy is stale rather than informative.
  // A device switched off in Modbus Settings is not polled, so everything
  // hanging off it is in the same position as a joint switched off directly:
  // no further samples, therefore no way to clear an alarm it was holding.
  const offSlaveIds = new Set((slaves || []).filter((s) => s.enabled === false).map((s) => s.slave_id));
  const monitored = (j) => j.enabled !== false && !offSlaveIds.has(j.slave_id);

  const validJointIds = new Set(joints.filter(monitored).map((j) => j.joint_id));
  const disabledJointIds = new Set(joints.filter((j) => !monitored(j)).map((j) => j.joint_id));
  // Likewise its OWN alarms - a BLACKLIST or COMM alarm about a device nobody is
  // talking to is stale, not informative, and the tracker can never clear it
  // because a device that is not polled produces neither an ok nor an err.
  const validSlaveIds = new Set((slaves || []).filter((s) => s.enabled !== false).map((s) => s.slave_id));

  const out = [];
  for (const [key, alarm] of Object.entries(alarms)) {
    if (!alarm || typeof alarm !== 'object') continue;

    if (alarm.category === 'SYSTEM') {
      // Only device-scoped SYSTEM alarms are sweepable, and only when we could
      // actually read the slave list.
      if (!slaves) continue;
      const scope = String(key).split('|')[1];
      if (!scope || PANEL_SCOPES.has(scope)) continue;      // COMM, PI POWER, per-bus: not a device
      // The scope of a SYSTEM alarm is NOT always a slave_id. The per-sensor
      // fault alarms the Alarm Manager raises are keyed
      // `SYSTEM|{joint_id}|COMMUNICATION` / `|SENSOR_FAULT` - a JOINT id in the
      // same position. Checking only the slave list swept those the instant they
      // were raised, producing a raise/clear pair (and a pair of e-mails) on
      // every blacklist probe cycle. Sweep only when the scope names nothing
      // that exists in EITHER id space.
      if (validSlaveIds.has(scope) || validJointIds.has(scope)) continue;
      if (ambientStillConfigured(scope, slaves) === true) continue;
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
    const disabled = disabledJointIds.has(jointId);
    out.push({
      instanceId: key,
      joint_id: jointId,
      slave_id: alarm.slave_id ?? null,
      // Distinct reasons: one of these is reversible from the table and the
      // other is not, and an operator reading the cleared-alarm history should
      // not have to guess which happened.
      reason: disabled ? 'CONFIG_DISABLED' : 'CONFIG_REMOVED',
      description: `${alarm.description || key} (auto-cleared: joint ${disabled ? 'switched off in the configuration' : 'no longer in configuration'})`,
    });
  }
  return out;
}

module.exports = { sweepDecommissionedAlarms, PANEL_SCOPES, AMBIENT_SCOPE };
