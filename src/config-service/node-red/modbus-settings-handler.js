'use strict';

const { nanoJobsEqual } = require('../nano-compiler');
const { DEFAULTS } = require('../validate-modbus-joints');

/**
 * Thin Node-RED handler behind the new schema-backed "Modbus Settings"
 * dashboard - the replacement for the legacy "Parameter - Modbus
 * Configuration" + "Comm Parameters" pair, which built Nano jobs from
 * raw dashboard input with no schema/R-rule validation and no
 * connection to cfg/modbus in the ConfigStore (see CLAUDE.md; the user
 * decided this schema-backed path is authoritative).
 *
 * Table model: **one row per channel**, matching the hardware reality
 * that one slave unit (one Modbus unit address) can carry several
 * temperature channels. The unit address may therefore repeat across
 * rows; within one unit address every channel number and every base
 * address must be unique. At apply time the rows for a unit address
 * are grouped into a single schema slave entry:
 *   channels       = number of rows for that unit address
 *   channel_addrs  = per-channel base addresses (stored explicitly
 *                    when channels > 1; single-channel slaves keep the
 *                    plain temp_base_addr shape the migration produced)
 *   channel_labels = per-channel display names (channels > 1)
 *   label          = the row's display name (single-channel slaves)
 *
 * Slave-level fields (model, words/channel, scale, poll interval) are
 * shown on every row but belong to the slave, not the channel - the
 * firmware reads all of a slave's channels in ONE Modbus transaction,
 * so there is exactly one poll interval per slave. Rows of the same
 * unit address must agree on these; a mismatch is a friendly apply
 * error rather than silently picking one.
 *
 * Editing model mirrors joint-master-handler: add/edit/delete/save are
 * draft bookkeeping on an intentionally-incomplete in-progress table;
 * only 'apply' builds a full cfg/modbus+joints document and pushes it
 * through the real validator + ConfigStore (R1-R15). The client sends
 * its current {slaves, bus} state on every action (lesson from the
 * JointMasterUI data-loss bug).
 *
 * On a successful apply this also derives the legacy global-context
 * values (SlaveIDList, slaveLength, parameterName{i}/parameterID{i}/
 * sID{i}/sregisterAddress{i}/sdataBits{i}, the comm globals, and
 * paraRaw) that the existing sensor-decode pipeline still consumes -
 * one legacy entry per CHANNEL row, exactly the shape the legacy
 * per-parameter table produced, with paraRaw grouped per unit address
 * (min addr, span) the same way the legacy SetVal grouped it.
 *
 * @param {object} msg - Node-RED msg; msg.payload = {action?, index?, slaves?, bus?}
 * @param {object} deps
 * @param {import('../store').ConfigStore} deps.store
 * @param {{slaves: Array, bus: object}|null} [deps.draft] - persisted draft (global 'modbus_settings_draft')
 * @param {Array} [deps.legacySlaveList] - current global SlaveIDList, for parameterID carry-over and label recovery
 * @param {string} [deps.user]
 * @returns {{msg: object|null, draft: {slaves: Array, bus: object}|null, resendNeeded?: boolean, legacy?: object}}
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

  if (action === 'add_channel' && slaves[index]) {
    // convenience: pre-fill a new channel row for the same physical unit
    const src = slaves[index];
    slaves.splice(index + 1, 0, {
      ...EMPTY_ROW(),
      slave_id: src.slave_id,
      unit_address: src.unit_address,
      channel: Number(src.channel) + 1 || '',
      model: src.model,
      temp_word_count: src.temp_word_count,
      temp_scale: src.temp_scale,
      poll_interval_s: src.poll_interval_s,
    });
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

  const mutatingActions = new Set(['add', 'add_channel', 'edit', 'delete']);
  return {
    msg: withPayload(msg, { slaves, bus }),
    draft: mutatingActions.has(action) ? { slaves, bus } : null,
  };
}

const EMPTY_ROW = () => ({
  slave_id: '',
  label: '',
  unit_address: '',
  channel: 1,
  base_addr: '',
  model: '',
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

/** Explodes each schema slave into one row per channel. */
function stateFromApplied(store, legacySlaveList) {
  const { doc } = store.readDomain('modbus_joints');
  if (!doc) return { slaves: [], bus: DEFAULT_BUS() };

  const legacyNameByAddress = new Map((legacySlaveList || []).map((ls) => [Number(ls.slaveID), ls.parameterName]));
  const slaves = [];
  for (const s of doc.modbus.slaves) {
    const channels = s.channels ?? DEFAULTS.channels;
    const wordCount = s.registers.temp_word_count ?? 1;
    for (let k = 0; k < channels; k++) {
      slaves.push({
        slave_id: s.slave_id,
        label:
          s.registers.channel_labels?.[k] ??
          (channels === 1
            ? s.label ?? legacyNameByAddress.get(s.unit_address) ?? ''
            : `${s.label ?? s.model} ch${k + 1}`),
        unit_address: s.unit_address,
        channel: k + 1,
        base_addr: s.registers.channel_addrs?.[k] ?? s.registers.temp_base_addr + k * wordCount,
        model: s.model,
        temp_word_count: wordCount,
        temp_scale: s.registers.temp_scale,
        poll_interval_s: s.poll_interval_s ?? 30,
        editing: false,
      });
    }
  }

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
  const ch = Number(row.channel);
  if (!Number.isInteger(ch) || ch < 1 || ch > 8) return 'Channel must be 1-8';
  const base = Number(row.base_addr);
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

/**
 * Groups per-channel rows by unit address into schema slave entries.
 * Returns { slaves } or { error } with a friendly message.
 */
function groupRowsIntoSlaves(rows) {
  const byAddress = new Map();
  for (const row of rows) {
    const ua = Number(row.unit_address);
    if (!byAddress.has(ua)) byAddress.set(ua, []);
    byAddress.get(ua).push(row);
  }

  const groups = [];
  for (const [ua, groupRows] of byAddress) {
    const name = (r) => r.label || `unit ${ua}`;

    // channel numbers must be exactly 1..N, no gaps or duplicates
    const channelNumbers = groupRows.map((r) => Number(r.channel)).sort((a, b) => a - b);
    for (let i = 0; i < channelNumbers.length; i++) {
      if (channelNumbers[i] !== i + 1) {
        return {
          error: `Unit ${ua}: channels must be 1..${groupRows.length} with no gaps or repeats (got ${channelNumbers.join(', ')})`,
        };
      }
    }

    // slave-level fields must agree across the unit's rows
    const first = groupRows[0];
    for (const r of groupRows.slice(1)) {
      if (String(r.model).trim() !== String(first.model).trim()) {
        return { error: `Unit ${ua}: model must match across its channels ('${first.model}' vs '${r.model}')` };
      }
      if (Number(r.poll_interval_s) !== Number(first.poll_interval_s)) {
        return { error: `Unit ${ua}: poll interval must match across its channels - the slave is polled as one transaction` };
      }
      if (Number(r.temp_word_count) !== Number(first.temp_word_count)) {
        return { error: `Unit ${ua}: words/channel must match across its channels` };
      }
      if (Number(r.temp_scale) !== Number(first.temp_scale)) {
        return { error: `Unit ${ua}: scale must match across its channels` };
      }
    }

    // base addresses unique and non-overlapping within the unit
    const wordCount = Number(first.temp_word_count);
    const inChannelOrder = [...groupRows].sort((a, b) => Number(a.channel) - Number(b.channel));
    const addrs = inChannelOrder.map((r) => Number(r.base_addr));
    const sortedAddrs = [...addrs].sort((a, b) => a - b);
    for (let i = 1; i < sortedAddrs.length; i++) {
      if (sortedAddrs[i] === sortedAddrs[i - 1]) {
        return { error: `Unit ${ua}: duplicate base address ${sortedAddrs[i]} - each channel needs its own register` };
      }
      if (sortedAddrs[i] - sortedAddrs[i - 1] < wordCount) {
        return { error: `Unit ${ua}: base addresses ${sortedAddrs[i - 1]} and ${sortedAddrs[i]} overlap (each channel reads ${wordCount} words)` };
      }
    }

    const carriedId = inChannelOrder.map((r) => r.slave_id).find((id) => /^sl[0-9]{2}$/.test(id)) || '';
    groups.push({
      unit_address: ua,
      slave_id: carriedId,
      rows: inChannelOrder,
      channels: inChannelOrder.length,
      model: String(first.model).trim(),
      poll_interval_s: Number(first.poll_interval_s),
      temp_word_count: wordCount,
      temp_scale: Number(first.temp_scale),
      base_addr: sortedAddrs[0],
      channel_addrs: addrs,
      channel_labels: inChannelOrder.map((r) => String(r.label).trim()),
      _firstLabel: name(first),
    });
  }
  return { groups };
}

function applyModbusSettings(msg, state, store, legacySlaveList, user) {
  const rows = state.slaves;
  const bus = state.bus;
  const fail = (error) => ({ msg: withPayload(msg, { slaves: rows, bus, error, action: 'apply' }), draft: null });

  if (rows.length === 0) return fail('At least one slave is required');

  const busProblem = busError(bus);
  if (busProblem) return fail(busProblem);

  for (const row of rows) {
    const problem = rowError(row);
    if (problem) return fail(`${problem} (${row.label || 'unnamed row'})`);
  }

  const grouped = groupRowsIntoSlaves(rows);
  if (grouped.error) return fail(grouped.error);
  const { groups } = grouped;

  const { doc: current } = store.readDomain('modbus_joints');
  const { doc: currentAlarms } = store.readDomain('alarms');
  if (!current) {
    return fail('No cfg/modbus applied yet - run the migration/commissioning step first');
  }

  // Stable slave_id per unit: keep the carried one; allocate the lowest unused for new units.
  const carried = new Set(groups.map((g) => g.slave_id).filter(Boolean));
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
  for (const g of groups) {
    const slaveId = g.slave_id || nextFreeId();
    if (!slaveId) return fail('No free slave IDs left (max 64 slaves)');
    g.slave_id = slaveId;
    const existing = existingById.get(slaveId);
    const singleChannel = g.channels === 1;
    newSlaves.push({
      slave_id: slaveId,
      bus_id: 'bus1',
      unit_address: g.unit_address,
      model: g.model,
      // single-channel slaves keep the plain shape the migration produced;
      // multi-channel slaves store explicit per-channel addresses/labels
      ...(singleChannel ? { label: g.channel_labels[0] } : {}),
      ...(existing?.hw_serial ? { hw_serial: existing.hw_serial } : {}),
      channels: g.channels,
      poll_interval_s: g.poll_interval_s,
      registers: {
        // firmware/Nano_IOT.ino always calls readHoldingRegisters - FC3 is the only implementable choice
        function_code: 3,
        temp_base_addr: g.base_addr,
        temp_word_count: g.temp_word_count,
        temp_scale: g.temp_scale,
        ...(singleChannel ? {} : { channel_addrs: g.channel_addrs, channel_labels: g.channel_labels }),
      },
    });
  }

  // Friendly referential pre-checks before the validator: a slave (or channel)
  // still mapped to a joint or ambient reference can't be deleted/shrunk.
  const newById = new Map(newSlaves.map((s) => [s.slave_id, s]));
  const missingJoints = current.joints.filter((j) => !newById.has(j.slave_id));
  if (missingJoints.length > 0) {
    return fail(`Cannot delete a slave still mapped to a joint: ${missingJoints.map((j) => j.joint_id).join(', ')} - unmap it in the joint table first`);
  }
  const shrunkJoints = current.joints.filter((j) => (j.channel ?? 1) > newById.get(j.slave_id).channels);
  if (shrunkJoints.length > 0) {
    return fail(
      `Cannot remove a channel still mapped to a joint: ${shrunkJoints.map((j) => `${j.joint_id} (channel ${j.channel})`).join(', ')} - unmap it in the joint table first`
    );
  }
  const ambientRefs = [
    ...(current.modbus.ambient_sensor ? [['panel default', current.modbus.ambient_sensor]] : []),
    ...current.zones.filter((z) => z.ambient_sensor).map((z) => [`zone ${z.zone_id}`, z.ambient_sensor]),
    ...current.joints.filter((j) => j.ambient_sensor).map((j) => [`joint ${j.joint_id}`, j.ambient_sensor]),
  ];
  const brokenAmbient = ambientRefs.filter(
    ([, ref]) => !newById.has(ref.slave_id) || (ref.channel ?? 1) > newById.get(ref.slave_id).channels
  );
  if (brokenAmbient.length > 0) {
    return fail(`Cannot delete a slave/channel used as an ambient reference (${brokenAmbient.map(([where]) => where).join(', ')}) - reassign it in the joint table first`);
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

  const idByAddress = new Map(groups.map((g) => [g.unit_address, g.slave_id]));
  const savedRows = rows.map((r) => ({ ...r, slave_id: idByAddress.get(Number(r.unit_address)), editing: false }));
  return {
    msg: withPayload(msg, { slaves: savedRows, bus, success: 'Modbus configuration applied', action: 'apply' }),
    draft: { slaves: savedRows, bus },
    resendNeeded: !nanoJobsEqual(current, newDoc),
    legacy: deriveLegacyBridge(newDoc, legacySlaveList),
  };
}

/**
 * Everything the legacy sensor-decode pipeline still reads, derived
 * from the just-applied document: one legacy entry per CHANNEL (the
 * legacy table was per-parameter rows), with paraRaw grouped per unit
 * address as [unit, min addr, span] - the same min/max grouping the
 * legacy SetVal computed. parameterID carry-over matches by
 * (unit address, register address) first, then unit address, then the
 * panel's most common existing type.
 */
function deriveLegacyBridge(newDoc, legacySlaveList) {
  const list = legacySlaveList || [];
  const idByAddrReg = new Map(list.map((ls) => [`${Number(ls.slaveID)}:${Number(ls.registerAddress)}`, ls.id]));
  const idByAddress = new Map(list.map((ls) => [Number(ls.slaveID), ls.id]));
  const defaultTypeId = mostCommon(list.map((ls) => ls.id)) ?? '6';

  const slaveIdList = [];
  const paraRaw = [];
  for (const s of newDoc.modbus.slaves) {
    const wordCount = s.registers.temp_word_count ?? 1;
    const channels = s.channels ?? DEFAULTS.channels;
    const addrs = s.registers.channel_addrs ?? Array.from({ length: channels }, (_, k) => s.registers.temp_base_addr + k * wordCount);
    for (let k = 0; k < channels; k++) {
      slaveIdList.push({
        id: idByAddrReg.get(`${s.unit_address}:${addrs[k]}`) ?? idByAddress.get(s.unit_address) ?? defaultTypeId,
        parameterName: s.registers.channel_labels?.[k] ?? s.label ?? s.model,
        slaveID: s.unit_address,
        registerAddress: addrs[k],
        dataBits: wordCount,
        enabled: true,
      });
    }
    paraRaw.push([s.unit_address, Math.min(...addrs), Math.max(...addrs) - Math.min(...addrs) + wordCount]);
  }

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
    paraRaw,
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
