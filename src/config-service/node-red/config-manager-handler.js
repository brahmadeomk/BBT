'use strict';

const { validateAlarms } = require('../validate-alarms');
const { buildRuntimeProfiles } = require('../../alarms/threshold-resolver');
const { precheckProfiles, buildProfilesDoc, profilesForUi } = require('../profile-manager');

const DEFAULT_PROFILE = {
  deltaT: { watch: 15, warning: 25, critical: 35 },
  ror: { watch: 15, warning: 30, critical: 60, timeWindowMin: 20 },
  persistence: { watchMin: 30, warningMin: 15, criticalMin: 5 },
};

/** Preserves the incoming msg's other properties (topic, req/res, socketid, _msgid, ...) - only payload changes. */
function withPayload(msg, payload) {
  return { ...msg, payload };
}

/**
 * Thin Node-RED handler replacing the "BusbarTherm Config Manager"
 * function node. Keeps the exact msg contract the dashboard already
 * uses (action: save/restore/<none for load>, msg.payload.config is
 * the flat {deltaT, ror, persistence} shape) but routes through the
 * schema-validated ConfigStore instead of raw global context - so
 * R13/A8 (audit trail, LKG snapshot) come for free instead of the
 * hand-rolled logAudit() the legacy node had.
 *
 * Only the 'default' profile is exposed here, matching the legacy
 * system's single flat threshold set. Additional named profiles (if
 * ever added through some other tool) are preserved untouched.
 *
 * @param {object} msg - Node-RED msg; msg.payload = {action?, user?, config?}
 * @param {import('../store').ConfigStore} store
 * @returns {{msg: object|null, audit: object|null, runtimeConfig: object|null}} msg to send (or
 *   null to suppress); audit is a legacy-viewer-shaped entry ({ts, user, action, oldConfig,
 *   newConfig}) for the wrapper to append to the `audit_busbartherm` global (see
 *   legacy-audit.js), present on save/restore attempts (applied or rejected), null on plain
 *   loads; runtimeConfig is the flat profile the wrapper must write to the
 *   `busbartherm_system_config` global on a SUCCESSFUL apply - that's what the live Alarm
 *   Manager evaluates against on every sample, so writing it IS the live re-evaluation (A10:
 *   raise/clear through the normal persistence paths, no mass-clear). The legacy node wrote
 *   this global inline; the Slice 2 refactor dropped it (regression - thresholds saved to the
 *   store stopped reaching the running alarm engine until this was restored).
 */
function handleConfigManagerMessage(msg, store) {
  const action = msg.payload?.action;
  const user = msg.payload?.user || 'UI';

  const { doc: currentAlarms } = store.readDomain('alarms');
  const { doc: currentModbusJoints } = store.readDomain('modbus_joints');

  if (action === 'save' && msg.payload.config) {
    return applyDefaultProfile(msg, store, currentAlarms, currentModbusJoints, msg.payload.config, user, 'Configuration saved successfully', 'APPLY');
  }

  if (action === 'restore') {
    return applyDefaultProfile(msg, store, currentAlarms, currentModbusJoints, DEFAULT_PROFILE, user, 'Default configuration restored', 'RESTORE');
  }

  // NAMED PROFILES (2026-09-11). The screen above edits `default` only, which is
  // why zone-wise thresholds were inert - no profile for a zone to bind to could
  // be created from the panel at all. These two actions manage the whole map.
  if (action === 'profiles_load') {
    return {
      msg: withPayload(msg, { profiles: profilesForUi(currentAlarms, currentModbusJoints) }),
      audit: null,
      runtimeConfig: null,
    };
  }

  if (action === 'profiles_apply') {
    return applyProfiles(msg, store, currentAlarms, currentModbusJoints, msg.payload.profiles, user);
  }

  // LOAD (no action): reflect the currently applied default profile, or the
  // built-in default if nothing has been applied yet.
  const config = currentAlarms?.profiles?.default
    ? {
        deltaT: currentAlarms.profiles.default.deltaT,
        ror: currentAlarms.profiles.default.ror,
        persistence: currentAlarms.profiles.default.persistence,
      }
    : DEFAULT_PROFILE;
  return { msg: withPayload(msg, { config }), audit: null, runtimeConfig: null };
}

/**
 * Apply a complete profiles map from the editor.
 *
 * The client sends its WHOLE map on every action - add, rename and delete are
 * all edits to the map it already holds - so there is one write path and no
 * partial-update shapes. That is the JointMasterUI data-loss lesson: a UI that
 * sends only what it touched lets the server answer from its own stale copy.
 */
