'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { CertRotator } = require('../../src/cloud-gateway/cert-rotation');

const CERT = '-----BEGIN CERTIFICATE-----\nMIIBnew==\n-----END CERTIFICATE-----\n';
const KEY = '-----BEGIN PRIVATE KEY-----\nMIIEnew==\n-----END PRIVATE KEY-----\n';
const CA = '-----BEGIN CERTIFICATE-----\nMIIBrootCA==\n-----END CERTIFICATE-----\n';

const P = { certPath: '/etc/certs/device.crt', keyPath: '/etc/certs/private.key', caPath: '/etc/certs/ca.pem' };

/** In-memory fs stand-in with just what CertRotator uses. */
function memFs(initial = {}) {
  const files = new Map(Object.entries(initial).map(([k, v]) => [k, Buffer.from(v)]));
  const chmods = [];
  return {
    files,
    chmods,
    readFileSync(p) {
      if (!files.has(p)) {
        const e = new Error(`ENOENT: ${p}`);
        e.code = 'ENOENT';
        throw e;
      }
      return files.get(p);
    },
    writeFileSync(p, data, opts) {
      files.set(p, Buffer.isBuffer(data) ? data : Buffer.from(data));
      if (opts && opts.mode !== undefined) chmods.push({ p, mode: opts.mode, via: 'write' });
    },
    renameSync(a, b) {
      files.set(b, files.get(a));
      files.delete(a);
    },
    chmodSync(p, mode) {
      chmods.push({ p, mode, via: 'chmod' });
    },
    text(p) {
      return files.has(p) ? files.get(p).toString() : undefined;
    },
  };
}

/** reconnectAndVerify stub returning a queued sequence of booleans. */
function verifier(results) {
  const calls = [];
  const fn = async (timeout) => {
    calls.push(timeout);
    return results[Math.min(calls.length - 1, results.length - 1)];
  };
  fn.calls = calls;
  return fn;
}

describe('CertRotator.validate', () => {
  test('accepts a well-formed cert + key (and optional CA)', () => {
    const r = new CertRotator({ ...P, reconnectAndVerify: verifier([true]) });
    assert.deepEqual(r.validate({ certificate: CERT, private_key: KEY }), []);
    assert.deepEqual(r.validate({ certificate: CERT, private_key: KEY, ca: CA }), []);
  });

  test('rejects missing/garbage PEM and a non-object payload', () => {
    const r = new CertRotator({ ...P, reconnectAndVerify: verifier([true]) });
    assert.match(r.validate({ certificate: 'nope', private_key: KEY })[0], /certificate must be a PEM/);
    assert.match(r.validate({ certificate: CERT, private_key: 'nope' })[0], /private_key must be a PEM/);
    assert.match(r.validate({ certificate: CERT, private_key: KEY, ca: 'nope' })[0], /ca, if provided/);
    assert.deepEqual(r.validate(null), ['payload must be a JSON object']);
  });
});

