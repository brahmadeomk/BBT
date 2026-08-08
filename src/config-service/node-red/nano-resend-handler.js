'use strict';

const { compileNanoJob } = require('../nano-compiler');

/**
 * Reads the currently applied cfg/modbus+joints document and compiles
 * it into the Nano job payload. Used by the "Send Nano Job" function
 * node, triggered on boot, after a RECOVERY CONTROLLER USB
 * power-cycle, and after a successful JointMasterBackEndNode apply
 * (see flows/flows_BBT.json, modbusMaster_V2 tab).
 *
 * @param {import('../store').ConfigStore} store
 * @param {object} [opts]
 * @param {string[]} [opts.excludeSlaveIds] - blacklisted slave_ids to omit
 *   from the read list (Slice 9). The blacklist handler writes the live set;
 *   the comm block is unchanged so the firmware's comm-change guard skips
 *   the bus re-init on a blacklist/probe resend.
 * @param {string} [opts.busId] - which RS-485 segment's Nano to build the job
 *   for (Slice 10 two-segment). On a single-bus panel this is treated as a
 *   preference, not a filter: there is exactly one Nano, so the sole bus is
 *   compiled even if the applied document names it something other than the
 *   'bus1' the flow carries by default - a bus rename must not silently stop
 *   the panel polling.
 * @returns {{job: {read: Array, comm: number[]}}|{error: string}}
 */
function buildNanoJobMessage(store, { excludeSlaveIds = [], busId } = {}) {
  const { doc } = store.readDomain('modbus_joints');
  if (!doc) {
    return { error: 'no cfg/modbus+joints has been applied yet - nothing to send to the Nano' };
  }
  const buses = doc.modbus?.buses || [];
  const effective = busId != null && buses.length === 1 ? buses[0].bus_id : busId;
  return compileNanoJob(doc, { excludeSlaveIds, busId: effective });
}

module.exports = { buildNanoJobMessage };
