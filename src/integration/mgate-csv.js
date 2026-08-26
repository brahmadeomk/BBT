'use strict';

/**
 * Generates the Moxa MGate 5217 Modbus-configuration CSV from a panel's live
 * register map, so the gateway's several hundred points are derived from the
 * commissioned configuration instead of typed by hand.
 *
 * WHY THIS EXISTS. The MGate reads **one register per command** (`Read quantity`
 * is 1 or 2, manual v1.4 p19), so a Tier-3 panel needs 600–1200 commands. Hand
 * entry is not realistic, and worse, a hand-built sheet drifts from the panel
 * the first time a joint is added. This reads the same `buildRegisterMap` the
 * panel serves from, so the two cannot disagree.
 *
 * WHY IT PREFERS A TEMPLATE. The manual documents the CSV's `[command_parameters]`
 * columns (p57–61) but its list does not include the `Data scaling` / `Data
 * addition` fields that the web console has (p20) — and the CSV format is
 * versioned (v1.2.0 at firmware v1.3, p54). Rather than hardcode a header that
 * may not match the firmware in front of you, pass `--template` an export from
 * the actual gateway and the rows are emitted against ITS header. Any column
 * this generator has no opinion about is filled with `*`, which the manual
 * defines as "not used".
 */

/** Manual p59: object type is constrained by the function code. */
const READ_FUNC = 3;   // read holding registers
const WRITE_FUNC = 6;  // write single register

/** Manual p60 unit codes. */
const UNIT_DEGREES_CELSIUS = 62;
const UNIT_NO_UNITS = 95;

/** Manual p57: devSequence is 1..32 for Modbus TCP. */
const MAX_DEVICES = 32;

/**
 * Manual p61: `- " ' # * , [ ]` are not allowed in bacnetDescription, and the
 * field is 40 characters. Non-ASCII is excluded too — the panel's own point
 * descriptions contain "°C" and "ΔT", which have no business in a CSV that is
 * parsed by firmware.
 */
