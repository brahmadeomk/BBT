'use strict';

const { readSpan } = require('./validate-modbus-joints');

/**
 * Decodes a Nano read frame into per-channel readings.
 *
 * THE BUG THIS EXISTS TO FIX. The node upstream of ProcessLogic was
 * `validateValue(msg.payload.val / 100)`, and `msg.payload.val` is an ARRAY.
 * Dividing an array coerces it through toString():
 *
 *   [2543]           / 100  ->  "2543"/100       ->  25.43   (works by accident)
 *   [2543,2601]      / 100  ->  "2543,2601"/100  ->  NaN  ->  0
 *
 * so a multi-channel slave read 0 degC, and `validateValue` turned the NaN into
 * a plausible zero rather than a fault - presenting as a COLD JOINT, not an
 * error. The same line hardcoded /100 while the schema carries a per-slave
 * `temp_scale` of 1, 0.1 or 0.01, so any module that is not centi-degrees was
 * already mis-scaled.
 *
 * HOW THE CHANNEL IS RECOVERED. `compileNanoJob` emits ONE contiguous read per
 * slave, so every channel's value arrives in the same frame; the decode path was
 * simply discarding all but the coerced first. The channel is an index into
 * `val`, computed from the configuration, and both layouts invert `readSpan`
 * exactly:
 *
 *   sparse (channel_addrs)  ->  val[ channel_addrs[k-1] - sa ]
 *   consecutive             ->  val[ (k-1) * word_count ]
 *
 * R15 is what makes this well-defined - it already requires
 * min(channel_addrs) === temp_base_addr, addresses unique and non-overlapping,
 * and length === channels. The rule written for commissioning turns out to be
 * exactly the invariant the decoder needs, so no schema change was required.
 */

const LEGACY_SCALE = 0.01; // what the hardcoded `/100` meant
const DEFAULT_WORD_COUNT = 1;

/**
 * Index into `val` for channel k (1-based), or null if the frame is too short.
 * Mirrors readSpan's two layouts.
 */
function channelIndex(slave, channel, sa) {
  const wordCount = slave.registers?.temp_word_count ?? DEFAULT_WORD_COUNT;
  const addrs = slave.registers?.channel_addrs;
  if (Array.isArray(addrs) && addrs.length > 0) {
    const addr = addrs[channel - 1];
    return addr == null ? null : addr - sa;
  }
  return (channel - 1) * wordCount;
}

/**
 * Raw registers -> degC. Two words are big-endian, matching the Modbus wire order.
 *
 * `useConfigScale` is OFF by default, and that is not timidity - `temp_scale` in
 * the applied document is a GUESS. `tools/migrate-legacy-config.js` writes 0.1
 * with the warning "legacy data does not record scaling, verify against the
 * sensor datasheet", because the legacy pipeline hardcoded the divisor and never
 * recorded it. Nothing read the field until 2026-09-01, so nobody had ever found
 * out it was wrong.
 *
 * Honouring it on this panel turned a 31 degC joint (raw 3100) into 310 degC,
 * past ProcessLogic's 300 limit, and raised "Sensor value out of valid range" on
 * every joint at once. Turn this on per-panel only after the Scale column in
 * Modbus Settings has been checked against the datasheets.
 */
function toCelsius(values, index, slave, useConfigScale = false) {
  const wordCount = slave.registers?.temp_word_count ?? DEFAULT_WORD_COUNT;
  const scale = useConfigScale ? (slave.registers?.temp_scale ?? LEGACY_SCALE) : LEGACY_SCALE;
  const offset = slave.registers?.temp_offset ?? 0;
  if (index < 0 || index + wordCount > values.length) return null;
  const raw = wordCount === 2 ? (values[index] << 16) | (values[index + 1] & 0xffff) : values[index];
  if (!Number.isFinite(raw)) return null;
  // Rounded to milli-degrees. `raw * scale` is not exact in binary floating
  // point - 254 * 0.1 is 25.400000000000002 - and that noise would travel into
  // the historian, the BMS registers and every alarm description. Three decimals
  // is far finer than any sensor here resolves, so it cannot lose information.
  return Math.round((raw * scale + offset) * 1000) / 1000;
}

