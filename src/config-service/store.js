'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DOMAIN_FILES = {
  modbus_joints: 'modbus_joints.json',
  alarms: 'alarms.json',
};

const DOMAIN_VERSION_KEYS = {
  modbus_joints: ['modbus', 'joints'],
  alarms: ['alarms'],
};

/**
 * Write-temp, fsync, rename: the file at filePath either has its old
 * contents or its new contents, never a partial write, even across a
 * crash (busduct_edge_config.yaml remote_config.apply_mode: atomic).
 */
function atomicWriteJson(filePath, doc) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  );
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(doc, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
  try {
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // Directory fsync isn't supported on every platform; the rename
    // itself is still atomic without it.
  }
}

/** Returns null if absent, undefined if present-but-unparseable, else the parsed doc. */
function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

class ConfigStore {
  /**
   * @param {object} opts
   * @param {string} opts.root - root directory for domain files, LKG snapshots, and the audit trail
   * @param {Record<string, (doc: object, context: object) => {valid: boolean, errors: object[]}>} opts.validators
   *   one validate function per domain: 'modbus_joints' and 'alarms'
   */
  constructor({ root, validators }) {
    this.root = root;
    this.validators = validators;
    this.auditPath = path.join(root, 'audit_trail.jsonl');
  }

  _domainPath(domain) {
    return path.join(this.root, DOMAIN_FILES[domain]);
  }

  _lkgPath(domain) {
    return path.join(this.root, DOMAIN_FILES[domain].replace(/\.json$/, '.lkg.json'));
  }

  /**
   * Reads the currently applied document for a domain. Falls back to the
   * last-known-good snapshot if the primary file is missing, corrupt, or
   * fails schema/cross-field validation (busduct_edge_config.yaml:
   * fallback: last_known_good).
   */
  readDomain(domain) {
    const primary = readJsonIfExists(this._domainPath(domain));
    if (primary !== null && primary !== undefined && this.validators[domain](primary, {}).valid) {
      return { doc: primary, source: 'current' };
    }
    const lkg = readJsonIfExists(this._lkgPath(domain));
    if (lkg !== null && lkg !== undefined && this.validators[domain](lkg, {}).valid) {
      return { doc: lkg, source: 'last-known-good' };
    }
    return { doc: null, source: 'none' };
  }

  /** Currently applied config_domain_versions for a domain, or {} if nothing applied yet. */
  getAppliedVersions(domain) {
    const { doc } = this.readDomain(domain);
    if (!doc) return {};
    const versions = {};
    for (const key of DOMAIN_VERSION_KEYS[domain]) versions[key] = doc.config_domain_versions[key];
    return versions;
  }

  _appendAudit(entry) {
    fs.mkdirSync(this.root, { recursive: true });
    fs.appendFileSync(this.auditPath, JSON.stringify(entry) + '\n');
  }

  /**
   * Validates newDoc (injecting the currently applied version(s) as
   * context, so callers don't have to fetch them separately for
   * R11/A6) and, if valid, atomically applies it: writes the domain
   * file and its LKG snapshot. Either way, appends a before/after audit
   * entry (R13 / A8) - rejections are audited too, with the rejection
   * reasons, so a rejected remote push always leaves a trace.
   *
   * @param {'modbus_joints'|'alarms'} domain
   * @param {object} newDoc
   * @param {object} [context] - extra validator context: source, maintenanceMode, cross-domain docs
   * @param {string} [user]
   * @returns {{applied: boolean, errors?: object[], appliedVersions?: object}}
   */
  applyIfValid(domain, newDoc, context = {}, user = 'system') {
    const { doc: currentDoc } = this.readDomain(domain);
    const versionContext =
      domain === 'alarms'
        ? { appliedVersion: currentDoc?.config_domain_versions?.alarms }
        : { appliedVersions: currentDoc?.config_domain_versions };

    const result = this.validators[domain](newDoc, { ...versionContext, ...context });

    const auditBase = {
      ts: new Date().toISOString(),
      domain,
      action: 'APPLY',
      user,
      oldConfig: currentDoc,
      newConfig: newDoc,
    };

    if (!result.valid) {
      this._appendAudit({ ...auditBase, result: 'rejected', errors: result.errors });
      return { applied: false, errors: result.errors, warnings: result.warnings || [] };
    }

    atomicWriteJson(this._domainPath(domain), newDoc);
    atomicWriteJson(this._lkgPath(domain), newDoc);
    this._appendAudit({ ...auditBase, result: 'applied' });

    // warnings are non-blocking diagnostics (e.g. R16 bus loading > 80%) -
    // surfaced to the caller so the dashboard can show them on a success.
    return { applied: true, appliedVersions: this.getAppliedVersions(domain), warnings: result.warnings || [] };
  }
}

module.exports = { ConfigStore, atomicWriteJson, readJsonIfExists };