const DESCRIPTION_MAX = 40;
function sanitizeDescription(text) {
  const cleaned = String(text ?? '')
    .replace(/[ΔΩ°]/g, (c) => ({ 'Δ': 'delta', 'Ω': 'ohm', '°': 'deg' }[c]))
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/["'#*,\[\]\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, DESCRIPTION_MAX);
}

/** cmdName is 39 characters (p57) and has no documented charset restriction. */
function sanitizeName(text) {
  return sanitizeDescription(text).slice(0, 39);
}

/**
 * Which BACnet object type a point becomes.
 *
 * The constraint that matters (p59): **Analog Value is only legal on WRITE
 * functions** (5/6/15/16). Every measurement we expose is FC 3, so the analog
 * choice for a read is `Analog Input`, never `Analog Value` — a mistake that
 * would be rejected at import rather than at runtime, but only after the whole
 * sheet had been built.
 */
function objectTypeFor(point, { write = false } = {}) {
  if (write) return 'Analog Value';                 // FC 6, readable + writable
  if (point.scale && point.scale !== 1) return 'Analog Input';
  if (point.key === 'level' || point.key === 'state' || point.key === 'highest_alarm_level') {
    return 'Multi-state Input';                     // enumerated, p59 allows on FC 3
  }
  return 'Integer Value';                           // counts, indices, heartbeat
}

function unitFor(point, objectType) {
  if (objectType === 'Multi-state Input' || objectType === 'Multi-state Value') return UNIT_NO_UNITS;
  return point.scale && point.scale !== 1 ? UNIT_DEGREES_CELSIUS : UNIT_NO_UNITS;
}

/**
 * COV increment. Manual p60: float for Analog, integer for Integer Value, and
 * the minimum is 1 — so on a ×0.1-scaled analog, 1 means "notify on a 1 °C
 * change", which is the sensible default. Moxa advise fewer than 300 COV
 * subscriptions (p21), so this is a ceiling on chattiness, not an invitation.
 */
function covIncrementFor() {
  return 1;
}

/**
 * Turns a register map into MGate devices + commands.
 *
 * @param {object} map - from buildRegisterMap()
 * @param {object} opts
 * @param {object} [opts.jointsDoc] - the applied cfg/joints. Needed for zone
 *   grouping: the register map deliberately does NOT carry zone_id on a Tier-3
 *   joint (it is a flat address map), so the joint->zone relation comes from
 *   the config it was built from.
 * @param {'zone'|'flat'} [opts.grouping='zone'] - 'zone' uses the gateway's
 *   virtual-node feature: one Modbus device (hence one BACnet device) for the
 *   panel summary and one per zone, so the BMS gets a navigable tree instead of
 *   one flat list of a thousand objects.
 * @param {boolean} [opts.skipAbsoluteTemp=false] - drop the Tier-3 `absolute_temp`
 *   point, which the register map documents as a duplicate of `temp`. Saves one
 *   point per joint; at ~200 joints that is the difference between one gateway
 *   and two.
 * @param {number} [opts.zoneFrom=0] @param {number} [opts.zoneTo=Infinity]
 *   Zone index range for this gateway — the RECOMMENDED way to split, because a
 *   zone's Tier-2 rollup covers every joint in that zone regardless of which
 *   gateway carries them. Splitting by joint index instead would put the same
 *   rollup on both gateways: two BACnet objects reporting one register.
 * @param {number} [opts.jointFrom=0] @param {number} [opts.jointTo=Infinity]
 *   Tier-3 joint index range. Use with `grouping: 'flat'`; with zone grouping
 *   prefer zoneFrom/zoneTo.
 * @param {boolean} [opts.includePanel=true] - Tier 1 + ACK. Put these on ONE
 *   gateway only; the heartbeat is added to the other separately.
 * @param {boolean} [opts.includeHeartbeat=true]
 * @param {string} [opts.panelIp='192.168.1.110'] @param {number} [opts.panelPort=1502]
 * @param {number} [opts.pollIntervalMs=1000]
 * @param {number} [opts.pointLimit=1200]
 */
function buildMgatePlan(map, opts = {}) {
  const {
    jointsDoc = null,
    grouping = 'zone',
    skipAbsoluteTemp = false,
    jointFrom = 0,
    jointTo = Infinity,
    zoneFrom = 0,
    zoneTo = Infinity,
    includePanel = true,
    includeHeartbeat = true,
    panelIp = '192.168.1.110',
    panelPort = 1502,
    pollIntervalMs = 1000,
    pointLimit = 1200,
  } = opts;

  const errors = [];
  const warnings = [];
  const devices = [];
  const commands = [];
  const instanceCounters = new Map();   // per object type — p60 requires uniqueness within a type

  const nextInstance = (objectType) => {
    const n = (instanceCounters.get(objectType) ?? 0) + 1;
    instanceCounters.set(objectType, n);
    return n;
  };

  const addDevice = (name) => {
    const devIndex = devices.length + 1;
    devices.push({
      devIndex,
      devSequence: devIndex,            // 2nd–3rd digits of the BACnet instance (p57)
      devSlaveId: devIndex,             // our server ignores unit id; this is a label
      devName: sanitizeName(name),
      devIpAddr: panelIp,
      devPort: panelPort,
    });
    return devIndex;
  };

  const addCommand = (devIndex, point, label, { write = false } = {}) => {
    const objectType = objectTypeFor(point, { write });
    commands.push({
      cmdIndex: commands.length + 1,
      cmdEnable: 'Enable',
      cmdName: sanitizeName(label),
      cmdDevIndex: devIndex,
      cmdDataFormat: 'int16',           // every point is signed 16-bit
      cmdFunc: write ? WRITE_FUNC : READ_FUNC,
      cmdTrigger: 'Cyclic',
      cmdPollinterval: pollIntervalMs,
      cmdEndianSwap: 'None',
      cmdReadStartAddr: write ? '*' : point.addr,
      cmdReadQuan: write ? '*' : 1,
      cmdWriteStartAddr: write ? point.addr : '*',
      cmdWriteQuan: write ? 1 : '*',
      bacnetObjectType: objectType,
      bacnetUnit: unitFor(point, objectType),
      bacnetCovIncrement: covIncrementFor(objectType),
      bacnetInstance: nextInstance(objectType),
      bacnetDescription: sanitizeDescription(label),
      // carried for the caller's own reporting, stripped before CSV output
      _scale: point.scale ?? 1,
      _addr: point.addr,
    });
  };

  // --- panel summary device ------------------------------------------------
  const heartbeat = map.tier1?.points?.find((p) => p.key === 'heartbeat');
  if (includePanel) {
    const dev = addDevice('Panel Summary');
    for (const p of map.tier1?.points ?? []) addCommand(dev, p, `Panel ${p.key}`);
    if (map.control?.ack != null) {
      addCommand(dev, { key: 'ack_command', addr: map.control.ack, scale: 1 }, 'Panel alarm ack', { write: true });
    }
  } else if (includeHeartbeat && heartbeat) {
    // The other gateway still needs liveness of its own: Modbus has none, so a
    // frozen heartbeat is the only way its BACnet device can be shown as dead.
    const dev = addDevice('Panel Heartbeat');
    addCommand(dev, heartbeat, 'Panel heartbeat');
  }

  // --- joints, grouped by zone (or flat) -----------------------------------
  const allJoints = (map.tier3?.joints ?? []).filter((j) => j.index >= jointFrom && j.index <= jointTo);
  const jointPoints = (j) => j.points.filter((p) => !(skipAbsoluteTemp && p.key === 'absolute_temp'));

  if (grouping === 'zone' && map.tier2?.zones?.length) {
    const zoneOfJoint = new Map((jointsDoc?.joints ?? []).map((j) => [j.joint_id, j.zone_id]));
    // Prefer the zone's human name for the BACnet device - "Zone 1" reads better
    // in a BMS tree than the internal id "z1".
    const zoneName = new Map((jointsDoc?.zones ?? []).map((z) => [z.zone_id, z.name || z.zone_id]));
    const jointsByZone = new Map();
    for (const j of allJoints) {
      const zoneId = zoneOfJoint.get(j.joint_id) ?? null;
      const key = zoneId ?? '_unzoned';
      if (!jointsByZone.has(key)) jointsByZone.set(key, []);
      jointsByZone.get(key).push(j);
    }
    for (const zone of map.tier2.zones) {
      // A zone belongs to exactly ONE gateway, rollup and joints together.
      if (zone.index < zoneFrom || zone.index > zoneTo) continue;
      const zoneJoints = jointsByZone.get(zone.zone_id) ?? [];
      const label = zoneName.get(zone.zone_id) || `Zone ${zone.zone_id}`;
      const dev = addDevice(label);
      for (const p of zone.points) addCommand(dev, p, `${label} ${p.key}`);
      for (const j of zoneJoints) {
        for (const p of jointPoints(j)) addCommand(dev, p, `${j.joint_id} ${p.key}`);
      }
    }
    const unzoned = jointsByZone.get('_unzoned') ?? [];
    if (unzoned.length) {
      const dev = addDevice('Unzoned Joints');
      for (const j of unzoned) for (const p of jointPoints(j)) addCommand(dev, p, `${j.joint_id} ${p.key}`);
    }
  } else {
    const dev = addDevice('Panel Joints');
    const zoneNameFlat = new Map((jointsDoc?.zones ?? []).map((z) => [z.zone_id, z.name || z.zone_id]));
    for (const z of map.tier2?.zones ?? []) {
      const label = zoneNameFlat.get(z.zone_id) || `Zone ${z.zone_id}`;
      for (const p of z.points) addCommand(dev, p, `${label} ${p.key}`);
    }
    for (const j of allJoints) for (const p of jointPoints(j)) addCommand(dev, p, `${j.joint_id} ${p.key}`);
  }

  // --- limits (p57) --------------------------------------------------------
  if (commands.length > pointLimit) {
    errors.push(
      `${commands.length} commands exceeds the ${pointLimit}-point model (cmdIndex caps at ${pointLimit}). ` +
      `Split across two gateways, or drop absolute_temp to save one point per joint.`
    );
  }
  if (devices.length > MAX_DEVICES) {
    errors.push(`${devices.length} Modbus devices exceeds the ${MAX_DEVICES} the gateway allows in TCP mode (devSequence 1..32).`);
  }
  if (commands.length > 300) {
    warnings.push(
      `${commands.length} points: Moxa advise fewer than 300 COV subscriptions (manual p21). ` +
      `Have the BMS subscribe COV to the summary and alarm levels only, and poll the per-joint values.`
    );
  }
  const scaled = commands.filter((c) => c._scale !== 1).length;
  if (scaled) {
    warnings.push(
      `${scaled} point(s) are x10 scaled. The CSV has no documented scaling column, so set ` +
      `"Data scaling (multiplication)" = 0.1 on these in the web console after import (manual p20), ` +
      `or tell the BMS to divide by 10. Their descriptions are the ones with a degrees-celsius unit (62).`
    );
  }

  return { devices, commands, errors, warnings };
}

/** Default header, used only when no gateway export is supplied. p57–61 order. */
const DEFAULT_COMMAND_HEADER = [
  'cmdIndex', 'cmdEnable', 'cmdName', 'cmdDevIndex', 'cmdDataFormat', 'cmdFunc',
  'cmdTrigger', 'cmdPollinterval', 'cmdEndianSwap', 'cmdReadStartAddr', 'cmdReadQuan',
  'cmdWriteStartAddr', 'cmdWriteQuan', 'cmdFaultProtType', 'cmdFaultProtTout',
  'bacnetObjectType', 'bacnetUnit', 'bacnetCovIncrement', 'bacnetRelinquishDefault',
  'bacnetInstance', 'bacnetRegisterAddress', 'bacnetDescription',
];

const DEFAULT_DEVICE_HEADER = [
  'devIndex', 'portIndex', 'devSlaveId', 'devName', 'devIpAddr', 'devPort',
  'devInactiveTime', 'devSequence',
];

/**
 * Pulls the real header for a section out of a CSV exported from the gateway.
 * @returns {string[]|null}
 */
function headerFromTemplate(csvText, section) {
  const lines = String(csvText || '').split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim().toLowerCase().startsWith(`[${section}]`));
  if (at === -1) return null;
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('[')) return null;          // section had no header row
    return line.split(',').map((h) => h.trim());
  }
  return null;
}