/**
 * @param {object} frame - parsed Nano frame {t:'r', id, sa, len, val:[], st}
 * @param {object} doc - the APPLIED cfg/modbus+joints document
 * @param {object} [opts]
 * @param {string} [opts.busId] - unit addresses are unique panel-wide, so this
 *   is only used to disambiguate a document that somehow repeats one
 * @returns {{readings: Array, warnings: string[]}}
 */
function decodeFrame(frame, doc, { busId, useConfigScale = false } = {}) {
  const warnings = [];
  if (!frame || frame.t !== 'r' || typeof frame.id !== 'number') {
    return { readings: [], warnings: [] }; // not a read frame; not our business
  }

  const values = Array.isArray(frame.val) ? frame.val : [];
  const slaves = doc?.modbus?.slaves ?? [];
  const slave = slaves.find(
    (s) => s.unit_address === frame.id && (!busId || !s.bus_id || s.bus_id === busId)
  );

  // FAIL-SAFE: an uncommissioned or unreadable slave still yields its first
  // value on the legacy scale, rather than the reading being dropped. This is a
  // monitoring system; a config that has not converged yet must not blind it.
  if (!slave) {
    return {
      readings: [{ id: frame.id, channel: 1, val: values.length ? values[0] * LEGACY_SCALE : null, st: frame.st, scale_source: 'legacy' }],
      warnings: [`unit ${frame.id} is not in the applied configuration - decoded on the legacy scale`],
    };
  }

  // A frame whose shape disagrees with the configuration was produced by a
  // PREVIOUS job - the window between a config apply and the resend landing, or
  // a resend that never arrived. Decoding it against the new configuration would
  // silently mis-attribute values, so say so.
  const expectedSa = slave.registers?.temp_base_addr;
  const expectedLen = readSpan(slave);
  if (frame.sa !== expectedSa || frame.len !== expectedLen) {
    warnings.push(
      `unit ${frame.id}: frame is sa=${frame.sa} len=${frame.len} but the applied config expects ` +
      `sa=${expectedSa} len=${expectedLen} - the Nano is running a stale job`
    );
  }

  // Surface the mismatch rather than silently ignoring the configured value:
  // one of the two is wrong, and which one is a question about the hardware.
  const configScale = slave.registers?.temp_scale;
  if (!useConfigScale && configScale != null && configScale !== LEGACY_SCALE) {
    warnings.push(
      `unit ${frame.id}: configured temp_scale ${configScale} is NOT being used - ` +
      `decoding on the legacy scale ${LEGACY_SCALE}. Verify the Scale column against the datasheet.`
    );
  }

  const channels = Math.max(1, slave.channels ?? 1);
  const readings = [];
  for (let k = 1; k <= channels; k += 1) {
    const idx = channelIndex(slave, k, frame.sa);
    const val = idx == null ? null : toCelsius(values, idx, slave, useConfigScale);
    if (val == null && frame.st === 'ok') {
      warnings.push(`unit ${frame.id} channel ${k}: no value at index ${idx} of ${values.length}`);
    }
    readings.push({
      id: frame.id,
      channel: k,
      val,
      st: frame.st,
      scale_source: useConfigScale ? 'config' : 'legacy',
    });
  }
  return { readings, warnings };
}

/**
 * Single-reading form for the current flow, which is not yet fanned out.
 * Behaviour on a single-channel slave is identical to the old line, except that
 * the scale now comes from the slave rather than being hardcoded.
 */
function decodeFirstChannel(frame, doc, opts) {
  const { readings, warnings } = decodeFrame(frame, doc, opts);
  return { reading: readings[0] ?? null, channels: readings.length, warnings };
}

module.exports = { decodeFrame, decodeFirstChannel, channelIndex, toCelsius, LEGACY_SCALE };
