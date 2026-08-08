#!/usr/bin/env node
'use strict';

// Exercises every multi-bus apply guard against a COPY of this panel's real
// applied configuration, in a throwaway directory. It never writes to the live
// config store, so it is safe to run on a production panel while it is
// monitoring.
//
//   cd ~/busduct-cloud-edge && node tools/multibus-guard-drill.js
//
// Why a script rather than only clicking through the dashboard: the guards that
// matter are the ones that REJECT, and a rejection leaves no trace to inspect
// afterwards. This prints each guard's actual message against your real slave
// names and addresses, so you can confirm the wording is intelligible to a
// commissioning engineer before you rely on it.
//
// Pass --root=<dir> to drill a different config store.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ConfigStore } = require('../src/config-service/store');
const { validateModbusJoints } = require('../src/config-service/validate-modbus-joints');
const { validateAlarms } = require('../src/config-service/validate-alarms');
const { handleModbusSettingsMessage } = require('../src/config-service/node-red/modbus-settings-handler');

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const LIVE_ROOT = arg('root', '/var/busduct/cfg');

const clone = (o) => JSON.parse(JSON.stringify(o));

function main() {
  // 1. Read the live config READ-ONLY, then rebuild it inside a temp store.
  const live = new ConfigStore({ root: LIVE_ROOT, validators: { modbus_joints: validateModbusJoints, alarms: validateAlarms } });
  let doc;
  try {
    doc = live.readDomain('modbus_joints').doc;
  } catch (e) {
    console.error(`Cannot read ${LIVE_ROOT}: ${e.message}`);
    process.exit(1);
  }
  if (!doc) {
    console.error(`No cfg/modbus+joints applied at ${LIVE_ROOT} - nothing to drill.`);
    process.exit(1);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-drill-'));
  const store = new ConfigStore({ root: tmp, validators: { modbus_joints: validateModbusJoints, alarms: validateAlarms } });
  const seeded = store.applyIfValid('modbus_joints', clone(doc));
  if (!seeded.applied) {
    console.error('The live document does not re-validate - that is a real problem, not a drill failure:');
    console.error(seeded.errors);
    process.exit(1);
  }

  console.log(`Drilling a COPY of ${LIVE_ROOT} in ${tmp}`);
  console.log(`(the live config is never written)\n`);
  console.log(`Panel: ${doc.modbus.slaves.length} unit(s), ${doc.joints.length} joint(s), ` +
    `buses: ${doc.modbus.buses.map((b) => `${b.bus_id}@${b.port}`).join(', ')}\n`);

  const call = (payload) => handleModbusSettingsMessage({ payload }, { store, draft: null, legacySlaveList: [] });
  const load = () => call({}).msg.payload;

  let pass = 0, fail = 0;

  /** A guard must REJECT and must not change the applied version. */
  const mustReject = (name, payload, expect) => {
    const before = store.readDomain('modbus_joints').doc.config_domain_versions.modbus;
    const p = call(payload).msg.payload;
    const after = store.readDomain('modbus_joints').doc.config_domain_versions.modbus;
    const ok = !!p.error && expect.test(p.error) && before === after;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    console.log(`      ${p.error || `(no rejection - it APPLIED, version ${before} -> ${after})`}`);
    ok ? pass++ : fail++;
  };

  const mustApply = (name, payload, expectResend) => {
    const r = call(payload);
    const p = r.msg.payload;
    const ok = !!p.success && JSON.stringify(r.resendBusIds) === JSON.stringify(expectResend);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    console.log(`      ${p.error || p.success}   resend=${JSON.stringify(r.resendBusIds)} (expected ${JSON.stringify(expectResend)})`);
    ok ? pass++ : fail++;
  };

  // --- commission an extra segment (the only step that commits) ------------
  // Adapt to whatever the panel already has: a panel already running two
  // segments gets a bus3 here, and every later step must refer to the bus this
  // step actually created, not a hardcoded 'bus2'.
  const base = load();
  const added = call({ action: 'add_bus', slaves: base.slaves, buses: base.buses }).msg.payload;
  if (added.buses.length <= base.buses.length) { console.error('add_bus did not add a bus'); process.exit(1); }
  const NEW_IDX = added.buses.length - 1;
  const NEW_BUS = added.buses[NEW_IDX].bus_id;
  const usedPorts = new Set(base.buses.map((b) => String(b.port)));
  let n = 0;
  while (usedPorts.has(`/dev/ttyACM${n}`)) n++;
  added.buses[NEW_IDX].port = `/dev/ttyACM${n}`;
  mustApply(`commission an empty ${NEW_BUS}`, { action: 'apply', slaves: added.slaves, buses: added.buses }, [NEW_BUS]);

  const firstUnit = load().slaves[0];

  // --- the guards ----------------------------------------------------------
  let g = clone(load()); g.buses[NEW_IDX].port = g.buses[0].port;
  mustReject('two buses on one serial port', { action: 'apply', slaves: g.slaves, buses: g.buses }, /share the serial port/);

  g = clone(load());
  g.slaves.push({ slave_id: '', label: 'DRILL clash', bus_id: NEW_BUS, unit_address: firstUnit.unit_address, channel: 1,
    base_addr: firstUnit.base_addr, model: firstUnit.model, temp_word_count: firstUnit.temp_word_count,
    temp_scale: firstUnit.temp_scale, poll_interval_s: firstUnit.poll_interval_s, editing: false });
  mustReject('same unit address on both buses', { action: 'apply', slaves: g.slaves, buses: g.buses }, /used on both/);

  g = clone(load()); g.slaves[0].bus_id = 'bus99';
  mustReject('slave on an undefined bus', { action: 'apply', slaves: g.slaves, buses: g.buses }, /not defined/);

  g = clone(load()); g.slaves[0].bus_id = NEW_BUS;
  mustReject('delete a bus that still carries sensors', { action: 'delete_bus', index: NEW_IDX, slaves: g.slaves, buses: g.buses }, /still carries/);

  g = clone(load());
  mustReject('delete the last remaining bus', { action: 'delete_bus', index: 0, slaves: [], buses: [g.buses[0]] }, /at least one RS-485 bus/);

  // --- per-bus resend ------------------------------------------------------
  g = clone(load()); g.slaves[0].label = (g.slaves[0].label || '') + ' (drill)';
  mustApply('label-only edit resends nothing', { action: 'apply', slaves: g.slaves, buses: g.buses }, []);

  g = clone(load()); g.buses[NEW_IDX].timeout_ms = Number(g.buses[NEW_IDX].timeout_ms) + 500;
  mustApply(`${NEW_BUS}-only change resends ${NEW_BUS} alone`, { action: 'apply', slaves: g.slaves, buses: g.buses }, [NEW_BUS]);

  console.log(`\n${fail === 0 ? 'ALL GUARDS PASS' : `${fail} GUARD(S) FAILED`}  (${pass} passed, ${fail} failed)`);
  console.log(`Live config at ${LIVE_ROOT} is untouched; drill copy left in ${tmp} if you want to inspect it.`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
