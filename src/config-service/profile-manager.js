'use strict';

/**
 * Named threshold profiles — the editor's server side.
 *
 * WHY THIS EXISTS. Profiles have been in `cfg/alarms` since Slice 2 and zones
 * can now bind to one (2026-09-11), but there was **no way to create a second
 * profile**: the Alarm Config screen calls `applyDefaultProfile`, which only
 * ever writes `profiles.default`. Zone-wise thresholds were therefore inert —
 * a zone could only name a profile that had arrived by remote config push or a
 * hand-edited file. This is the missing half.
 *
 * THE CLIENT SENDS ITS WHOLE MAP ON EVERY ACTION, and this takes a whole map,
 * never a delta. That is the lesson from the `JointMasterUI`/`ZoneMasterUI`
 * data-loss bug: a UI that sends only the row it touched lets the server answer
 * from its own last-persisted copy, and the template's `$watch` then overwrites
 * an in-progress edit with stale state. Add, rename and delete are all just
 * edits to the map the client already holds, so there is one write path, one
 * validation pass, and no partial-update shapes to reason about.
 *
 * FRIENDLY PRE-CHECKS RUN BEFORE THE SCHEMA. A1/A2/A3/A4 already make every one
 * of these conditions invalid, so nothing here is load-bearing for correctness
 * — it exists so the operator reads "profile 'outdoor' is still used by zone
 * 'z2'" instead of an AJV path. The real enforcement stays in the validators.
 */

/** Matches the schema's `profiles` key pattern, so a name is spelled the same everywhere. */
const NAME_PATTERN = /^[a-z][a-z0-9_]{0,23}$/;
/** Mirrors `profiles.maxProperties`. */
const MAX_PROFILES = 50;
const GROUPS = ['deltaT', 'ror', 'persistence'];

/**
 * Which joints and zones reference each profile name.
 * @returns {Map<string, string[]>} profile name -> human scopes, e.g. ["zone 'z2'", "joint 'J07'"]
 */
function profileUsage(jointsDoc) {
  const usage = new Map();
  const add = (name, scope) => {
    if (name == null) return;
    if (!usage.has(name)) usage.set(name, []);
    usage.get(name).push(scope);
  };
  for (const z of jointsDoc?.zones ?? []) add(z.threshold_profile, `zone '${z.zone_id}'`);
  for (const j of jointsDoc?.joints ?? []) add(j.threshold_profile, `joint '${j.joint_id}'`);
  return usage;
}

function isComplete(p) {
  return !!p && typeof p === 'object' && GROUPS.every((g) => p[g] && typeof p[g] === 'object');
}

/**
 * Operator-facing checks. Returns [] when the map is acceptable.
 *
 * @param {object} profiles - the complete profiles map the client is proposing
 * @param {object} jointsDoc - applied cfg/modbus+joints, for the in-use check
 * @param {object} [currentAlarms] - applied cfg/alarms, to tell a DELETE from an add
 */
