'use strict';

const { nanoJobsEqual } = require('../nano-compiler');

/**
 * Thin Node-RED handler behind the new schema-backed "Modbus Settings"
 * dashboard - the replacement for the legacy "Parameter - Modbus
 * Configuration" + "Comm Parameters" pair, which built Nano jobs from
 * raw dashboard input with no schema/R-rule validation and no
 * connection to cfg/modbus in the ConfigStore (see the OPEN DESIGN GAP
 * note in CLAUDE.md; the user has since decided this schema-backed
 * path is authoritative).
 *
 * Editing model mirrors joint-master-handler: add/edit/delete/save are
 * draft bookkeeping on an intentionally-incomplete in-progress table
 * (can't be schema-validated mid-edit); only 'apply' builds a full
 * cfg/modbus+joints document and pushes it through the real validator
 * + ConfigStore. The client sends its current {slaves, bus} state on
 * every action (lesson from the JointMasterUI data-loss bug - the
 * server must never respond from a stale server-side copy).
 *
 * UI row shape (draft, not the schema shape):
 *   { slave_id?, label, unit_address, model, channels, temp_base_addr,
 *     temp_word_count, temp_scale, poll_interval_s, editing }
 * slave_id is carried invisibly for existing slaves so joint mappings
 * survive edits (schema: "Stable even if unit_address changes"); new
 * rows get the lowest unused one at apply time.
 *
 * Bus form shape (single RTU bus - the firmware has one RS-485 port,
 * and compileNanoJob rejects multi-bus docs for the same reason):
 *   { port, baud, parity, stop_bits, timeout_ms, retries, inter_frame_ms }
 *
 * On a successful apply this also derives the legacy global-context
 * values (SlaveIDList, slaveLength, parameterName{i}/parameterID{i}/
 * sID{i}/sregisterAddress{i}/sdataBits{i}, the comm globals, and
 * paraRaw) that the existing sensor-decode pipeline on the
 * modbusMaster_V2 tab still consumes - ~40 function nodes read those,
 * and they keep working unchanged. parameterID (the legacy decode-type
 * selector) has no schema equivalent; it's carried over per
 * unit_address from the current SlaveIDList, and new slaves default to
 * the panel's most common existing type.
 *
 * @param {object} msg - Node-RED msg; msg.payload = {action?, index?, slaves?, bus?}
 * @param {object} deps
 * @param {import('../store').ConfigStore} deps.store
 * @param {{slaves: Array, bus: object}|null} [deps.draft] - persisted draft (global 'modbus_settings_draft')
 * @param {Array} [deps.legacySlaveList] - current global SlaveIDList, for parameterID carry-over and label recovery
 * @param {string} [deps.user]
 * @returns {{msg: object|null, draft: {slaves: Array, bus: object}|null, resendNeeded?: boolean, legacy?: object}}
 *   draft is null when nothing needs persisting; resendNeeded is true only after a successful
 *   'apply' whose compiled Nano job actually differs (nanoJobsEqual); legacy is the bridge
 *   payload for the wrapper to write into global/flow context, present only on successful apply
 */
function handleModbusSettingsMessage(msg, deps) {
  const { store, draft = null, legacySlaveList = [], user = 'UI' } = deps;
  const action = msg.payload?.action;
  const index = msg.payload?.index;

  const state = currentState(msg, draft, store, legacySlaveList);

  if (action === 'apply') {
    return applyModbusSettings(msg, state, store, legacySlaveList, user);
  }

  const slaves = [...state.slaves];
  const bus = { ...state.bus };

  if (action === 'add') {
    slaves.push(EMPTY_ROW());
  }

  if (action === 'edit' && slaves[index]) {
    slaves[index] = { ...slaves[index], editing: true };
  }

  if (action === 'save' && slaves[index]) {
    const row = { ...slaves[index] };
    const problem = rowError(row);
    if (problem) {
      return { msg: withPayload(msg, { slaves, bus, error: problem, action: 'save' }), draft: null };
    }
    row.editing = false;
    slaves[index] = row;
    return { msg: withPayload(msg, { slaves, bus, success: 'Saved', action: 'save' }), draft: { slaves, bus } };
  }

  if (action === 'delete' && slaves[index]) {
    slaves.splice(index, 1);
  }

  const anyEditing = slaves.some((s) => s.editing === true);
  if (anyEditing && !action) {
    return { msg: null, draft: null }; // safe refresh: don't clobber an in-progress edit
  }

  const mutatingActions = new Set(['add', 'edit', 'delete']);
  return {
    msg: withPayload(msg, { slaves, bus }),
    draft: mutatingActions.has(action) ? { slaves, bus } : null,
  };
}

