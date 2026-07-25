'use strict';

/**
 * Slice 11 — build the Modbus holding-register image from a register map +
 * a computed rollup. Pure: given the same inputs it produces the same
 * registers, so it's fully unit-testable without a socket.
 *
 * Signed 16-bit two's-complement on the wire; ×10 scaling for
 * temperature/ΔT/RoR. A joint with no live reading (blacklisted/stale)
 * gets NO_DATA (-32768 / 0x8000) so the gateway can distinguish "no data"
 * from a real 0.0.
 */

const { STATE_ORD } = require('./rollup');

const INT16_MIN = -32768;
const INT16_MAX = 32767;
const NO_DATA = INT16_MIN; // sentinel

function clampInt16(n) {
  if (n < INT16_MIN) return INT16_MIN;
  if (n > INT16_MAX) return INT16_MAX;
  return n;
}

/** Scale + clamp a value for a point; null/undefined -> NO_DATA. */
function encode(value, scale) {
  if (value == null || !Number.isFinite(value)) return NO_DATA;
  return clampInt16(Math.round(value * scale));
}

/**
 * Build the register image.
 * @param {object} map - from register-map.buildRegisterMap
 * @param {object} rollup - from rollup.computeRollup
 * @param {object} [opts]
 * @param {number} [opts.heartbeat=0] - current scan counter (already wrapped)
 * @returns {{[addr:number]: number}} sparse signed-int16 image
 */
function buildImage(map, rollup, opts = {}) {
  const img = {};
  const set = (addr, v) => { img[addr] = clampInt16(v); };

  // Tier 1
  const worstIndex =
    rollup.worst_joint_id != null && map.tier3
      ? map.tier3.joints.find((j) => j.joint_id === rollup.worst_joint_id)?.index ?? -1
      : rollup.worst_joint_id != null
        ? -2 // worst joint exists but Tier 3 not exposed -> "unknown index"
        : -1;

  const t1 = {
    heartbeat: (opts.heartbeat ?? 0) % 32768,
    system_health: rollup.system_health ?? 0,
    highest_alarm_level: rollup.highest_level ?? 0,
    active_alarm_count: rollup.active_alarm_count ?? 0,
    count_watch: rollup.counts?.watch ?? 0,
    count_warning: rollup.counts?.warning ?? 0,
    count_critical: rollup.counts?.critical ?? 0,
    worst_joint_index: worstIndex,
    panel_max_temp: rollup.panel_max_temp,
    panel_max_deltaT: rollup.panel_max_deltaT,
    panel_max_ror: rollup.panel_max_ror,
    live_joint_count: rollup.live_joint_count ?? 0,
  };
  for (const p of map.tier1.points) set(p.addr, encode(t1[p.key], p.scale));

  // Control block ACK register defaults to 0 (idle) — the server keeps the
  // last-written value; the image builder must not stomp a pending write, so
  // it does NOT write the ACK address here.

  // Severity bitmap (2 bits/joint)
  if (map.bitmap) {
    const regs = {};
    for (const b of map.bitmap.joints) {
      const level = rollup.perJoint[b.joint_id]?.level || 0;
      regs[b.register] = (regs[b.register] || 0) | ((level & 0x3) << b.shift);
    }
    for (const [addr, v] of Object.entries(regs)) set(Number(addr), v & 0xffff);
    // ensure every reserved bitmap register is present (0) so the block reads clean
    for (let i = 0; i < map.bitmap.registers; i++) {
      const addr = map.bitmap.base + i;
      if (!(addr in img)) set(addr, 0);
    }
  }

  // Tier 2 (per zone)
  if (map.tier2) {
    for (const z of map.tier2.zones) {
      const zr = rollup.perZone[z.zone_id] || {};
      const vals = {
        highest_alarm_level: zr.highest_level ?? 0,
        active_alarm_count: zr.active_count ?? 0,
        max_temp: zr.max_temp,
        max_deltaT: zr.max_deltaT,
        max_ror: zr.max_ror,
        count_warning: zr.count_warning ?? 0,
        count_critical: zr.count_critical ?? 0,
      };
      for (const p of z.points) set(p.addr, encode(vals[p.key], p.scale));
    }
  }

  // Tier 3 (per joint)
  if (map.tier3) {
    for (const j of map.tier3.joints) {
      const jr = rollup.perJoint[j.joint_id] || {};
      const vals = {
        level: jr.level ?? 0,
        state: STATE_ORD[jr.state] ?? 0,
        temp: jr.temp,
        deltaT: jr.deltaT,
        ror: jr.ror,
        absolute_temp: jr.temp,
      };
      for (const p of j.points) set(p.addr, encode(vals[p.key], p.scale));
    }
  }

  return img;
}

/**
 * Convert the signed image into the unsigned 16-bit register array a Modbus
 * server serves (length = map.extent). Addresses not in the image read 0.
 */
function toWireRegisters(map, image) {
  const regs = new Uint16Array(map.extent);
  for (const [addr, v] of Object.entries(image)) {
    regs[Number(addr)] = clampInt16(v) & 0xffff;
  }
  return regs;
}

module.exports = { buildImage, toWireRegisters, encode, clampInt16, NO_DATA, INT16_MIN, INT16_MAX };
