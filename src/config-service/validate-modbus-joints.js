'use strict';

const { validateModbusJointSchema, formatAjvErrors } = require('./schemas');

const DEFAULTS = {
  channels: 4,
  poll_interval_s: 30,
  timeout_ms: 500,
  retries: 2,
  inter_frame_ms: 20,
  temp_word_count: 1,
};

function err(rule, message) {
  return { rule, message };
}

/**
 * Worst-case per-slave transaction time on an RTU bus: frame time at the
 * configured baud plus a full timeout*retries in case the slave never
 * answers. This is deliberately pessimistic (R10 asks for worst case, not
 * average case).
 */
function worstCaseSlaveMs(bus, slave) {
  const timeoutMs = bus.timeout_ms ?? DEFAULTS.timeout_ms;
  const retries = bus.retries ?? DEFAULTS.retries;
  const interFrameMs = bus.inter_frame_ms ?? DEFAULTS.inter_frame_ms;

  if (bus.type !== 'rtu' || !bus.baud) {
    // TCP buses aren't subject to RS-485 half-duplex bus-sharing timing;
    // still bound worst case by timeout*retries per slave.
    return interFrameMs + timeoutMs * retries;
  }

  const channels = slave.channels ?? DEFAULTS.channels;
  const wordCount = slave.registers?.temp_word_count ?? DEFAULTS.temp_word_count;
  const registerCount = channels * wordCount;

  const reqBytes = 8; // addr(1) + func(1) + startAddr(2) + count(2) + crc(2)
  const respBytes = 5 + 2 * registerCount; // addr(1) + func(1) + bytecount(1) + data(2*n) + crc(2)
  const charTimeMs = (11 / bus.baud) * 1000; // 11 bits/char worst case (8N1 + framing margin)

  return interFrameMs + (reqBytes + respBytes) * charTimeMs + timeoutMs * retries;
}

/**
 * Validates a cfg/modbus + cfg/joints document: JSON Schema, then the
 * mandatory cross-field rules R1-R12 and R14 (R13 is an apply-time
 * workflow requirement enforced by the config store, not a document
 * validation rule - see src/config-service/store.js).
 *
 * Ambient sensor resolution (R7/R9/R14) follows a 3-level override
 * chain per joint: joints[].ambient_sensor, else zones[].ambient_sensor
 * for that joint's zone, else modbus.ambient_sensor (panel-wide
 * default) - added so a busduct run that passes through both
 * air-conditioned and open-air zones can use a different ambient
 * reference per zone (or per joint, for an exception within a zone)
 * instead of one panel-wide ambient for the whole run.
 *
 * @param {object} doc - the cfg/modbus + cfg/joints document
 * @param {object} [context]
 * @param {{modbus?: number, joints?: number}} [context.appliedVersions] - currently applied per-domain versions, for R11
 * @param {'remote'|'local'} [context.source] - origin of this push, for R12
 * @param {boolean} [context.maintenanceMode] - whether the panel is in maintenance mode, for R12
 * @param {object} [context.alarmsDoc] - the currently applied cfg/alarms document, for R9
 * @returns {{valid: boolean, errors: {rule: string, message: string}[]}}
 */
