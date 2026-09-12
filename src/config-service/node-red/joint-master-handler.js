'use strict';

const { validateModbusJoints } = require('../validate-modbus-joints');
const { resolveAmbientChain } = require('../ambient-resolution');
const { nanoJobsEqual } = require('../nano-compiler');
// Same reverse-map the remote-config path uses to rebuild dashboard drafts.
// No cycle: remote-config-handler does not require this module.
const { buildLegacyDrafts } = require('./remote-config-handler');

function findSlave(slaveList, id) {
  return slaveList.find((s) => s.slaveID == id); // eslint-disable-line eqeqeq -- legacy draft rows store slaveID as either string or number
}

function findZone(zones, id) {
  return zones.find((z) => z.zone_id == id); // eslint-disable-line eqeqeq
}

// A new row inherits from its zone - '' is the dropdown's inherit option.
const EMPTY_ROW = () => ({ joint_name: '', joint_id: '', slaveID: '', channel: 1, ambientSlaveID: '', zone_id: '', threshold_profile: '', editing: true });

/**
 * A profile selection from a draft row, or `null` for "inherit".
 *
 * CORRECTED 2026-09-12 (live report). This used to map an empty selection to
 * 'default', which killed the whole zone feature: `applyJoints` writes what this
 * returns onto EVERY joint, and an explicit value beats the joint's zone in the
 * resolution chain. So every joint carried an explicit 'default' and no zone
 * profile could ever take effect - the zone column was decorative.
 *
 * Empty now means **absent**, and the caller omits the field. The three states
 * are distinct and all reachable:
 *
 *   omitted    -> inherit from the zone (the dropdown's "inherit" option)
 *   'default'  -> the panel-wide set, explicitly, IGNORING the zone
 *   '<name>'   -> that profile, ignoring the zone
 *
 * Trimmed because the value reaches a schema pattern with no room for stray
 * whitespace.
 */
function normaliseProfile(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return name === '' ? null : name;
}

/** Legacy draft rows predate the channel column - treat a missing/blank channel as 1. */
function rowChannel(j) {
  const ch = Number(j.channel);
  return Number.isInteger(ch) && ch >= 1 ? ch : 1;
}

/** Preserves the incoming msg's other properties (topic, req/res, socketid, _msgid, ...) - only payload changes. */
function withPayload(msg, payload) {
  return { ...msg, payload };
}

/**
 * Every reply carries the profile names the zone and joint dropdowns offer.
 *
 * Attached here rather than in each of the handler's many return points, and
 * NOT in the function node, which stays thin. Sent on every reply because the
 * table re-renders from whatever the last message carried: omit it on one path
 * and the dropdowns empty themselves the moment an operator saves a row.
 *
 * Read from cfg/alarms, so it is always the set A3 will actually accept - a
 * dropdown that offered a name the validator then rejected would be worse than
 * a free-text box.
 */
function availableProfileNames(store) {
  try {
    const names = Object.keys(store?.readDomain?.('alarms')?.doc?.profiles ?? {});
    // 'default' always offered, even on a panel with no alarms document yet:
    // it is what an unbound joint resolves to, so it must be selectable.
    if (!names.includes('default')) names.unshift('default');
    return names.sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)));
  } catch {
    return ['default'];
  }
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
 * @returns {{msg: object|null, draft: Array|null, resendNeeded?: boolean, audit?: object|null}} draft is null when nothing
 *   needs persisting; resendNeeded is true only after a successful 'apply' whose compiled Nano job
 *   actually differs from what's currently applied (see nano-compiler.js's nanoJobsEqual) - a
 *   joint/zone-only edit leaves modbus.slaves/buses untouched, so it does NOT trigger a resend
 */
function handleJointMasterMessage(msg, deps) {
  const out = handleJointMasterMessageInner(msg, deps);
  if (out && out.msg && out.msg.payload && typeof out.msg.payload === 'object') {
    out.msg.payload.profile_names = availableProfileNames(deps?.store);
  }
  return out;
}

