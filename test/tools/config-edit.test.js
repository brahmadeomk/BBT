'use strict';

/**
 * The CLI is a testing aid, but it WRITES THE APPLIED CONFIGURATION of a real
 * panel, so the properties that make it safe are worth pinning:
 *
 *  - it never writes except through ConfigStore.applyIfValid (so R1-R17 hold);
 *  - --dry-run really does not write;
 *  - the three-state threshold_profile distinction survives a round trip, which
 *    is exactly what a previous UI-side bug got wrong (empty stored as
 *    'default' silently disabled every zone binding);
 *  - the resend notice tracks the COMPILED job, not "something changed" - a
 *    label edit must not tell the operator to resend, because a resend re-inits
 *    the Modbus timeout and disrupts live polling.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ConfigStore } = require('../../src/config-service/store');
const { validateModbusJoints } = require('../../src/config-service/validate-modbus-joints');
const { validateAlarms } = require('../../src/config-service/validate-alarms');
const { main } = require('../../tools/config-edit');

const SLAVE = (id, unit, channels = 1, extra = {}) => ({
  slave_id: id, bus_id: 'bus1', unit_address: unit, model: 'LEGACY',
  channels, poll_interval_s: 30,
  registers: { function_code: 3, temp_base_addr: 3, temp_word_count: 1, temp_scale: 0.1, ...extra },
});

function panel() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-cli-'));
  const store = new ConfigStore({ root, validators: { modbus_joints: validateModbusJoints, alarms: validateAlarms } });
  assert.ok(store.applyIfValid('modbus_joints', {
    config_domain_versions: { modbus: 1, joints: 1 },
    modbus: {
      buses: [{ bus_id: 'bus1', type: 'rtu', port: '/dev/busduct-bus1', baud: 9600, parity: 'N', stop_bits: 2, timeout_ms: 1000, retries: 2, inter_frame_ms: 20 }],
      slaves: [SLAVE('sl01', 1), SLAVE('sl02', 2), SLAVE('sl21', 101)],
      ambient_sensor: { slave_id: 'sl21', channel: 1 },
    },
    joints: [
      { joint_id: 'J01', slave_id: 'sl01', channel: 1, zone_id: 'z1', enabled: true },
      { joint_id: 'J02', slave_id: 'sl02', channel: 1, zone_id: 'z1', enabled: true },
    ],
    zones: [{ zone_id: 'z1', name: 'Riser' }],
  }).applied);
  assert.ok(store.applyIfValid('alarms', {
    config_domain_versions: { alarms: 1 },
    profiles: { default: { deltaT: { watch: 15, warning: 25, critical: 35 }, ror: { watch: 15, warning: 30, critical: 60, timeWindowMin: 20 }, persistence: { watchMin: 30, warningMin: 15, criticalMin: 5 } } },
  }).applied);
  return { root, store };
}

/** Runs the CLI with stdout/stderr captured, so a failing case does not spam the test log. */
function run(root, ...argv) {
  const out = [];
  const log = console.log, err = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  try {
    return { code: main([...argv, `--root=${root}`]), out: out.join('\n') };
  } finally {
    console.log = log; console.error = err;
  }
}

const applied = (store) => store.readDomain('modbus_joints').doc;

