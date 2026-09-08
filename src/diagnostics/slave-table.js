'use strict';

/**
 * Diagnostics slave table, built from the NEW decode path.
 *
 * WHY (user request 2026-09-08: "separate from legacy system"). The table was
 * assembled from legacy globals — `parameterName{i}` / `sID{i}` /
 * `sregisterAddress{i}` for the attributes, `sensorData[sID][addr]` for the
 * value, and `Status[sID]` / `StatusTs` for connectivity. Every one of those is
 * written by the legacy decode chain hanging off `parameterForLoop`, so the
 * operator's diagnostic view was reporting on a pipeline that no longer decides
 * anything: alarms, the historian, the BMS image and the cloud all read
 * `Scale Nano Reading` instead. Two independent representations of the same
 * measurement, and the one on screen was the one nothing else used.
 *
 * Now: **values and connectivity come from the decoded readings**, and
 * **attributes come from the applied `cfg/modbus` document** — the same document
 * the Modbus Settings table edits, ProcessLogic matches against and the alarm
 * sweep clears against.
 *
 * ROWS COME FROM THE CONFIG, NOT FROM THE READINGS. A commissioned channel that
 * has never reported must appear, as "No Data" — that is precisely the case an
 * engineer opens this page to find. Deriving rows from traffic would make a dead
 * device vanish from the table instead of showing up as dead, which is the
 * failure mode this project has hit repeatedly (a stale value that reads as
 * healthy, a frozen table that looks live).
 */

const DEFAULT_STALE_MS = 60000;
const DEFAULT_WORD_COUNT = 1;

/** Readings are identified by (unit address, channel) throughout the panel. */
function readingKey(unit, channel) {
  return `${unit}:${channel}`;
}

/**
 * Fold one decoded reading into the cache. Returns the same object, mutated —
 * this runs on the live measurement path, so it does not copy.
 *
 * @param {object} cache - accumulator, `{}` on first call
 * @param {object} msg - a `Scale Nano Reading` output message
 * @param {number} nowMs
 */
function recordReading(cache, msg, nowMs) {
  const p = msg && msg.payload;
  if (!p || typeof p.id !== 'number') return cache;
  const channel = Number.isInteger(p.channel) ? p.channel : 1;
  cache[readingKey(p.id, channel)] = {
    val: Number.isFinite(p.val) ? p.val : null,
    st: p.st ?? 'ok',
    ts: nowMs,
    bus_id: msg.bus_id ?? null,
  };
  return cache;
}

/** Per-channel register address: explicit when sparse, derived when consecutive. */
function channelAddress(slave, channel) {
  const r = slave.registers || {};
  const addrs = r.channel_addrs;
  if (Array.isArray(addrs) && addrs.length >= channel) return addrs[channel - 1];
  const words = r.temp_word_count ?? DEFAULT_WORD_COUNT;
  return (r.temp_base_addr ?? 0) + (channel - 1) * words;
}

/**
 * Display name for one channel. The operator names devices in Modbus Settings
 * (`label`) and channels in `channel_labels`; fall back to the unit address
 * rather than inventing anything, so an unnamed device is visibly unnamed.
 */
function channelName(slave, channel) {
  const labels = slave.registers && slave.registers.channel_labels;
  if (Array.isArray(labels) && labels[channel - 1]) return String(labels[channel - 1]);
  const base = slave.label || `Slave ${slave.unit_address}`;
  const channels = Math.max(1, slave.channels ?? 1);
  return channels > 1 ? `${base} ch${channel}` : base;
}

/**
 * Connectivity, derived from the reading itself rather than a separate
 * `Status`/`StatusTs` global pair that nothing else maintains.
 *
 * `staleMs` MUST exceed the bus sweep time or every device flickers to
 * "No Data" between polls. At `inter_frame_ms` 250 and 71 slaves the sweep is
 * ~20 s, so the 60 s default holds; a slower sweep needs this raised, which is
 * why it is a parameter and not a constant.
 */
function statusFor(reading, nowMs, staleMs) {
  if (!reading) return 'No Data';
  if (nowMs - reading.ts > staleMs) return 'No Data';
  if (reading.st !== 'ok') return 'Error';
  return 'Connected';
}

/**
 * @param {object} doc - the APPLIED cfg/modbus+joints document
 * @param {object} cache - from recordReading
 * @param {object} [opts]
 * @returns {{rows: Array, available: boolean}}
 */
