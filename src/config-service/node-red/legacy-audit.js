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

/**
 * Newest-first ordering for the two audit viewers, done HERE rather than with
 * Angular's `orderBy` filter in the template.
 *
 * WHY (2026-09-08, from a live report that the Audit page was slow to leave).
 * `ng-repeat="a in msg.payload | orderBy:'-ts'"` re-runs the sort on **every
 * digest cycle**, not just when the data changes — 200 entries (the cap above)
 * re-sorted on every UI interaction anywhere on the dashboard. The order only
 * changes when an entry is appended, which is on a config apply.
 *
 * RETURNS A COPY. `global.get(key, 'default')` hands back a live reference to
 * the stored array, so sorting in place would permanently reorder the persisted
 * audit log — a record that exists precisely so its order can be trusted.
 *
 * Missing values sort last rather than throwing, and equal values keep their
 * original relative order, so the result is stable across renders.
 */
function sortAuditDesc(entries, field) {
  return (Array.isArray(entries) ? entries : [])
    .map((e, i) => [e, i])
    .sort((a, b) => {
      const av = a[0] ? a[0][field] : undefined;
      const bv = b[0] ? b[0][field] : undefined;
      if (av === bv) return a[1] - b[1];
      if (av === undefined || av === null) return 1;
      if (bv === undefined || bv === null) return -1;
      return av < bv ? 1 : -1;
    })
    .map((pair) => pair[0]);
}

module.exports = { appendLegacyAudit, sortAuditDesc };
