'use strict';

/**
 * What losing one device costs, and how an operator identifies it.
 *
 * EXTRACTED 2026-09-24 from blacklist-handler.js, verbatim, so behaviour could
 * not shift in the move. Two surfaces now need the same two sentences and must
 * not word them differently: the blacklist alarm (a device that FAILED) and the
 * Configuration Status banner (a device deliberately SWITCHED OFF).
 *
 * The distinction the wording carries is the valuable part - joints a device
 * CARRIES stop being measurable, while joints that merely REFERENCE it as their
 * ambient lose ΔT - and a dedicated ambient slave carries no joints at all, so
 * a naive summary reads "no joints affected" for a loss that disables ΔT across
 * the panel. That understatement is the bug this text was written to fix once
 * already, on the blacklist alarm.
 */

function jointsForSlave(doc, slaveId) {
  return (doc?.joints || []).filter((j) => j.slave_id === slaveId).map((j) => j.joint_id);
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
 * The two ways losing a device hurts: joints it CARRIES stop being measurable,
 * and joints that merely REFERENCE it as their ambient lose ΔT. `text` is the
 * operator-facing summary; `joints`/`ambientFor` are the raw lists for a caller
 * that wants to word it differently.
 *
 * Shared by the blacklist raise path, its description refresh, and the
 * Configuration Status banner, so none of the three can word it differently -
 * and so the refresh can compare IMPACT rather than the full description, whose
 * prefixes deliberately differ.
 */
function impactFor(doc, slaveId) {
  const joints = jointsForSlave(doc, slaveId);
  const ambientFor = jointsUsingAmbientSlave(doc, slaveId).filter((j) => !joints.includes(j));
  const parts = [];
  if (joints.length) parts.push(`joint(s) ${joints.join(', ')} not measurable`);
  if (ambientFor.length) parts.push(`ambient reference for joint(s) ${ambientFor.join(', ')} - ΔT unavailable`);
  if (!parts.length) parts.push('no joints affected');
  return { joints, ambientFor, text: parts.join('; ') };
}

module.exports = {
  jointsForSlave,
  ambientSlaveForJoint,
  jointsUsingAmbientSlave,
  slaveDisplayName,
  impactFor,
};