const EMPTY_ROW = () => ({
  slave_id: '',
  label: '',
  unit_address: '',
  model: '',
  channels: 1,
  temp_base_addr: '',
  temp_word_count: 1,
  temp_scale: 0.1,
  poll_interval_s: 30,
  editing: true,
});

const DEFAULT_BUS = () => ({ port: '/dev/ttyUSB0', baud: 9600, parity: 'N', stop_bits: 1, timeout_ms: 1000, retries: 2, inter_frame_ms: 10 });

/** Preserves the incoming msg's other properties (topic, req/res, socketid, _msgid, ...) - only payload changes. */
function withPayload(msg, payload) {
  return { ...msg, payload };
}

/**
 * Client-sent state wins (it's the live table); else the persisted
 * draft; else rows rebuilt from the applied cfg/modbus document.
 */
function currentState(msg, draft, store, legacySlaveList) {
  if (Array.isArray(msg.payload?.slaves) && msg.payload?.bus) {
    return { slaves: msg.payload.slaves, bus: msg.payload.bus };
  }
  if (draft && Array.isArray(draft.slaves) && draft.bus) {
    return draft;
  }
  return stateFromApplied(store, legacySlaveList);
}

function stateFromApplied(store, legacySlaveList) {
  const { doc } = store.readDomain('modbus_joints');
  if (!doc) return { slaves: [], bus: DEFAULT_BUS() };

  const legacyNameByAddress = new Map((legacySlaveList || []).map((ls) => [Number(ls.slaveID), ls.parameterName]));
  const slaves = doc.modbus.slaves.map((s) => ({
    slave_id: s.slave_id,
    // migrated docs predate the label field - recover the display name from the legacy list
    label: s.label ?? legacyNameByAddress.get(s.unit_address) ?? '',
    unit_address: s.unit_address,
    model: s.model,
    channels: s.channels ?? 4,
    temp_base_addr: s.registers.temp_base_addr,
    temp_word_count: s.registers.temp_word_count ?? 1,
    temp_scale: s.registers.temp_scale,
    poll_interval_s: s.poll_interval_s ?? 30,
    editing: false,
  }));

  const b = doc.modbus.buses[0];
  const bus = {
    port: b.port,
    baud: b.baud,
    parity: b.parity ?? 'N',
    stop_bits: b.stop_bits ?? 1,
    timeout_ms: b.timeout_ms ?? 500,
    retries: b.retries ?? 2,
    inter_frame_ms: b.inter_frame_ms ?? 20,
  };
  return { slaves, bus };
}

/** Friendly single-row validation, mirroring the schema's bounds (the real validator still runs at apply). */
function rowError(row) {
  const ua = Number(row.unit_address);
  if (!row.label || String(row.label).trim() === '') return 'Missing sensor name';
  if (!row.model || String(row.model).trim() === '') return 'Missing model';
  if (!Number.isInteger(ua) || ua < 1 || ua > 247) return 'Unit address must be 1-247';
  const ch = Number(row.channels);
  if (!Number.isInteger(ch) || ch < 1 || ch > 8) return 'Channels must be 1-8';
  const base = Number(row.temp_base_addr);
  if (!Number.isInteger(base) || base < 0 || base > 65535) return 'Base address must be 0-65535';
  const words = Number(row.temp_word_count);
  if (!Number.isInteger(words) || words < 1 || words > 2) return 'Words/channel must be 1 or 2';
  if (![1, 0.1, 0.01].includes(Number(row.temp_scale))) return 'Scale must be 1, 0.1 or 0.01';
  const poll = Number(row.poll_interval_s);
  if (!Number.isInteger(poll) || poll < 5 || poll > 300) return 'Poll interval must be 5-300s';
  return null;
}

function busError(bus) {
  if (!bus.port || String(bus.port).trim() === '') return 'Missing serial port';
  if (![9600, 19200, 38400, 57600, 115200].includes(Number(bus.baud))) return 'Baud must be 9600/19200/38400/57600/115200';
  if (!['N', 'E', 'O'].includes(bus.parity)) return 'Parity must be N, E or O';
  if (![1, 2].includes(Number(bus.stop_bits))) return 'Stop bits must be 1 or 2';
  const t = Number(bus.timeout_ms);
  if (!Number.isInteger(t) || t < 50 || t > 5000) return 'Timeout must be 50-5000ms';
  const r = Number(bus.retries);
  if (!Number.isInteger(r) || r < 0 || r > 5) return 'Retries must be 0-5';
  const f = Number(bus.inter_frame_ms);
  if (!Number.isInteger(f) || f < 0 || f > 500) return 'Inter-frame delay must be 0-500ms';
  return null;
}

