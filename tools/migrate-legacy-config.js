#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FUNCTION_CODE_HOLDING = 3; // firmware/Nano_IOT.ino always calls readHoldingRegisters - see CLAUDE.md

function pad2(n) {
  return String(n).padStart(2, '0');
}

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
 * Converts the legacy Node-RED global-context shapes (SlaveIDList,
 * joint_master_zone_A, zone_master, busbartherm_system_config, and the
 * flat bus-timing globals) into cfg/modbus+joints and cfg/alarms
 * documents. Pure/offline - does not touch the live config store.
 *
 * @param {object} legacy
 * @param {Array} legacy.SlaveIDList - [{slaveID, registerAddress, dataBits, parameterName, ...}]
 * @param {Array} legacy.joint_master_zone_A - [{joint_id, slaveID, ambientSlaveID, zone_id, ...}]
 * @param {Array} legacy.zone_master - [{zone_id, zone_name}]
 * @param {object} legacy.busbartherm_system_config - {deltaT, ror, persistence}
 * @param {string} legacy.port
 * @param {number} legacy.baudRate
 * @param {string} legacy.parity
 * @param {number} legacy.stopBits
 * @param {number} legacy.Polling - microseconds, legacy inter-frame delay
 * @param {number} legacy.Timeout - ms
 * @param {object} [options]
 * @param {number} [options.startVersion=1] - config_domain_versions value to start at
 * @param {{watchMin:number,warningMin:number,criticalMin:number}} [options.persistenceOverride] -
 *   apply this in place of legacy.busbartherm_system_config.persistence if the legacy
 *   values violate A2 ordering (human-approved correction, never invented silently)
 * @returns {{modbusJoints: object, alarms: object, warnings: string[]}}
 */
function migrateLegacyConfig(legacy, options = {}) {
  const startVersion = options.startVersion ?? 1;
  const warnings = [];

  // --- slaves ---
  const sortedLegacySlaves = [...legacy.SlaveIDList].sort((a, b) => a.slaveID - b.slaveID);
  const legacyToNewSlaveId = new Map();
  const slaves = sortedLegacySlaves.map((ls, index) => {
    const newId = `sl${pad2(index + 1)}`;
    legacyToNewSlaveId.set(ls.slaveID, newId);
    return {
      slave_id: newId,
      bus_id: 'bus1',
      unit_address: ls.slaveID,
      model: 'LEGACY-1CH',
      channels: 1,
      poll_interval_s: 30,
      registers: {
        function_code: FUNCTION_CODE_HOLDING,
        temp_base_addr: ls.registerAddress,
        temp_word_count: ls.dataBits,
        temp_scale: 0.1,
      },
    };
  });
  warnings.push(
    "slaves[].model set to placeholder 'LEGACY-1CH' - legacy data has no part number, get the real model from commissioning records"
  );
  warnings.push('slaves[].poll_interval_s defaulted to 30s for every slave - legacy scanned all slaves as one combined cycle with no per-slave interval');
  warnings.push('slaves[].registers.temp_scale assumed 0.1 (raw/10 = degC) - legacy data does not record scaling, verify against the sensor datasheet');
  warnings.push(`modbus.buses[0].retries defaulted to 2 - legacy has no retry concept`);

  // --- zones ---
  const zones = (legacy.zone_master || []).map((z) => ({
    zone_id: z.zone_id.toLowerCase(),
    name: z.zone_name,
  }));

  // --- joints + ambient sensor resolution ---
  const joints = legacy.joint_master_zone_A.map((lj) => ({
    joint_id: lj.joint_id,
    slave_id: legacyToNewSlaveId.get(lj.slaveID),
    channel: 1,
    zone_id: lj.zone_id.toLowerCase(),
    enabled: true,
    threshold_profile: 'default',
    _legacyAmbientSlaveID: lj.ambientSlaveID, // stripped before returning
  }));
  warnings.push('joints[].label omitted - legacy has no physical-location description, fill in during commissioning review');

  const panelDefaultAmbientLegacyId = mode(joints.map((j) => j._legacyAmbientSlaveID));
  const panelAmbientNewId = legacyToNewSlaveId.get(panelDefaultAmbientLegacyId);
  if (!panelAmbientNewId) {
    warnings.push(`most common ambientSlaveID (${panelDefaultAmbientLegacyId}) does not match any known slave - no modbus.ambient_sensor set`);
  }

  const jointsByZone = new Map();
  for (const j of joints) {
    if (!jointsByZone.has(j.zone_id)) jointsByZone.set(j.zone_id, []);
    jointsByZone.get(j.zone_id).push(j);
  }
  for (const zone of zones) {
    const zoneJoints = jointsByZone.get(zone.zone_id) || [];
    const distinctAmbientIds = new Set(zoneJoints.map((j) => j._legacyAmbientSlaveID));
    if (distinctAmbientIds.size === 1) {
      const onlyId = [...distinctAmbientIds][0];
      if (onlyId !== panelDefaultAmbientLegacyId && legacyToNewSlaveId.has(onlyId)) {
        zone.ambient_sensor = { slave_id: legacyToNewSlaveId.get(onlyId), channel: 1 };
        warnings.push(`zone '${zone.zone_id}': all joints share ambientSlaveID ${onlyId} (differs from panel default) - set as zone-level override`);
      }
    }
  }
  for (const j of joints) {
    const zone = zones.find((z) => z.zone_id === j.zone_id);
    const resolvesViaZone = zone?.ambient_sensor;
    const needsOverride = j._legacyAmbientSlaveID !== panelDefaultAmbientLegacyId && !resolvesViaZone;
    if (needsOverride && legacyToNewSlaveId.has(j._legacyAmbientSlaveID)) {
      j.ambient_sensor = { slave_id: legacyToNewSlaveId.get(j._legacyAmbientSlaveID), channel: 1 };
      warnings.push(`joint '${j.joint_id}': ambientSlaveID ${j._legacyAmbientSlaveID} differs from both panel default and its zone - set as joint-level override`);
    }
    delete j._legacyAmbientSlaveID;
  }

  // --- modbus / bus ---
  const modbus = {
    buses: [
      {
        bus_id: 'bus1',
        type: 'rtu',
        port: legacy.port,
        baud: legacy.baudRate,
        parity: legacy.parity,
        stop_bits: legacy.stopBits,
        timeout_ms: legacy.Timeout,
        retries: 2,
        inter_frame_ms: Math.round(legacy.Polling / 1000),
      },
    ],
    slaves,
  };
  if (panelAmbientNewId) {
    modbus.ambient_sensor = { slave_id: panelAmbientNewId, channel: 1 };
  }

  const modbusJoints = {
    config_domain_versions: { modbus: startVersion, joints: startVersion },
    modbus,
    joints,
    zones,
  };

  // --- alarms ---
  const legacyPersistence = legacy.busbartherm_system_config.persistence;
  const violatesA2 = !(legacyPersistence.watchMin >= legacyPersistence.warningMin && legacyPersistence.warningMin >= legacyPersistence.criticalMin);
  let persistence = legacyPersistence;
  if (violatesA2) {
    if (options.persistenceOverride) {
      warnings.push(
        `persistence ${JSON.stringify(legacyPersistence)} violates A2 (watchMin >= warningMin >= criticalMin) - replaced with human-approved ${JSON.stringify(options.persistenceOverride)}`
      );
      persistence = options.persistenceOverride;
    } else {
      warnings.push(
        `persistence ${JSON.stringify(legacyPersistence)} violates A2 (watchMin >= warningMin >= criticalMin) - carried through as-is; this document will fail validation until corrected`
      );
    }
  }

  const alarms = {
    config_domain_versions: { alarms: startVersion },
    profiles: {
      default: {
        description: 'Migrated from legacy busbartherm_system_config',
        deltaT: legacy.busbartherm_system_config.deltaT,
        ror: legacy.busbartherm_system_config.ror,
        persistence,
      },
    },
  };
  warnings.push(
    'alarms.notifications omitted - legacy notification recipients (email/SMS) are personal data and must be configured directly on the live system, not via a version-controlled file'
  );

  return { modbusJoints, alarms, warnings };
}

