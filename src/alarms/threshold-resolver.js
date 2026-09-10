'use strict';

/**
 * Resolve the alarm thresholds that apply to ONE joint.
 *
 * WHY THIS EXISTS. `cfg/alarms` has had named threshold `profiles` since Slice 2,
 * `cfg/joints` has had `joints[].threshold_profile` to select one, and **A3
 * validates that the reference resolves**. None of it did anything. The Alarm
 * Manager read a single global (`busbartherm_system_config`) holding one flat
 * `{deltaT, ror, persistence}` and evaluated every joint on the panel against
 * it; no node in the flow referenced `threshold_profile` or `profiles` at all.
 * So an operator could set a per-joint profile, watch it validate, see it
 * written to the audit trail — and the panel would keep using the panel-wide
 * numbers. A silent no-op, and one that looks exactly like it is working.
 *
 * It is the same shape as the `poll_interval_s` trap found the day before
 * (2026-09-09): a value that is validated, displayed and stored, but never
 * reaches the code that acts on it. Validation proves a document is
 * self-consistent. It cannot prove anyone reads the field.
 *
 * FAIL-SAFE DIRECTION: this is a fire-safety monitor, so "no thresholds" must
 * never mean "no alarms". Every fallback here widens what is accepted rather
 * than narrowing it, and the last resort is the panel-wide set that was in use
 * before profiles were honoured — i.e. the worst case is exactly today's
 * behaviour, never silence. `null` is returned only when the config carries no
 * usable thresholds at ALL, which is the one case the caller already handles by
 * bailing out (`if (!cfg) return null`).
 *
 * WHAT IS NOT DONE HERE: partial profiles are not merged. The schema makes
 * `deltaT`, `ror` and `persistence` all required on a profile, so a profile is
 * complete by construction; a profile missing one of them is malformed, not a
 * request to inherit, and is rejected in favour of the default rather than
 * silently half-applied.
 */

const GROUPS = ['deltaT', 'ror', 'persistence'];

/** A usable threshold set has all three groups as objects. */
function isComplete(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  return GROUPS.every((g) => candidate[g] && typeof candidate[g] === 'object');
}

/** Just the three threshold groups, so callers cannot accidentally depend on profile metadata. */
function pick(source, profileName, via) {
  return {
    deltaT: source.deltaT,
    ror: source.ror,
    persistence: source.persistence,
    profile: profileName,
    via,
  };
}

/**
 * @param {object} runtimeCfg - the `busbartherm_system_config` value. Carries the
 *   flat `{deltaT, ror, persistence}` for the default profile (the legacy shape,
 *   still written so an older flow keeps working) and, since this change, a
 *   `profiles` map keyed by profile name.
 * @param {string|null|undefined} profileName - the joint's `threshold_profile`.
 * @returns {{deltaT:object, ror:object, persistence:object, profile:string, via:string}|null}
 *   `via` records WHICH rung of the chain answered, so the caller can surface a
 *   joint quietly running on the wrong thresholds instead of it being invisible.
 */
function resolveThresholds(runtimeCfg, profileName) {
  if (!runtimeCfg || typeof runtimeCfg !== 'object') return null;

  const profiles = runtimeCfg.profiles;
  const named = typeof profileName === 'string' ? profileName.trim() : '';

  // 1. The joint's own profile, when it exists and is complete.
  //    A joint that explicitly names 'default' reports `via: 'default'`, exactly
  //    as one that names nothing does: the thresholds are the same and neither
  //    is anomalous. `via` exists to make an unexpected resolution visible, so
  //    it must not distinguish two spellings of the ordinary case.
  if (named && profiles && typeof profiles === 'object') {
    const wanted = profiles[named];
    if (isComplete(wanted)) return pick(wanted, named, named === 'default' ? 'default' : 'profile');
  }

  // 2. The default profile. Reached when the joint names no profile, names one
  //    that has since been deleted, or names a malformed one. A3 rejects a
  //    dangling reference at apply time, but the two documents version
  //    independently: a profile can be removed from cfg/alarms while a joint
  //    still names it, and the panel must keep watching that joint.
  if (profiles && typeof profiles === 'object' && isComplete(profiles.default)) {
    return pick(profiles.default, 'default', named && named !== 'default' ? 'fallback_default' : 'default');
  }

  // 3. The flat legacy shape. This is what every panel carried before profiles
  //    were honoured, and what a panel still carries between a library update
  //    and the operator's next alarm-config apply. Dropping to it costs the
  //    per-joint distinction, never the alarm.
  if (isComplete(runtimeCfg)) {
    return pick(runtimeCfg, 'default', named && named !== 'default' ? 'fallback_flat' : 'flat');
  }

  return null;
}

/**
 * Build the `profiles` map that belongs on `busbartherm_system_config`.
 *
 * Kept beside the resolver so the writer and the reader of this shape cannot
 * drift — the same reason `nanoJobsEqual` lives next to `compileNanoJob`.
 * Returns `null` (not `{}`) when there is nothing worth publishing, so a caller
 * can spread it conditionally and leave the global's legacy shape untouched.
 */
function buildRuntimeProfiles(alarmsDoc) {
  const profiles = alarmsDoc?.profiles;
  if (!profiles || typeof profiles !== 'object') return null;

  const out = {};
  for (const [name, p] of Object.entries(profiles)) {
    if (!isComplete(p)) continue;
    out[name] = { deltaT: p.deltaT, ror: p.ror, persistence: p.persistence };
  }
  return Object.keys(out).length > 0 ? out : null;
}

module.exports = { resolveThresholds, buildRuntimeProfiles };
