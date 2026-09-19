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

describe('the Wi-Fi screen cannot scan itself in a loop (2026-09-19)', () => {
  // Live report: the network dropdown refreshed constantly and the selection
  // changed while the operator was typing the password.
  //
  // WifiUI had fwdInMessages ("Pass through messages from input to output") ON,
  // and its output wires to the backend that feeds it. So the backend's
  // {networks} reply was echoed straight back to the backend, which saw no
  // action, fell through to its default - a scan - and replied again. An
  // unbounded loop running nmcli as fast as it completed, from boot onwards,
  // which also disturbs the very association it is reporting on.
  const fs = require('node:fs');
  const path = require('node:path');
  const flows = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'flows', 'flows_BBT.json'), 'utf8'));
  const node = (id) => {
    const n = flows().find((x) => x.id === id);
    assert.ok(n, `node ${id} must exist`);
    return n;
  };
  const UI = 'n3701c0000000002';
  const BACKEND = 'n3701c0000000003';
  const BOOT = 'n3701c0000000004';

  test('the template does NOT pass its input through to its output', () => {
    // This is the fix. It must stay off for any template wired back to the node
    // that feeds it, or the echo loop returns.
    assert.equal(node(UI).fwdInMessages, false);
  });

  test('the loop it would close is still present, so the flag is what prevents it', () => {
    // If the wiring is ever changed so the two no longer point at each other,
    // this test should be re-read rather than deleted - it documents WHY the
    // flag matters here specifically.
    assert.ok(node(UI).wires.flat().includes(BACKEND), 'template feeds the backend');
    assert.ok(node(BACKEND).wires.flat().includes(UI), 'backend feeds the template');
  });

  test('the backend acts only on an action it recognises', () => {
    // Defence in depth: "no action" used to fall through to a scan, which is
    // what turned an accidental echo into a scan storm rather than a no-op.
    const fn = node(BACKEND).func;
    assert.ok(/if \(action !== 'scan'\)/.test(fn), 'unknown actions are rejected');
    assert.ok(fn.indexOf("if (action !== 'scan')") < fn.indexOf('svc.wifi.scan()'),
      'the guard comes BEFORE the scan, or it guards nothing');
  });

  test('the boot inject names its action instead of relying on a fallthrough', () => {
    const b = node(BOOT);
    assert.equal(b.payloadType, 'json');
    assert.deepEqual(JSON.parse(b.payload), { action: 'scan' });
    assert.equal(b.repeat, '', 'boot only - a repeat here would be a slow version of the same bug');
  });

  test('a refresh keeps the operator\'s selection', () => {
    const t = node(UI).format;
    assert.ok(/const keep = scope\.sel && p\.networks\.find/.test(t),
      'the rebuild must look for the current choice before replacing it');
    assert.ok(/no longer in range/.test(t),
      'and say so when the chosen network has genuinely gone');
  });
});
