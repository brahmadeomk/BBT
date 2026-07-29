#!/usr/bin/env node
'use strict';

// Applies a cfg/integration document (Slice 11 BMS) to the live ConfigStore.
//
// Why a CLI: cfg/integration has no dashboard screen yet (unlike cfg/alarms and
// cfg/modbus+joints), and it is commissioning-time configuration - set once per
// panel when the BMS is wired, not tuned day to day. This is the same role
// tools/apply-migrated-config.js plays for the bootstrap domains.
//
// It is safe to re-run: the domain version is auto-bumped past whatever is
// applied, so you never hit the I4 monotonicity error by hand.
//
// Usage:
//   node tools/apply-integration-config.js                      # apply the example as-is
//   node tools/apply-integration-config.js my-panel.json
//   node tools/apply-integration-config.js --port=1502 --tier=3
//   node tools/apply-integration-config.js --show               # print what's applied, change nothing
//   node tools/apply-integration-config.js --disable            # stop serving Modbus TCP
//
// Options:
//   --root=<dir>      config store root (default /var/busduct/cfg)
//   --port=<n>        modbus_tcp.port
//   --unit=<n>        modbus_tcp.unit_id
//   --bind=<addr>     modbus_tcp.bind_host (e.g. the BMS-facing interface)
//   --tier=<1|2|3>    exposure_tier
//   --bitmap          enable the severity bitmap block
//   --disable         apply with modbus_tcp.enabled = false
//   --show            print the applied document and exit

const fs = require('node:fs');
const path = require('node:path');

const { ConfigStore } = require('../src/config-service/store');
const { validateModbusJoints } = require('../src/config-service/validate-modbus-joints');
const { validateAlarms } = require('../src/config-service/validate-alarms');
const { validateIntegration } = require('../src/config-service/validate-integration');
const { buildRegisterMap } = require('../src/integration/register-map');

const DEFAULT_ROOT = '/var/busduct/cfg';
const EXAMPLE = path.join(__dirname, '..', 'config', 'examples', 'integration.json');

function parseArgs(argv) {
  const opts = { file: null };
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      opts[k] = v === undefined ? true : v;
    } else if (!opts.file) {
      opts.file = a;
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = opts.root || DEFAULT_ROOT;

  const store = new ConfigStore({
    root,
    validators: { modbus_joints: validateModbusJoints, alarms: validateAlarms, integration: validateIntegration },
  });

  const applied = store.readDomain('integration').doc;

  if (opts.show) {
    if (!applied) {
      console.log(`No cfg/integration applied at ${root} - the BMS interface is off.`);
      process.exit(0);
    }
    console.log(JSON.stringify(applied, null, 2));
    process.exit(0);
  }

  // Base document: an explicit file, else what's already applied (so a flag-only
  // run edits in place rather than silently reverting to the example), else the
  // shipped example.
  let doc;
  const sourceFile = opts.file || (applied ? null : EXAMPLE);
  if (sourceFile) {
    if (!fs.existsSync(sourceFile)) {
      console.error(`File not found: ${sourceFile}`);
      process.exit(1);
    }
    doc = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  } else {
    doc = JSON.parse(JSON.stringify(applied));
  }

  // Flag overrides
  doc.modbus_tcp = doc.modbus_tcp || {};
  if (opts.port) doc.modbus_tcp.port = Number(opts.port);
  if (opts.unit) doc.modbus_tcp.unit_id = Number(opts.unit);
  if (opts.bind) doc.modbus_tcp.bind_host = String(opts.bind);
  if (opts.disable) doc.modbus_tcp.enabled = false;
  if (opts.tier) doc.exposure_tier = Number(opts.tier);
  if (opts.bitmap) doc.severity_bitmap = { enabled: true };

  // I4 requires the domain version to advance on every apply. Doing that by hand
  // is pure friction, so bump it past whatever is applied.
  doc.config_domain_versions = doc.config_domain_versions || {};
  const appliedVersion = applied?.config_domain_versions?.integration ?? 0;
  doc.config_domain_versions.integration = Math.max(doc.config_domain_versions.integration || 1, appliedVersion + 1);

  // point_map_version is APPEND-ONLY: never let a file with a stale value
  // regress a panel that has already published a higher map to its gateway.
  const appliedPmv = applied?.point_map_version ?? 0;
  if ((doc.point_map_version ?? 1) < appliedPmv) {
    console.warn(`point_map_version ${doc.point_map_version} < applied ${appliedPmv}; raising to ${appliedPmv} (the register map is append-only).`);
    doc.point_map_version = appliedPmv;
  }

  const jointsDoc = store.readDomain('modbus_joints').doc;
  if (!jointsDoc) {
    console.error('No cfg/modbus+joints applied yet - commission the panel first (tools/apply-migrated-config.js).');
    process.exit(1);
  }

  const res = store.applyIfValid('integration', doc, { jointsDoc, source: 'local' }, opts.user || 'cli');

  if (!res.applied) {
    console.error('REJECTED - cfg/integration not applied:');
    for (const e of res.errors) console.error(`  ${e.rule}: ${e.message}`);
    process.exit(1);
  }

  for (const w of res.warnings || []) console.warn(`WARNING ${w.rule}: ${w.message}`);

  const map = buildRegisterMap(doc, jointsDoc);
  console.log(`Applied cfg/integration v${res.appliedVersions.integration} to ${root}`);
  console.log(`  Modbus TCP : ${doc.modbus_tcp.enabled ? `${doc.modbus_tcp.bind_host || '0.0.0.0'}:${doc.modbus_tcp.port} unit ${doc.modbus_tcp.unit_id}` : 'DISABLED'}`);
  console.log(`  Exposure   : tier ${doc.exposure_tier}  (point_map_version ${doc.point_map_version})`);
  console.log(`  Registers  : ${map.extent} (Tier 1 @0, ACK @${map.control.ack}${map.tier2 ? `, zones @${map.tier2.base}` : ''}${map.tier3 ? `, joints @${map.tier3.base}` : ''})`);
  if (map.tier3) console.log(`  Joints     : ${map.tier3.joints.length} mapped (index 0 = ${map.tier3.joints[0]?.joint_id})`);
  console.log('\nRestart Node-RED (or wait for the BMS server node to re-run) for the listener to bind.');
}

main();
