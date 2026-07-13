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
 * @returns {{job: {read: Array, comm: number[]}}|{error: string}}
 */
function buildNanoJobMessage(store) {
  const { doc } = store.readDomain('modbus_joints');
  if (!doc) {
    return { error: 'no cfg/modbus+joints has been applied yet - nothing to send to the Nano' };
  }
  return compileNanoJob(doc);
}

module.exports = { buildNanoJobMessage };
