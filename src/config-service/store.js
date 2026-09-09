'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DOMAIN_FILES = {
  modbus_joints: 'modbus_joints.json',
  alarms: 'alarms.json',
  integration: 'integration.json',
};

const DOMAIN_VERSION_KEYS = {
  modbus_joints: ['modbus', 'joints'],
  alarms: ['alarms'],
  integration: ['integration'],
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

/**
 * Cheap identity of a file, for cache invalidation: one `stat`, no read, no
 * parse, no validation. The atomic write path below is write-temp + rename, so
 * an apply always changes the inode - a same-second, same-size rewrite cannot
 * slip past this.
 */
function fileSignature(filePath) {
  try {
    const st = fs.statSync(filePath);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    return 'absent';
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const k of Object.keys(value)) deepFreeze(value[k]);
  }
  return value;
}

/**
 * MODULE scope, deliberately. Node-RED's `context`/`flow`/`global` all route
 * through the configured context store, which on these panels is
 * `localfilesystem`; a cache kept there would be the very cost it is meant to
 * remove. Module scope is the only genuinely in-process memory available to a
 * function node, and it survives a Deploy (the module stays `require`d) while
 * being rebuilt on a restart - which is what we want, since a restart is also
 * when the files may have been changed underneath us.
 *
 * Keyed by absolute domain path, so two stores with different roots (tests,
 * a migration tool) never share an entry.
 */
const appliedCache = new Map();

/** Test-only: drop every cached document. */
function _resetAppliedCache() {
  appliedCache.clear();
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

  /**
   * `readDomain`, but memoised against the on-disk file identity.
   *
   * WHY THIS EXISTS (measured live on ESBUSBBT06, 2026-09-09). `readDomain`
   * reads the file, `JSON.parse`s it and runs the FULL R1-R17 validation pass
   * on every call. Two nodes were calling it on the hot path - the Alarm
   * Manager once per KPI message and the Blacklist Engine once per Nano frame -
   * so a 71-device panel re-parsed and re-validated its entire commissioning
   * document several times a second, on the single thread that also runs every
   * other function node. Node-RED sat at ~50 % of a core with no dashboard
   * client connected at all, and `/proc/<pid>/io` showed ~2 MB/s of reads
   * against serial ports physically incapable of delivering more than ~23 KB/s.
   *
   * The cost is real work, not I/O: `read_bytes` never moved, so every one of
   * those reads was served from page cache. It was the parse and the validation
   * burning the CPU.
   *
   * Correctness is preserved by invalidating on the file's identity rather than
   * on a timer: a `stat` is orders of magnitude cheaper than parse + validate,
   * and an apply is picked up on the very next message rather than after a TTL.
   * The LKG snapshot is part of the signature because `readDomain` falls back
   * to it - a corrupt primary that later gets repaired must not serve a stale
   * fallback forever.
   *
   * The returned document is deep-frozen. Every current consumer treats it as
   * read-only (checked), and freezing makes that a guarantee instead of a
   * convention now that callers share one object.
   *
   * Use this for anything on a per-message path. Use `readDomain` where you
   * specifically want an uncached read - `applyIfValid` does, since it is about
   * to write.
   */
  readDomainCached(domain) {
    const primaryPath = this._domainPath(domain);
    const sig = `${fileSignature(primaryPath)}|${fileSignature(this._lkgPath(domain))}`;
    const hit = appliedCache.get(primaryPath);
    if (hit && hit.sig === sig) return hit.result;

    const { doc, source } = this.readDomain(domain);
    const result = Object.freeze({ doc: deepFreeze(doc), source });
    appliedCache.set(primaryPath, { sig, result });
    return result;
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
    let versionContext;
    if (domain === 'alarms') {
      versionContext = { appliedVersion: currentDoc?.config_domain_versions?.alarms };
    } else if (domain === 'integration') {
      versionContext = {
        appliedVersion: currentDoc?.config_domain_versions?.integration,
        appliedPointMapVersion: currentDoc?.point_map_version,
      };
    } else {
      versionContext = { appliedVersions: currentDoc?.config_domain_versions };
    }

    // `applying: true` distinguishes an APPLY from the bare validation readDomain
    // runs. Rules that must not retroactively invalidate a config already in
    // service key off this - R17 (panel-wide unit-address uniqueness) is the
    // first: readDomain treats an invalid document as absent, so an
    // unconditional new rule could take a running panel's configuration away.
    const result = this.validators[domain](newDoc, { applying: true, ...versionContext, ...context });

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

module.exports = { ConfigStore, atomicWriteJson, readJsonIfExists, _resetAppliedCache };
