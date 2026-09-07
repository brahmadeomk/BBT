#!/usr/bin/env node
'use strict';

/**
 * Per-frame cost of the live measurement path, at a chosen device count.
 *
 * WHY THIS EXISTS. Panel ESBUSBBT06 (71 devices) runs Node-RED pegged at a full
 * core with a visibly slow HMI, and Slice 10 targets 110. Two guesses at the
 * cause had already been wrong - the alarm history looked like an O(n) cost
 * until the code turned out to cap it at 100 entries, and the legacy InfluxDB
 * feeder looked unthrottled until its upstream delay node turned out to be
 * rate-limited to 1/s. Reasoning from the flow graph kept producing plausible
 * and false answers, so this measures instead.
 *
 * WHAT IT MEASURES: the four function nodes a Nano frame actually traverses,
 * lifted verbatim out of flows_BBT.json and run against a synthetic panel of N
 * slaves. Same code the Pi runs, so a change that helps here helps there.
 *
 * WHAT IT DOES NOT MEASURE, and must not be read as covering: Node-RED's own
 * per-message overhead (cloning, routing, the dashboard's socket.io fan-out to
 * every connected browser) and anything outside Node-RED. If the numbers here
 * come out small against the observed frame rate, the cost is in the runtime or
 * the dashboard, NOT in this code - which is a result, not a failure.
 *
 *   node tools/bench-hot-path.js [--devices=71] [--frames=2000] [--alarms=20]
 */

const fs = require('fs');
const path = require('path');

const FLOWS = path.join(__dirname, '..', 'flows', 'flows_BBT.json');
const NODES = {
  ScaleNanoReading: '2390b9df3335021b',
  ProcessLogic: '39dad91df0c15744',
  AlarmManager: 'de6fcc55794afd9e',
  BlacklistEngine: 'd9b1ac57e0f10002',
};

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : dflt;
}

/** A Node-RED-ish context store: per-scope Map, honouring the store argument. */
function makeStore(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    get: (k) => m.get(k),
    set: (k, v) => { m.set(k, v); },
    keys: () => [...m.keys()],
    _map: m,
  };
}

/** Synthetic applied cfg/modbus+joints for `n` single-channel slaves + 1 ambient. */
function buildDoc(n) {
  const slaves = [];
  const joints = [];
  for (let i = 1; i <= n; i += 1) {
    slaves.push({
      slave_id: `sl${String(i).padStart(2, '0')}`,
      unit_address: i,
      bus_id: 'bus1',
      channels: 1,
      label: `Sensor${i}`,
      registers: { temp_base_addr: 3, temp_word_count: 1, temp_scale: 0.01, function_code: 3 },
      poll_interval_ms: 1000,
    });
    joints.push({
      joint_id: `J${String(i).padStart(2, '0')}`,
      label: `Joint ${i}`,
      slave_id: `sl${String(i).padStart(2, '0')}`,
      channel: 1,
      zone_id: 'z1',
      enabled: true,
    });
  }
  const amb = n + 1;
  slaves.push({
    slave_id: `sl${amb}`, unit_address: 101, bus_id: 'bus1', channels: 1, label: 'AMBIENT',
    registers: { temp_base_addr: 3, temp_word_count: 1, temp_scale: 0.01, function_code: 3 },
    poll_interval_ms: 1000,
  });
  return {
    config_version: 7,
    modbus: {
      buses: [{ bus_id: 'bus1', port: '/dev/busduct-bus1', baud_rate: 115200, parity: 'none', stop_bits: 1, poll_interval_ms: 500, timeout_ms: 300 }],
      slaves,
      ambient_sensor: { slave_id: `sl${amb}`, channel: 1 },
    },
    zones: [{ zone_id: 'z1', name: 'Zone1' }],
    joints,
  };
}

/**
 * The shape ProcessLogic and the Alarm Manager actually read from
 * `busbartherm_system_config` - the LEGACY runtime shape the live Alarm Manager
 * evaluates against, not the cfg/alarms schema. `ror.timeWindowMin` is load
 * bearing: without it ProcessLogic returns [null,null,null] at its config gate
 * and every node downstream measures as free, which is exactly how the first
 * run of this benchmark reported the Alarm Manager at 0.0 us.
 */
function alarmConfig() {
  return {
    ror: { timeWindowMin: 20, watch: 1, warning: 2, critical: 3 },
    deltaT: { watch: 10, warning: 20, critical: 30 },
    persistence: { watch: 1, warning: 1, critical: 1 },
    clear_hysteresis_pct: 10,
    clear_persistence_min: 1,
    sensor_fault: { enabled: true },
    notifications: { email: { enabled: false }, sms: { enabled: false }, cloud: { enabled: false } },
  };
}

function loadNode(flows, id) {
  const n = flows.find((x) => x.id === id);
  if (!n) throw new Error(`node ${id} not found`);
  // Node-RED wraps a function node's body in exactly these parameters.
  // eslint-disable-next-line no-new-func
  const fn = new Function('msg', 'node', 'global', 'flow', 'context', 'env', 'RED', 'util', `${n.func}\nreturn null;`);
  return { id, name: n.name || id, fn };
}

