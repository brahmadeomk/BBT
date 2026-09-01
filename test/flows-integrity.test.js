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

  test('the tile lives in its own dashboard group, not crowded into the blacklist table', () => {
    const group = byId('d9b1ac57e0f10060');
    assert.equal(group.type, 'ui_group');
    assert.equal(group.tab, 'd9b1ac57e0f10020', 'on the Device Health tab');
    const tile = byId('d9b1ac57e0f10061');
    assert.equal(tile.group, 'd9b1ac57e0f10060');
  });

  test('the tile renders SSID and signal, and degrades before the first sample', () => {
    const fmt = byId('d9b1ac57e0f10061').format;
    assert.match(fmt, /s\.uplink\.label/);
    assert.match(fmt, /s\.uplink\.detail/);
    assert.match(fmt, /not sampled yet/, 'must not render blank on a cold start');
    for (const f of ['s.cpu_temp', 's.ram', 's.disk', 's.uptime', 's.load', 's.warnings']) {
      assert.ok(fmt.includes(f), `${f} must be shown`);
    }
  });
});
