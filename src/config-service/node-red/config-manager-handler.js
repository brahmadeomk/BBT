'use strict';

const { validateAlarms } = require('../validate-alarms');

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
 * @returns {object|null} a Node-RED msg to return, or null to suppress output
 */
function handleConfigManagerMessage(msg, store) {
  const action = msg.payload?.action;
  const user = msg.payload?.user || 'UI';

  const { doc: currentAlarms } = store.readDomain('alarms');
  const { doc: currentModbusJoints } = store.readDomain('modbus_joints');

  if (action === 'save' && msg.payload.config) {
    return applyDefaultProfile(msg, store, currentAlarms, currentModbusJoints, msg.payload.config, user, 'Configuration saved successfully');
  }

  if (action === 'restore') {
    return applyDefaultProfile(msg, store, currentAlarms, currentModbusJoints, DEFAULT_PROFILE, user, 'Default configuration restored');
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
  return withPayload(msg, { config });
}

function applyDefaultProfile(msg, store, currentAlarms, currentModbusJoints, flatProfile, user, successMessage) {
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
    const currentFlat = currentAlarms?.profiles?.default
      ? { deltaT: currentAlarms.profiles.default.deltaT, ror: currentAlarms.profiles.default.ror, persistence: currentAlarms.profiles.default.persistence }
      : DEFAULT_PROFILE;
    return withPayload(msg, {
      config: currentFlat,
      error: result.errors.map((e) => `${e.rule}: ${e.message}`).join('; '),
    });
  }

  return withPayload(msg, { config: flatProfile, success: successMessage });
}

module.exports = { handleConfigManagerMessage, DEFAULT_PROFILE };
