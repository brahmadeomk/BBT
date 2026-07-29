'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'tools', 'apply-integration-config.js');
const BOOTSTRAP = path.join(__dirname, '..', '..', 'tools', 'apply-migrated-config.js');

function tmpRoot({ commissioned = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-apply-integration-test-'));
  if (commissioned) execFileSync('node', [BOOTSTRAP, `--root=${root}`]);
  return root;
}

// Warnings go to stderr (console.warn) and results to stdout, so assertions
// need both streams; throws on a non-zero exit like execFileSync would.
function run(root, ...args) {
  const r = spawnSync('node', [SCRIPT, `--root=${root}`, ...args], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0) {
    const e = new Error(`exit ${r.status}`);
    e.stderr = r.stderr;
    e.output = out;
    throw e;
  }
  return out;
}
const applied = (root) => JSON.parse(fs.readFileSync(path.join(root, 'integration.json'), 'utf8'));

describe('apply-integration-config.js', () => {
  test('applies the shipped example against a commissioned panel', () => {
    const root = tmpRoot();
    const out = run(root);
    assert.match(out, /Applied cfg\/integration v1/);
    assert.match(out, /Registers\s+: \d+/);
    assert.equal(applied(root).exposure_tier, 3);
  });

  test('--show reports nothing applied without changing anything', () => {
    const root = tmpRoot();
    const out = run(root, '--show');
    assert.match(out, /No cfg\/integration applied/);
    assert.ok(!fs.existsSync(path.join(root, 'integration.json')));
  });

  test('re-running auto-bumps the domain version (I4 monotonicity is not the user\'s problem)', () => {
    const root = tmpRoot();
    run(root);
    run(root);
    const out = run(root);
    assert.match(out, /Applied cfg\/integration v3/);
  });

  test('flag-only runs edit the applied doc in place rather than reverting to the example', () => {
    const root = tmpRoot();
    run(root, '--tier=1');
    run(root, '--port=1600');
    const doc = applied(root);
    assert.equal(doc.exposure_tier, 1, 'earlier tier override survives a later port-only edit');
    assert.equal(doc.modbus_tcp.port, 1600);
  });

  test('a privileged port applies but warns (I2)', () => {
    const root = tmpRoot();
    const out = run(root, '--port=502');
    assert.match(out, /WARNING I2/);
    assert.match(out, /Applied cfg\/integration/);
  });

  test('--disable turns the listener off without discarding the rest of the config', () => {
    const root = tmpRoot();
    run(root, '--tier=2');
    const out = run(root, '--disable');
    assert.match(out, /DISABLED/);
    const doc = applied(root);
    assert.equal(doc.modbus_tcp.enabled, false);
    assert.equal(doc.exposure_tier, 2);
  });

  test('point_map_version can never regress (the register map is append-only)', () => {
    const root = tmpRoot();
    run(root);
    // hand-edit the applied doc up to v5, then re-apply a file still carrying v1
    const doc = applied(root);
    doc.point_map_version = 5;
    doc.config_domain_versions.integration += 1;
    fs.writeFileSync(path.join(root, 'integration.json'), JSON.stringify(doc));
    const stale = path.join(root, 'stale.json');
    fs.writeFileSync(stale, JSON.stringify({ ...doc, point_map_version: 1 }));
    const out = run(root, stale);
    assert.match(out, /append-only/);
    assert.equal(applied(root).point_map_version, 5, 'raised back to the applied value, never lowered');
  });

  test('refuses to run on an uncommissioned panel (no cfg/modbus+joints)', () => {
    const root = tmpRoot({ commissioned: false });
    assert.throws(
      () => run(root),
      (e) => /No cfg\/modbus\+joints applied/.test(String(e.stderr)),
      'must point the user at the commissioning step'
    );
  });

  test('an invalid document is rejected with the rule id, and nothing is applied', () => {
    const root = tmpRoot();
    const bad = path.join(root, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ config_domain_versions: { integration: 1 }, exposure_tier: 9, point_map_version: 1, modbus_tcp: { enabled: true, port: 1502, unit_id: 1 } }));
    assert.throws(
      () => run(root, bad),
      (e) => /REJECTED/.test(String(e.stderr)),
    );
    assert.ok(!fs.existsSync(path.join(root, 'integration.json')));
  });
});