function precheckProfiles(profiles, jointsDoc, currentAlarms) {
  const errors = [];

  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) {
    return ['No profiles were received. Nothing has been changed.'];
  }

  const names = Object.keys(profiles);

  // A4 in friendly form. `default` is what every unbound joint resolves to, so
  // losing it would silently move the whole panel onto a fallback.
  if (!Object.prototype.hasOwnProperty.call(profiles, 'default')) {
    errors.push("The 'default' profile cannot be deleted or renamed - it is the panel-wide fallback.");
  }

  if (names.length > MAX_PROFILES) {
    errors.push(`Too many profiles: ${names.length}. The maximum is ${MAX_PROFILES}.`);
  }

  for (const name of names) {
    if (!NAME_PATTERN.test(name)) {
      errors.push(
        `Profile name '${name}' is not allowed. Use lower-case letters, digits and underscore, ` +
          'starting with a letter, up to 24 characters.'
      );
    }
    if (!isComplete(profiles[name])) {
      errors.push(`Profile '${name}' is incomplete - it needs deltaT, ror and persistence.`);
    }
  }

  // DELETING WITHOUT THE JOINTS DOCUMENT IS REFUSED (found 2026-09-11 by running
  // the handler against a real store, not by a unit test - the unit passed).
  // `readDomain` returns null for an unreadable or invalid document, and both
  // this check and A3 are gated on having it, so with no document BOTH layers
  // fail OPEN: a profile a zone depends on could be deleted and every joint in
  // that zone would slide onto the panel-wide default without a word.
  //
  // The asymmetry is deliberate. Adding or editing a profile is safe without the
  // joints document, and a fresh panel legitimately has no joints yet - blocking
  // all edits would make the editor unusable at commissioning. Only a DELETE
  // needs the reference check, so only a delete is refused when it cannot run.
  // This is the same rule the config-change alarm sweep follows: refusing to act
  // on absent information, rather than reading absence as "nothing is bound".
  const removed = Object.keys(currentAlarms?.profiles ?? {}).filter(
    (n) => !Object.prototype.hasOwnProperty.call(profiles, n)
  );
  if (removed.length > 0 && !jointsDoc) {
    errors.push(
      `Cannot delete ${removed.map((n) => `'${n}'`).join(', ')}: the applied joint configuration ` +
        'could not be read, so it is not possible to check whether a zone or joint still uses it.'
    );
  }

  // THE ONE THAT MATTERS OPERATIONALLY. A3 rejects a dangling reference too, but
  // it reports it against cfg/alarms at apply time; naming the zone or joint
  // here tells the operator what to go and change first. A zone is listed before
  // a joint by profileUsage because removing a profile a ZONE uses moves every
  // joint in that zone, not one.
  const usage = profileUsage(jointsDoc);
  for (const [name, scopes] of usage) {
    if (!Object.prototype.hasOwnProperty.call(profiles, name)) {
      const shown = scopes.slice(0, 4).join(', ');
      const more = scopes.length > 4 ? ` and ${scopes.length - 4} more` : '';
      errors.push(`Profile '${name}' is still used by ${shown}${more}. Reassign those first.`);
    }
  }

  return errors;
}

/**
 * The `cfg/alarms` document to apply for a new profiles map.
 *
 * Everything outside `profiles` is carried through untouched: `sensor_fault`
 * and `notifications` are panel-wide and have their own screens, and dropping
 * them here would silently reset them on every profile edit.
 */
function buildProfilesDoc(currentAlarms, profiles) {
  const clean = {};
  for (const [name, p] of Object.entries(profiles)) {
    clean[name] = {
      // Preserve the profile's own description if the client did not send one -
      // it is the only place an operator can say what a profile is FOR.
      ...(p.description != null ? { description: p.description } : {}),
      ...(currentAlarms?.profiles?.[name]?.description != null && p.description == null
        ? { description: currentAlarms.profiles[name].description }
        : {}),
      deltaT: p.deltaT,
      ror: p.ror,
      persistence: p.persistence,
      ...(p.clear_hysteresis_pct != null ? { clear_hysteresis_pct: p.clear_hysteresis_pct } : {}),
      ...(p.clear_persistence_min != null ? { clear_persistence_min: p.clear_persistence_min } : {}),
    };
  }

  return {
    config_domain_versions: {
      alarms: (currentAlarms?.config_domain_versions?.alarms ?? 0) + 1,
    },
    profiles: clean,
    ...(currentAlarms?.sensor_fault ? { sensor_fault: currentAlarms.sensor_fault } : {}),
    ...(currentAlarms?.notifications ? { notifications: currentAlarms.notifications } : {}),
  };
}

/** What the editor renders: every profile, plus where each is in use. */
function profilesForUi(currentAlarms, jointsDoc) {
  const usage = profileUsage(jointsDoc);
  const profiles = currentAlarms?.profiles ?? {};
  return Object.keys(profiles)
    .sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)))
    .map((name) => ({
      name,
      description: profiles[name].description ?? null,
      deltaT: profiles[name].deltaT,
      ror: profiles[name].ror,
      persistence: profiles[name].persistence,
      used_by: usage.get(name) ?? [],
      // `default` is protected by A4; the UI greys out its delete control rather
      // than offering an action the server will refuse.
      removable: name !== 'default' && (usage.get(name) ?? []).length === 0,
    }));
}

module.exports = { precheckProfiles, buildProfilesDoc, profilesForUi, profileUsage, MAX_PROFILES, NAME_PATTERN };
