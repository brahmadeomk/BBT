'use strict';

/**
 * Projects the APPLIED cfg/modbus+joints document into the row shape
 * `ProcessLogic` consumes, so alarms are raised against the same configuration
 * they are swept against.
 *
 * WHY (user decision 2026-09-01). ProcessLogic read `global.joint_master_zone_A`
 * — the legacy DRAFT the dashboard edits — while `sweepDecommissionedAlarms`
 * clears against the applied document. Two sources of truth for one lifecycle:
 *
 *  - the draft is NOT schema-validated, so a joint id the schema would reject
 *    could still raise alarms (`J1_2143124`, 10 characters, seen live on
 *    2026-08-31 against a 6-character pattern);
 *  - a row saved but never applied was monitored anyway, silently, with nothing
 *    telling the operator their edit was not in service;
 *  - and anything raised from the draft but absent from the applied doc was
 *    immediately swept, producing raise/clear churn.
 *
 * WHAT THIS DOES NOT FIX: channel disambiguation. ProcessLogic's input is the
 * raw Nano frame `{t:'r', id:<unit address>, sa, len, val, st}` — there is no
 * channel in the stream at all. A multi-channel slave therefore cannot be split
 * across joints here no matter what the configuration says, so rows are keyed by
 * **unit address**, exactly as the draft was. Where two joints share a unit
 * address the lowest channel wins (matching the old `joints.find(...)`, so no
 * behaviour changes) and a warning is emitted for the operator rather than the
 * reading being silently attributed to an arbitrary joint. Fixing it properly
 * means carrying the channel through the decode path — a separate change.
 */

/** Legacy draft rows use unit addresses; the schema uses slave_id. */
function unitAddressOf(doc, slaveId) {
  const s = (doc?.modbus?.slaves ?? []).find((x) => x.slave_id === slaveId);
  return s ? s.unit_address : null;
}

/**
 * R14's ambient override chain: joint, else the joint's zone, else panel-wide.
 * The draft only ever had a flat per-joint `ambientSlaveID`, so reading the
 * applied document also makes the zone and panel levels actually take effect.
 */
function resolveAmbientUnit(doc, joint) {
  const zone = (doc?.zones ?? []).find((z) => z.zone_id === joint.zone_id);
  const ref = joint.ambient_sensor ?? zone?.ambient_sensor ?? doc?.modbus?.ambient_sensor ?? null;
  if (!ref) return null;
  // The reference may be a bare slave_id or {slave_id, channel}; only the unit
  // address survives into the reading stream either way.
  const slaveId = typeof ref === 'string' ? ref : ref.slave_id;
  return slaveId ? unitAddressOf(doc, slaveId) : null;
}

/**
 * @param {object} doc - the APPLIED cfg/modbus+joints document
 * @returns {{joints: Array, warnings: string[], sourceVersion: number|null}}
 */
function buildProcessLogicJoints(doc) {
  const warnings = [];
  const joints = Array.isArray(doc?.joints) ? doc.joints : null;

  // Refuse to act on absent information - the same rule the alarm sweep follows.
  // An empty result would silently stop monitoring the whole panel, so the
  // caller is told to keep whatever it already had.
  if (!joints || joints.length === 0) {
    return { joints: null, warnings: ['applied configuration unreadable or empty'], sourceVersion: null };
  }

  const zoneName = new Map((doc?.zones ?? []).map((z) => [z.zone_id, z.name]));
  const byUnit = new Map();

  // Lowest channel first, so the winner on a collision is deterministic and
  // matches what `joints.find()` returned before this change.
  const ordered = joints
    .filter((j) => j.enabled !== false)
    .slice()
    .sort((a, b) => (a.channel ?? 1) - (b.channel ?? 1));

  for (const j of ordered) {
    const unit = unitAddressOf(doc, j.slave_id);
    if (unit == null) {
      warnings.push(`${j.joint_id}: slave ${j.slave_id} is not commissioned - not monitored`);
      continue;
    }
    if (byUnit.has(unit)) {
      const held = byUnit.get(unit);
      warnings.push(
        `${j.joint_id} and ${held.joint_id} share unit address ${unit}; ` +
        `readings carry no channel, so only ${held.joint_id} (channel ${held._channel}) is monitored`
      );
      continue;
    }
    byUnit.set(unit, {
      joint_id: j.joint_id,
      joint_name: j.label ?? j.joint_id,
      slaveID: unit,
      zone_id: j.zone_id ?? null,
      zone_name: zoneName.get(j.zone_id) ?? 'Unknown',
      ambientSlaveID: resolveAmbientUnit(doc, j),
      _channel: j.channel ?? 1,
    });
  }

  return {
    joints: [...byUnit.values()],
    warnings,
    sourceVersion: doc?.config_version ?? doc?.version ?? null,
  };
}

/**
 * What the operator has saved but not applied — the change this whole switch
 * makes visible. Before it, an unapplied row was monitored anyway; after it, it
 * is not, and that MUST announce itself rather than being discovered when a
 * joint turns out to have been unwatched.
 *
 * @param {Array} draftRows - legacy `joint_master_zone_A` rows
 * @param {Array} appliedRows - buildProcessLogicJoints().joints
 */
function diffDraftVsApplied(draftRows, appliedRows) {
  const draft = Array.isArray(draftRows) ? draftRows : [];
  const applied = Array.isArray(appliedRows) ? appliedRows : [];
  const appliedIds = new Set(applied.map((j) => j.joint_id));
  const draftIds = new Set(draft.map((j) => j.joint_id).filter(Boolean));

  // A row still being typed has no id yet; it is not "unapplied", it is unfinished.
  const notApplied = [...draftIds].filter((id) => !appliedIds.has(id));
  const notInDraft = [...appliedIds].filter((id) => !draftIds.has(id));

  return {
    notApplied,
    notInDraft,
    inSync: notApplied.length === 0 && notInDraft.length === 0,
  };
}

module.exports = { buildProcessLogicJoints, diffDraftVsApplied };