function buildSlaveRows(doc, cache, { nowMs = Date.now(), staleMs = DEFAULT_STALE_MS } = {}) {
  const slaves = doc && doc.modbus && Array.isArray(doc.modbus.slaves) ? doc.modbus.slaves : null;
  // Refuse to act on absent information - the same rule the alarm sweep and
  // buildProcessLogicJoints follow. An empty table would read as "no devices
  // commissioned", which is a different and alarming statement from "the
  // configuration could not be read".
  if (!slaves || slaves.length === 0) return { rows: [], available: false };

  const readings = cache || {};
  const rows = [];
  for (const slave of slaves) {
    const channels = Math.max(1, slave.channels ?? 1);
    for (let ch = 1; ch <= channels; ch += 1) {
      const r = readings[readingKey(slave.unit_address, ch)];
      rows.push({
        // Field names match what the dashboard template already binds, so the
        // view did not have to change with the source.
        Name: channelName(slave, ch),
        ID: slave.unit_address,
        Add: channelAddress(slave, ch),
        Data: r && r.val != null ? r.val : null,
        Status: statusFor(r, nowMs, staleMs),
        // Additions - present in the data, not yet rendered.
        Ch: ch,
        Bus: slave.bus_id ?? (r && r.bus_id) ?? null,
        SlaveId: slave.slave_id ?? null,
        AgeSec: r ? Math.round((nowMs - r.ts) / 1000) : null,
      });
    }
  }

  rows.sort((a, b) => (a.ID - b.ID) || (a.Ch - b.Ch));
  return { rows, available: true };
}

/**
 * MODULE SINGLETON for the live cache.
 *
 * CORRECTION (2026-09-08). The first cut kept this in Node-RED **flow context**,
 * on the reasoning that flow scope is memory-only. That is wrong: a context
 * store is chosen by `contextStorage.default`, which applies to node, flow AND
 * global scope alike — and on these panels the default store is
 * **localfilesystem**. So `flow.set('diagReadings', …)` on every reading put a
 * write back on the SD card, which is precisely what the historian
 * investigation was about, and it JSON-serialises the value on the way through.
 *
 * A module singleton is the pattern this repo already uses for exactly this —
 * the blacklist tracker and `getBmsService` are both process-wide for the same
 * reason. It is memory-only by construction and reaches every function node,
 * because `busductConfigService` is required once at startup and shared.
 *
 * It does NOT survive a Node-RED restart, and that is correct: after a restart
 * no readings have arrived, so every row should read "No Data" until they do.
 * Note this cannot repeat the stale-blacklist bug of 2026-08-31, where a
 * PERSISTED global disagreed with a non-persisted tracker — nothing here is
 * persisted, so there are no two lifetimes to diverge.
 */
const _cache = Object.create(null);

/** Fold a reading into the process-wide cache. */
function record(msg, nowMs = Date.now()) {
  return recordReading(_cache, msg, nowMs);
}

/** The live cache, for the row builder. */
function snapshot() {
  return _cache;
}

let _doc = null;
let _docTs = 0;
let _docError = null;

/**
 * The applied cfg/modbus+joints document, cached IN MEMORY.
 *
 * WHY NOT NODE CONTEXT (regression fixed 2026-09-08). The first cut cached it
 * with `context.get`/`context.set` — copied from the pre-existing `function 12`,
 * which does the same with `blDoc`. But node context uses `contextStorage.default`
 * exactly as flow and global do, and on these panels that is **localfilesystem**.
 * So a ~100 KB config document was being read back out of a disk-backed store on
 * every 1 s tick, deserialised each time. Node-RED's CPU went from ~19 % to ~53 %
 * and its allocation rate rose enough to be visible as V8 heap sawtooth in `top`.
 *
 * The lesson is the one this file already carries once: **in this deployment
 * "context" means the SD card unless a store is named.** Module scope is the only
 * free memory.
 *
 * ON A READ FAILURE the last good document is KEPT rather than blanked. The
 * config changes only on an apply, so a transient read error should not empty
 * the diagnostics table — and an empty table would read as "no devices
 * commissioned", a different and alarming statement. The caller is told via
 * `error` so it can show that the view is not fresh.
 */
function appliedDoc(createStore, { nowMs = Date.now(), ttlMs = 30000 } = {}) {
  if (_doc && (nowMs - _docTs) < ttlMs) return { doc: _doc, ageMs: nowMs - _docTs, error: _docError };
  try {
    const d = createStore().readDomain('modbus_joints').doc;
    if (d) { _doc = d; _docError = null; }
    else _docError = 'readDomain returned no document';
  } catch (e) {
    _docError = String((e && e.message) || e);
  }
  _docTs = nowMs;
  return { doc: _doc, ageMs: 0, error: _docError };
}

/** Test seam - the module singletons would otherwise leak between cases. */
function _resetForTests() {
  _doc = null; _docTs = 0; _docError = null;
  for (const k of Object.keys(_cache)) delete _cache[k];
}

module.exports = {
  record,
  snapshot,
  appliedDoc,
  _resetForTests,
  recordReading,
  buildSlaveRows,
  readingKey,
  channelAddress,
  channelName,
  statusFor,
  DEFAULT_STALE_MS,
};
