'use strict';

const { MESSAGE_TYPES, SCHEMA_VERSION } = require('../../cloud-gateway/message-types');

const { nanoJobsEqual } = require('../nano-compiler');

/**
 * Slice 7: processes one message from the remote config channel
 * (cmd/{c}/{s}/{p}/config) and produces the ack plus every local side
 * effect the wrapper must apply. Pure - no context/transport access
 * here.
 *
 * Message envelope (published by the cloud, QoS 1):
 *   {
 *     "request_id": "opaque string echoed in the ack",
 *     "user":       "who/what pushed (goes into the audit trail)",
 *     "domain":     "alarms" | "modbus_joints" | "edge",
 *     "doc":        <domain document>
 *   }
 *
 * - alarms:        full cfg/alarms document -> A-rules; freely tunable
 *                  (no maintenance gate). On success the flat default
 *                  profile is returned as runtimeConfig for the
 *                  busbartherm_system_config global - the live Alarm
 *                  Manager evaluates every sample against it, which is
 *                  A10's live re-evaluation: raise/clear through the
 *                  normal persistence paths, never a mass-clear.
 * - modbus_joints: full cfg/modbus+joints document -> R-rules with
 *                  source:'remote', so R12 rejects unless the panel is
 *                  in maintenance mode. On success returns the legacy
 *                  bridge + rebuilt dashboard drafts + content-aware
 *                  resendNeeded (nanoJobsEqual), exactly like a local
 *                  Modbus Settings apply.
 * - edge:          runtime knobs outside the schema domains. First
 *                  knob: {"telemetry_interval_min": N} (1-1440).
 *
 * Ack shape (published on cmd/.../config/ack, QoS 1 via the outbox
 * alarm class so it survives a link drop):
 *   { request_id, domain, result: "applied"|"rejected",
 *     applied_versions?, errors?: [{rule, message}], timestamp }
 *
 * @param {object} payload - the parsed cmd message
 * @param {object} deps
 * @param {import('../store').ConfigStore} deps.store
 * @param {boolean} deps.maintenanceMode - local maintenance-mode flag (R12)
 * @param {{min: number, max: number, apply: Function}} deps.telemetryInterval -
 *   bounds + applier for the edge knob (wrapper passes the gateway's setter)
 * @returns {{ack: object, applied: boolean, domain: string|null,
 *   runtimeConfig?: object, legacy?: object, drafts?: {joints: Array, zones: Array},
 *   resendNeeded?: boolean, audits?: Array<{key: string, entry: object}>}}
 */
function processRemoteConfig(payload, deps) {
  const { store, maintenanceMode = false } = deps;
  const requestId = typeof payload?.request_id === 'string' ? payload.request_id : null;
  const user = typeof payload?.user === 'string' ? `remote:${payload.user}` : 'remote';
  const domain = payload?.domain;

  const ack = (result, extra = {}) => ({
    type: MESSAGE_TYPES.CONFIG_ACK,
    v: SCHEMA_VERSION,
    request_id: requestId,
    domain: typeof domain === 'string' ? domain : null,
    result,
    ...extra,
    timestamp: new Date().toISOString(),
  });
  const rejected = (errors) => ({ ack: ack('rejected', { errors }), applied: false, domain: domain ?? null });

  if (!payload || typeof payload !== 'object') {
    return rejected([{ rule: 'ENVELOPE', message: 'payload must be a JSON object' }]);
  }
  if (!['alarms', 'modbus_joints', 'edge'].includes(domain)) {
    return rejected([{ rule: 'ENVELOPE', message: `unknown domain '${domain}' - expected alarms | modbus_joints | edge` }]);
  }
  if (!payload.doc || typeof payload.doc !== 'object') {
    return rejected([{ rule: 'ENVELOPE', message: 'doc (the domain document) is required' }]);
  }

  if (domain === 'edge') {
    return applyEdgeKnobs(payload.doc, deps, ack, user);
  }

  if (domain === 'alarms') {
    const { doc: currentModbusJoints } = store.readDomain('modbus_joints');
    const { doc: currentAlarmsDoc } = store.readDomain('alarms');
    // the audit "before" value: the flat default profile currently applied
    const beforeFlat = currentAlarmsDoc?.profiles?.default
      ? { deltaT: currentAlarmsDoc.profiles.default.deltaT, ror: currentAlarmsDoc.profiles.default.ror, persistence: currentAlarmsDoc.profiles.default.persistence }
      : null;
    const result = store.applyIfValid(
      'alarms',
      payload.doc,
      { source: 'remote', jointsDoc: currentModbusJoints, modbusDoc: currentModbusJoints },
      user
    );
    const p = payload.doc?.profiles?.default;
    const attemptedFlat = p ? { deltaT: p.deltaT, ror: p.ror, persistence: p.persistence } : payload.doc;
    if (!result.applied) {
      return {
        ...rejected(result.errors.map((e) => ({ rule: e.rule, message: e.message }))),
        audits: [remoteAudit('audit_busbartherm', user, 'REMOTE_REJECTED', beforeFlat, attemptedFlat)],
      };
    }
    const runtimeConfig = attemptedFlat;
    return {
      ack: ack('applied', { applied_versions: result.appliedVersions }),
      applied: true,
      domain,
      runtimeConfig,
      audits: [remoteAudit('audit_busbartherm', user, 'REMOTE_APPLY', beforeFlat, runtimeConfig)],
    };
  }

  // modbus_joints
  const { doc: before } = store.readDomain('modbus_joints');
  const { doc: currentAlarms } = store.readDomain('alarms');
  const result = store.applyIfValid(
    'modbus_joints',
    payload.doc,
    { source: 'remote', maintenanceMode, alarmsDoc: currentAlarms },
    user
  );
  if (!result.applied) {
    return {
      ...rejected(result.errors.map((e) => ({ rule: e.rule, message: e.message }))),
      audits: [
        {
          key: 'joint_config_audit_log',
          entry: {
            timestamp: new Date().toISOString(),
            user,
            action: 'APPLY_CONFIG',
            details: `REMOTE REJECTED: ${result.errors.map((e) => e.rule).join(', ')}`,
          },
        },
      ],
    };
  }

  const drafts = buildLegacyDrafts(payload.doc);
  // Per-bus resend, exactly like a local Modbus Settings apply: each RS-485
  // segment is its own Nano with its own job, and the firmware re-inits its
  // Modbus timeout on every job update, so a resend is not a free no-op.
  //
  // This MUST pass a busId. `nanoJobsEqual(a, b)` with none errors out on a
  // multi-bus document and reports "not equal", which would make every remote
  // apply - even a label-only one - resend every segment, throwing away the
  // content-aware behaviour the local path has.
  const resendBusIds = (payload.doc.modbus?.buses || [])
    .map((b) => b.bus_id)
    .filter((busId) => !before || !nanoJobsEqual(before, payload.doc, busId));
  return {
    ack: ack('applied', { applied_versions: result.appliedVersions }),
    applied: true,
    domain,
    // the wrapper reuses the Modbus Settings bridge so the decode
    // pipeline and dashboards follow the remote change like a local one
    resendNeeded: resendBusIds.length > 0,
    resendBusIds,
    drafts,
    newDoc: payload.doc,
    audits: [
      {
        key: 'joint_config_audit_log',
        entry: {
          timestamp: new Date().toISOString(),
          user,
          action: 'APPLY_CONFIG',
          details: `REMOTE: ${payload.doc.joints.length} joint(s), ${payload.doc.modbus.slaves.length} slave(s) applied (modbus v${payload.doc.config_domain_versions.modbus})`,
        },
      },
    ],
  };
}

