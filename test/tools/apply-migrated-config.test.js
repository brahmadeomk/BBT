'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'tools', 'apply-migrated-config.js');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-apply-migrated-test-'));
}

describe('apply-migrated-config.js', () => {
  test('applies the committed migrated config to a fresh store', () => {
    const root = tmpRoot();
    const output = execFileSync('node', [SCRIPT, `--root=${root}`], { encoding: 'utf8' });
    assert.match(output, /cfg\/modbus\+joints applied/);
    assert.match(output, /cfg\/alarms applied/);
    assert.ok(fs.existsSync(path.join(root, 'modbus_joints.json')));
    assert.ok(fs.existsSync(path.join(root, 'alarms.json')));
  });

  test('refuses to overwrite an already-bootstrapped store', () => {
    const root = tmpRoot();
    execFileSync('node', [SCRIPT, `--root=${root}`]);
    assert.throws(() => execFileSync('node', [SCRIPT, `--root=${root}`], { stdio: 'pipe' }));
  });
});