function applyProfiles(msg, store, currentAlarms, currentModbusJoints, profiles, user) {
  const problems = precheckProfiles(profiles, currentModbusJoints, currentAlarms);
  if (problems.length > 0) {
    // Refused before the store is touched, so the applied document is unchanged
    // and the editor can keep the operator's in-progress map on screen.
    return {
      msg: withPayload(msg, {
        profiles: profilesForUi(currentAlarms, currentModbusJoints),
        error: problems.join(' '),
      }),
      audit: null,
      runtimeConfig: null,
    };
  }

  const newDoc = buildProfilesDoc(currentAlarms, profiles);
  const result = store.applyIfValid(
    'alarms',
    newDoc,
    { jointsDoc: currentModbusJoints, modbusDoc: currentModbusJoints },
    user
  );

  if (!result.applied) {
    return {
      msg: withPayload(msg, {
        profiles: profilesForUi(currentAlarms, currentModbusJoints),
        error: result.errors.map((e) => `${e.rule}: ${e.message}`).join('; '),
      }),
      audit: {
        ts: new Date().toISOString(),
        user,
        action: 'PROFILES_APPLY_REJECTED',
        oldConfig: { profiles: Object.keys(currentAlarms?.profiles ?? {}) },
        newConfig: { profiles: Object.keys(profiles) },
      },
      runtimeConfig: null,
    };
  }

  // The runtime needs every profile, not just the edited one: a joint bound to
  // 'outdoor' has to find 'outdoor' in the global. The flat default stays at the
  // top level so an older flow, and this one before its next apply, still work.
  const runtimeProfiles = buildRuntimeProfiles(newDoc);
  const def = newDoc.profiles.default;

  return {
    msg: withPayload(msg, {
      profiles: profilesForUi(newDoc, currentModbusJoints),
      success: 'Threshold profiles saved',
    }),
    audit: {
      ts: new Date().toISOString(),
      user,
      action: 'PROFILES_APPLY',
      // Names, not every number: the audit viewers are capped at 20 rows and a
      // 50-profile dump would make the entry unreadable. The full document is in
      // the store's own versioned history if the values are ever needed.
      oldConfig: { profiles: Object.keys(currentAlarms?.profiles ?? {}).sort() },
      newConfig: { profiles: Object.keys(newDoc.profiles).sort() },
    },
    runtimeConfig: {
      deltaT: def.deltaT,
      ror: def.ror,
      persistence: def.persistence,
      ...(runtimeProfiles ? { profiles: runtimeProfiles } : {}),
      ...(newDoc.sensor_fault ? { sensor_fault: newDoc.sensor_fault } : {}),
    },
  };
}

function applyDefaultProfile(msg, store, currentAlarms, currentModbusJoints, flatProfile, user, successMessage, auditAction) {
  const currentFlatProfile = currentAlarms?.profiles?.default
    ? { deltaT: currentAlarms.profiles.default.deltaT, ror: currentAlarms.profiles.default.ror, persistence: currentAlarms.profiles.default.persistence }
    : null;
  const newDoc = {
    config_domain_versions: {
      alarms: (currentAlarms?.config_domain_versions?.alarms ?? 0) + 1,
    },
    profiles: {
      ...(currentAlarms?.profiles || {}),
      default: {
        ...(currentAlarms?.profiles?.default || {}),
        deltaT: flatProfile.deltaT,
        ror: flatProfile.ror,
        persistence: flatProfile.persistence,
      },
    },
    ...(currentAlarms?.sensor_fault ? { sensor_fault: currentAlarms.sensor_fault } : {}),
    ...(currentAlarms?.notifications ? { notifications: currentAlarms.notifications } : {}),
  };

  const result = store.applyIfValid(
    'alarms',
    newDoc,
    { jointsDoc: currentModbusJoints, modbusDoc: currentModbusJoints },
    user
  );

  if (!result.applied) {
    const currentFlat = currentFlatProfile ?? DEFAULT_PROFILE;
    return {
      msg: withPayload(msg, {
        config: currentFlat,
        error: result.errors.map((e) => `${e.rule}: ${e.message}`).join('; '),
      }),
      audit: {
        ts: new Date().toISOString(),
        user,
        action: `${auditAction}_REJECTED`,
        oldConfig: currentFlatProfile,
        newConfig: flatProfile,
      },
      runtimeConfig: null,
    };
  }

  // The dashboard edits only the default profile, but the RUNTIME needs every
  // profile: a joint whose threshold_profile names 'outdoor' has to find
  // 'outdoor' in the global, and this apply is the only thing that rewrites it.
  // Publishing just the edited profile would mean saving the panel-wide
  // thresholds silently reverted every other joint to them.
  // The flat {deltaT, ror, persistence} stays at the top level so a panel
  // running an older flow - or this one before its next apply - is unaffected.
  const runtimeProfiles = buildRuntimeProfiles(newDoc);

  // sensor_fault carries the plausibility ceiling ProcessLogic uses to tell a
  // measurement from a fault. It is preserved on newDoc across every apply, but
  // was never published to the runtime, so the flow used a hardcoded 300.
  const runtimeSensorFault = newDoc.sensor_fault;

  return {
    msg: withPayload(msg, { config: flatProfile, success: successMessage }),
    audit: {
      ts: new Date().toISOString(),
      user,
      action: auditAction,
      oldConfig: currentFlatProfile,
      newConfig: flatProfile,
    },
    runtimeConfig: {
      ...flatProfile,
      ...(runtimeProfiles ? { profiles: runtimeProfiles } : {}),
      ...(runtimeSensorFault ? { sensor_fault: runtimeSensorFault } : {}),
    },
  };
}

module.exports = { handleConfigManagerMessage, DEFAULT_PROFILE };