function applyEdgeKnobs(doc, deps, ack, user) {
  const knownKnobs = ['telemetry_interval_min'];
  const unknown = Object.keys(doc).filter((k) => !knownKnobs.includes(k));
  if (unknown.length > 0) {
    return {
      ack: ack('rejected', { errors: [{ rule: 'EDGE', message: `unknown edge setting(s): ${unknown.join(', ')}` }] }),
      applied: false,
      domain: 'edge',
    };
  }
  if (doc.telemetry_interval_min === undefined) {
    return {
      ack: ack('rejected', { errors: [{ rule: 'EDGE', message: 'no recognized edge setting in doc' }] }),
      applied: false,
      domain: 'edge',
    };
  }
  const error = deps.telemetryInterval.apply(doc.telemetry_interval_min);
  if (error) {
    return { ack: ack('rejected', { errors: [{ rule: 'EDGE', message: error }] }), applied: false, domain: 'edge' };
  }
  return {
    ack: ack('applied', { applied_versions: { telemetry_interval_min: doc.telemetry_interval_min } }),
    applied: true,
    domain: 'edge',
    audits: [
      {
        key: 'joint_config_audit_log',
        entry: {
          timestamp: new Date().toISOString(),
          user,
          action: 'APPLY_CONFIG',
          details: `REMOTE: telemetry interval set to ${doc.telemetry_interval_min} min`,
        },
      },
    ],
  };
}

function remoteAudit(key, user, action, oldConfig, newConfig) {
  return { key, entry: { ts: new Date().toISOString(), user, action, oldConfig, newConfig } };
}

/**
 * Rebuilds the legacy dashboard draft shapes from a freshly applied
 * cfg/modbus+joints document, so the joint/zone tables show the remote
 * change instead of stale drafts. Reverse of the local apply mapping:
 * schema slave_id -> legacy slaveID (unit address), lowercase zone ids
 * -> the uppercase legacy form, effective ambient (joint -> zone ->
 * panel chain) -> the flat per-joint ambientSlaveID.
 */
function buildLegacyDrafts(doc) {
  const slaveById = new Map(doc.modbus.slaves.map((s) => [s.slave_id, s]));
  const zoneById = new Map((doc.zones || []).map((z) => [z.zone_id, z]));

  const zones = (doc.zones || []).map((z) => ({
    zone_id: z.zone_id.toUpperCase(),
    zone_name: z.name,
    editing: false,
  }));

  const channelLabel = (slave, channel) =>
    slave.registers.channel_labels?.[channel - 1] ?? slave.label ?? slave.model;

  const joints = doc.joints.map((j) => {
    const slave = slaveById.get(j.slave_id);
    const zone = zoneById.get(j.zone_id);
    const effAmbient = j.ambient_sensor ?? zone?.ambient_sensor ?? doc.modbus.ambient_sensor ?? null;
    const ambientSlave = effAmbient ? slaveById.get(effAmbient.slave_id) : null;
    const label = channelLabel(slave, j.channel ?? 1);
    return {
      joint_name: j.label ?? j.joint_id,
      joint_id: j.joint_id,
      slaveID: slave.unit_address,
      channel: j.channel ?? 1,
      slaveName: label,
      slaveTooltip: `Slave ${slave.unit_address}\n${label}`,
      zone_id: j.zone_id.toUpperCase(),
      zone_name: zone?.name ?? 'Unknown',
      ambientSlaveID: ambientSlave ? ambientSlave.unit_address : '',
      editing: false,
    };
  });

  return { joints, zones };
}

module.exports = { processRemoteConfig, buildLegacyDrafts };
