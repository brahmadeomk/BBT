'use strict';

/**
 * Human-readable dump of the register image the Modbus TCP slave is serving —
 * exactly what a gateway/Modbus master reads, decoded.
 *
 * Commissioning a Modbus→BACnet gateway means proving "address N really is
 * panel_max_temp = 61.5 °C". A raw register array can't show that, and the
 * ×10 scaling plus the NO_DATA sentinel are easy to misread by eye. This
 * renders address → block → point → raw → engineering value so the register
 * map document, the HMI and the gateway can be cross-checked in one glance.
 *
 * Pure: takes the map + the sparse signed image that buildImage() produced.
 */

const { NO_DATA } = require('./holding-registers');
const { STATE_ORD } = require('./rollup');

const LEVEL_NAME = ['none', 'WATCH', 'WARNING', 'CRITICAL'];
const HEALTH_NAME = ['OK', 'DEGRADED', 'FAULT'];
const STATE_NAME = Object.keys(STATE_ORD); // index-aligned: LIVE, STALE, OFFLINE

/** Engineering rendering of one point's raw register value. */
function renderValue(key, raw, scale) {
  if (raw === NO_DATA) return 'no data';
  if (scale === 10) return `${(raw / 10).toFixed(1)} ${key.includes('ror') ? '°C/hr' : '°C'}`;
  if (key === 'highest_alarm_level' || key === 'level') return `${raw} (${LEVEL_NAME[raw] ?? '?'})`;
  if (key === 'system_health') return `${raw} (${HEALTH_NAME[raw] ?? '?'})`;
  if (key === 'state') return `${raw} (${STATE_NAME[raw] ?? '?'})`;
  if (key === 'worst_joint_index') {
    if (raw === -1) return '-1 (none)';
    if (raw === -2) return '-2 (set, Tier 3 not exposed)';
    return String(raw);
  }
  return String(raw);
}

/**
 * @param {object} map - buildRegisterMap() output
 * @param {object} image - buildImage() output (sparse {addr: signed int16})
 * @param {object} [opts]
 * @param {boolean} [opts.includeEmpty=false] - include reserved/unwritten addresses
 * @returns {{rows: Array, extent: number, point_map_version: number, exposure_tier: number}}
 */
function describeImage(map, image = {}, { includeEmpty = false } = {}) {
  const rows = [];
  const push = (addr, block, point, label) => {
    const raw = image[addr];
    if (raw === undefined && !includeEmpty) return;
    rows.push({
      addr,
      block,
      point,
      label: label ?? null,
      raw: raw === undefined ? null : raw,
      value: raw === undefined ? '(not written)' : renderValue(point, raw, pointScale(block, point)),
    });
  };

  const scaleOf = {};
  function pointScale(block, key) {
    return scaleOf[`${block}:${key}`] ?? 1;
  }

  for (const p of map.tier1.points) scaleOf[`Tier 1:${p.key}`] = p.scale;
  if (map.tier2) for (const p of map.tier2.zones[0]?.points || []) scaleOf[`Tier 2:${p.key}`] = p.scale;
  if (map.tier3) for (const p of map.tier3.joints[0]?.points || []) scaleOf[`Tier 3:${p.key}`] = p.scale;

  for (const p of map.tier1.points) push(p.addr, 'Tier 1', p.key);

  // The ACK register is writable and deliberately not written by buildImage,
  // so show it explicitly rather than letting it look absent.
  rows.push({
    addr: map.control.ack,
    block: 'Control',
    point: 'ack_command',
    label: 'writable (1 = ack all, 1000+i = ack joint i)',
    raw: image[map.control.ack] ?? 0,
    value: String(image[map.control.ack] ?? 0),
  });

  if (map.bitmap) {
    for (let i = 0; i < map.bitmap.registers; i++) {
      const addr = map.bitmap.base + i;
      const joints = map.bitmap.joints.filter((b) => b.register === addr).map((b) => b.joint_id);
      push(addr, 'Bitmap', `severity_bits_${i}`, joints.join(', '));
    }
  }

  if (map.tier2) {
    for (const z of map.tier2.zones) for (const p of z.points) push(p.addr, 'Tier 2', p.key, z.zone_id);
  }
  if (map.tier3) {
    for (const j of map.tier3.joints) for (const p of j.points) push(p.addr, 'Tier 3', p.key, j.joint_id);
  }

  rows.sort((a, b) => a.addr - b.addr);
  return {
    rows,
    extent: map.extent,
    point_map_version: map.point_map_version,
    exposure_tier: map.exposure_tier,
  };
}

/** Fixed-width text dump, for a debug node or a terminal. */
function formatImage(map, image, opts) {
  const d = describeImage(map, image, opts);
  const head = `BMS register image — tier ${d.exposure_tier}, point_map_version ${d.point_map_version}, ${d.extent} registers`;
  const lines = d.rows.map(
    (r) => `${String(r.addr).padStart(5)}  ${r.block.padEnd(8)} ${r.point.padEnd(20)} ${String(r.raw).padStart(7)}  ${r.value}${r.label ? `   [${r.label}]` : ''}`
  );
  return [head, '  addr  block    point                    raw  value', ...lines].join('\n');
}

module.exports = { describeImage, formatImage, renderValue, LEVEL_NAME, HEALTH_NAME, STATE_NAME };
