'use strict';

const { validateModbusJoints } = require('../validate-modbus-joints');
const { resolveAmbientChain } = require('../ambient-resolution');

function findSlave(slaveList, id) {
  return slaveList.find((s) => s.slaveID == id); // eslint-disable-line eqeqeq -- legacy draft rows store slaveID as either string or number
}

function findZone(zones, id) {
  return zones.find((z) => z.zone_id == id); // eslint-disable-line eqeqeq
}

const EMPTY_ROW = () => ({ joint_name: '', joint_id: '', slaveID: '', ambientSlaveID: '', zone_id: '', editing: true });

/** Preserves the incoming msg's other properties (topic, req/res, socketid, _msgid, ...) - only payload changes. */
function withPayload(msg, payload) {
  return { ...msg, payload };
}

/**
 * Thin Node-RED handler replacing "JointMasterBackEndNode". add/edit/
 * delete/save-one-row keep operating on the legacy draft shape exactly
 * as before (they're UI-side bookkeeping on an intentionally-incomplete
 * in-progress array, which can't be schema-validated mid-edit) - only
 * 'apply' is replaced: instead of a hand-rolled duplicate/missing-field
 * check plus a raw global.set, it transforms the completed draft into
 * the new cfg/modbus+joints shape and pushes it through the real
 * validator + ConfigStore, so R1-R14/R11/R12/R13 all apply for real.
 *
 * Mirrors the legacy node's control flow exactly: add/add_below/edit/
 * delete all fall through to the same final "send {joints, zones}"
 * output (the dashboard table repaints after every draft edit, not
 * just after save/apply) - only the "no action, something mid-edit"
 * case suppresses output, to avoid clobbering an in-progress edit on a
 * plain refresh poll.
 *
 * The caller (the actual Node-RED function node) owns all global
 * context access - this function is pure: given the current draft,
 * the legacy slave/zone lookup lists (still sourced from
 * SlaveIDList/zone_master - unchanged, since the dashboard's dropdowns
 * depend on them and this refactor doesn't touch slave/zone
 * commissioning), and the ConfigStore, it returns what to send and
 * what (if anything) to persist back into the draft global.
 *
 * @param {object} msg - Node-RED msg; msg.payload = {action, index?, joints?}
 * @param {object} deps
 * @param {Array} deps.joints - current draft (from global.get("joint_master_zone_A"))
 * @param {Array} deps.slaveList - legacy SlaveIDList
 * @param {Array} deps.zones - legacy zone_master
 * @param {import('../store').ConfigStore} deps.store
 * @param {string} [deps.user]
 * @returns {{msg: object|null, draft: Array|null}} draft is null when nothing needs persisting
 */
function handleJointMasterMessage(msg, deps) {
  const { slaveList, zones, store, user = 'UI' } = deps;
  const action = msg.payload?.action;
  const index = msg.payload?.index;

  if (action === 'apply') {
    const original = Array.isArray(msg.payload?.joints) ? msg.payload.joints : deps.joints;
    return applyJoints(msg, original, zones, slaveList, store, user);
  }

  let joints = [...(Array.isArray(msg.payload?.joints) ? msg.payload.joints : deps.joints)];

  if (action === 'add') {
    joints.push(EMPTY_ROW());
  }

  if (action === 'add_below' && joints[index]) {
    joints.splice(index + 1, 0, EMPTY_ROW());
  }

  if (action === 'edit' && joints[index]) {
    joints[index] = { ...joints[index], editing: true };
  }

  if (action === 'save' && joints[index]) {
    const j = { ...joints[index] };
    const s = findSlave(slaveList, j.slaveID);
    const z = findZone(zones, j.zone_id);

    if (!j.joint_name || !j.joint_id || j.slaveID === '') {
      return { msg: withPayload(msg, { joints, zones, error: 'Missing fields', action: 'save' }), draft: null };
    }
    if (!s) {
      return { msg: withPayload(msg, { joints, zones, error: 'Invalid Slave', action: 'save' }), draft: null };
    }
    if (!z) {
      return { msg: withPayload(msg, { joints, zones, error: 'Invalid Zone', action: 'save' }), draft: null };
    }

    j.slaveName = s.parameterName;
    j.slaveTooltip = `Slave ${s.slaveID}\n${s.parameterName}`;
    j.zone_name = z.zone_name;
    j.editing = false;
    joints[index] = j;

    return { msg: withPayload(msg, { joints, zones, success: 'Saved', action: 'save' }), draft: joints };
  }

  if (action === 'delete' && joints[index]) {
    joints.splice(index, 1);
  }

  const anyEditing = joints.some((j) => j.editing === true);
  if (anyEditing && !action) {
    return { msg: null, draft: null }; // safe refresh: suppress output, don't clobber an in-progress edit
  }

  const mutatingActions = new Set(['add', 'add_below', 'edit', 'delete']);
  return { msg: withPayload(msg, { joints, zones }), draft: mutatingActions.has(action) ? joints : null };
}