function applyModbusSettings(msg, state, store, legacySlaveList, user) {
  const rows = state.slaves;
  const bus = state.bus;
  const fail = (error) => ({ msg: withPayload(msg, { slaves: rows, bus, error, action: 'apply' }), draft: null });

  if (rows.length === 0) return fail('At least one slave is required');

  const busProblem = busError(bus);
  if (busProblem) return fail(busProblem);

  const seenAddress = new Set();
  for (const row of rows) {
    const problem = rowError(row);
    if (problem) return fail(`${problem} (${row.label || 'unnamed row'})`);
    const ua = Number(row.unit_address);
    if (seenAddress.has(ua)) return fail(`Duplicate unit address ${ua}`);
    seenAddress.add(ua);
  }

  const { doc: current } = store.readDomain('modbus_joints');
  const { doc: currentAlarms } = store.readDomain('alarms');
  if (!current) {
    return fail('No cfg/modbus applied yet - run the migration/commissioning step first');
  }

  // Stable slave_id: keep the one each row carries; allocate the lowest unused for new rows.
  const carried = new Set(rows.map((r) => r.slave_id).filter((id) => /^sl[0-9]{2}$/.test(id)));
  const nextFreeId = () => {
    for (let i = 1; i <= 64; i++) {
      const candidate = `sl${String(i).padStart(2, '0')}`;
      if (!carried.has(candidate)) {
        carried.add(candidate);
        return candidate;
      }
    }
    return null;
  };

  const existingById = new Map(current.modbus.slaves.map((s) => [s.slave_id, s]));
  const newSlaves = [];
  for (const row of rows) {
    const slaveId = /^sl[0-9]{2}$/.test(row.slave_id) ? row.slave_id : nextFreeId();
    if (!slaveId) return fail('No free slave IDs left (max 64 slaves)');
    const existing = existingById.get(slaveId);
    newSlaves.push({
      slave_id: slaveId,
      bus_id: 'bus1',
      unit_address: Number(row.unit_address),
      model: String(row.model).trim(),
      label: String(row.label).trim(),
      ...(existing?.hw_serial ? { hw_serial: existing.hw_serial } : {}),
      channels: Number(row.channels),
      poll_interval_s: Number(row.poll_interval_s),
      registers: {
        // firmware/Nano_IOT.ino always calls readHoldingRegisters - FC3 is the only implementable choice
        function_code: 3,
        temp_base_addr: Number(row.temp_base_addr),
        temp_word_count: Number(row.temp_word_count),
        temp_scale: Number(row.temp_scale),
      },
    });
  }

  // Friendly referential pre-check before the validator: a slave still mapped
  // to a joint (or used as an ambient reference) can't be deleted.
  const newIds = new Set(newSlaves.map((s) => s.slave_id));
  const mappedJoints = current.joints.filter((j) => !newIds.has(j.slave_id));
  if (mappedJoints.length > 0) {
    return fail(`Cannot delete a slave still mapped to a joint: ${mappedJoints.map((j) => j.joint_id).join(', ')} - unmap it in the joint table first`);
  }
  const ambientRefs = [
    ...(current.modbus.ambient_sensor ? [['panel default', current.modbus.ambient_sensor]] : []),
    ...current.zones.filter((z) => z.ambient_sensor).map((z) => [`zone ${z.zone_id}`, z.ambient_sensor]),
    ...current.joints.filter((j) => j.ambient_sensor).map((j) => [`joint ${j.joint_id}`, j.ambient_sensor]),
  ];
  const brokenAmbient = ambientRefs.filter(([, ref]) => !newIds.has(ref.slave_id));
  if (brokenAmbient.length > 0) {
    return fail(`Cannot delete a slave used as an ambient reference (${brokenAmbient.map(([where]) => where).join(', ')}) - reassign it in the joint table first`);
  }

  const newDoc = {
    config_domain_versions: {
      modbus: current.config_domain_versions.modbus + 1,
      joints: current.config_domain_versions.joints + 1, // R11: one atomic document, both bump
    },
    modbus: {
      buses: [
        {
          bus_id: 'bus1',
          type: 'rtu',
          port: String(bus.port).trim(),
          baud: Number(bus.baud),
          parity: bus.parity,
          stop_bits: Number(bus.stop_bits),
          timeout_ms: Number(bus.timeout_ms),
          retries: Number(bus.retries),
          inter_frame_ms: Number(bus.inter_frame_ms),
        },
      ],
      slaves: newSlaves,
      ...(current.modbus.ambient_sensor ? { ambient_sensor: current.modbus.ambient_sensor } : {}),
    },
    joints: current.joints,
    zones: current.zones,
  };

  const result = store.applyIfValid('modbus_joints', newDoc, { source: 'local', alarmsDoc: currentAlarms }, user);
  if (!result.applied) {
    return fail(result.errors.map((e) => `${e.rule}: ${e.message}`).join('; '));
  }

  const savedRows = rows.map((r, i) => ({ ...r, slave_id: newSlaves[i].slave_id, editing: false }));
  return {
    msg: withPayload(msg, { slaves: savedRows, bus, success: 'Modbus configuration applied', action: 'apply' }),
    draft: { slaves: savedRows, bus },
    resendNeeded: !nanoJobsEqual(current, newDoc),
    legacy: deriveLegacyBridge(newDoc, legacySlaveList),
  };
}