/**
 * Rebuild the editing draft from the APPLIED document when the draft is empty.
 *
 * WHY (live 2026-09-12, twice): the joint table renders from the legacy DRAFT
 * global, not from the applied configuration. If that draft is ever empty - and
 * only this node writes it, so a context-store reset, a fresh panel, or a
 * restore leaves it so - the operator sees a COMPLETELY BLANK table while the
 * panel is happily monitoring 88 commissioned joints. Nothing is wrong with the
 * configuration; only the editing copy of it is missing, and there is no button
 * that rebuilds it.
 *
 * `buildLegacyDrafts` already does exactly this reverse-map for the remote-config
 * path, so the same rows the operator would see after a cloud push are what they
 * get here.
 *
 * FOR DISPLAY ONLY - this deliberately does NOT persist. Writing the draft from
 * a read would be a side effect on a refresh poll, and it is not needed: the
 * template sends its full array back on every action, so the first real edit
 * carries these rows and the normal persistence path takes over.
 *
 * TRADE-OFF, accepted: an operator who deletes every row and does NOT apply will
 * see them come back on the next refresh, because the applied document still has
 * them. An unapplied mass-deletion is not a committed intent, and the
 * Configuration Status banner names saved-but-not-applied differences - whereas a
 * permanently blank config screen has no route out at all.
 */
function draftFromAppliedIfEmpty(joints, store) {
  if (Array.isArray(joints) && joints.length > 0) return joints;
  try {
    const applied = store?.readDomain?.('modbus_joints')?.doc;
    if (!applied?.joints?.length) return joints;
    return buildLegacyDrafts(applied).joints;
  } catch {
    // A blank table is bad; a thrown config screen is worse.
    return joints;
  }
}

function handleJointMasterMessageInner(msg, deps) {
  const { slaveList, zones, store, user = 'UI' } = deps;
  const action = msg.payload?.action;
  const index = msg.payload?.index;

  if (action === 'apply') {
    const original = Array.isArray(msg.payload?.joints) ? msg.payload.joints : deps.joints;
    return applyJoints(msg, original, zones, slaveList, store, user);
  }

  let joints = [...(Array.isArray(msg.payload?.joints) ? msg.payload.joints : deps.joints)];

  // Only on a plain load: an action carries the client's own array, and second-
  // guessing that is how the data-loss bug worked.
  if (!action) joints = draftFromAppliedIfEmpty(joints, store);

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
    const ch = Number(j.channel ?? 1);
    if (!Number.isInteger(ch) || ch < 1 || ch > 8) {
      return { msg: withPayload(msg, { joints, zones, error: 'Channel must be 1-8', action: 'save' }), draft: null };
    }
    if (!z) {
      return { msg: withPayload(msg, { joints, zones, error: 'Invalid Zone', action: 'save' }), draft: null };
    }

    j.channel = ch;
    j.slaveName = s.parameterName;
    j.slaveTooltip = `Slave ${s.slaveID}\n${s.parameterName}`;
    j.zone_name = z.zone_name;
    j.editing = false;
    joints[index] = j;

    return {
      msg: withPayload(msg, { joints, zones, success: 'Saved', action: 'save' }),
      draft: joints,
      audit: {
        timestamp: new Date().toISOString(),
        user: msg.payload?.user || 'UI',
        action: 'SAVE_ROW',
        details: `Joint ${j.joint_id}: slave ${j.slaveID} ch ${j.channel}, zone ${j.zone_id}`,
      },
    };
  }

  let deleteAudit = null;
  if (action === 'delete' && joints[index]) {
    const removed = joints.splice(index, 1)[0];
    deleteAudit = {
      timestamp: new Date().toISOString(),
      user: msg.payload?.user || 'UI',
      action: 'DELETE_ROW',
      details: `Joint ${removed.joint_id || '(unnamed)'} removed from draft`,
    };
  }

  const anyEditing = joints.some((j) => j.editing === true);
  if (anyEditing && !action) {
    return { msg: null, draft: null }; // safe refresh: suppress output, don't clobber an in-progress edit
  }

  const mutatingActions = new Set(['add', 'add_below', 'edit', 'delete']);
  return { msg: withPayload(msg, { joints, zones }), draft: mutatingActions.has(action) ? joints : null, audit: deleteAudit };
}

