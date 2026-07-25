'use strict';

const { validateIntegrationSchema, formatAjvErrors } = require('./schemas');
const { mapExtent } = require('../integration/register-map');

function err(rule, message) {
  return { rule, message };
}
function warn(rule, message) {
  return { rule, message };
}

/**
 * Validates a cfg/integration document (Slice 11 BMS domain): JSON Schema
 * (I1) plus the cross-field / cross-domain rules below. Follows the same
 * shape as validateAlarms / validateModbusJoints — returns
 * { valid, errors, warnings }.
 *
 *  I1  schema
 *  I2  (warning) TCP port < 1024 needs a privileged bind
 *  I3  exposure_tier >= 2 must have at least one alarmable zone in cfg/joints
 *  I4  point_map_version must not DECREASE across an apply (append-only map)
 *  I5  the generated register map must fit the Modbus address space AND build
 *      cleanly (too many zones/joints, bitmap overflow, etc.)
 *
 * @param {object} doc - the cfg/integration document
 * @param {object} [context]
 * @param {object} [context.jointsDoc] - applied cfg/joints, for I3/I5
 * @param {number} [context.appliedPointMapVersion] - applied point_map_version, for I4
 * @param {number} [context.appliedVersion] - applied integration domain version (monotonicity, like A6)
 * @returns {{valid: boolean, errors: {rule,message}[], warnings: {rule,message}[]}}
 */
function validateIntegration(doc, context = {}) {
  const schemaValid = validateIntegrationSchema(doc);
  if (!schemaValid) {
    return { valid: false, errors: formatAjvErrors(validateIntegrationSchema.errors), warnings: [] };
  }

  const errors = [];
  const warnings = [];

  // I2 — privileged port warning (not fatal; a capability or nftables redirect can grant it)
  if (doc.modbus_tcp.port < 1024) {
    warnings.push(warn('I2', `modbus_tcp.port ${doc.modbus_tcp.port} is privileged (<1024); the Node-RED user needs CAP_NET_BIND_SERVICE or a port >=1024 to bind it`));
  }

  // Domain version monotonicity (mirrors A6/R11) — an apply must advance it
  if (context.appliedVersion != null) {
    const incoming = doc.config_domain_versions.integration;
    if (incoming <= context.appliedVersion) {
      errors.push(err('I4', `config_domain_versions.integration (${incoming}) must be greater than the applied version (${context.appliedVersion})`));
    }
  }

  // I4 — point-map append-only: the version may only advance, never regress.
  if (context.appliedPointMapVersion != null && doc.point_map_version < context.appliedPointMapVersion) {
    errors.push(err('I4', `point_map_version ${doc.point_map_version} is below the applied ${context.appliedPointMapVersion}; the register map is append-only and must never be renumbered/regressed`));
  }

  // I3 — Tier 2+ needs zones to roll up into.
  if (doc.exposure_tier >= 2 && context.jointsDoc) {
    const includeAmbient = !!doc.zone_rollup?.include_ambient_zone;
    const zones = new Set(
      (context.jointsDoc.zones || []).map((z) => z.zone_id)
        .concat((context.jointsDoc.joints || []).map((j) => j.zone_id).filter((z) => z != null))
    );
    if (!includeAmbient) { zones.delete('AMBIENT'); zones.delete('AMBIENT_ZONE'); }
    if (zones.size === 0) {
      errors.push(err('I3', `exposure_tier ${doc.exposure_tier} exposes a per-zone block, but cfg/joints defines no alarmable zones`));
    }
  }

  // I5 — the generated map must build and fit the address space.
  if (context.jointsDoc) {
    const extent = mapExtent(doc, context.jointsDoc);
    if (extent && extent.error) {
      errors.push(err('I5', `register map cannot be built: ${extent.error}`));
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

module.exports = { validateIntegration };