describe('CertRotator.rotate', () => {
  test('happy path: backs up old, writes new atomically, commits when the new cert connects', async () => {
    const fs = memFs({ [P.certPath]: 'OLDCERT', [P.keyPath]: 'OLDKEY' });
    const verify = verifier([true]);
    const r = new CertRotator({ ...P, fs, reconnectAndVerify: verify, verifyTimeoutSec: 30 });

    const out = await r.rotate({ certificate: CERT, private_key: KEY, certificate_id: 'abc123' });

    assert.deepEqual(out, { ok: true, rolledBack: false, certificate_id: 'abc123' });
    assert.equal(fs.text(P.certPath), CERT, 'new cert is live');
    assert.equal(fs.text(P.keyPath), KEY, 'new key is live');
    assert.equal(fs.text(`${P.certPath}.bak`), 'OLDCERT', 'old cert backed up');
    assert.equal(fs.text(`${P.keyPath}.bak`), 'OLDKEY', 'old key backed up');
    assert.deepEqual(verify.calls, [30], 'verified once with the configured timeout');
    // private key written 0600 (mode passed to write and re-chmod'd)
    assert.ok(fs.chmods.some((c) => c.p === P.keyPath && c.mode === 0o600));
  });

  test('rollback: restores the previous cert and reconnects on it when the new cert fails', async () => {
    const fs = memFs({ [P.certPath]: 'OLDCERT', [P.keyPath]: 'OLDKEY' });
    const verify = verifier([false, true]); // new fails, old reconnects
    const r = new CertRotator({ ...P, fs, reconnectAndVerify: verify, verifyTimeoutSec: 10 });

    const out = await r.rotate({ certificate: CERT, private_key: KEY });

    assert.equal(out.ok, false);
    assert.equal(out.rolledBack, true);
    assert.equal(out.reconnectedOnOld, true);
    assert.match(out.error, /failed to connect within 10s - rolled back/);
    assert.equal(fs.text(P.certPath), 'OLDCERT', 'live cert restored to the old one');
    assert.equal(fs.text(P.keyPath), 'OLDKEY', 'live key restored to the old one');
    assert.deepEqual(verify.calls, [10, 10], 'verified new, then verified old after restore');
  });

  test('optional CA is rotated and rolled back together with the cert/key', async () => {
    const fs = memFs({ [P.certPath]: 'OLDCERT', [P.keyPath]: 'OLDKEY', [P.caPath]: 'OLDCA' });
    const r = new CertRotator({ ...P, fs, reconnectAndVerify: verifier([false, true]) });
    await r.rotate({ certificate: CERT, private_key: KEY, ca: CA });
    assert.equal(fs.text(P.caPath), 'OLDCA', 'CA restored on rollback');
    assert.equal(fs.text(`${P.caPath}.bak`), 'OLDCA', 'CA backed up');
  });

  test('a CA is left untouched when the rotation does not carry one', async () => {
    const fs = memFs({ [P.certPath]: 'OLDCERT', [P.keyPath]: 'OLDKEY', [P.caPath]: 'OLDCA' });
    const r = new CertRotator({ ...P, fs, reconnectAndVerify: verifier([true]) });
    await r.rotate({ certificate: CERT, private_key: KEY });
    assert.equal(fs.text(P.caPath), 'OLDCA', 'CA unchanged');
    assert.equal(fs.text(`${P.caPath}.bak`), undefined, 'no CA backup written');
  });

  test('no filesystem changes and no reconnect when the PEM is invalid', async () => {
    const fs = memFs({ [P.certPath]: 'OLDCERT', [P.keyPath]: 'OLDKEY' });
    const verify = verifier([true]);
    const r = new CertRotator({ ...P, fs, reconnectAndVerify: verify });
    const out = await r.rotate({ certificate: 'garbage', private_key: KEY });
    assert.equal(out.ok, false);
    assert.equal(out.rolledBack, false);
    assert.equal(fs.text(P.certPath), 'OLDCERT', 'live cert untouched');
    assert.equal(verify.calls.length, 0, 'never attempted a reconnect');
  });

  test('fresh panel (no existing cert): a failed new cert cannot roll back', async () => {
    const fs = memFs({}); // nothing on disk yet
    const r = new CertRotator({ ...P, fs, reconnectAndVerify: verifier([false]) });
    const out = await r.rotate({ certificate: CERT, private_key: KEY });
    assert.equal(out.ok, false);
    assert.equal(out.rolledBack, false);
    assert.match(out.error, /no previous certificate to roll back to/);
  });

  test('rejects a second rotation while one is in progress', async () => {
    const fs = memFs({ [P.certPath]: 'OLDCERT', [P.keyPath]: 'OLDKEY' });
    let release;
    const gate = new Promise((r) => (release = r));
    const r = new CertRotator({ ...P, fs, reconnectAndVerify: () => gate.then(() => true) });
    const first = r.rotate({ certificate: CERT, private_key: KEY });
    const second = await r.rotate({ certificate: CERT, private_key: KEY });
    assert.equal(second.ok, false);
    assert.match(second.error, /already in progress/);
    release();
    assert.equal((await first).ok, true);
  });
});
