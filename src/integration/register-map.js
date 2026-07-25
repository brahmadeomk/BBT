'use strict';

/**
 * Slice 11 — deterministic BMS register-map builder.
 *
 * Generates the Modbus holding-register layout from cfg/joints +
 * cfg/integration, so a joint-count change needs no code edit. The layout
 * is customer-facing (docs/bms-register-map.md) and governed by the
 * APPEND-ONLY rule: block bases and per-item strides are FIXED constants
 * here, never derived from counts, so adding a joint/zone never renumbers
 * an existing point. Reserved gaps at the end of each block absorb future
 * appends.
 *
 * All values are signed 16-bit; temperature/ΔT/RoR are ×10 scaled
 * (0.1 resolution); counts/levels/states are unscaled. NO_DATA (a
 * blacklisted/stale joint) is the sentinel -32768 so a gateway can tell
 * "no reading" apart from a real 0.0. See holding-registers.js.
 */

// --- Fixed block layout (append-only: never change an existing base) ---
const TIER1_BASE = 0; //   summary block (points 0..11, 12..15 reserved)
const CONTROL_BASE = 16; // writable control block (ACK point + reserved)
const ACK_ADDR = 16;
const BITMAP_BASE = 32; // optional 2-bit/joint severity block (32..47 -> up to 128 joints)
const BITMAP_MAX_REGISTERS = 16;
const TIER2_BASE = 100; // per-zone blocks, stride 8 (room for up to 50 zones before Tier 3)
const TIER2_STRIDE = 8;
const TIER3_BASE = 500; // per-joint blocks, stride 8
const TIER3_STRIDE = 8;

const MODBUS_MAX_ADDR = 65535;

const S = { unscaled: 1, x10: 10 };

// Tier-1 summary points, in fixed address order.
const TIER1_POINTS = [
  { key: 'heartbeat', off: 0, scale: S.unscaled, desc: 'Scan heartbeat counter (increments every refresh, wraps 0..32767). A frozen value means the Pi/flow has stopped.' },
  { key: 'system_health', off: 1, scale: S.unscaled, desc: '0=OK, 1=DEGRADED (a device blacklisted/comm fault), 2=FAULT (no live joints).' },
  { key: 'highest_alarm_level', off: 2, scale: S.unscaled, desc: 'Highest active process alarm level across the panel: 0=none, 1=WATCH, 2=WARNING, 3=CRITICAL.' },
  { key: 'active_alarm_count', off: 3, scale: S.unscaled, desc: 'Number of active process alarm instances.' },
  { key: 'count_watch', off: 4, scale: S.unscaled, desc: 'Active WATCH-level alarm instances.' },
  { key: 'count_warning', off: 5, scale: S.unscaled, desc: 'Active WARNING-level alarm instances.' },
  { key: 'count_critical', off: 6, scale: S.unscaled, desc: 'Active CRITICAL-level alarm instances.' },
  { key: 'worst_joint_index', off: 7, scale: S.unscaled, desc: 'Tier-3 index of the latched worst joint (first-raised holds it), or -1 when none.' },
  { key: 'panel_max_temp', off: 8, scale: S.x10, desc: 'Panel maximum joint temperature (°C ×10).' },
  { key: 'panel_max_deltaT', off: 9, scale: S.x10, desc: 'Panel maximum ΔT (°C ×10).' },
  { key: 'panel_max_ror', off: 10, scale: S.x10, desc: 'Panel maximum rate-of-rise (°C/hr ×10).' },
  { key: 'live_joint_count', off: 11, scale: S.unscaled, desc: 'Joints currently measurable (LIVE).' },
];

const TIER2_POINTS = [
  { key: 'highest_alarm_level', off: 0, scale: S.unscaled, desc: 'Zone highest active alarm level (0..3).' },
  { key: 'active_alarm_count', off: 1, scale: S.unscaled, desc: 'Zone active process alarm instances.' },
  { key: 'max_temp', off: 2, scale: S.x10, desc: 'Zone maximum temperature (°C ×10).' },
  { key: 'max_deltaT', off: 3, scale: S.x10, desc: 'Zone maximum ΔT (°C ×10).' },
  { key: 'max_ror', off: 4, scale: S.x10, desc: 'Zone maximum RoR (°C/hr ×10).' },
  { key: 'count_warning', off: 5, scale: S.unscaled, desc: 'Zone active WARNING instances.' },
  { key: 'count_critical', off: 6, scale: S.unscaled, desc: 'Zone active CRITICAL instances.' },
  // off 7 reserved
];

const TIER3_POINTS = [
  { key: 'level', off: 0, scale: S.unscaled, desc: 'Joint highest active alarm level (0..3).' },
  { key: 'state', off: 1, scale: S.unscaled, desc: 'Joint liveness: 0=LIVE, 1=STALE (held alarm, device dark), 2=OFFLINE.' },
  { key: 'temp', off: 2, scale: S.x10, desc: 'Joint temperature (°C ×10); -32768 = no data.' },
  { key: 'deltaT', off: 3, scale: S.x10, desc: 'Joint ΔT (°C ×10); -32768 = no data.' },
  { key: 'ror', off: 4, scale: S.x10, desc: 'Joint RoR (°C/hr ×10); -32768 = no data.' },
  { key: 'absolute_temp', off: 5, scale: S.x10, desc: 'Joint absolute temperature (°C ×10); duplicate of temp for gateways wanting a distinct point.' },
  // off 6,7 reserved
];

