#!/usr/bin/env node
'use strict';

// One-time bootstrap: applies the already-migrated config
// (config/examples/migrated_modbus_joints.json and migrated_alarms.json)
// to the live ConfigStore at /var/busduct/cfg. Needed once per panel,
// the first time this repo's config service runs on it - the
// migration tool only produces files in the repo; it doesn't touch
// the live store, since it's an offline conversion step (see
// tools/migrate-legacy-config.js and the decision log).
//
// Usage: node tools/apply-migrated-config.js [--root=/var/busduct/cfg]

const fs = require('node:fs');
const path = require('node:path');

const { ConfigStore } = require('../src/config-service/store');
const { validateModbusJoints } = require('../src/config-service/validate-modbus-joints');
const { validateAlarms } = require('../src/config-service/validate-alarms');

function main() {
  const rootArg = process.argv.find((a) => a.startsWith('--root='));
  const root = rootArg ? rootArg.slice('--root='.length) : '/var/busduct/cfg';

  const modbusJointsPath = path.join(__dirname, '..', 'config', 'examples', 'migrated_modbus_joints.json');
  const alarmsPath = path.join(__dirname, '..', 'config', 'examples', 'migrated_alarms.json');

  if (!fs.existsSync(modbusJointsPath) || !fs.existsSync(alarmsPath)) {
    console.error('Missing config/examples/migrated_modbus_joints.json or migrated_alarms.json - run tools/migrate-legacy-config.js first.');
    process.exit(1);
  }

  const modbusJoints = JSON.parse(fs.readFileSync(modbusJointsPath, 'utf8'));
  const alarms = JSON.parse(fs.readFileSync(alarmsPath, 'utf8'));

  const store = new ConfigStore({ root, validators: { modbus_joints: validateModbusJoints, alarms: validateAlarms } });

  const { doc: existingModbusJoints } = store.readDomain('modbus_joints');
  const { doc: existingAlarms } = store.readDomain('alarms');
  if (existingModbusJoints || existingAlarms) {
    console.error(
      `Refusing to overwrite: ${root} already has an applied config (modbus_joints: ${!!existingModbusJoints}, alarms: ${!!existingAlarms}). ` +
        'This tool is for first-time bootstrap only - use the dashboard to make further changes.'
    );
    process.exit(1);
  }

  const modbusResult = store.applyIfValid('modbus_joints', modbusJoints, {}, 'bootstrap');
  const alarmsResult = store.applyIfValid('alarms', alarms, {}, 'bootstrap');

  if (!modbusResult.applied) {
    console.error('cfg/modbus+joints FAILED to apply:');
    for (const e of modbusResult.errors) console.error(' -', e.rule, e.message);
  } else {
    console.log(`cfg/modbus+joints applied at ${root} (versions: ${JSON.stringify(modbusResult.appliedVersions)})`);
  }

  if (!alarmsResult.applied) {
    console.error('cfg/alarms FAILED to apply:');
    for (const e of alarmsResult.errors) console.error(' -', e.rule, e.message);
  } else {
    console.log(`cfg/alarms applied at ${root} (versions: ${JSON.stringify(alarmsResult.appliedVersions)})`);
  }

  if (!modbusResult.applied || !alarmsResult.applied) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { main };
