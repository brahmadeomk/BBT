'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FLOWS_PATH = path.join(__dirname, '..', 'flows', 'flows_BBT.json');

describe('flows_BBT.json integrity', () => {
  test('is valid JSON', () => {
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8')));
  });

  test('every wires/links reference points at a real node id', () => {
    const nodes = JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'));
    const ids = new Set(nodes.map((n) => n.id));
    const dangling = [];

    for (const n of nodes) {
      for (const out of n.wires || []) {
        for (const target of out) {
          if (!ids.has(target)) dangling.push(`${n.id} (${n.type} ${n.name || ''}) wires -> missing '${target}'`);
        }
      }
      for (const linked of n.links || []) {
        if (!ids.has(linked)) dangling.push(`${n.id} (${n.type} ${n.name || ''}) links -> missing '${linked}'`);
      }
    }

    assert.deepEqual(dangling, []);
  });

  test('link in/out nodes are mutually paired', () => {
    const nodes = JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const mismatches = [];

    for (const n of nodes) {
      if (n.type !== 'link in' && n.type !== 'link out') continue;
      for (const otherId of n.links || []) {
        const other = byId.get(otherId);
        if (!other) continue; // already reported by the dangling-reference test
        if (!(other.links || []).includes(n.id)) {
          mismatches.push(`${n.id} (${n.type} ${n.name || ''}) -> ${otherId} is not paired back`);
        }
      }
    }

    assert.deepEqual(mismatches, []);
  });
});