/** A field this generator has no opinion about: the manual's "not used" marker. */
const NOT_USED = '*';

function toCsv(plan, { commandHeader, deviceHeader, portIndex = 1 } = {}) {
  const ch = commandHeader && commandHeader.length ? commandHeader : DEFAULT_COMMAND_HEADER;
  const dh = deviceHeader && deviceHeader.length ? deviceHeader : DEFAULT_DEVICE_HEADER;

  const row = (obj, header) => header.map((h) => {
    const v = obj[h];
    return v === undefined || v === null ? NOT_USED : String(v);
  }).join(',');

  const out = [];
  out.push('[device_parameters]');
  out.push(dh.join(','));
  for (const d of plan.devices) out.push(row({ ...d, portIndex, devInactiveTime: 0 }, dh));
  out.push('');
  out.push('[command_parameters]');
  out.push(ch.join(','));
  for (const c of plan.commands) {
    const clean = { ...c };
    delete clean._scale; delete clean._addr;
    out.push(row(clean, ch));
  }
  return out.join('\n') + '\n';
}

module.exports = {
  buildMgatePlan, toCsv, headerFromTemplate,
  sanitizeDescription, sanitizeName, objectTypeFor, unitFor,
  DEFAULT_COMMAND_HEADER, DEFAULT_DEVICE_HEADER,
  UNIT_DEGREES_CELSIUS, UNIT_NO_UNITS, MAX_DEVICES, DESCRIPTION_MAX,
};
