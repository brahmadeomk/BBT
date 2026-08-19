'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const wifi = require('../../src/network/wifi');

/** Stands in for child_process.execFile: records the call, replays a result. */
function fakeExecFile({ stdout = '', stderr = '', err = null } = {}) {
  const calls = [];
  const stdinWrites = [];
  const fn = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    setImmediate(() => cb(err, stdout, stderr));
    return { stdin: { end: (d) => stdinWrites.push(d), on: () => {} } };
  };
  fn.calls = calls;
  fn.stdinWrites = stdinWrites;
  return fn;
}

describe('wifi scan parsing', () => {
  test('parses nmcli terse output, strongest first, de-duplicated', () => {
    const out = [
      ' :PlantWiFi:62:WPA2',
      '*:Godrej-Ops:81:WPA2',
      ' :PlantWiFi:44:WPA2',      // same SSID, second AP
      ' :Guest:39:',              // open network
    ].join('\n');
    const nets = wifi.parseScan(out);
    assert.deepEqual(nets.map((n) => n.ssid), ['Godrej-Ops', 'PlantWiFi', 'Guest']);
    assert.equal(nets[0].inUse, true);
    assert.equal(nets[0].signal, 81);
    assert.equal(nets[2].open, true, 'empty SECURITY means open');
  });

  test('an SSID containing a colon does not shift the other columns', () => {
    // nmcli escapes a literal ':' as '\:'. Splitting naively would report this
    // network's signal as "B" and silently mis-parse everything after it.
    const nets = wifi.parseScan(' :Plant\\:B:73:WPA2');
    assert.equal(nets[0].ssid, 'Plant:B');
    assert.equal(nets[0].signal, 73);
    assert.equal(nets[0].security, 'WPA2');
  });

  test('skips hidden networks (no SSID) and blank lines', () => {
    assert.deepEqual(wifi.parseScan(' ::48:WPA2\n\n :Real:50:WPA2').map((n) => n.ssid), ['Real']);
  });
});

describe('wifi input validation', () => {
  test('rejects an SSID this panel cannot safely handle', () => {
    assert.equal(wifi.validateSsid('Plant-A'), null);
    assert.match(wifi.validateSsid(''), /Choose a network/);
    assert.match(wifi.validateSsid('x'.repeat(33)), /32-character/);
    assert.match(wifi.validateSsid('a/b'), /must not contain/);
    assert.match(wifi.validateSsid('café'), /cannot handle/);
  });

  test('enforces the WPA passphrase bounds', () => {
    assert.equal(wifi.validatePassphrase('goodpass1'), null);
    assert.match(wifi.validatePassphrase(''), /Enter the network password/);
    assert.match(wifi.validatePassphrase('short'), /8-63 characters/);
    assert.match(wifi.validatePassphrase('x'.repeat(64)), /8-63 characters/);
  });

  test('an open network wants no passphrase at all', () => {
    assert.equal(wifi.validatePassphrase('', true), null);
    assert.match(wifi.validatePassphrase('anything', true), /open - leave the password blank/);
  });
});

describe('wifi connect', () => {
  test('THE PASSPHRASE NEVER APPEARS IN ARGV - it goes to stdin', async () => {
    // /proc/<pid>/cmdline is world-readable. This is the whole reason the
    // helper exists in the shape it does; if this test ever fails, the panel is
    // leaking the site's Wi-Fi password to every local user.
    const execFile = fakeExecFile({ stdout: 'connected:Plant-A\n' });
    const r = await wifi.connect({ execFile }, 'Plant-A', 'sup3rsecret!');
    assert.deepEqual(r, { connected: 'Plant-A' });

    const argv = JSON.stringify(execFile.calls[0]);
    assert.ok(!argv.includes('sup3rsecret!'), `passphrase leaked into argv: ${argv}`);
    assert.deepEqual(execFile.calls[0].args, [wifi.HELPER, 'connect', 'Plant-A']);
    assert.deepEqual(execFile.stdinWrites, ['sup3rsecret!\n']);
  });

  test('validates before shelling out at all', async () => {
    const execFile = fakeExecFile();
    const r = await wifi.connect({ execFile }, 'Plant-A', 'short');
    assert.match(r.error, /8-63 characters/);
    assert.equal(execFile.calls.length, 0, 'nothing should have been executed');
  });

  test('an open network sends an empty passphrase', async () => {
    const execFile = fakeExecFile({ stdout: 'connected:Guest\n' });
    await wifi.connect({ execFile }, 'Guest', '', { open: true });
    assert.deepEqual(execFile.stdinWrites, ['\n']);
  });

  test('a failed join tells the operator the panel is back on its old network', async () => {
    const execFile = fakeExecFile({ err: Object.assign(new Error('exit 1'), { code: 1 }), stderr: 'failed:Plant-A:reverted to Godrej-Ops' });
    const r = await wifi.connect({ execFile }, 'Plant-A', 'wrongpass1');
    assert.match(r.error, /check the password/);
    assert.match(r.error, /back on its previous network/);
    assert.ok(!r.error.includes('wrongpass1'), 'never echo the passphrase back');
  });

  test('names the real problem when the helper is not installed', async () => {
    const execFile = fakeExecFile({ err: new Error('x'), stderr: 'sudo: busduct-wifi: command not found' });
    const r = await wifi.scan({ execFile });
    assert.match(r.error, /helper is not installed/);
  });

  test('names the real problem when sudoers is missing the rule', async () => {
    const execFile = fakeExecFile({ err: new Error('x'), stderr: 'sudo: a password is required' });
    const r = await wifi.scan({ execFile });
    assert.match(r.error, /not permitted to run without a password/);
  });
});

describe('wifi status', () => {
  test('lists the active connections', async () => {
    const execFile = fakeExecFile({ stdout: 'busduct-wifi:wlan0:802-11-wireless:activated\nWired:eth0:802-3-ethernet:activated\n' });
    const r = await wifi.status({ execFile });
    assert.deepEqual(r.active.map((a) => a.device), ['wlan0', 'eth0']);
    assert.equal(r.active[0].state, 'activated');
  });
});