describe('config-edit CLI', () => {
  test('a rejected change writes nothing and reports the rule id', () => {
    const { root, store } = panel();
    const before = applied(store);
    const r = run(root, 'joint', 'set', 'J02', '--slave=sl01', '--channel=1');
    assert.equal(r.code, 1);
    assert.match(r.out, /R7:/);
    assert.deepEqual(applied(store), before, 'the store must be untouched');
  });

  test('--dry-run validates without writing', () => {
    const { root, store } = panel();
    const r = run(root, 'bus', 'set', 'bus1', '--inter-frame=250', '--dry-run');
    assert.equal(r.code, 0);
    assert.match(r.out, /WOULD APPLY/);
    assert.equal(applied(store).modbus.buses[0].inter_frame_ms, 20);
    assert.equal(applied(store).config_domain_versions.modbus, 1, 'a dry run must not bump the version either');
  });

  test('both domain versions bump on a real apply (R11)', () => {
    const { root, store } = panel();
    assert.equal(run(root, 'zone', 'set', 'z1', '--name=Renamed').code, 0);
    assert.deepEqual(applied(store).config_domain_versions, { modbus: 2, joints: 2 });
  });

  describe('threshold_profile keeps its three states', () => {
    test('no flag at all leaves the joint inheriting', () => {
      const { root, store } = panel();
      run(root, 'joint', 'set', 'J01', '--label=Riser A');
      assert.equal('threshold_profile' in applied(store).joints[0], false);
    });

    test("--profile=- clears it back to inherit", () => {
      const { root, store } = panel();
      run(root, 'joint', 'set', 'J01', '--profile=default');
      assert.equal(applied(store).joints[0].threshold_profile, 'default');
      run(root, 'joint', 'set', 'J01', '--profile=-');
      assert.equal('threshold_profile' in applied(store).joints[0], false);
    });

    test('a zone profile reaches the joint that inherits, and not the one that pins', () => {
      const { root } = panel();
      assert.equal(run(root, 'profile', 'set', 'hot_riser', '--dt=8,12,18').code, 0);
      assert.equal(run(root, 'zone', 'set', 'z1', '--profile=hot_riser').code, 0);
      assert.equal(run(root, 'joint', 'set', 'J02', '--profile=default').code, 0);
      const shown = run(root, 'show').out;
      assert.match(shown, /J01\s+sl01\s+1\s+z1\s+\(inherit\)\s+hot_riser/);
      assert.match(shown, /J02\s+sl02\s+1\s+z1\s+default\s+default/);
    });
  });

  describe('the resend notice follows the compiled job', () => {
    test('a label edit does not ask for a resend', () => {
      const { root } = panel();
      const r = run(root, 'slave', 'set', 'sl01', '--label=Sensor1');
      assert.equal(r.code, 0);
      assert.match(r.out, /Nano job is unchanged/);
    });

    test('a bus timing change does', () => {
      const { root } = panel();
      const r = run(root, 'bus', 'set', 'bus1', '--inter-frame=250');
      assert.match(r.out, /Nano job CHANGED on bus1/);
    });

    test('so does adding a slave', () => {
      const { root, store } = panel();
      const r = run(root, 'slave', 'add', '--unit=7');
      assert.equal(r.code, 0);
      assert.match(r.out, /Nano job CHANGED/);
      assert.ok(applied(store).modbus.slaves.some((s) => s.unit_address === 7));
    });
  });

  describe('deletes refuse by name rather than by rule id', () => {
    test('a slave still mapped to a joint', () => {
      const { root, store } = panel();
      const r = run(root, 'slave', 'del', 'sl01');
      assert.equal(r.code, 2);
      assert.match(r.out, /still mapped to joint\(s\) J01/);
      assert.equal(applied(store).modbus.slaves.length, 3);
    });

    test('the panel ambient reference', () => {
      const { root } = panel();
      const r = run(root, 'slave', 'del', 'unit:101');
      assert.equal(r.code, 2);
      assert.match(r.out, /ambient reference for the panel default/);
    });

    test('a profile a zone still uses', () => {
      const { root, store } = panel();
      run(root, 'profile', 'set', 'hot_riser', '--dt=8,12,18');
      run(root, 'zone', 'set', 'z1', '--profile=hot_riser');
      const r = run(root, 'profile', 'del', 'hot_riser');
      assert.equal(r.code, 1);
      assert.match(r.out, /still used by zone 'z1'/);
      assert.ok(store.readDomain('alarms').doc.profiles.hot_riser);
    });
  });

  test('export/import round-trips, and import rewrites the versions R11 would reject', () => {
    const { root, store } = panel();
    const file = path.join(root, 'dump.json');
    assert.equal(run(root, 'export', file).code, 0);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(doc.config_domain_versions.modbus, 1);
    doc.zones[0].name = 'Edited By Hand';
    fs.writeFileSync(file, JSON.stringify(doc));
    // Re-imported verbatim, the carried v1 would fail R11 (must exceed applied).
    assert.equal(run(root, 'import', file).code, 0);
    assert.equal(applied(store).zones[0].name, 'Edited By Hand');
    assert.equal(applied(store).config_domain_versions.modbus, 2);
  });

  test('a unit address resolves as sl06, unit:6 or 6', () => {
    const { root } = panel();
    for (const ref of ['sl02', 'unit:2', '2']) {
      assert.equal(run(root, 'slave', 'set', ref, `--label=via-${ref.replace(':', '')}`).code, 0, ref);
    }
  });

  test('an unknown reference names what is available instead of throwing', () => {
    const { root } = panel();
    const r = run(root, 'joint', 'set', 'J99', '--zone=z1');
    assert.equal(r.code, 2);
    assert.match(r.out, /no joint 'J99' - known: J01, J02/);
  });
});
