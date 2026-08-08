#!/usr/bin/env node
'use strict';

// Runs the EXACT code path behind the "Modbus Settings" dashboard against the
// panel's real applied config, and prints what the table would be handed.
//
// Why this exists: a blank Modbus Settings table has two completely different
// causes and they look identical in the browser -
//   (A) the server has no rows to give (config not applied / not readable), or
//   (B) the server has the rows but the message never reached the widget.
// Guessing between them wastes a Pi trip. Run this on the Pi:
//
//   cd ~/busduct-cloud-edge && node tools/modbus-settings-selftest.js
//
// If it prints rows, the config side is fine and the problem is the browser /
// flow wiring - re-import flows/flows_BBT.json and press RELOAD.
// If it prints an error or zero rows, the problem is the config store, and the
// output says which.

const { createStore, handleModbusSettingsMessage } = require('../src/config-service/node-red');

const root = process.argv.find((a) => a.startsWith('--root='))?.split('=')[1];

function main() {
  console.log(`Config root: ${root || '/var/busduct/cfg'} (running as uid ${process.getuid?.() ?? '?'})\n`);

  const store = root ? createStore(root) : createStore();

  // 1. Can we read the domain at all?
  let doc;
  try {
    doc = store.readDomain('modbus_joints').doc;
  } catch (e) {
    console.error(`FAIL reading cfg/modbus+joints: ${e.message}`);
    console.error('  -> the store path is unreadable by this user. Node-RED runs as its own');
    console.error('     user; check ownership/permissions on the config root above.');
    process.exit(1);
  }

  if (!doc) {
    console.log('cfg/modbus+joints has NEVER BEEN APPLIED on this panel.');
    console.log('  -> an empty table is correct. Commission the slaves, or run the migration');
    console.log('     tool if this panel came from the legacy commissioning screens.');
    process.exit(0);
  }

  console.log(`Applied doc: modbus v${doc.config_domain_versions?.modbus}, joints v${doc.config_domain_versions?.joints}`);
  console.log(`  buses:  ${(doc.modbus?.buses || []).map((b) => `${b.bus_id}@${b.port}`).join(', ') || '(none)'}`);
  console.log(`  slaves: ${(doc.modbus?.slaves || []).length}`);
  console.log(`  joints: ${(doc.joints || []).length}\n`);

  // 2. The load the dashboard's inject performs (payload is a timestamp, so it
  //    carries neither an action nor any table state - a plain load).
  let result;
  try {
    result = handleModbusSettingsMessage({ payload: Date.now() }, { store, draft: null, legacySlaveList: [] });
  } catch (e) {
    console.error(`FAIL in handleModbusSettingsMessage: ${e.stack}`);
    console.error('  -> this would show as a red error on the ModbusSettingsBackEndNode');
    console.error('     in the Node-RED editor, and the widget would get nothing.');
    process.exit(1);
  }

  if (!result.msg) {
    console.error('FAIL: the handler suppressed its output (that only happens mid-edit).');
    process.exit(1);
  }

  const p = result.msg.payload;
  console.log(`Handler returned: ${p.buses?.length ?? 0} bus row(s), ${p.slaves?.length ?? 0} slave channel row(s)`);
  for (const b of p.buses || []) {
    console.log(`  BUS  ${b.bus_id.padEnd(6)} ${String(b.port).padEnd(16)} ${b.baud} ${b.parity}${b.stop_bits} timeout=${b.timeout_ms}ms`);
  }
  for (const s of (p.slaves || []).slice(0, 30)) {
    console.log(`  ROW  ${String(s.bus_id).padEnd(6)} unit=${String(s.unit_address).padEnd(4)} ch=${s.channel} addr=${String(s.base_addr).padEnd(5)} ${s.label || '(no label)'}`);
  }
  if ((p.slaves || []).length > 30) console.log(`  ... ${(p.slaves).length - 30} more`);

  console.log('');
  if ((p.buses?.length ?? 0) > 0) {
    console.log('RESULT: the server side is HEALTHY - it has rows to give.');
    console.log('  A blank table in the browser is therefore a delivery problem, not a config');
    console.log('  problem. Re-import flows/flows_BBT.json in the Node-RED editor (a git pull');
    console.log('  alone does NOT change the running flow), redeploy, reload the dashboard page,');
    console.log('  and press RELOAD on the Modbus Settings card.');
  } else {
    console.log('RESULT: the server side has NO rows - the blank table is honest.');
  }
}

main();
