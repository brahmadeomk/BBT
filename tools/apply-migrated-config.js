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
// The two domains are bootstrapped independently: a panel can easily
// have one already applied (e.g. someone clicked "Restore Defaults" on
// the alarm screen before this ran) and not the other. Refusing the
// whole run in that case would block bootstrapping the domain that
// actually still needs it - so each domain is only skipped if IT
// specifically already has something applied.
//
// Usage: node tools/apply-migrated-config.js [--root=/var/busduct/cfg]

const fs = require('node:fs');
const path = require('node:path');

const { ConfigStore } = require('../src/config-service/store');
const { validateModbusJoints } = require('../src/config-service/validate-modbus-joints');
const { validateAlarms } = require('../src/config-service/validate-alarms');

function bootstrapDomain(store, domain, migratedDoc) {
  const { doc: existing } = store.readDomain(domain);
  if (existing) {
    console.log(`Skipping ${domain}: ${store.root} already has an applied config for it - use the dashboard for further changes.`);
    return true; // not a failure - just nothing to do
  }

  const result = store.applyIfValid(domain, migratedDoc, {}, 'bootstrap');
  if (!result.applied) {
    console.error(`${domain} FAILED to apply:`);
    for (const e of result.errors) console.error(' -', e.rule, e.message);
    return false;
  }
  console.log(`${domain} applied at ${store.root} (versions: ${JSON.stringify(result.appliedVersions)})`);
  return true;
}

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

  const modbusOk = bootstrapDomain(store, 'modbus_joints', modbusJoints);
  const alarmsOk = bootstrapDomain(store, 'alarms', alarms);

  if (!modbusOk || !alarmsOk) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { main };
