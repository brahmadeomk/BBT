'use strict';

/**
 * Bridge to the dashboard audit viewers (regression fix): the legacy
 * backend nodes appended audit entries to global context arrays that
 * two ui_templates still read - `joint_config_audit_log` (Audit Log
 * Viewer: {timestamp, user, action, details}) and `audit_busbartherm`
 * (alarms audit viewer: {ts, user, action, oldConfig, newConfig}).
 * The refactored handlers write the durable trail to the ConfigStore's
 * audit_trail.jsonl but stopped feeding these globals, so the screens
 * went blank after settings changes. Handlers now also return a
 * viewer-shaped `audit` entry; the thin wrappers push it here.
 *
 * The capped in-context array is display-only - audit_trail.jsonl
 * remains the durable, complete record.
 *
 * @param {{get: Function, set: Function}} globalContext - the function node's `global`
 * @param {string} key - which legacy audit global to append to
 * @param {object} entry - viewer-shaped audit entry
 * @param {number} [cap] - max entries kept (oldest dropped)
 */
function appendLegacyAudit(globalContext, key, entry, cap = 200) {
  // Both audit viewers read the "default" named context store
  // (global.get(key, "default")) and the original legacy nodes wrote it
  // there too - so write to the same store, not the unnamed default,
  // or the entries silently land where the viewer never looks.
  const log = globalContext.get(key, 'default') || [];
  log.push(entry);
  while (log.length > cap) log.shift();
  globalContext.set(key, log, 'default');
}

module.exports = { appendLegacyAudit };