/**
 * Real (alarmable) zones from cfg/joints, in a STABLE order (declared
 * zones[] order first, then any zone referenced by a joint but not
 * declared, sorted). Stable order == stable Tier-2 indices == append-only.
 */
function orderedZones(jointsDoc, { includeAmbient = false } = {}) {
  const declared = (jointsDoc?.zones || []).map((z) => z.zone_id);
  const seen = new Set(declared);
  const extra = [];
  for (const j of jointsDoc?.joints || []) {
    const z = j.zone_id;
    if (z != null && !seen.has(z)) { seen.add(z); extra.push(z); }
  }
  extra.sort();
  let zones = [...declared, ...extra];
  if (!includeAmbient) zones = zones.filter((z) => z !== 'AMBIENT' && z !== 'AMBIENT_ZONE');
  return zones;
}

/** Joints in cfg/joints[] order — that order is the fixed Tier-3 index. */
function orderedJoints(jointsDoc) {
  return (jointsDoc?.joints || []).map((j) => j.joint_id);
}

/**
 * Build the full register map for a cfg/integration doc + cfg/joints doc.
 * @returns {{point_map_version, exposure_tier, tier1, control, bitmap, tier2, tier3, extent}}
 */
function buildRegisterMap(integrationDoc, jointsDoc) {
  const tier = integrationDoc?.exposure_tier ?? 1;
  const bitmapOn = !!integrationDoc?.severity_bitmap?.enabled;
  const includeAmbient = !!integrationDoc?.zone_rollup?.include_ambient_zone;

  const zones = orderedZones(jointsDoc, { includeAmbient });
  const joints = orderedJoints(jointsDoc);

  let extent = 0;
  const bump = (addr) => { if (addr + 1 > extent) extent = addr + 1; };

  // Tier 1 (always) + control block
  const tier1 = { base: TIER1_BASE, points: TIER1_POINTS.map((p) => ({ ...p, addr: TIER1_BASE + p.off })) };
  tier1.points.forEach((p) => bump(p.addr));
  const control = { base: CONTROL_BASE, ack: ACK_ADDR };
  bump(CONTROL_BASE + 3); // reserve 16..19

  // Optional severity bitmap
  let bitmap = null;
  if (bitmapOn) {
    const registers = Math.ceil(joints.length / 8);
    if (registers > BITMAP_MAX_REGISTERS) {
      return { error: `severity_bitmap needs ${registers} registers but only ${BITMAP_MAX_REGISTERS} are reserved (max 128 joints)` };
    }
    bitmap = {
      base: BITMAP_BASE,
      registers,
      joints: joints.map((joint_id, index) => ({
        joint_id, index,
        register: BITMAP_BASE + Math.floor(index / 8),
        shift: (index % 8) * 2, // 2 bits per joint
      })),
    };
    bitmap.joints.forEach((b) => bump(b.register));
  }

  // Tier 2 (per zone) when exposure >= 2
  let tier2 = null;
  if (tier >= 2) {
    tier2 = {
      base: TIER2_BASE, stride: TIER2_STRIDE,
      zones: zones.map((zone_id, index) => {
        const zbase = TIER2_BASE + index * TIER2_STRIDE;
        return { zone_id, index, base: zbase, points: TIER2_POINTS.map((p) => ({ ...p, addr: zbase + p.off })) };
      }),
    };
    tier2.zones.forEach((z) => z.points.forEach((p) => bump(p.addr)));
    const tier2End = TIER2_BASE + zones.length * TIER2_STRIDE;
    if (tier2End > TIER3_BASE) {
      return { error: `${zones.length} zones overflow the Tier-2 region (base ${TIER2_BASE}..${TIER3_BASE}); too many zones for the fixed layout` };
    }
  }

  // Tier 3 (per joint) when exposure >= 3
  let tier3 = null;
  if (tier >= 3) {
    tier3 = {
      base: TIER3_BASE, stride: TIER3_STRIDE,
      joints: joints.map((joint_id, index) => {
        const jbase = TIER3_BASE + index * TIER3_STRIDE;
        return { joint_id, index, base: jbase, points: TIER3_POINTS.map((p) => ({ ...p, addr: jbase + p.off })) };
      }),
    };
    tier3.joints.forEach((j) => j.points.forEach((p) => bump(p.addr)));
  }

  if (extent - 1 > MODBUS_MAX_ADDR) {
    return { error: `register map extent ${extent} exceeds the Modbus address space (${MODBUS_MAX_ADDR})` };
  }

  return {
    point_map_version: integrationDoc?.point_map_version ?? 1,
    exposure_tier: tier,
    tier1, control, bitmap, tier2, tier3,
    extent,
  };
}

/**
 * Highest register the map would occupy (for validator I5 capacity check),
 * or an error string if the layout can't be built.
 */
function mapExtent(integrationDoc, jointsDoc) {
  const m = buildRegisterMap(integrationDoc, jointsDoc);
  return m.error ? { error: m.error } : m.extent;
}

module.exports = {
  buildRegisterMap,
  mapExtent,
  orderedZones,
  orderedJoints,
  TIER1_POINTS,
  TIER2_POINTS,
  TIER3_POINTS,
  ACK_ADDR,
  constants: { TIER1_BASE, CONTROL_BASE, ACK_ADDR, BITMAP_BASE, BITMAP_MAX_REGISTERS, TIER2_BASE, TIER2_STRIDE, TIER3_BASE, TIER3_STRIDE, MODBUS_MAX_ADDR },
};
