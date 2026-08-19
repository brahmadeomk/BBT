'use strict';

/**
 * Wi-Fi selection for the panel's touchscreen, over the narrow root helper
 * `deploy/bin/busduct-wifi` (scan / status / connect only — see that script for
 * why it is not plain `sudo nmcli`).
 *
 * Everything that can be pure is pure and unit-tested; the two functions that
 * shell out take an injected `execFile`, the same dependency-injection pattern
 * the cloud transport, the Modbus server factory and pi-health already use.
 *
 * THE PASSPHRASE NEVER ENTERS AN ARGUMENT VECTOR. `/proc/<pid>/cmdline` is
 * world-readable, so passing it as an argument would leak it to any local user
 * for the life of the process. It is written to the child's stdin instead, and
 * this module never returns it, logs it, or puts it in a message.
 */

const HELPER = '/usr/local/sbin/busduct-wifi';

/** WPA-PSK: 8..63 printable ASCII (the standard's own bound). */
const PSK_MIN = 8;
const PSK_MAX = 63;

/**
 * Parses `nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list`.
 *
 * nmcli's terse output escapes a literal ':' inside a field as '\:', so the
 * fields cannot simply be split on ':' — an SSID containing a colon would
 * shift every later column. Splitting on unescaped separators only is what
 * makes an SSID like "Plant:B" parse correctly instead of silently reporting
 * the wrong signal strength.
 */
function parseScan(stdout) {
  const nets = [];
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim()) continue;
    const fields = splitTerse(line);
    if (fields.length < 4) continue;
    const [inUse, ssid, signal, security] = fields;
    if (!ssid) continue;                       // hidden network - nothing to show
    nets.push({
      ssid,
      signal: Number.isFinite(Number(signal)) ? Number(signal) : null,
      security: security && security !== '--' ? security : '',
      open: !security || security === '--',
      inUse: inUse === '*',
    });
  }
  // Strongest first, and de-duplicate the same SSID seen on several APs/bands.
  nets.sort((a, b) => (b.signal ?? -1) - (a.signal ?? -1));
  const seen = new Set();
  return nets.filter((n) => (seen.has(n.ssid) ? false : (seen.add(n.ssid), true)));
}

/** Splits an nmcli terse line on ':' separators that are not backslash-escaped. */
function splitTerse(line) {
  const out = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) { cur += line[i + 1]; i++; continue; }
    if (c === ':') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** @returns {string|null} an error message, or null when acceptable. */
function validateSsid(ssid) {
  const s = String(ssid ?? '');
  if (!s) return 'Choose a network';
  if (s.length > 32) return 'SSID is longer than the 32-character maximum';
  if (/[^ -~]/.test(s)) return 'SSID contains characters this panel cannot handle';
  if (s.includes('/')) return "SSID must not contain '/'";
  return null;
}

/**
 * @param {string} psk
 * @param {boolean} open - true for an open network, where a passphrase is wrong
 * @returns {string|null}
 */
function validatePassphrase(psk, open = false) {
  const p = String(psk ?? '');
  if (open) return p ? 'This network is open - leave the password blank' : null;
  if (!p) return 'Enter the network password';
  if (p.length < PSK_MIN || p.length > PSK_MAX) return `Password must be ${PSK_MIN}-${PSK_MAX} characters`;
  if (/[^ -~]/.test(p)) return 'Password contains characters this panel cannot handle';
  return null;
}

function run(execFile, args, { input, timeoutMs = 45000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile('sudo', [HELPER, ...args], { timeout: timeoutMs, encoding: 'utf8' },
        (err, stdout, stderr) => resolve({
          ok: !err,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        }));
    } catch (e) {
      resolve({ ok: false, stdout: '', stderr: e.message, code: 1 });
      return;
    }
    if (input != null && child && child.stdin) {
      child.stdin.on('error', () => { /* child died first; the callback reports it */ });
      child.stdin.end(`${input}\n`);
    }
  });
}

/** @returns {Promise<{networks: Array}|{error: string}>} */
async function scan({ execFile }) {
  const r = await run(execFile, ['scan'], { timeoutMs: 20000 });
  if (!r.ok) return { error: friendly(r, 'Could not scan for networks') };
  return { networks: parseScan(r.stdout) };
}

/** @returns {Promise<{connected: string}|{error: string}>} */
async function connect({ execFile }, ssid, passphrase, { open = false } = {}) {
  const bad = validateSsid(ssid) || validatePassphrase(passphrase, open);
  if (bad) return { error: bad };

  // stdin, never argv - see the file header.
  const r = await run(execFile, ['connect', String(ssid)], { input: open ? '' : String(passphrase) });
  if (r.ok) return { connected: String(ssid) };

  // The helper reverts to the previous network on failure and says so; surface
  // that, because "wrong password" and "wrong password, and you are back on the
  // old network" are very different things to an operator at the panel.
  const detail = r.stderr.includes('reverted to')
    ? ' The panel is back on its previous network.'
    : '';
  return { error: `Could not join "${ssid}" - check the password.${detail}` };
}

/** @returns {Promise<{active: Array}|{error: string}>} */
async function status({ execFile }) {
  const r = await run(execFile, ['status'], { timeoutMs: 10000 });
  if (!r.ok) return { error: friendly(r, 'Could not read the network status') };
  const active = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [name, device, type, state] = splitTerse(line);
    active.push({ name, device, type, state });
  }
  return { active };
}

function friendly(r, fallback) {
  if (/command not found|No such file/i.test(r.stderr)) {
    return 'The Wi-Fi helper is not installed on this panel (see docs/security-hardening.md §2b).';
  }
  if (/sudo|password is required|not allowed/i.test(r.stderr)) {
    return 'The Wi-Fi helper is not permitted to run without a password (sudoers rule missing).';
  }
  return `${fallback}: ${r.stderr.trim().split('\n')[0] || `exit ${r.code}`}`;
}

module.exports = {
  scan, connect, status,
  parseScan, splitTerse, validateSsid, validatePassphrase,
  HELPER, PSK_MIN, PSK_MAX,
};
