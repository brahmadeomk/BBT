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
    assert.ok(cleanup.includes("readDomain('modbus_joints')"),
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
    for (const marker of ['No data received from', 'Slave ${b.slave_id} blacklisted', 'Raspberry Pi power fault']) {
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
