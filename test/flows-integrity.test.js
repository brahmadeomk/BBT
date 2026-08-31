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
