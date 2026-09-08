'use strict';

/**
 * Entries kept in the display-only context arrays, and rendered by the viewers.
 * The durable record (audit_trail.jsonl) is unaffected and uncapped.
 */
const VIEWER_CAP = 20;

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
 * remains the durable, complete record. That is what makes the cap a
 * free choice: trimming this array deletes nothing, it only shortens
 * what the dashboard renders.
 *
 * CAP REDUCED 200 -> 20 (user request 2026-09-08). Two reasons beyond
 * the render cost: each `audit_busbartherm` entry embeds a FULL
 * before/after config snapshot (`oldConfig`/`newConfig`), and this array
 * lives in the localfilesystem context store - so 200 of them is a
 * sizeable object rewritten to the SD card on every context flush, for
 * history nobody scrolls to. The complete trail is on disk either way.
 *
 * @param {{get: Function, set: Function}} globalContext - the function node's `global`
 * @param {string} key - which legacy audit global to append to
 * @param {object} entry - viewer-shaped audit entry
 * @param {number} [cap] - max entries kept (oldest dropped)
 */
function appendLegacyAudit(globalContext, key, entry, cap = VIEWER_CAP) {
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
function sortAuditDesc(entries, field, limit) {
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
    .map((pair) => pair[0])
    .slice(0, limit == null ? undefined : limit);
}

/**
 * What a viewer should render: newest first, capped.
 *
 * Applied on READ as well as on write because a panel already carrying 200
 * entries would otherwise keep rendering all of them until its next config
 * apply. Read-side trimming does not write back - that would put an SD write on
 * every page open, and the stored array converges on the next append anyway.
 */
function viewerRows(entries, field) {
  return sortAuditDesc(entries, field, VIEWER_CAP);
}

module.exports = { appendLegacyAudit, sortAuditDesc, viewerRows, VIEWER_CAP };