function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--persistence-override='));
  const overrideArg = process.argv.find((a) => a.startsWith('--persistence-override='));
  const inputPath = args[0];
  const outDir = args[1] || path.join(__dirname, '..', 'config', 'examples');
  if (!inputPath) {
    console.error(
      'Usage: node tools/migrate-legacy-config.js <legacy-context.json> [output-dir] [--persistence-override=\'{"watchMin":5,"warningMin":2,"criticalMin":1}\']'
    );
    process.exit(1);
  }

  const { validateModbusJoints } = require('../src/config-service/validate-modbus-joints');
  const { validateAlarms } = require('../src/config-service/validate-alarms');

  const legacy = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const persistenceOverride = overrideArg ? JSON.parse(overrideArg.slice('--persistence-override='.length)) : undefined;
  const { modbusJoints, alarms, warnings } = migrateLegacyConfig(legacy, { persistenceOverride });

  console.log('Warnings / assumptions:');
  for (const w of warnings) console.log(' -', w);

  const modbusResult = validateModbusJoints(modbusJoints, { alarmsDoc: alarms });
  const alarmsResult = validateAlarms(alarms, { jointsDoc: modbusJoints, modbusDoc: modbusJoints });

  if (!modbusResult.valid) {
    console.error('\ncfg/modbus+joints FAILED validation:');
    for (const e of modbusResult.errors) console.error(' -', e.rule, e.message);
  }
  if (!alarmsResult.valid) {
    console.error('\ncfg/alarms FAILED validation:');
    for (const e of alarmsResult.errors) console.error(' -', e.rule, e.message);
  }
  if (!modbusResult.valid || !alarmsResult.valid) {
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'migrated_modbus_joints.json'), JSON.stringify(modbusJoints, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'migrated_alarms.json'), JSON.stringify(alarms, null, 2) + '\n');
  console.log(`\nWrote valid migrated config to ${outDir}`);
}

if (require.main === module) {
  main();
}

module.exports = { migrateLegacyConfig };
