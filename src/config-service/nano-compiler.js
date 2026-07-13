'use strict';

const { validateModbusJoints } = require('./validate-modbus-joints');

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
 * @returns {{job: {read: Array, comm: number[]}}|{error: string}}
 */
function compileNanoJob(doc) {
  const { valid, errors } = validateModbusJoints(doc);
  if (!valid) {
    return { error: `cannot compile an invalid cfg/modbus+joints document: ${errors.map((e) => `${e.rule}: ${e.message}`).join('; ')}` };
  }

  const buses = doc.modbus.buses;
  if (buses.length !== 1) {
    return { error: `Nano job compiler only supports a single bus (firmware has one RS-485 port); found ${buses.length}` };
  }
  const bus = buses[0];
  if (bus.type !== 'rtu') {
    return { error: `bus '${bus.bus_id}' is type '${bus.type}', but the Nano only speaks Modbus RTU over its RS-485 port` };
  }

  const slaves = doc.modbus.slaves;
  const readTuples = slaves.map((s) => {
    const registerCount = (s.channels ?? 4) * (s.registers.temp_word_count ?? 1);
    return [s.unit_address, s.registers.temp_base_addr, registerCount];
  });

  const read = [readTuples.length, ...readTuples];
  const comm = [Math.round(bus.inter_frame_ms * 1000), bus.baud, bus.timeout_ms];

  return { job: { read, comm } };
}

module.exports = { compileNanoJob };
