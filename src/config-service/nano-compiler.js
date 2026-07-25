'use strict';

const { validateModbusJoints, readSpan } = require('./validate-modbus-joints');

/**
 * Compiles a cfg/modbus+joints document into the job JSON
 * firmware/Nano_IOT.ino parses over serial (see CLAUDE.md's "Nano job
 * protocol" section for the wire format).
 *
 * Only `read` + `comm` are emitted - this panel's joints are read-only
 * temperature sensors, so `write`/`transfer` packets aren't needed for
 * normal polling (the firmware accepts a job update without them: it
 * treats a missing array as a zero-length one).
 *
 * One read packet per slave, spanning all of that slave's channels in
 * a single Modbus transaction (base address, length = channels *
 * temp_word_count) - matching the legacy modbusMaster_V2 tab's
 * paraRaw construction (min/max register span per slaveID), verified
 * against real production data.
 *
 * The firmware handles exactly one RS-485 bus (Serial1) - this
 * compiler only supports a single bus for that reason. A schema-valid
 * document with more than one bus configured is rejected here with a
 * clear error rather than silently picking one, since which bus is
 * physically wired to the Nano isn't something this function can know.
 *
 * @param {object} doc - cfg/modbus+joints document (already-applied, from ConfigStore.readDomain)
 * @param {object} [opts]
 * @param {string[]} [opts.excludeSlaveIds] - slave_ids to omit from the read
 *   list (Slice 9 blacklisting: a blacklisted slave is temporarily not
 *   polled). The document itself is unchanged/valid — this only trims the
 *   compiled job — so R10 scan-time capacity still assesses the full fleet.
 * @param {string} [opts.busId] - which RS-485 segment to compile a job for
 *   (Slice 10 two-segment support: one Nano per bus). Omit for the
 *   single-bus case; required when the document has more than one bus, since
 *   each bus is a separate Nano with its own serial port.
 * @returns {{job: {read: Array, comm: number[]}}|{error: string}}
 */
function compileNanoJob(doc, { excludeSlaveIds = [], busId } = {}) {
  const { valid, errors } = validateModbusJoints(doc);
  if (!valid) {
    return { error: `cannot compile an invalid cfg/modbus+joints document: ${errors.map((e) => `${e.rule}: ${e.message}`).join('; ')}` };
  }

  const buses = doc.modbus.buses;
  let bus;
  if (busId != null) {
    bus = buses.find((b) => b.bus_id === busId);
    if (!bus) return { error: `no bus '${busId}' in cfg/modbus` };
  } else if (buses.length === 1) {
    bus = buses[0];
  } else {
    // one Nano per RS-485 segment - can't emit a single job for several buses
    return { error: `cfg/modbus has ${buses.length} buses; specify {busId} to compile one Nano job per RS-485 segment` };
  }
  if (bus.type !== 'rtu') {
    return { error: `bus '${bus.bus_id}' is type '${bus.type}', but the Nano only speaks Modbus RTU over its RS-485 port` };
  }

  const exclude = new Set(excludeSlaveIds);
  // one read per slave ON THIS BUS - each Nano polls only its own segment
  const slaves = doc.modbus.slaves.filter((s) => s.bus_id === bus.bus_id && !exclude.has(s.slave_id));
  // One contiguous read per slave. readSpan handles both layouts:
  // consecutive channels (channels * temp_word_count from base) and
  // sparse channel_addrs (min..max span, R15 guarantees min == base) -
  // shared with the validator's R10 timing math so they never disagree.
  const readTuples = slaves.map((s) => [s.unit_address, s.registers.temp_base_addr, readSpan(s)]);

  const read = [readTuples.length, ...readTuples];
  const comm = [Math.round(bus.inter_frame_ms * 1000), bus.baud, bus.timeout_ms];

  return { job: { read, comm } };
}

/**
 * Whether two cfg/modbus+joints documents would compile to the same
 * Nano job. Used to decide whether a config apply actually needs to
 * resend anything to the Nano - joint/zone-only edits (the only kind
 * JointMasterBackEndNode's apply can make; it always spreads
 * modbus.buses/modbus.slaves through unchanged) never change the
 * compiled job, since compileNanoJob only reads modbus.slaves/buses,
 * never joints[]. Resending a job the Nano already has is not a
 * harmless no-op: the firmware re-inits Serial1 and its Modbus timeout
 * on every job update, briefly disrupting live polling - so this
 * isn't just an optimization, it avoids a real polling glitch on every
 * unrelated joint-mapping edit.
 *
 * A compile error on either side is treated as "changed" (report it
 * rather than silently skip a resend that might matter).
 */
function nanoJobsEqual(docA, docB, busId) {
  const a = compileNanoJob(docA, { busId });
  const b = compileNanoJob(docB, { busId });
  if (a.error || b.error) return false;
  return JSON.stringify(a.job) === JSON.stringify(b.job);
}

module.exports = { compileNanoJob, nanoJobsEqual };
