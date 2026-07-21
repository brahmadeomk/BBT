'use strict';

const nodeFs = require('node:fs');

/**
 * Certificate rotation orchestration (Edge Cloud Readiness Workplan
 * Phase 1: "the device must accept a new certificate pushed via the
 * config/OTA channel and switch atomically with rollback").
 *
 * Deliberately cloud-AGNOSTIC and transport-agnostic: it does the
 * filesystem mechanics (validate PEM, back up the current material,
 * write the new material atomically) and the commit/rollback decision,
 * but the actual "switch the live connection and tell me if the new
 * cert works" step is an injected callback (`reconnectAndVerify`). On
 * the real panel that callback is AwsIotTransport.reloadCredentials;
 * in tests it's a stub. So this module stays outside src/adapters/aws
 * and works against any X.509-mutual-auth broker (Slice 8 portability
 * drill) without change.
 *
 * Rotation is all-or-nothing:
 *   1. validate the incoming PEM (no filesystem change if it's junk);
 *   2. snapshot + back up the current cert/key(/ca);
 *   3. atomically write the new material to the live paths (tmp+rename);
 *   4. reconnectAndVerify() - does the broker accept the new cert?
 *   5a. yes  -> commit (leave the new files in place);
 *   5b. no   -> restore the snapshot and reconnectAndVerify() again, so
 *               a bad/expired/misissued cert can never strand the panel
 *               offline.
 */

const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;
const PEM_KEY = /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC )?PRIVATE KEY-----/;

class CertRotator {
  /**
   * @param {object} opts
   * @param {string} opts.certPath - live device certificate path
   * @param {string} opts.keyPath  - live private key path
   * @param {string} opts.caPath   - live root CA path (only touched if a rotation carries `ca`)
   * @param {(verifyTimeoutSec: number) => Promise<boolean>} opts.reconnectAndVerify
   * @param {number} [opts.verifyTimeoutSec=60]
   * @param {object} [opts.fs] - injectable fs (tests); defaults to node:fs
   * @param {number} [opts.keyMode=0o600] - private-key file permissions
   */
  constructor({ certPath, keyPath, caPath, reconnectAndVerify, verifyTimeoutSec = 60, fs = nodeFs, keyMode = 0o600 }) {
    this.certPath = certPath;
    this.keyPath = keyPath;
    this.caPath = caPath;
    this.reconnectAndVerify = reconnectAndVerify;
    this.verifyTimeoutSec = verifyTimeoutSec;
    this.fs = fs;
    this.keyMode = keyMode;
    this._busy = false;
  }

  /** Structural PEM checks; returns an array of human-readable errors (empty = valid). */
  validate(msg) {
    if (!msg || typeof msg !== 'object') return ['payload must be a JSON object'];
    const errors = [];
    if (typeof msg.certificate !== 'string' || !PEM_CERT.test(msg.certificate)) {
      errors.push('certificate must be a PEM certificate');
    }
    if (typeof msg.private_key !== 'string' || !PEM_KEY.test(msg.private_key)) {
      errors.push('private_key must be a PEM private key');
    }
    if (msg.ca !== undefined && (typeof msg.ca !== 'string' || !PEM_CERT.test(msg.ca))) {
      errors.push('ca, if provided, must be a PEM certificate');
    }
    return errors;
  }

  /**
   * @param {{certificate: string, private_key: string, ca?: string, certificate_id?: string}} msg
   * @returns {Promise<{ok: boolean, rolledBack: boolean, reconnectedOnOld?: boolean, certificate_id?: string|null, error?: string}>}
   */
  async rotate(msg) {
    if (this._busy) {
      return { ok: false, rolledBack: false, error: 'a certificate rotation is already in progress' };
    }
    const errors = this.validate(msg);
    if (errors.length) {
      return { ok: false, rolledBack: false, error: errors.join('; ') };
    }

    this._busy = true;
    try {
      const rotateCa = msg.ca !== undefined;
      // Snapshot the current material for rollback (null if the panel has
      // no cert yet - e.g. a rotation racing a fresh provision).
      const snap = {
        cert: this._readIfExists(this.certPath),
        key: this._readIfExists(this.keyPath),
        ca: rotateCa ? this._readIfExists(this.caPath) : null,
      };
      // Forensic backups (.bak) alongside the live files.
      this._backup(this.certPath, snap.cert);
      this._backup(this.keyPath, snap.key);
      if (rotateCa) this._backup(this.caPath, snap.ca);

      // Atomic swap-in of the new material.
      this._atomicWrite(this.certPath, msg.certificate);
      this._atomicWrite(this.keyPath, msg.private_key, this.keyMode);
      if (rotateCa) this._atomicWrite(this.caPath, msg.ca);

      const ok = await this.reconnectAndVerify(this.verifyTimeoutSec);
      if (ok) {
        return { ok: true, rolledBack: false, certificate_id: msg.certificate_id ?? null };
      }

      // The new cert did not connect - put the old material back and
      // reconnect on it so monitoring keeps flowing.
      const restored = this._rollback(snap, rotateCa);
      let reconnectedOnOld = false;
      if (restored) {
        try {
          reconnectedOnOld = await this.reconnectAndVerify(this.verifyTimeoutSec);
        } catch {
          reconnectedOnOld = false;
        }
      }
      return {
        ok: false,
        rolledBack: restored,
        reconnectedOnOld,
        certificate_id: msg.certificate_id ?? null,
        error:
          `new certificate failed to connect within ${this.verifyTimeoutSec}s` +
          (restored ? ' - rolled back to the previous certificate' : ' - no previous certificate to roll back to'),
      };
    } finally {
      this._busy = false;
    }
  }

  _readIfExists(p) {
    try {
      return this.fs.readFileSync(p);
    } catch {
      return null;
    }
  }

  _backup(p, bytes) {
    if (bytes == null) return;
    this._atomicWrite(`${p}.bak`, bytes);
  }

  _atomicWrite(p, data, mode) {
    const tmp = `${p}.tmp`;
    this.fs.writeFileSync(tmp, data, mode !== undefined ? { mode } : undefined);
    this.fs.renameSync(tmp, p);
    if (mode !== undefined && typeof this.fs.chmodSync === 'function') {
      this.fs.chmodSync(p, mode); // belt-and-suspenders: writeFileSync mode only applies on create
    }
  }

  _rollback(snap, includeCa) {
    if (snap.cert == null || snap.key == null) return false; // nothing to restore
    this._atomicWrite(this.certPath, snap.cert);
    this._atomicWrite(this.keyPath, snap.key, this.keyMode);
    if (includeCa && snap.ca != null) this._atomicWrite(this.caPath, snap.ca);
    return true;
  }
}

module.exports = { CertRotator, PEM_CERT, PEM_KEY };
