'use strict';

const { validateAlarmsSchema, formatAjvErrors } = require('./schemas');

function err(rule, message) {
  return { rule, message };
}

/**
 * A1 (deltaT/ror leg): strict ordering watch < warning < critical.
 * Exported standalone so it can be exercised directly against
 * hand-built profile objects, independent of the full schema pipeline.
 */
function checkThresholdOrdering(profileName, profile) {
  const errors = [];
  const { watch: dw, warning: dwn, critical: dc } = profile.deltaT;
  if (!(dw < dwn && dwn < dc)) {
    errors.push(err('A1', `profile '${profileName}' deltaT thresholds must satisfy watch < warning < critical (got ${dw}, ${dwn}, ${dc})`));
  }
  const { watch: rw, warning: rwn, critical: rc } = profile.ror;
  if (!(rw < rwn && rwn < rc)) {
    errors.push(err('A1', `profile '${profileName}' ror thresholds must satisfy watch < warning < critical (got ${rw}, ${rwn}, ${rc})`));
  }
  return errors;
}

/** A2: persistence must react at least as fast at higher severity. */
function checkPersistenceOrdering(profileName, profile) {
  const { watchMin, warningMin, criticalMin } = profile.persistence;
  if (!(watchMin >= warningMin && warningMin >= criticalMin)) {
    return [
      err(
        'A2',
        `profile '${profileName}' persistence must satisfy watchMin >= warningMin >= criticalMin (got ${watchMin}, ${warningMin}, ${criticalMin})`
      ),
    ];
  }
  return [];
}

/**
 * A9: the clear level (watch threshold reduced by clear_hysteresis_pct)
 * must not go below zero. Given the schema's own bounds (clear_hysteresis_pct
 * <= 30, deltaT.watch >= 5) this can't actually be violated by a
 * schema-valid document today - it's checked anyway as defense-in-depth
 * against future schema relaxation, and is unit-tested by calling this
 * function directly with an out-of-schema-range profile.
 */
function checkHysteresisSanity(profileName, profile) {
  const pct = profile.clear_hysteresis_pct ?? 10;
  const clearLevel = profile.deltaT.watch * (1 - pct / 100);
  if (clearLevel < 0) {
    return [err('A9', `profile '${profileName}' clear_hysteresis_pct of ${pct}% pushes the deltaT clear level below 0`)];
  }
  return [];
}

/**
 * A4: the 'default' profile can't be deleted. The schema's own
 * required: ["default"] on profiles{} already guarantees this for any
 * schema-valid document; this is a defense-in-depth re-check with a
 * friendlier rule-tagged message, unit-tested by calling it directly.
 */
function checkDefaultProfilePresent(profiles) {
  if (!profiles || !Object.prototype.hasOwnProperty.call(profiles, 'default')) {
    return [err('A4', "profiles must include a 'default' profile")];
  }
  return [];
}

/**
 * Validates a cfg/alarms document: JSON Schema, then the mandatory
 * cross-field rules A1-A7 and A9 (A8 is an apply-time workflow
 * requirement enforced by the config store - see
 * src/config-service/store.js. A10 is an alarm-engine runtime behavior,
 * not something a config document validator can check - see CLAUDE.md).
 *
 * @param {object} doc - the cfg/alarms document
 * @param {object} [context]
 * @param {number} [context.appliedVersion] - currently applied alarms domain version, for A6
 * @param {object} [context.jointsDoc] - the currently applied cfg/joints document, for A3
 * @param {object} [context.modbusDoc] - the currently applied cfg/modbus document, for A5
 * @returns {{valid: boolean, errors: {rule: string, message: string}[]}}
 */
function validateAlarms(doc, context = {}) {
  const schemaValid = validateAlarmsSchema(doc);
  if (!schemaValid) {
    return { valid: false, errors: formatAjvErrors(validateAlarmsSchema.errors) };
  }

  const errors = [];
  const profiles = doc.profiles;

  // A1 / A2 / A9 per profile
  for (const [name, profile] of Object.entries(profiles)) {
    errors.push(...checkThresholdOrdering(name, profile));
    errors.push(...checkPersistenceOrdering(name, profile));
    errors.push(...checkHysteresisSanity(name, profile));
  }

  // A3: every joints[].threshold_profile must resolve to a profile here
  if (context.jointsDoc) {
    const referenced = new Set(
      (context.jointsDoc.joints || [])
        .map((j) => j.threshold_profile)
        .filter((p) => p != null)
    );
    for (const name of referenced) {
      if (!Object.prototype.hasOwnProperty.call(profiles, name)) {
        errors.push(err('A3', `cfg/joints references threshold_profile '${name}', which does not exist in cfg/alarms`));
      }
    }
  }

  // A5: deltaT alarming requires ambient_sensor in cfg/modbus
  if (context.modbusDoc) {
    if (!context.modbusDoc.modbus?.ambient_sensor) {
      errors.push(err('A5', 'cfg/alarms profiles use deltaT but cfg/modbus.modbus.ambient_sensor is not configured'));
    }
  }

  // A6: version monotonicity
  if (context.appliedVersion != null) {
    const incoming = doc.config_domain_versions.alarms;
    if (incoming <= context.appliedVersion) {
      errors.push(
        err('A6', `config_domain_versions.alarms (${incoming}) must be greater than applied version (${context.appliedVersion})`)
      );
    }
  }

  // A7: enabled notification channels must have recipients
  if (doc.notifications) {
    for (const channel of ['email', 'sms']) {
      const cfg = doc.notifications[channel];
      if (cfg?.enabled && (!cfg.recipients || cfg.recipients.length === 0)) {
        errors.push(err('A7', `notifications.${channel} is enabled but has no recipients`));
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  validateAlarms,
  checkThresholdOrdering,
  checkPersistenceOrdering,
  checkHysteresisSanity,
  checkDefaultProfilePresent,
};