/**
 * Everything the legacy sensor-decode pipeline still reads, derived
 * from the just-applied document so the new table is the single source
 * of truth. The wrapper function node writes these into context:
 * global scope for everything except paraRaw, which is flow-scoped on
 * the modbusMaster_V2 tab (delivered there via a link node).
 */
function deriveLegacyBridge(newDoc, legacySlaveList) {
  const idByAddress = new Map((legacySlaveList || []).map((ls) => [Number(ls.slaveID), ls.id]));
  const defaultTypeId = mostCommon((legacySlaveList || []).map((ls) => ls.id)) ?? '6';

  const slaves = newDoc.modbus.slaves;
  const slaveIdList = slaves.map((s) => ({
    id: idByAddress.get(s.unit_address) ?? defaultTypeId,
    parameterName: s.label ?? s.model,
    slaveID: s.unit_address,
    registerAddress: s.registers.temp_base_addr,
    dataBits: s.channels * (s.registers.temp_word_count ?? 1),
    enabled: true,
  }));

  const bus = newDoc.modbus.buses[0];
  return {
    SlaveIDList: slaveIdList,
    slaveLength: slaveIdList.length,
    indexed: slaveIdList.map((ls) => ({
      parameterName: ls.parameterName,
      parameterID: ls.id,
      sID: ls.slaveID,
      sregisterAddress: ls.registerAddress,
      sdataBits: ls.dataBits,
    })),
    comm: {
      port: bus.port,
      baudRate: bus.baud,
      parity: bus.parity,
      stopBits: bus.stop_bits,
      Polling: bus.inter_frame_ms * 1000,
      Timeout: bus.timeout_ms,
    },
    paraRaw: slaveIdList.map((ls) => [ls.slaveID, ls.registerAddress, ls.dataBits]),
  };
}

/**
 * Writes the bridge payload into Node-RED's global context. Lives here
 * (not in the function node) so the wrapper stays a thin plumbing shim
 * and this stays unit-testable. paraRaw is NOT written here - it's
 * flow-scoped on the modbusMaster_V2 tab, so the wrapper ships it there
 * via a link node instead.
 *
 * @param {{set: Function}} globalContext - the function node's `global`
 * @param {object} legacy - the `legacy` field returned by handleModbusSettingsMessage
 */
function writeLegacyModbusGlobals(globalContext, legacy) {
  globalContext.set('SlaveIDList', legacy.SlaveIDList);
  globalContext.set('slaveLength', legacy.slaveLength);
  legacy.indexed.forEach((row, i) => {
    globalContext.set('parameterName' + i, row.parameterName);
    globalContext.set('parameterID' + i, row.parameterID);
    globalContext.set('sID' + i, row.sID);
    globalContext.set('sregisterAddress' + i, row.sregisterAddress);
    globalContext.set('sdataBits' + i, row.sdataBits);
  });
  globalContext.set('port', legacy.comm.port);
  globalContext.set('baudRate', legacy.comm.baudRate);
  globalContext.set('parity', legacy.comm.parity);
  globalContext.set('stopBits', legacy.comm.stopBits);
  globalContext.set('Polling', legacy.comm.Polling);
  globalContext.set('Timeout', legacy.comm.Timeout);
}

function mostCommon(values) {
  const counts = new Map();
  let best = null;
  let bestCount = 0;
  for (const v of values) {
    if (v == null || v === '') continue;
    const c = (counts.get(v) ?? 0) + 1;
    counts.set(v, c);
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

module.exports = { handleModbusSettingsMessage, writeLegacyModbusGlobals };
