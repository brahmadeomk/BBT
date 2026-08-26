#!/usr/bin/env node
'use strict';

// Generates the Moxa MGate 5217 Modbus-configuration CSV for this panel.
//
// The MGate reads ONE register per command (manual v1.4 p19), so a Tier-3 panel
// needs 600-1200 commands. This builds them from the panel's own applied config,
// so the gateway and the panel cannot drift apart.
//
//   # single gateway, one BACnet device per zone (recommended)
//   node tools/mgate-csv.js --pi=192.168.1.110 > gateway.csv
//
//   # match the CSV header of the gateway you actually have (RECOMMENDED):
//   #   export a template from its web console first, then
//   node tools/mgate-csv.js --pi=192.168.1.110 --template=exported.csv > gateway.csv
//
//   # two gateways: split by ZONE (recommended - a zone's rollup covers all of
//   # its joints, so a zone must not straddle two gateways)
//   node tools/mgate-csv.js --pi=... --zones=0-3            > gatewayA.csv
//   node tools/mgate-csv.js --pi=... --zones=4- --no-panel  > gatewayB.csv
//
//   # save a point per joint by dropping the duplicate absolute_temp
//   node tools/mgate-csv.js --pi=... --skip-absolute-temp
//
// Other options: --root=<cfg dir> --port=1502 --poll=1000 --flat
//                --limit=600|1200 --plan (summary only, no CSV)

const fs = require('node:fs');
const { ConfigStore } = require('../src/config-service/store');
const { validateModbusJoints } = require('../src/config-service/validate-modbus-joints');
const { validateAlarms } = require('../src/config-service/validate-alarms');
const { validateIntegration } = require('../src/config-service/validate-integration');
const { buildRegisterMap } = require('../src/integration/register-map');
const { buildMgatePlan, toCsv, headerFromTemplate } = require('../src/integration/mgate-csv');

const arg = (k, d) => {
  const hit = process.argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`));
  if (!hit) return d;
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : true;
};
const die = (m) => { console.error(m); process.exit(1); };

function main() {
  const root = arg('root', '/var/busduct/cfg');
  const store = new ConfigStore({
    root,
    validators: { modbus_joints: validateModbusJoints, alarms: validateAlarms, integration: validateIntegration },
  });

  let integrationDoc, jointsDoc;
  try {
    integrationDoc = store.readDomain('integration').doc;
    jointsDoc = store.readDomain('modbus_joints').doc;
  } catch (e) {
    die(`Cannot read the config store at ${root}: ${e.message}`);
  }
  if (!integrationDoc) die(`No cfg/integration applied at ${root}. Run tools/apply-integration-config.js first.`);
  if (!jointsDoc) die(`No cfg/modbus+joints applied at ${root}.`);

  const map = buildRegisterMap(integrationDoc, jointsDoc);
  if (map.error) die(`Cannot build the register map: ${map.error}`);

  const parseRange = (flag) => {
    const raw = arg(flag, null);
    if (typeof raw !== 'string') return [0, Infinity];
    const m = /^(\d+)?-(\d+)?$/.exec(raw.trim());
    if (!m) die(`--${flag} wants a range like 0-3, 4- or 4-7 (got "${raw}")`);
    return [m[1] !== undefined ? Number(m[1]) : 0, m[2] !== undefined ? Number(m[2]) : Infinity];
  };
  const [jointFrom, jointTo] = parseRange('joints');
  const [zoneFrom, zoneTo] = parseRange('zones');

  let commandHeader = null, deviceHeader = null;
  const template = arg('template', null);
  if (typeof template === 'string') {
    let text;
    try { text = fs.readFileSync(template, 'utf8'); }
    catch (e) { die(`Cannot read the template ${template}: ${e.message}`); }
    commandHeader = headerFromTemplate(text, 'command_parameters');
    deviceHeader = headerFromTemplate(text, 'device_parameters');
    if (!commandHeader) {
      die(`${template} has no [command_parameters] header row. Export a template from the gateway ` +
          `AFTER creating two or three commands in its web console (manual p54).`);
    }
  }

  const plan = buildMgatePlan(map, {
    jointsDoc,
    grouping: arg('flat', false) ? 'flat' : 'zone',
    skipAbsoluteTemp: !!arg('skip-absolute-temp', false),
    jointFrom,
    jointTo,
    zoneFrom,
    zoneTo,
    includePanel: !arg('no-panel', false),
    panelIp: String(arg('pi', '192.168.1.110')),
    panelPort: Number(arg('port', integrationDoc.modbus_tcp?.port ?? 1502)),
    pollIntervalMs: Number(arg('poll', 1000)),
    pointLimit: Number(arg('limit', 1200)),
  });

  // Everything diagnostic goes to stderr so `> gateway.csv` stays clean.
  const log = (...a) => console.error(...a);
  log(`Panel: ${jointsDoc.joints.length} joint(s), ${(jointsDoc.zones || []).length} zone(s), ` +
      `tier ${map.exposure_tier}, register extent ${map.extent}`);
  log(`Plan : ${plan.devices.length} Modbus device(s) -> ${plan.devices.length} BACnet device(s), ` +
      `${plan.commands.length} point(s)`);
  for (const d of plan.devices) {
    const n = plan.commands.filter((c) => c.cmdDevIndex === d.devIndex).length;
    log(`   devSequence ${String(d.devSequence).padStart(2)}  unit id ${String(d.devSlaveId).padStart(3)}  ` +
        `${d.devName.padEnd(24)} ${String(n).padStart(4)} point(s)`);
  }
  if (!commandHeader) {
    log('');
    log('NOTE: no --template given, so the column order is the one documented in');
    log('      manual v1.4 p57-61. The CSV format is versioned; if the import is');
    log('      rejected, export a template from the gateway and pass --template.');
  }
  for (const w of plan.warnings) log(`\nWARN: ${w}`);
  for (const e of plan.errors) log(`\nERROR: ${e}`);
  if (plan.errors.length) process.exit(1);

  if (arg('plan', false)) { log('\n(--plan: no CSV written)'); return; }
  process.stdout.write(toCsv(plan, { commandHeader, deviceHeader }));
}

main();
