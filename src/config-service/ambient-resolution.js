'use strict';

function mode(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null;
  let bestCount = -1;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

/**
 * Derives the 3-level ambient_sensor chain (panel default / zone
 * override / joint override) from a flat per-joint legacy ambient
 * reference, shared by tools/migrate-legacy-config.js (one-time
 * conversion) and the live JointMasterBackEndNode replacement (every
 * "apply").
 *
 * @param {{joint_id: string, zone_id: string, legacyAmbientId: *}[]} joints
 * @param {{zone_id: string}[]} zones
 * @param {Map<*, string>} legacyIdToNewSlaveId - maps a legacy ambient reference to a new slave_id
 * @returns {{
 *   panelDefaultSlaveId: string|null,
 *   zoneOverrides: Map<string, string>,
 *   jointOverrides: Map<string, string>,
 * }}
 */
function resolveAmbientChain(joints, zones, legacyIdToNewSlaveId) {
  const panelDefaultLegacyId = mode(joints.map((j) => j.legacyAmbientId));
  const panelDefaultSlaveId = legacyIdToNewSlaveId.get(panelDefaultLegacyId) || null;

  const jointsByZone = new Map();
  for (const j of joints) {
    if (!jointsByZone.has(j.zone_id)) jointsByZone.set(j.zone_id, []);
    jointsByZone.get(j.zone_id).push(j);
  }

  const zoneOverrides = new Map();
  for (const zone of zones) {
    const zoneJoints = jointsByZone.get(zone.zone_id) || [];
    const distinctIds = new Set(zoneJoints.map((j) => j.legacyAmbientId));
    if (distinctIds.size === 1) {
      const onlyId = [...distinctIds][0];
      if (onlyId !== panelDefaultLegacyId && legacyIdToNewSlaveId.has(onlyId)) {
        zoneOverrides.set(zone.zone_id, legacyIdToNewSlaveId.get(onlyId));
      }
    }
  }

  const jointOverrides = new Map();
  for (const j of joints) {
    const resolvesViaZone = zoneOverrides.has(j.zone_id);
    const needsOverride = j.legacyAmbientId !== panelDefaultLegacyId && !resolvesViaZone;
    if (needsOverride && legacyIdToNewSlaveId.has(j.legacyAmbientId)) {
      jointOverrides.set(j.joint_id, legacyIdToNewSlaveId.get(j.legacyAmbientId));
    }
  }

  return { panelDefaultSlaveId, zoneOverrides, jointOverrides };
}

module.exports = { resolveAmbientChain, mode };