function validateModbusJoints(doc, context = {}) {
  const schemaValid = validateModbusJointSchema(doc);
  if (!schemaValid) {
    return { valid: false, errors: formatAjvErrors(validateModbusJointSchema.errors) };
  }

  const errors = [];
  const buses = doc.modbus.buses;
  const slaves = doc.modbus.slaves;
  const joints = doc.joints;
  const zones = doc.zones;
  const panelAmbient = doc.modbus.ambient_sensor;

  const busIds = new Set(buses.map((b) => b.bus_id));
  const slaveById = new Map(slaves.map((s) => [s.slave_id, s]));
  const zoneIds = zones ? new Set(zones.map((z) => z.zone_id)) : null;
  const zoneById = zones ? new Map(zones.map((z) => [z.zone_id, z])) : new Map();

  /**
   * Resolves the ambient sensor that applies to a joint: its own
   * override, else its zone's override, else the panel-wide default.
   * Returns { ref, source } or null if nothing applies at any level.
   */
  function resolveEffectiveAmbient(joint) {
    if (joint.ambient_sensor) return { ref: joint.ambient_sensor, source: `joint '${joint.joint_id}' override` };
    const zone = zoneById.get(joint.zone_id);
    if (zone?.ambient_sensor) return { ref: zone.ambient_sensor, source: `zone '${zone.zone_id}' override` };
    if (panelAmbient) return { ref: panelAmbient, source: 'panel default' };
    return null;
  }

  // R3: slaves[].bus_id must exist in buses[].bus_id
  for (const slave of slaves) {
    if (!busIds.has(slave.bus_id)) {
      errors.push(err('R3', `slave '${slave.slave_id}' references unknown bus_id '${slave.bus_id}'`));
    }
  }

  // R1: joints[].slave_id must exist in modbus.slaves[].slave_id
  for (const joint of joints) {
    if (!slaveById.has(joint.slave_id)) {
      errors.push(err('R1', `joint '${joint.joint_id}' references unknown slave_id '${joint.slave_id}'`));
    }
  }

  // R2: joints[].zone_id must exist in zones[].zone_id, if zones provided
  if (zoneIds) {
    for (const joint of joints) {
      if (!zoneIds.has(joint.zone_id)) {
        errors.push(err('R2', `joint '${joint.joint_id}' references unknown zone_id '${joint.zone_id}'`));
      }
    }
  }

  // R4: (bus_id, unit_address) pairs must be unique
  {
    const seen = new Map();
    for (const slave of slaves) {
      const key = `${slave.bus_id}:${slave.unit_address}`;
      if (seen.has(key)) {
        errors.push(
          err(
            'R4',
            `duplicate unit_address ${slave.unit_address} on bus '${slave.bus_id}' (slaves '${seen.get(key)}' and '${slave.slave_id}')`
          )
        );
      } else {
        seen.set(key, slave.slave_id);
      }
    }
  }

  // R5: slave_id / joint_id / zone_id uniqueness
  {
    const dupes = (items, keyFn, label) => {
      const seen = new Set();
      for (const item of items) {
        const key = keyFn(item);
        if (seen.has(key)) {
          errors.push(err('R5', `duplicate ${label} '${key}'`));
        }
        seen.add(key);
      }
    };
    dupes(slaves, (s) => s.slave_id, 'slave_id');
    dupes(joints, (j) => j.joint_id, 'joint_id');
    if (zones) dupes(zones, (z) => z.zone_id, 'zone_id');
  }

  // R6: joints[].channel <= channels of the referenced slave
  for (const joint of joints) {
    const slave = slaveById.get(joint.slave_id);
    if (!slave) continue; // already reported by R1
    const channels = slave.channels ?? DEFAULTS.channels;
    if (joint.channel > channels) {
      errors.push(
        err(
          'R6',
          `joint '${joint.joint_id}' channel ${joint.channel} exceeds slave '${slave.slave_id}' channel count ${channels}`
        )
      );
    }
  }

  // R7: (slave_id, channel) referenced by at most one joint, and not also by any effective ambient_sensor
  {
    const claimedBy = new Map();
    for (const joint of joints) {
      const key = `${joint.slave_id}:${joint.channel}`;
      if (claimedBy.has(key)) {
        errors.push(
          err(
            'R7',
            `slave '${joint.slave_id}' channel ${joint.channel} is mapped by both joint '${claimedBy.get(key)}' and joint '${joint.joint_id}'`
          )
        );
      } else {
        claimedBy.set(key, joint.joint_id);
      }
    }

    const ambientClaims = [];
    if (panelAmbient) ambientClaims.push({ ref: panelAmbient, label: 'modbus.ambient_sensor (panel default)' });
    for (const zone of zones || []) {
      if (zone.ambient_sensor) ambientClaims.push({ ref: zone.ambient_sensor, label: `zone '${zone.zone_id}' ambient_sensor` });
    }
    for (const joint of joints) {
      if (joint.ambient_sensor) ambientClaims.push({ ref: joint.ambient_sensor, label: `joint '${joint.joint_id}' ambient_sensor override` });
    }
    for (const claim of ambientClaims) {
      const key = `${claim.ref.slave_id}:${claim.ref.channel}`;
      if (claimedBy.has(key)) {
        errors.push(
          err(
            'R7',
            `slave '${claim.ref.slave_id}' channel ${claim.ref.channel} is used by both ${claim.label} and joint '${claimedBy.get(key)}'`
          )
        );
      }
    }
  }

  // R8: bus type consistency - RTU requires port+baud, TCP requires host, no mixed fields
  for (const bus of buses) {
    if (bus.type === 'rtu') {
      if (!bus.port || !bus.baud) {
        errors.push(err('R8', `RTU bus '${bus.bus_id}' requires both port and baud`));
      }
      if (bus.host) {
        errors.push(err('R8', `RTU bus '${bus.bus_id}' must not set host (TCP-only field)`));
      }
    } else if (bus.type === 'tcp') {
      if (!bus.host) {
        errors.push(err('R8', `TCP bus '${bus.bus_id}' requires host`));
      }
      if (bus.port || bus.baud) {
        errors.push(err('R8', `TCP bus '${bus.bus_id}' must not set port/baud (RTU-only fields)`));
      }
    }
  }

  // R9: if alarms are in use (every profile requires deltaT), every joint must resolve
  // an effective ambient sensor via joint override -> zone override -> panel default.
  if (context.alarmsDoc) {
    for (const joint of joints) {
      if (!resolveEffectiveAmbient(joint)) {
        errors.push(
          err(
            'R9',
            `joint '${joint.joint_id}' has no ambient sensor available (no joint override, zone override for '${joint.zone_id}', or panel default)`
          )
        );
      }
    }
  }

  // R14: any ambient_sensor set at panel, zone, or joint level must reference a real
  // slave/channel, independent of whether alarms/R9 are in play.
  {
    const checkAmbientRef = (ref, label) => {
      if (!ref) return;
      const slave = slaveById.get(ref.slave_id);
      if (!slave) {
        errors.push(err('R14', `${label} references unknown slave_id '${ref.slave_id}'`));
        return;
      }
      const channels = slave.channels ?? DEFAULTS.channels;
      if (ref.channel > channels) {
        errors.push(err('R14', `${label} channel ${ref.channel} exceeds slave '${ref.slave_id}' channel count ${channels}`));
      }
    };
    checkAmbientRef(panelAmbient, 'modbus.ambient_sensor');
    for (const zone of zones || []) {
      checkAmbientRef(zone.ambient_sensor, `zone '${zone.zone_id}' ambient_sensor`);
    }
    for (const joint of joints) {
      checkAmbientRef(joint.ambient_sensor, `joint '${joint.joint_id}' ambient_sensor override`);
    }
  }

  // R10: worst-case scan time per bus must fit within the shortest poll_interval_s on that bus
  {
    const slavesByBus = new Map();
    for (const slave of slaves) {
      if (!busIds.has(slave.bus_id)) continue; // already reported by R3
      if (!slavesByBus.has(slave.bus_id)) slavesByBus.set(slave.bus_id, []);
      slavesByBus.get(slave.bus_id).push(slave);
    }
    const busById = new Map(buses.map((b) => [b.bus_id, b]));
    for (const [busId, busSlaves] of slavesByBus) {
      const bus = busById.get(busId);
      const totalMs = busSlaves.reduce((sum, s) => sum + worstCaseSlaveMs(bus, s), 0);
      const minPollMs = Math.min(...busSlaves.map((s) => (s.poll_interval_s ?? DEFAULTS.poll_interval_s) * 1000));
      if (totalMs > minPollMs) {
        errors.push(
          err(
            'R10',
            `bus '${busId}' worst-case scan time ${Math.round(totalMs)}ms exceeds shortest poll_interval ${minPollMs}ms`
          )
        );
      }
    }
  }

  // R11: version monotonicity
  if (context.appliedVersions) {
    for (const domain of ['modbus', 'joints']) {
      const applied = context.appliedVersions[domain];
      const incoming = doc.config_domain_versions[domain];
      if (applied != null && incoming <= applied) {
        errors.push(
          err('R11', `config_domain_versions.${domain} (${incoming}) must be greater than applied version (${applied})`)
        );
      }
    }
  }

  // R12: maintenance-mode gate for remote-originated changes
  if (context.source === 'remote' && context.maintenanceMode !== true) {
    errors.push(err('R12', 'remote changes to cfg/modbus or cfg/joints are only accepted in maintenance mode'));
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { validateModbusJoints, worstCaseSlaveMs, DEFAULTS };
