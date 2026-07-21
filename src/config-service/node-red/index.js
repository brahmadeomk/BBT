'use strict';

const { ConfigStore } = require('../store');
const { validateModbusJoints } = require('../validate-modbus-joints');
const { validateAlarms } = require('../validate-alarms');
const { handleConfigManagerMessage } = require('./config-manager-handler');
const { handleJointMasterMessage } = require('./joint-master-handler');
const { handleModbusSettingsMessage, writeLegacyModbusGlobals } = require('./modbus-settings-handler');
const { buildNanoJobMessage } = require('./nano-resend-handler');
const { appendLegacyAudit } = require('./legacy-audit');
const { processRemoteConfig, buildLegacyDrafts } = require('./remote-config-handler');
const { deriveLegacyBridge } = require('./modbus-settings-handler');

const DEFAULT_ROOT = '/var/busduct/cfg';

/**
 * Entry point exposed to Node-RED function nodes via
 * functionGlobalContext (see settings.js.example in this directory) so
 * the "BusbarTherm Config Manager" and "JointMasterBackEndNode"
 * function nodes can stay thin one-liners that just require() and
 * call into this library, per CLAUDE.md's standing instruction.
 */
function createStore(root = DEFAULT_ROOT) {
  return new ConfigStore({ root, validators: { modbus_joints: validateModbusJoints, alarms: validateAlarms } });
}

module.exports = { createStore, handleConfigManagerMessage, handleJointMasterMessage, handleModbusSettingsMessage, writeLegacyModbusGlobals, deriveLegacyBridge, appendLegacyAudit, processRemoteConfig, buildLegacyDrafts, buildNanoJobMessage };
