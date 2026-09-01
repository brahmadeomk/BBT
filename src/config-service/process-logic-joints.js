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
 * CHANNELS (2026-09-01, steps 3-4). "Scale Nano Reading" now fans a frame out
 * into one message per channel, so rows are keyed by **(unit address, channel)**
 * — what the schema modelled all along, and what R7 exists to keep unique. The
 * earlier "lowest channel wins" collapse and its warning are gone.
 *
 * Ambient references are keyed the same way, as `"<unit>:<channel>"`. A flat
 * unit address could not distinguish channel 3 of a 4-channel module used as the
 * zone ambient, and `resolveAmbient` stringifies its keys anyway, so a composite
 * costs nothing. Legacy draft rows, which are single-channel by construction,
 * resolve to `":1"`.
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
function resolveAmbientKey(doc, joint) {
  const zone = (doc?.zones ?? []).find((z) => z.zone_id === joint.zone_id);
  const ref = joint.ambient_sensor ?? zone?.ambient_sensor ?? doc?.modbus?.ambient_sensor ?? null;
  if (!ref) return null;
  // A reference may be a bare slave_id or {slave_id, channel}. Both halves matter
  // now that a module can expose several channels - channel 3 of a 4-channel
  // module is a different sensor from channel 1.
  const slaveId = typeof ref === 'string' ? ref : ref.slave_id;
  const channel = typeof ref === 'string' ? 1 : (ref.channel ?? 1);
  const unit = slaveId ? unitAddressOf(doc, slaveId) : null;
  return unit == null ? null : `${unit}:${channel}`;
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
  const byChannel = new Map();

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
    const channel = j.channel ?? 1;
    const key = `${unit}:${channel}`;
    // R7 already rejects a duplicate (slave, channel) pair at apply time, so
    // this can only fire on a document that bypassed validation.
    if (byChannel.has(key)) {
      warnings.push(
        `${j.joint_id} and ${byChannel.get(key).joint_id} both claim unit ${unit} channel ${channel}` +
        ` - only ${byChannel.get(key).joint_id} is monitored`
      );
      continue;
    }
    byChannel.set(key, {
      joint_id: j.joint_id,
      joint_name: j.label ?? j.joint_id,
      slaveID: unit,
      channel,
      zone_id: j.zone_id ?? null,
      zone_name: zoneName.get(j.zone_id) ?? 'Unknown',
      ambientKey: resolveAmbientKey(doc, j),
    });
  }

  return {
    joints: [...byChannel.values()],
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