function applyJoints(msg, joints, zones, slaveList, store, user) {
  // Legacy-shape pre-checks first, for the same friendly per-row errors the dashboard already shows.
  const usedJoint = new Set();
  const usedSlave = new Set();
  for (const j of joints) {
    const s = findSlave(slaveList, j.slaveID);
    const z = findZone(zones, j.zone_id);

    if (!j.joint_name || !j.joint_id || j.slaveID === '') {
      return { msg: withPayload(msg, { joints, zones, error: 'Incomplete rows', action: 'apply' }), draft: null };
    }
    if (!s) return { msg: withPayload(msg, { joints, zones, error: 'Invalid Slave', action: 'apply' }), draft: null };
    if (!z) return { msg: withPayload(msg, { joints, zones, error: 'Invalid Zone', action: 'apply' }), draft: null };
    if (usedJoint.has(j.joint_id)) {
      return { msg: withPayload(msg, { joints, zones, error: 'Duplicate Joint ID', action: 'apply' }), draft: null };
    }
    if (usedSlave.has(j.slaveID)) {
      return { msg: withPayload(msg, { joints, zones, error: 'Duplicate Slave ID', action: 'apply' }), draft: null };
    }
    usedJoint.add(j.joint_id);
    usedSlave.add(j.slaveID);
  }

  const { doc: currentModbusJoints } = store.readDomain('modbus_joints');
  const { doc: currentAlarms } = store.readDomain('alarms');
  if (!currentModbusJoints) {
    return {
      msg: withPayload(msg, { joints, zones, error: 'No cfg/modbus applied yet - run the migration/commissioning step first', action: 'apply' }),
      draft: null,
    };
  }

  const unitAddressToNewSlaveId = new Map(currentModbusJoints.modbus.slaves.map((s) => [s.unit_address, s.slave_id]));
  const missingSlave = joints.find((j) => !unitAddressToNewSlaveId.has(Number(j.slaveID)));
  if (missingSlave) {
    return {
      msg: withPayload(msg, {
        joints,
        zones,
        error: `Slave ${missingSlave.slaveID} is not yet provisioned in cfg/modbus - commission it first`,
        action: 'apply',
      }),
      draft: null,
    };
  }

  const newJoints = joints.map((j) => ({
    joint_id: j.joint_id,
    slave_id: unitAddressToNewSlaveId.get(Number(j.slaveID)),
    channel: 1,
    zone_id: j.zone_id.toLowerCase(),
    enabled: true,
    threshold_profile: 'default',
  }));

  const chainInput = joints.map((j) => ({ joint_id: j.joint_id, zone_id: j.zone_id.toLowerCase(), legacyAmbientId: j.ambientSlaveID }));
  const legacyAmbientIdToNewSlaveId = new Map(
    currentModbusJoints.modbus.slaves.map((s) => [s.unit_address, s.slave_id])
  );
  const newZones = zones.map((z) => ({ zone_id: z.zone_id.toLowerCase(), name: z.zone_name }));
  const { panelDefaultSlaveId, zoneOverrides, jointOverrides } = resolveAmbientChain(chainInput, newZones, legacyAmbientIdToNewSlaveId);
  for (const zone of newZones) {
    if (zoneOverrides.has(zone.zone_id)) zone.ambient_sensor = { slave_id: zoneOverrides.get(zone.zone_id), channel: 1 };
  }
  for (const j of newJoints) {
    if (jointOverrides.has(j.joint_id)) j.ambient_sensor = { slave_id: jointOverrides.get(j.joint_id), channel: 1 };
  }

  const newDoc = {
    config_domain_versions: {
      modbus: currentModbusJoints.config_domain_versions.modbus + 1,
      joints: currentModbusJoints.config_domain_versions.joints + 1,
    },
    modbus: {
      ...currentModbusJoints.modbus,
      ...(panelDefaultSlaveId ? { ambient_sensor: { slave_id: panelDefaultSlaveId, channel: 1 } } : {}),
    },
    joints: newJoints,
    zones: newZones,
  };

  const result = store.applyIfValid('modbus_joints', newDoc, { source: 'local', alarmsDoc: currentAlarms }, user);

  if (!result.applied) {
    return {
      msg: withPayload(msg, {
        joints,
        zones,
        error: result.errors.map((e) => `${e.rule}: ${e.message}`).join('; '),
        action: 'apply',
      }),
      draft: null,
    };
  }

  const savedJoints = joints.map((j) => ({ ...j, editing: false }));
  return { msg: withPayload(msg, { joints: savedJoints, zones, success: 'Configuration saved', action: 'apply' }), draft: savedJoints };
}

module.exports = { handleJointMasterMessage };