function main() {
  const devices = arg('devices', 71);
  const frames = arg('frames', 2000);
  const alarms = arg('alarms', 20);

  const flows = JSON.parse(fs.readFileSync(FLOWS, 'utf8'));
  const svc = require(path.join(__dirname, '..', 'src', 'config-service', 'node-red'));
  const doc = buildDoc(devices);
  const applied = svc.processLogicJoints.buildProcessLogicJoints(doc).joints;

  // Pre-seed an alarm history at its steady-state cap and a realistic number of
  // active alarms - the Alarm Manager's per-message work scales with both.
  const historian = [];
  for (let i = 0; i < 100; i += 1) {
    historian.push({
      instanceId: `PROCESS|J${i % devices}|DELTA_T|WATCH`, joint_id: `J${i % devices}`,
      joint_name: `Joint ${i}`, zone_id: 'z1', zone_name: 'Zone1', category: 'PROCESS',
      type: 'DELTA_T', level: 'WATCH', description: `J${i}: dT 12.00 >= 10`,
      raisedTs: new Date().toISOString(), clearedTs: new Date().toISOString(), status: 'CLEARED',
    });
  }
  const activeAlarms = {};
  for (let i = 0; i < alarms; i += 1) {
    const id = `PROCESS|J${String(i + 1).padStart(2, '0')}|DELTA_T|WATCH`;
    activeAlarms[id] = {
      instanceId: id, joint_id: `J${String(i + 1).padStart(2, '0')}`, joint_name: `Joint ${i + 1}`,
      zone_id: 'z1', zone_name: 'Zone1', category: 'PROCESS', type: 'DELTA_T', level: 'WATCH',
      description: 'x', raisedTs: new Date().toISOString(), status: 'ACTIVE', ack: false,
    };
  }

  const globalStore = makeStore({
    busductConfigService: svc,
    busduct_applied_joints: applied,
    busbartherm_system_config: alarmConfig(),
    'busbartherm.alarmHistorian': historian,
    'busbartherm.activeAlarms': activeAlarms,
  });
  const flowStore = makeStore({ decodeDoc: doc, decodeDocTs: Date.now() });

  const nodes = Object.fromEntries(
    Object.entries(NODES).map(([k, id]) => [k, loadNode(flows, id)])
  );
  const ctx = Object.fromEntries(Object.keys(NODES).map((k) => [k, makeStore(
    k === 'AlarmManager' ? { activeAlarms, alarmPersistence: {}, emailSentState: {} } : {}
  )]));

  const nodeApi = { send() {}, warn() {}, error() {}, status() {}, log() {}, debug() {} };
  const totals = Object.fromEntries(Object.keys(NODES).map((k) => [k, 0]));
  const calls = Object.fromEntries(Object.keys(NODES).map((k) => [k, 0]));

  // One "frame" = one slave's read result, which is what the Nano actually emits.
  const run = (name, msg) => {
    calls[name] += 1;
    const t0 = process.hrtime.bigint();
    let out = null;
    try {
      out = nodes[name].fn(msg, nodeApi, globalStore, flowStore, ctx[name], { get: () => undefined }, {}, {});
    } catch (e) {
      if (!run._warned?.[name]) {
        (run._warned ??= {})[name] = true;
        console.error(`  ! ${name} threw: ${e.message.slice(0, 90)}`);
      }
    }
    totals[name] += Number(process.hrtime.bigint() - t0);
    return out;
  };

  console.log(`\nBenchmark: ${devices} devices, ${frames} frames, ${alarms} active alarms, history 100\n`);

  for (let i = 0; i < frames; i += 1) {
    const unit = (i % devices) + 1;
    // Drift the value so EMA/RoR do real work rather than short-circuiting on
    // an unchanged reading.
    const raw = 3000 + Math.round(Math.sin(i / 7) * 400);
    const frame = { t: 'r', id: unit, sa: 3, len: 1, val: [raw], st: 'ok' };

    run('BlacklistEngine', { payload: frame, bus_id: 'bus1' });
    const scaled = run('ScaleNanoReading', { payload: frame, bus_id: 'bus1' });
    const readings = Array.isArray(scaled) ? scaled.flat().filter(Boolean) : (scaled ? [scaled] : []);
    for (const r of readings) {
      const pl = run('ProcessLogic', r);
      const outs = Array.isArray(pl) ? pl : [pl];
      for (const o of outs.slice(0, 2)) if (o) run('AlarmManager', o);
    }
  }

  const rows = Object.entries(totals)
    .map(([k, ns]) => ({ node: k, us: ns / 1000 / frames, calls: calls[k] }))
    .sort((a, b) => b.us - a.us);
  const sum = rows.reduce((a, r) => a + r.us, 0);
  // A node that never ran measures 0 us and would read as "free". Say so loudly
  // rather than letting a silent no-op look like a result.
  const dead = rows.filter((r) => r.calls === 0).map((r) => r.node);
  if (dead.length) console.log(`  !! NEVER INVOKED (not a measurement): ${dead.join(', ')}\n`);

  console.log('  per frame (microseconds)');
  for (const r of rows) {
    const pct = sum ? (r.us / sum) * 100 : 0;
    console.log(`    ${r.node.padEnd(18)} ${r.us.toFixed(1).padStart(8)} us   ${pct.toFixed(1).padStart(5)}%   calls=${r.calls}`);
  }
  console.log(`    ${'TOTAL'.padEnd(18)} ${sum.toFixed(1).padStart(8)} us`);

  // What that means at a frame rate: one core is 1e6 us of budget per second.
  console.log('\n  share of ONE core at a given frame rate:');
  for (const fps of [10, 25, 50, 100, 200]) {
    console.log(`    ${String(fps).padStart(4)} frames/s -> ${((sum * fps) / 10000).toFixed(1)}% of a core`);
  }
  console.log('\n  Excludes Node-RED runtime and dashboard fan-out - see the header.');
  console.log('  Measured on THIS machine. A Pi 4 runs JS roughly 3-5x slower,');
  console.log('  so multiply before comparing against a panel.\n');
}

main();
