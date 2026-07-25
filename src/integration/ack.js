'use strict';

/**
 * Slice 11 — decode a BMS write to the ACK control register into an alarm
 * acknowledgement command, routed through the SAME alarm ACK path as the
 * HMI so the audit trail captures BMS-originated ACKs.
 *
 * Contract (documented in docs/bms-register-map.md, append-only):
 *   write to ACK register (map.control.ack):
 *     value 1        -> ACK ALL currently active alarms (summary ACK)
 *     value 1000 + i -> ACK all active alarms on Tier-3 joint index i
 *     any other      -> ignored (no-op), including 0 (the idle/reset value)
 *
 * "Summary ACK acknowledges all currently active" is deliberate and stated
 * to the customer — a single point cannot carry per-alarm intent.
 */
const ACK_ALL = 1;
const ACK_JOINT_BASE = 1000;

function decodeAck(map, addr, value) {
  if (!map || addr !== map.control?.ack) return null;
  const v = Number(value);
  if (!Number.isInteger(v)) return null;
  if (v === ACK_ALL) return { scope: 'all', source: 'bms' };
  if (v >= ACK_JOINT_BASE) {
    const index = v - ACK_JOINT_BASE;
    const j = map.tier3?.joints.find((x) => x.index === index);
    if (!j) return { scope: 'joint', index, joint_id: null, source: 'bms', error: `no joint at Tier-3 index ${index}` };
    return { scope: 'joint', index, joint_id: j.joint_id, source: 'bms' };
  }
  return null; // 0 / reset / unknown -> no-op
}

module.exports = { decodeAck, ACK_ALL, ACK_JOINT_BASE };