function applyJoints(msg, joints, zones, slaveList, store, user) {
  // Legacy-shape pre-checks first, for the same friendly per-row errors the dashboard already shows.
  const usedJoint = new Set();
  const usedSlaveChannel = new Map();
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
    // One physical probe = one joint: the same (slave, channel) pair may not
    // repeat across joints. Different channels of the same slave are fine.
    const pair = `${j.slaveID}:${rowChannel(j)}`;
    if (usedSlaveChannel.has(pair)) {
      return {
        msg: withPayload(msg, {
          joints,
          zones,
          error: `Slave ${j.slaveID} channel ${rowChannel(j)} is already mapped to joint ${usedSlaveChannel.get(pair)}`,
          action: 'apply',
        }),
        draft: null,
      };
    }
    usedJoint.add(j.joint_id);
    usedSlaveChannel.set(pair, j.joint_id);
  }

  const { doc: currentModbusJoints } = store.readDomain('modbus_joints');
  const { doc: currentAlarms } = store.readDomain('alarms');
  if (!currentModbusJoints) {
    return {
      msg: withPayload(msg, { joints, zones, error: 'No cfg/modbus applied yet - run the migration/commissioning step first', action: 'apply' }),
      draft: null,
    };
  }

  const slavesByAddress = new Map(currentModbusJoints.modbus.slaves.map((s) => [s.unit_address, s]));
  const missingSlave = joints.find((j) => !slavesByAddress.has(Number(j.slaveID)));
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

  // Friendly version of R6: the selected channel must exist on the commissioned slave.
  for (const j of joints) {
    const slave = slavesByAddress.get(Number(j.slaveID));
    const channels = slave.channels ?? 4;
    if (rowChannel(j) > channels) {
      return {
        msg: withPayload(msg, {
          joints,
          zones,
          error: `Slave ${j.slaveID} only has ${channels} channel${channels > 1 ? 's' : ''} - joint ${j.joint_id} selects channel ${rowChannel(j)}`,
          action: 'apply',
        }),
        draft: null,
      };
    }
  }

  const newJoints = joints.map((j) => ({
    joint_id: j.joint_id,
    // The operator-facing location, a MANDATORY column in the joint table. It
    // used to live only in the legacy draft, so repointing ProcessLogic at the
    // applied document (2026-09-01) silently lost it from every alarm - the
    // e-mail body went back to "Joint: J02". The name belongs in the applied
    // config like everything else the panel runs on.
    label: j.joint_name,
    slave_id: slavesByAddress.get(Number(j.slaveID)).slave_id,
    channel: rowChannel(j),
    zone_id: j.zone_id.toLowerCase(),
    enabled: true,
  }));

  // The profile is attached separately because "inherit from the zone" is the
  // ABSENCE of the key, and spreading `undefined` into the literal above would
  // still create it - which is how the zone feature came to be dead on arrival.
  for (let i = 0; i < newJoints.length; i += 1) {
    const profile = normaliseProfile(joints[i].threshold_profile);
    if (profile !== null) newJoints[i].threshold_profile = profile;
  }

  const chainInput = joints.map((j) => ({ joint_id: j.joint_id, zone_id: j.zone_id.toLowerCase(), legacyAmbientId: j.ambientSlaveID }));
  const legacyAmbientIdToNewSlaveId = new Map(
    currentModbusJoints.modbus.slaves.map((s) => [s.unit_address, s.slave_id])
  );
  // A zone's profile is carried the same way, and omitted when it is 'default':
  // the schema treats an absent zone binding as "no zone-level override", which
  // is what lets a joint's own 'default' stay meaningful against a zone that
  // sets one. Writing 'default' explicitly on every zone would be a binding.
  const newZones = zones.map((z) => {
    const profile = normaliseProfile(z.threshold_profile);
    // Both "no override" and an explicit 'default' store nothing: an absent zone
    // binding IS "no zone-level override", and writing 'default' would be a
    // redundant binding that reads as a deliberate choice.
    const bind = profile !== null && profile !== 'default';
    return {
      zone_id: z.zone_id.toLowerCase(),
      name: z.zone_name,
      ...(bind ? { threshold_profile: profile } : {}),
    };
  });
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
      audit: {
        timestamp: new Date().toISOString(),
        user,
        action: 'APPLY_CONFIG',
        details: `REJECTED: ${result.errors.map((e) => `${e.rule}: ${e.message}`).join('; ')}`,
      },
    };
  }

  const savedJoints = joints.map((j) => ({ ...j, editing: false }));
  return {
    msg: withPayload(msg, { joints: savedJoints, zones, success: 'Configuration saved', action: 'apply' }),
    draft: savedJoints,
    // joint/zone-only edits always spread modbus.slaves/buses through unchanged, so most
    // applies don't actually change what the Nano needs to poll - only resend when the
    // compiled job itself differs, since a resend briefly disrupts live polling (the
    // firmware re-inits Serial1/timeout on every job update - see nano-compiler.js).
    resendNeeded: !nanoJobsEqual(currentModbusJoints, newDoc),
    audit: {
      timestamp: new Date().toISOString(),
      user,
      action: 'APPLY_CONFIG',
      details: `${newJoints.length} joint(s) applied (modbus v${newDoc.config_domain_versions.modbus}, joints v${newDoc.config_domain_versions.joints})`,
    },
  };
}

module.exports = { handleJointMasterMessage };