describe('Alarm Manager config sweep (2026-08-31)', () => {
  const alarmManager = () => {
    const flows = JSON.parse(require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'flows', 'flows_BBT.json'), 'utf8'));
    return flows.find((n) => n.name === 'Alarm Manager (PROCESS + SYSTEM ready)').func;
  };

  test('sweeps against the APPLIED config, not the legacy draft global', () => {
    // joint_master_zone_A is the draft the dashboard edits; it can disagree with
    // what is actually running, which is why alarms survived a config change.
    const fn = alarmManager();
    const cleanup = fn.slice(fn.indexOf('CLEANUP DELETED SENSORS'));
    // Checks USAGE, not mention - the comment explaining why we no longer read
    // the draft is worth keeping.
    assert.ok(!/global\.get\(\s*["']joint_master_zone_A/.test(cleanup),
      'the cleanup sweep must not READ the legacy draft global');
    assert.ok(cleanup.includes('sweepDecommissionedAlarms'),
      'it must use the library sweep');
    // Either accessor is fine here - what matters is that the SOURCE is the
    // applied document. `readDomainCached` is the one to use on this path (it
    // runs per message); see the hot-path test below, which pins that.
    assert.match(cleanup, /readDomain(Cached)?\('modbus_joints'\)/,
      'which is fed from the applied cfg/modbus+joints document');
  });

  test('the sweep can never break alarming', () => {
    // It runs on the live alarm path; a throw here would take out the panel's
    // whole alarm engine, so it must be wrapped and default to sweeping nothing.
    const fn = alarmManager();
    const i = fn.indexOf('alarmSweep.sweepDecommissionedAlarms(');   // the CALL, not the comment
    const around = fn.slice(Math.max(0, i - 500), i + 300);
    assert.ok(/try\s*\{/.test(around) && /catch/.test(around), 'must be inside try/catch');
    assert.ok(/__sweep\s*=\s*\[\]/.test(fn), 'and default to an empty sweep');
  });
});

describe('joint_name reaches every alarm surface (2026-08-31)', () => {
  // The operator names each joint in the Joint Config table - a mandatory column,
  // stored as schema joints[].label ("Riser bend, above ACB-8"). ProcessLogic
  // carried it as d.joint_name, but the Alarm Manager kept only joint_id, so the
  // Active Alarms column headed "Location" rendered "J02". Zone had both id and
  // name all along. These pin the whole path, because the flow is hand-imported
  // JSON where a dropped binding fails silently.
  const flows = () => JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'));
  const byId = (id) => flows().find((n) => n.id === id);

  test('ProcessLogic still emits the name the Alarm Manager depends on', () => {
    assert.match(byId('39dad91df0c15744').func, /joint_name:\s*joint\.joint_name/);
  });

  test('the Alarm Manager defaults joint_name onto every raised alarm', () => {
    const fn = byId('de6fcc55794afd9e').func;
    // Defaulted in raiseAlarm, exactly as zone_name is - one place, all callers.
    assert.match(fn, /alarm\.joint_name\s*=\s*alarm\.joint_name\s*\?\?\s*joint_name/);
    assert.match(fn, /const joint_name\s*=/);
  });

  test('an unnamed joint yields null, never a fabricated name', () => {
    // A joint_name echoing the id would be indistinguishable from a real one.
    const fn = byId('de6fcc55794afd9e').func;
    const decl = fn.slice(fn.indexOf('const joint_name ='));
    assert.match(decl.slice(0, 160), /:\s*null;/);
  });

  test('all three e-mail bodies name the joint, not just its id', () => {
    const fn = byId('de6fcc55794afd9e').func;
    assert.equal((fn.match(/Joint: \$\{jointLabel\(/g) || []).length, 3,
      'raise, clear and auto-clear bodies');
    assert.ok(!/Joint: \$\{a(larm)?\.joint_id\}/.test(fn), 'no body still prints the bare id');
  });

  test('both alarm tables render the name and keep the id reachable', () => {
    for (const id of ['24acd52109175c6b', '180eeb72d29409ed']) {
      const fmt = byId(id).format;
      assert.ok(fmt.includes('{{a.joint_name || a.joint_id}}'), `${id} must fall back to the id`);
      assert.ok(fmt.includes('title="{{a.joint_id}}"'), `${id} must keep the id as a tooltip`);
    }
  });

  test('the history CSV export gains a Location column, in the right position', () => {
    const fmt = byId('180eeb72d29409ed').format;
    const header = fmt.match(/let csv = "([^"]*)/)[1].split(',');
    assert.deepEqual(header.slice(0, 4), ['Sr', 'Joint', 'Location', 'Zone']);
    // ...and the row array agrees, or every later column is off by one
    const row = fmt.slice(fmt.indexOf('const row = ['), fmt.indexOf('const row = [') + 200);
    assert.match(row, /a\.joint_id,\s*a\.joint_name \|\| "",\s*a\.zone_name/);
  });
});

describe('alarm descriptions lead with the joint id (2026-08-31)', () => {
  // User request. The description is the one field that travels everywhere
  // intact - e-mail subject lines and bodies, the CSV export, the alarm history,
  // the cloud snapshot - and several of those show it with no joint column
  // beside it, so a bare "ΔT 29.48 ≥ 25" did not say which joint.
  // Safe because nothing keys on the string: dedupe is by instanceId, historian
  // matching by instanceId + raisedTs, and description is only ever displayed.
  const mgr = () => JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'))
    .find((n) => n.id === 'de6fcc55794afd9e').func;

  test('all three joint-scoped builders go through describeJoint', () => {
    const fn = mgr();
    assert.match(fn, /description: describeJoint\(S\.description\)/, 'COMMUNICATION / SENSOR_FAULT');
    assert.match(fn, /description: describeJoint\(`RoR /, 'RoR');
    assert.match(fn, /description: describeJoint\(`ΔT /, 'deltaT');
    assert.equal((fn.match(/describeJoint\(/g) || []).length, 4, '3 call sites + the definition');
  });

  test('the prefix is the id, and falls back cleanly when there is no joint', () => {
    const fn = mgr();
    const body = fn.slice(fn.indexOf('function describeJoint'), fn.indexOf('function describeJoint') + 220);
    assert.match(body, /\$\{d\.joint_id\}: \$\{text\}/, 'leads with the id');
    assert.match(body, /String\(text\)/, 'unprefixed when there is no joint id');
  });

  test('panel- and device-scoped alarms are NOT prefixed', () => {
    // They belong to no joint - "SYSTEM: ..." would be noise, and the blacklist
    // alarm already names its device and the joints it affects.
    const fn = mgr();
    for (const marker of ['No data received from', 'Slave ${b.slave_id} blacklisted', 'Edge controller power fault']) {
      const i = fn.indexOf(marker);
      assert.ok(i > 0, `${marker} still present`);
      const line = fn.slice(fn.lastIndexOf('\n', i) + 1, fn.indexOf('\n', i));
      assert.ok(!line.includes('describeJoint'), `${marker} must not be prefixed`);
    }
  });
});

describe('Panel & Uplink tile on Device Health (2026-09-01)', () => {
  // The heartbeat already carries uplink and Pi health, but hourly and only when
  // the link is up - exactly wrong for a technician at the panel wondering why
  // the uplink is marginal. This renders it locally every 30 s, offline.
  const flows = () => JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'));
  const byId = (id) => flows().find((n) => n.id === id);

  test('reuses the snapshot Pi Power Health already collects, at no extra cost', () => {
    // A second collector would have meant a second round of process spawns
    // (df, iw, mmcli, timedatectl) every 30 s for the same numbers.
    const fn = byId('d9b1ac57e0f10042').func;
    assert.equal((fn.match(/collectPiHealth\(\)/g) || []).length, 1, 'still exactly one collection');
    assert.match(fn, /summarizeSystemHealth\(health\)/, 'and it summarises THAT snapshot');
    assert.match(fn, /global\.set\('busduct_system_health'/);
  });

  test('the tile is fed from the same 5 s view refresh as the blacklist table', () => {
    const view = byId('d9b1ac57e0f10024');
    assert.deepEqual(view.wires, [['d9b1ac57e0f10022', 'd9b1ac57e0f10061']]);
    assert.match(view.func, /msg\.payload\.system = global\.get\('busduct_system_health'/);
  });

  test('the tile sits beside BMS Registers on Diagnostics, the page operators actually open', () => {
    // Moved off the Device Health dashboard tab 2026-09-01: it rendered
    // correctly there, but that tab is not one the HMI operators navigate to.
    const bms = byId('b115ac57e0f10010');
    const group = byId('d9b1ac57e0f10060');
    assert.equal(group.type, 'ui_group');
    assert.equal(group.tab, bms.tab, 'same dashboard tab as BMS Registers');
    assert.ok(Number(group.order) > Number(bms.order), 'ordered after it');
    assert.equal(String(group.width), String(bms.width), 'same width, so the two sit side by side');
    const tile = byId('d9b1ac57e0f10061');
    assert.equal(tile.group, 'd9b1ac57e0f10060');
    // The feed is unchanged - the dashboard group moved, the wiring did not.
    assert.deepEqual(byId('d9b1ac57e0f10024').wires, [['d9b1ac57e0f10022', 'd9b1ac57e0f10061']]);
  });

  test('the tile updates live, not only on a browser reload', () => {
    // ng-init evaluates ONCE when the element is created, so the tile froze on
    // its first snapshot and only refreshed when the page was reloaded. On a
    // HEALTH display that is worse than useless: it would keep showing "Panel
    // healthy" and a strong signal long after either stopped being true.
    const fmt = byId('d9b1ac57e0f10061').format;
    // The ATTRIBUTE, not the word - the fix's own comment names it on purpose.
    assert.ok(!/ng-init=/.test(fmt), 'ng-init cannot track a changing msg');
    assert.match(fmt, /scope\.\$watch\('msg'/, 'must watch msg');
    assert.match(fmt, /scope\.s = /);
  });

  test('the tile renders SSID and signal, and degrades before the first sample', () => {
    const fmt = byId('d9b1ac57e0f10061').format;
    assert.match(fmt, /s\.uplink\.label/);
    assert.match(fmt, /s\.uplink\.detail/);
    assert.match(fmt, /not sampled yet/, 'must not render blank on a cold start');
    // Timestamps render in site local time like every other HMI table. The
    // collector stamps UTC (edge_utc, as the wire contract does); rendering is
    // the only place a timezone belongs, and raw "...Z" on an operator screen
    // makes "is this current?" a mental arithmetic problem.
    assert.match(fmt, /\{\{toIST\(s\.updatedTs\)\}\}/, 'the timestamp must go through toIST');
    assert.match(fmt, /scope\.toIST\s*=/, 'and the tile must define it - scope is per-template');
    assert.match(fmt, /Asia\/Kolkata/);
    for (const f of ['s.cpu_temp', 's.ram', 's.disk', 's.uptime', 's.load', 's.warnings']) {
      assert.ok(fmt.includes(f), `${f} must be shown`);
    }
  });
});

describe('ProcessLogic matches on (unit address, channel) (2026-09-01)', () => {
  const pl = () => JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'))
    .find((n) => n.id === '39dad91df0c15744').func;

  test('the joint lookup uses the channel, not the unit address alone', () => {
    assert.match(pl(), /j\.slaveID === sensorID && \(j\.channel \?\? 1\) === sensorChannel/);
  });

  test('a message with no channel is treated as channel 1', () => {
    // Pre-fan-out messages, and the library-missing fallback. Every slave on
    // this panel is single-channel, so this is the correct reading.
    assert.match(pl(), /Number\.isInteger\(sensor\.channel\) \? sensor\.channel : 1/);
  });

  test('ambient state is keyed by (unit, channel) too', () => {
    // A flat unit address cannot tell channel 3 of a 4-channel module used as
    // the zone ambient from channel 1.
    const body = pl();
    assert.match(body, /ambientState\[sensorKeyCh\]/);
    assert.match(body, /ambientSet\.has\(sensorKeyCh\)/);
    assert.match(body, /ambKeyOf/, 'and legacy draft rows still resolve');
  });

  test('the channel-1 ambient keeps its original AMBIENT_<unit> id', () => {
    // Historian tags and any alarm already raised against an existing ambient
    // must survive the change.
    assert.match(pl(), /sensorChannel === 1 \? `AMBIENT_\$\{sensorID\}`/);
  });
});

describe('legacy decode dispatcher routes instead of fanning out (2026-09-08)', () => {
  // The 100 ms inject over `slaveLength` used to send every sensor to all 21
  // branch filters, so Node-RED cloned each message 20 times and ran 20 filters
  // that matched nothing: ~14,900 node executions/s at 71 sensors, the fixed CPU
  // cost behind the sluggish HMI. Now one output per branch.
  const flows = () => JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'));
  const loop = () => flows().find((n) => n.id === 'bf2e916c59fbf553');

  test('one output per branch, one destination per output', () => {
    const n = loop();
    assert.equal(n.wires.length, n.outputs, 'outputs and wire arrays must agree');
    assert.ok(n.outputs > 1, 'a single output means the fan-out is back');
    for (const w of n.wires) {
      assert.equal(w.length, 1, 'each output feeds exactly one branch - no cloning');
    }
  });

  // The map lives in the dispatcher but the truth lives in each branch's own
  // `compare` array. If someone reorders the wires, the map silently routes
  // sensors to the wrong decode type - a mis-scaled reading, not an error. So
  // check them against each other rather than against a copy of the map.
  test('TYPE_OUTPUT agrees with every branch\'s own compare array', () => {
    const all = flows();
    const byId = (id) => all.find((n) => n.id === id);
    const n = loop();
    const map = {};
    const block = n.func.slice(n.func.indexOf('const TYPE_OUTPUT'), n.func.indexOf('const NOUT'));
    for (const m of block.matchAll(/"([^"]+)":\s*(\d+)/g)) map[m[1]] = Number(m[2]);

    let checked = 0;
    n.wires.forEach((wire, idx) => {
      const branch = byId(wire[0]);
      const cmp = /compare\s*=\s*\[([^\]]*)\]/.exec(branch.func || '');
      assert.ok(cmp, `branch ${branch.name} has no compare array`);
      for (const nm of cmp[1].matchAll(/["']([^"']+)["']/g)) {
        assert.equal(map[nm[1]], idx,
          `type "${nm[1]}" is wired to output ${idx} (${branch.name}) but mapped to ${map[nm[1]]}`);
        checked += 1;
      }
    });
    assert.equal(checked, n.outputs, 'every branch must contribute a type');
  });

  test('an unknown type is LOUD, not silently skipped', () => {
    // sensorData has exactly one source - the conversion nodes below the
    // dispatcher. A type with no branch simply stops being written, and a frozen
    // sensorData looks identical to a live one: last-known plausible values, no
    // error, no alarm, while the legacy absolute-threshold alerts never fire
    // again. So a missing branch must announce itself.
    const fn = loop().func;
    assert.match(fn, /unknown\.add\(String\(type\)\)/, 'unknown types must be collected');
    assert.match(fn, /fill: 'red'/, 'and shown as a red node status');
    assert.match(fn, /node\.warn\(/, 'and warned about');
    assert.match(fn, /unknownWarnAt/, 'throttled - it is true every tick once true at all');
  });

  test('the legacy decode tick is not faster than 1 s', () => {
    // It re-decodes values that only change when a frame arrives - every ~20 s
    // per sensor at inter_frame_ms 250. At 0.1 s it was ~200x oversampled and
    // cost O(sensors) work per tick regardless of the scan rate. Guarding the
    // floor, not the exact value, so it can still be tuned per panel.
    const inject = flows().find((n) => n.id === '8233660a43277487');
    assert.ok(Number(inject.repeat) >= 1,
      `legacy decode tick is ${inject.repeat}s; below 1s it re-decodes far faster than data arrives`);
  });

  test('each sensor gets a fresh message object', () => {
    // The old loop mutated and re-sent one shared msg; the first recipient holds
    // it by reference, so the next iteration could rewrite a payload in flight.
    assert.match(loop().func, /Object\.assign\(\{\}, msg,/);
  });
});

describe('sensor plausibility band is two-sided (2026-09-05)', () => {
  // Found live: J19 read -273 and J09 read exactly 0 while their neighbours read
  // 27-31 degC against a 33.8 degC ambient. The gate was `sensorVal > 300` only,
  // so an implausible LOW reading was accepted as a measurement and a dead
  // channel presented as a healthy cold joint - never alarmed.
  const pl = () => JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'))
    .find((n) => n.id === '39dad91df0c15744').func;

  // Assert on the CODE, not the commentary: the comment block above this gate
  // says "-273" and "> 300" while explaining the bug, so a naive substring
  // search passes against prose even if the check itself is gone.
  const gate = () => {
    const b = pl();
    const i = b.indexOf('let sensor_status');
    return b.slice(i, b.indexOf('const freeze', i));
  };

  test('an implausibly low reading is a sensor fault', () => {
    assert.match(gate(), /sensorVal < SENSOR_MIN_C/);
    assert.match(pl(), /SENSOR_MIN_C = -40\b/);
  });

  test('the upper limit comes from the sensor (was 300, now 150)', () => {
    // SUPERSEDED 2026-09-10. This test used to assert the ceiling was "unchanged
    // at 300" - correct at the time, because that change was completing the LOW
    // side and deliberately not retuning anything else. 300 was never derived
    // from anything though, and the datasheet for the NTC element specifies
    // -80..+150 degC, so 151-300 could not be a measurement at all.
    assert.match(pl(), /SENSOR_MAX_C = 150\b/, 'the datasheet default');
    assert.match(gate(), /sensorVal > SENSOR_MAX_C/);
  });

  test('a non-finite reading is a fault, not a value', () => {
    assert.match(gate(), /!Number\.isFinite\(sensorVal\)/);
  });

  test('an out-of-band reading freezes the joint like any other fault', () => {
    // The whole point: it must not update the EMA or feed deltaT.
    assert.match(pl(), /sensor_status === "Sensor_Error"/);
  });

  // Behavioural check on the real gate, lifted out of the flow rather than
  // re-typed - a copy would keep passing after the flow changed.
  test('the extracted gate classifies the live readings correctly', () => {
    const body = gate();
    // The band is resolved from config now, so the lifted code hits `global.get`
    // and `CONFIG_KEY`, neither of which exists here - both throw and are caught
    // by the gate's own try/catch, leaving the datasheet defaults. That is the
    // library-missing path on a real panel, so this exercises it for free.
    const run = new Function('sensor', 'sensorVal', `let sensor_status = sensor.st ?? "OK";${
      body.slice(body.indexOf('let SENSOR_MIN_C'))}\nreturn sensor_status;`);
    // A healthy reading carries the frame's own lowercase "ok" through; only an
    // absent st defaults to "OK". What matters is that it is not a fault.
    const faulted = (v, st = 'ok') => run({ st }, v) === 'Sensor_Error';
    assert.equal(faulted(31.4), false, 'a normal joint');
    assert.equal(faulted(131), false, 'J10 under a heat test - hot but real, and still under 150');
    assert.equal(faulted(-273), true, 'J19 absolute-zero sentinel');
    assert.equal(faulted(382.36), true, 'the same value read unsigned');
    // The case the old 300 ceiling let through: above the element's range, so
    // it cannot be a measurement whatever it looks like.
    assert.equal(faulted(200), true, 'beyond the sensor range - was accepted as real until 2026-09-10');
    assert.equal(faulted(149.5), false, 'just inside the range is still a measurement');
    assert.equal(run({ st: 'err' }, 25), 'Communication_Error', 'comm errors still win');
    // NOT caught by the band, and deliberately so: 0 degC is a real temperature
    // in an unheated panel. Distinguishing a dead channel from a cold one needs
    // the sustained-negative-deltaT rule (STATUS.md D2), which is a design-chat
    // decision, not a bound.
    assert.equal(faulted(0), false, 'exact zero is still accepted - see D2');
  });
});

describe('alarms raised against the applied configuration (2026-09-01)', () => {
  // ProcessLogic read the legacy draft while the alarm sweep cleared against the
  // applied document. Two sources of truth for one lifecycle: it let a joint id
  // the schema would reject raise alarms, and produced raise/clear churn.
  const flows = () => JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'));
  const byId = (id) => flows().find((n) => n.id === id);

  test('ProcessLogic reads the applied list first', () => {
    const fn = byId('39dad91df0c15744').func;
    assert.match(fn, /APPLIED_JOINTS_KEY = "busduct_applied_joints"/);
    assert.match(fn, /joints = global\.get\(APPLIED_JOINTS_KEY, "default"\)/);
  });

  test('...but falls back to the draft rather than monitoring nothing', () => {
    // Fire-safety monitor: it must never stop watching joints because a global
    // has not been populated yet (at boot, or if the library failed to load).
    const fn = byId('39dad91df0c15744').func;
    const block = fn.slice(fn.indexOf('APPLIED_JOINTS_KEY, "default"'));
    assert.match(block.slice(0, 300), /global\.get\(JOINT_MASTER_KEY\)/,
      'the draft must remain a fallback');
  });

  // Measured live on ESBUSBBT06 (2026-09-09): the Alarm Manager and the
  // Blacklist Engine each called the UNCACHED readDomain once per message, so a
  // 71-device panel re-parsed and re-ran the full R1-R17 validation over its
  // whole commissioning document several times a second. Node-RED sat at ~50 %
  // of a core with no dashboard client connected. This is a cheap guard against
  // it coming back - the uncached form is easy to reach for and the cost is
  // invisible until a panel is large.
  test('no per-message node uses the uncached readDomain', () => {
    const PER_MESSAGE = {
      'de6fcc55794afd9e': 'Alarm Manager (runs per KPI message)',
      'd9b1ac57e0f10002': 'Blacklist Engine (runs per Nano frame)',
      '2390b9df3335021b': 'Scale Nano Reading (runs per Nano frame)',
    };
    for (const [id, why] of Object.entries(PER_MESSAGE)) {
      const fn = byId(id).func;
      // Checks the CALL, not a mention: the comments explaining the cache are
      // worth keeping, and they name the uncached method.
      assert.ok(!/\.readDomain\(/.test(fn),
        `${why} must use readDomainCached - a parse + full validation per message`);
      assert.match(fn, /\.readDomainCached\(/, `${why} must still read the applied doc`);
    }
  });

  test('ProcessLogic never reads the config store itself', () => {
    // It runs on every reading; a file read per sample would be a real
    // regression. The publisher node does the read on a slow tick.
    const fn = byId('39dad91df0c15744').func;
    assert.ok(!/readDomain|createStore/.test(fn), 'the hot path must stay in memory');
  });

  test('the publisher polls, so no apply route can bypass it', () => {
    // Local joint apply, local Modbus apply, a remote push and a hand-edited
    // file all have to converge; hooking apply sites can miss one.
    const inj = byId('c0nf1gd21ft00001');
    assert.equal(inj.type, 'inject');
    assert.equal(inj.repeat, '10');
    assert.equal(inj.once, true, 'and publishes at boot');
    const fn = byId('c0nf1gd21ft00002').func;
    assert.match(fn, /readDomain\('modbus_joints'\)/);
    assert.match(fn, /global\.set\('busduct_applied_joints'/);
  });

  test('an unreadable config keeps the previous list rather than blanking it', () => {
    const fn = byId('c0nf1gd21ft00002').func;
    assert.match(fn, /if \(built\.joints\) \{[\s\S]*?global\.set\('busduct_applied_joints'/,
      'the publish must be guarded');
  });

  test('the unapplied-joints banner exists and is fed by the same tick', () => {
    // The behaviour change - an unapplied row is no longer monitored - must
    // announce itself rather than being discovered when a joint turns out to
    // have been unwatched.
    assert.deepEqual(byId('c0nf1gd21ft00002').wires, [['c0nf1gd21ft00011']]);
    const group = byId('c0nf1gd21ft00010');
    assert.equal(group.tab, 'tab_cfg', 'on Joint Config, where the operator edits');
    const fmt = byId('c0nf1gd21ft00011').format;
    assert.match(fmt, /NOT APPLIED/);
    assert.match(fmt, /not being monitored/);
    assert.match(fmt, /msg\.payload\.warnings/, 'channel collisions surface here too');
  });
});

describe('Nano frame scaling goes through the decoder (2026-09-01)', () => {
  const fn = () => JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'))
    .find((n) => n.id === '2390b9df3335021b').func;

  // Check CODE, not mentions - the node's comment explains the old expression,
  // and matching that instead of the call is a mistake already made twice today.
  const code = () => fn().split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  test('the array-coercion expression is gone', () => {
    // `msg.payload.val / 100` where val is an array: [2543] coerced to 25.43 by
    // accident, [2543,2601] became NaN -> 0, so a multi-channel slave read 0 degC
    // and looked like a cold joint rather than a fault.
    assert.ok(!/payload\.val\s*\/\s*100/.test(code()), 'must not divide the array again');
    assert.match(code(), /channelDecode\.decodeFrame\(/);
  });

  test('it fans out one message per channel', () => {
    // The legacy sensorData chain was ALREADY per-channel
    // (sensorData[unit][register_addr]); only this path collapsed a frame to a
    // single value, which is why the fan-out touches nothing else.
    assert.match(code(), /r\.readings\.map\(/);
    assert.match(code(), /channel: rd\.channel/);
    assert.match(code(), /return \[out\]/, 'one output, many messages');
  });

  test('a channel the frame did not carry is a fault, never a zero', () => {
    // Reporting 0 would read as a COLD JOINT - the exact failure this whole
    // change exists to remove.
    assert.match(code(), /st: Number\.isFinite\(rd\.val\) \? rd\.st : 'err'/);
  });

  test('it still scales when the library is missing, rather than going blind', () => {
    const body = code();
    const guard = body.slice(0, body.indexOf('const joints'));
    assert.match(guard, /val\[0\]/, 'legacy fallback takes the first element, not the array');
    assert.match(guard, /\/ 100/, 'on the legacy scale');
  });

  test('the applied doc is cached, not read per frame', () => {
    // This node runs on every Nano frame; a store read per frame would be a
    // real regression on a 110-device panel.
    assert.match(fn(), /flow\.get\('decodeDoc'\)/);
    assert.match(fn(), /decodeDocTs/);
  });

  test('the node status shows every channel it decoded', () => {
    assert.match(fn(), /payload\.channel\}=\$\{m\.payload\.val\}/);
  });
});

describe('the decode node cannot spam the log (2026-09-01)', () => {
  // A scale mismatch is true of EVERY frame from that unit, forever. Unthrottled
  // that is ~12 lines/second on a 6-slave panel, filling the SD card the
  // historian and the outbox share.
  const fn = () => JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'))
    .find((n) => n.id === '2390b9df3335021b').func;

  test('warnings are throttled per unit', () => {
    const body = fn();
    assert.match(body, /decodeWarnAt/);
    assert.match(body, /300000/, 'once per unit per 5 minutes');
    assert.ok(!/^\s*if \(r\.warnings\.length\) node\.warn/m.test(body), 'never warn unconditionally');
  });

  test('the configured temp_scale is not opted into', () => {
    // It is a migration guess; honouring it raised "value out of valid range"
    // on every joint at once.
    assert.ok(!/useConfigScale/.test(fn()), 'the flow must not opt in');
  });
});

describe('the joint name survives the applied-config repoint (2026-09-01)', () => {
  const flows = () => JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'));

  test('the publisher passes the draft as a label fallback', () => {
    // A document applied before `label` was persisted carries no joint name, so
    // the alarm e-mails would fall back to the bare id.
    const fn = flows().find((n) => n.id === 'c0nf1gd21ft00002').func;
    assert.match(fn, /labelFallback/);
    assert.match(fn, /r\.joint_id && r\.joint_name/, 'built from the draft rows');
  });
});

describe('the Alarm Manager applies blacklist description updates (2026-09-01)', () => {
  const fn = () => JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'))
    .find((n) => n.id === 'de6fcc55794afd9e').func;

  test('an update refreshes the text in place, not by re-raising', () => {
    // Same alarm instance, same raisedTs, same ACK state - only what it SAYS
    // changes. A re-raise would reset the ACK and send another e-mail.
    const body = fn();
    const i = body.indexOf('b.action === "update"');
    assert.ok(i > 0, 'the update action must be handled');
    // Bound to THIS block. A fixed-size window spilled into the neighbouring
    // clear branch, whose historian.push then failed the assertion below.
    const block = body.slice(i, body.indexOf('b.action === "clear"', i));
    assert.match(block, /a\.description = b\.description/);
    assert.ok(!/emails\.push/.test(block), 'an update must not send an e-mail');
    assert.ok(!/raisedTs: nowISO/.test(block), 'nor restamp the raise');
    assert.ok(!/historian\.push/.test(block), 'nor add a history entry');
  });

  test('the historian copy of that raise is kept in step', () => {
    // Otherwise Cleared Alarm History keeps showing text the alarm no longer has.
    const body = fn();
    const i = body.indexOf('b.action === "update"');
    const block = body.slice(i, body.indexOf('b.action === "clear"', i));
    assert.match(block, /h\.description = a\.description/);
  });
});

describe('table headers stay pinned while scrolling (2026-09-01)', () => {
  // Requested from the panel: on a table with a row per joint or channel the
  // column titles scroll off first, exactly when you need them.
  const flows = () => JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'));
  const byId = (id) => flows().find((n) => n.id === id);

  const TABLES = [
    ['d58c3f80174c66df', 'JointMasterUI'],
    ['7f3a1c9e2b5d4a02', 'ModbusSettingsUI'],
    ['db41c2b5077e83fc', 'Diagnostics'],
    ['24acd52109175c6b', 'Active Alarms'],
    ['180eeb72d29409ed', 'Alarm History'],
    ['b115ac57e0f10013', 'BMS Registers'],
  ];

  for (const [id, name] of TABLES) {
    test(`${name} pins its header`, () => {
      assert.match(byId(id).format, /position:\s*sticky;?\s*top:\s*0/);
    });

    test(`${name}'s sticky header is OPAQUE`, () => {
      // A sticky header with a transparent background has the rows scroll
      // visibly through it - the single most common way this is got wrong.
      const fmt = byId(id).format;
      const i = fmt.search(/position:\s*sticky/);
      const rule = fmt.slice(Math.max(0, i - 400), i + 400);
      assert.match(rule, /background:\s*#[0-9a-fA-F]{6}/);
    });
  }

  test('a pinned header needs a bounded scroll container to move within', () => {
    // The panels carry overflow-x:auto, which per CSS makes them scroll
    // containers on BOTH axes - so without a max-height the sticky header binds
    // to a container that never scrolls and does nothing at all.
    for (const [id, cls] of [['d58c3f80174c66df', 'jm-wrap'],
                             ['7f3a1c9e2b5d4a02', 'mbs-wrap'],
                             ['db41c2b5077e83fc', 'diag-wrap']]) {
      const fmt = byId(id).format;
      assert.ok(fmt.includes(`<div class="${cls}">`), `${cls} must wrap the table`);
      assert.match(fmt, new RegExp(`\\.${cls}\\s*\\{[^}]*max-height`), `${cls} must be bounded`);
      assert.match(fmt, new RegExp(`\\.${cls}\\s*\\{[^}]*overflow`), `${cls} must scroll`);
    }
  });
});

describe('every busductConfigService member a flow node calls actually exists', () => {
  // Found the hard way 2026-09-08: sortAuditDesc was required into
  // node-red/index.js but never added to module.exports. The audit viewers call
  // `cs.sortAuditDesc(...)` behind a `cs && cs.sortAuditDesc` guard, so the
  // omission did not throw - it silently fell back to UNSORTED audit entries.
  // Graceful fallbacks turn a missing export into a behaviour change nobody
  // sees, which is why this checks the contract rather than trusting the guard.
  const svc = require('../src/config-service/node-red');

  test('no flow node calls a member the service does not export', () => {
    const flows = JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'));
    const missing = [];
    for (const n of flows) {
      const body = n.func || '';
      if (!body.includes('busductConfigService')) continue;
      // Which local names hold the service in this node?
      const vars = new Set();
      for (const m of body.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*global\.get\(\s*['"]busductConfigService['"]/g)) {
        vars.add(m[1]);
      }
      for (const v of vars) {
        for (const m of body.matchAll(new RegExp(`\\b${v}\\.([A-Za-z_$][\\w$]*)`, 'g'))) {
          if (svc[m[1]] === undefined) missing.push(`${n.name || n.id}: ${v}.${m[1]}`);
        }
      }
    }
    assert.deepEqual([...new Set(missing)], []);
  });
});

describe('thresholds are resolved per joint, not panel-wide (2026-09-10)', () => {
  // THE BUG THIS PINS. cfg/alarms has had named `profiles` since Slice 2,
  // cfg/joints has had joints[].threshold_profile to select one, and A3 has
  // always validated that the reference resolves. None of it reached the
  // runtime: the Alarm Manager read one flat {deltaT, ror, persistence} out of
  // `busbartherm_system_config` and evaluated EVERY joint against it, and no
  // node in the flow mentioned threshold_profile at all. An operator could set
  // a per-joint profile, watch it validate, see it audited - and nothing
  // changed. It is the same shape as poll_interval_s never reaching the Nano
  // (2026-09-09): validated, displayed, stored, never read.
  //
  // Validation cannot catch this class of bug, because the document IS
  // self-consistent. Only a test that asserts somebody READS the field can.
  const flows = JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'));
  const byId = (id) => flows.find((n) => n.id === id);
  const ALARM_MANAGER = 'de6fcc55794afd9e';
  const PROCESS_LOGIC = '39dad91df0c15744';

  test('ProcessLogic carries each joint threshold_profile on its KPI message', () => {
    const body = byId(PROCESS_LOGIC).func;
    assert.match(
      body,
      /threshold_profile:\s*joint\.threshold_profile/,
      'the Alarm Manager cannot resolve a profile it is never told about'
    );
  });

  test('the Alarm Manager resolves thresholds instead of reading the flat set', () => {
    const body = byId(ALARM_MANAGER).func;
    assert.match(body, /alarmThresholds\?\.resolveThresholds\(/, 'must go through the resolver');
    const flat = body.match(/\bcfg\.(deltaT|ror|persistence)\./g) || [];
    assert.deepEqual(
      flat,
      [],
      `Alarm Manager reads panel-wide thresholds directly (${flat.join(', ')}) - ` +
        'that is the regression: every joint gets the default profile again'
    );
  });

  test('the resolved set is declared before it is used', () => {
    // A subtle one: hoisting means a `let TH` moved below the RoR/deltaT blocks
    // would throw ReferenceError on the live alarm path, per message, and the
    // only symptom would be alarms silently not being raised.
    const body = byId(ALARM_MANAGER).func;
    const declared = body.indexOf('let TH = cfg;');
    const firstUse = body.search(/TH\.(deltaT|ror|persistence)\./);
    assert.ok(declared >= 0, 'expected the resolved threshold set to be declared');
    assert.ok(firstUse > declared, 'thresholds are used before they are resolved');
  });

  test('resolution falls back rather than leaving a joint unwatched', () => {
    // The fail-safe direction is the whole point: a fire-safety monitor must
    // never stop alarming because a profile name is wrong or the library is
    // missing. Worst case is the panel-wide set - never silence.
    const { resolveThresholds } = require('../src/alarms/threshold-resolver');
    const complete = {
      deltaT: { watch: 15, warning: 25, critical: 35 },
      ror: { watch: 15, warning: 30, critical: 60, timeWindowMin: 20 },
      persistence: { watchMin: 30, warningMin: 15, criticalMin: 5 },
    };
    assert.ok(resolveThresholds({ ...complete, profiles: { default: complete } }, 'gone'));
    assert.ok(resolveThresholds(complete, 'gone'), 'a pre-profiles global must still resolve');
  });
});

describe('the sensor plausibility ceiling comes from the sensor (2026-09-10)', () => {
  // ProcessLogic hardcoded `SENSOR_MAX_C = 300` - a number inherited rather than
  // derived - while cfg/alarms sensor_fault.sensor_error_above_c sat validated
  // and unread. The element is an NTC thermistor specified -80..+150 degC, so a
  // reading of 151-300 could never be a true measurement, yet it was accepted as
  // one and passed to the alarms, the historian, the BMS image and the cloud:
  // the one number the band exists to catch was the one it let through.
  const flows = JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'));
  const processLogic = flows.find((n) => n.id === '39dad91df0c15744').func;

  test('the ceiling is resolved, not hardcoded', () => {
    assert.match(processLogic, /alarmThresholds\?\.resolveSensorLimits\(/);
    assert.doesNotMatch(
      processLogic,
      /SENSOR_MAX_C\s*=\s*300/,
      'the inherited 300 ceiling is back: readings above the sensor range would be trusted'
    );
  });

  test('the resolved band is set before the fault check reads it', () => {
    // Same temporal-dead-zone trap as the threshold set: `let` used above its
    // declaration throws per message, and the only symptom is a joint losing its
    // sensor-fault check.
    const declared = processLogic.indexOf('let SENSOR_MAX_C');
    const used = processLogic.indexOf('sensorVal > SENSOR_MAX_C');
    assert.ok(declared >= 0 && used > declared, 'band used before it is resolved');
  });

  test('the datasheet default survives a config the flow cannot read', () => {
    // The lookup is wrapped in try/catch precisely so a missing library cannot
    // remove the fault check; this pins the value it falls back to.
    const { resolveSensorLimits } = require('../src/alarms/threshold-resolver');
    assert.equal(resolveSensorLimits(null).maxC, 150);
    assert.equal(resolveSensorLimits(null).minC, -40);
  });

  test('the schema default matches the sensor, so a fresh panel is right', () => {
    const schema = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'config', 'schemas', 'busduct_alarms_config.schema.json'), 'utf8')
    );
    const sf = schema.definitions?.sensor_fault?.properties ?? schema.properties?.sensor_fault?.properties;
    assert.equal(sf.sensor_error_above_c.default, 150);
  });
});

describe('threshold profile editor (2026-09-11)', () => {
  // Zone-wise thresholds were inert without this: profiles existed in the schema
  // and zones could bind one, but the Alarm Config screen only ever wrote
  // profiles.default, so there was no way to create the profile a zone would
  // name. This is the editor.
  const flows = JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'));
  const byId = (id) => flows.find((n) => n.id === id);
  const UI = 'a1c3f5e7b9d1a002';
  const BACKEND = 'a1c3f5e7b9d1a003';

  test('the editor loop is closed: UI -> backend -> UI', () => {
    assert.deepEqual(byId(UI).wires, [[BACKEND]]);
    assert.deepEqual(byId(BACKEND).wires, [[UI]]);
  });

  test('it has its own backend, separate from the thresholds screen', () => {
    // Sharing "BusbarTherm Config Manager" would push every profile reply
    // through the existing screen's $watch too. This change must not be able to
    // break the screen that already works.
    const configManager = 'ebbf810a01b0f9a6';
    assert.notEqual(BACKEND, configManager);
    assert.ok(!byId(configManager).wires.some((w) => w.includes(UI)), 'profiles must not ride the thresholds loop');
  });

  test('a boot inject seeds it, and the widget can also heal itself', () => {
    // The inject fires ONCE. Re-deploying with the dashboard open re-creates the
    // widget with an empty scope and nothing to replay - a permanently blank
    // table - which is why the template asks for its own data too.
    assert.ok(flows.some((n) => n.type === 'inject' && (n.wires || []).some((w) => w.includes(BACKEND))));
    assert.match(byId(UI).format, /setTimeout\(function\(\)\{ if \(!loaded\) scope\.reload\(\); \}, 700\)/);
  });

  test('every action ships the full table, never a single row', () => {
    // The JointMasterUI data-loss bug: a server reply built from its own
    // last-persisted copy silently overwrote an unsaved in-progress edit.
    const fmt = byId(UI).format;
    assert.match(fmt, /action: 'profiles_apply', profiles: map/);
    assert.doesNotMatch(fmt, /index:/, 'a per-row action is the shape that lost data');
  });

  test('handlers tolerate an undefined scope.msg', () => {
    // Real JS, not a forgiving Angular expression: `scope.msg.payload.profiles`
    // on an undefined msg throws and the click does nothing, which is what made
    // ADD BUS dead on a freshly-deployed widget.
    assert.match(byId(UI).format, /var p = \(scope\.msg && scope\.msg\.payload\) \|\| \{\}/);
  });

  test('duplicate and unnamed profiles are refused before they are sent', () => {
    // The server takes a MAP, so two rows sharing a name would collapse into one
    // and the operator would lose a profile without being told which.
    const fmt = byId(UI).format;
    assert.match(fmt, /Duplicate profile name/);
    assert.match(fmt, /Give every profile a name/);
  });

  test('the backend writes the runtime global, or a profile change does nothing', () => {
    assert.match(byId(BACKEND).func, /global\.set\('busbartherm_system_config', runtimeConfig, 'default'\)/);
  });
});

describe('profile selectors on the zone and joint tables (2026-09-11)', () => {
  // The editor could create profiles but nothing could assign them. These two
  // dropdowns are the assignment half - added to the tables where the
  // JointMasterUI data-loss bug happened, so the properties that bug taught us
  // are pinned alongside the new column.
  const flows = JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'));
  const byName = (n) => flows.find((x) => x.name === n);

  test('both tables offer the profile dropdown', () => {
    assert.match(byName('ZoneMasterUI').format, /ng-model="z\.threshold_profile"/);
    assert.match(byName('JointMasterUI').format, /ng-model="j\.threshold_profile"/);
  });

  test('headers and cells still line up after the added column', () => {
    // A table whose <th> count drifts from its <td> count renders every later
    // column under the wrong heading - silently, and this is a config screen.
    for (const name of ['ZoneMasterUI', 'JointMasterUI']) {
      const fmt = byName(name).format;
      const th = (fmt.match(/<th>/g) || []).length;
      const td = (fmt.match(/<td>/g) || []).length;
      assert.equal(th, td, `${name}: ${th} headers vs ${td} cells`);
    }
  });

  test('the dropdown never renders empty, even before a reply arrives', () => {
    // ng-options over an undefined list yields an empty select, and interacting
    // with one nulls the model - which the next apply would write back as a
    // cleared selection.
    for (const name of ['ZoneMasterUI', 'JointMasterUI']) {
      assert.match(byName(name).format, /msg\.payload\.profile_names \|\| \['default'\]/);
    }
  });

  test('the options can only be names the validator will accept', () => {
    // Sourced from cfg/alarms, so A3 cannot reject what the dropdown offered.
    assert.match(byName('ZoneMasterBackEnd').func, /readDomain\("alarms"\)/);
    assert.match(
      fs.readFileSync(path.join(__dirname, '..', 'src', 'config-service', 'node-red', 'joint-master-handler.js'), 'utf8'),
      /function availableProfileNames/
    );
  });

  test('every zone reply carries the options, not just the load', () => {
    // The table re-renders from whatever the last message held, so omitting them
    // on one path empties the dropdowns the moment an operator saves a row.
    const fn = byName('ZoneMasterBackEnd').func;
    const returns = fn.match(/return \{payload:\{zones[^}]*\}/g) || [];
    assert.ok(returns.length >= 3, 'expected the save-error and save-success returns');
    for (const r of returns) assert.match(r, /profile_names/, r);
    assert.match(fn, /msg\.payload = \{ zones, profile_names \}/);
  });

  test('a new zone row starts on the panel-wide set', () => {
    assert.match(byName('ZoneMasterBackEnd').func, /threshold_profile:"default", editing:true/);
  });
});

describe('the config tables load themselves and keep their dropdown options (2026-09-12)', () => {
  // TWO live failures, one symptom: the joint table came up completely EMPTY.
  //
  // 1. storeOutMessages is false, so resendOnRefresh has nothing to replay, and
  //    the only other source is a ONCE inject that fires at deploy. Any page
  //    opened afterwards - a refresh, a restart, a re-import - creates the
  //    widget with an empty scope and nothing ever arrives. ModbusSettingsUI has
  //    carried a self-healing load for this since it was written; these two
  //    never got one.
  // 2. Their $watch REBUILDS scope.msg.payload field by field, so anything not
  //    named there is silently dropped - which is what happened to the
  //    profile_names the Alarm Profile dropdowns need. The dropdown then falls
  //    back to ['default'] and no other profile can ever be selected.
  const flows = JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'));
  const fmt = (name) => flows.find((n) => n.name === name).format;

  for (const name of ['JointMasterUI', 'ZoneMasterUI']) {
    test(`${name} asks for its own data rather than relying on the deploy inject`, () => {
      assert.match(fmt(name), /selfHealLoad/, 'without this the table is blank on any later page load');
      assert.match(fmt(name), /setTimeout\(selfHealLoad/);
    });

    test(`${name} carries profile_names through its $watch rebuild`, () => {
      assert.match(
        fmt(name),
        /profile_names: angular\.copy/,
        'dropped here, the Alarm Profile dropdown only ever offers default'
      );
    });

    test(`${name} still parses as JavaScript`, () => {
      // These templates are hand-edited JSON strings; a broken script fails
      // silently in the browser and the whole table simply never renders.
      const body = fmt(name).slice(fmt(name).indexOf('<script')).replace(/^<script>/, '').replace(/<\/script>\s*$/, '');
      assert.doesNotThrow(() => new (require('node:vm').Script)(`(function(scope,angular,alert,confirm){${body}})`));
    });
  }

  test('the joint table still renders one cell per header', () => {
    // The Actions column vanished once before, when a 9th column was added to a
    // table whose widths were a hand-maintained nth-child list.
    const t = fmt('JointMasterUI');
    assert.equal((t.match(/<th>/g) || []).length, (t.match(/<td>/g) || []).length);
  });
});
