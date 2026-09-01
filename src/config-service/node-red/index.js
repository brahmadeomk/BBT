'use strict';

const { ConfigStore } = require('../store');
const { validateModbusJoints } = require('../validate-modbus-joints');
const { validateAlarms } = require('../validate-alarms');
const { validateIntegration } = require('../validate-integration');
const { handleConfigManagerMessage } = require('./config-manager-handler');
const { handleJointMasterMessage } = require('./joint-master-handler');
const { handleModbusSettingsMessage, writeLegacyModbusGlobals } = require('./modbus-settings-handler');
const { buildNanoJobMessage } = require('./nano-resend-handler');
const { appendLegacyAudit } = require('./legacy-audit');
const { processRemoteConfig, buildLegacyDrafts } = require('./remote-config-handler');
const { deriveLegacyBridge } = require('./modbus-settings-handler');
const blacklist = require('./blacklist-handler');
const { resolveAmbient } = require('../ambient-resolver');
const { planRecovery } = require('../bus-recovery');
const alarmEmail = require('../../alarms/email-subject');
const alarmSweep = require('../../alarms/config-sweep');
const processLogicJoints = require('../process-logic-joints');
const channelDecode = require('../channel-decode');
// Wi-Fi selection for the touchscreen. Exposed on THIS existing global rather
// than a new functionGlobalContext entry so enabling it needs no settings.js
// edit on deployed panels - same reasoning as power-health on the gateway.
const wifiLib = require('../../network/wifi');
const { execFile } = require('node:child_process');
const wifi = {
  scan: () => wifiLib.scan({ execFile }),
  status: () => wifiLib.status({ execFile }),
  connect: (ssid, passphrase, opts) => wifiLib.connect({ execFile }, ssid, passphrase, opts),
  validateSsid: wifiLib.validateSsid,
  validatePassphrase: wifiLib.validatePassphrase,
};

const DEFAULT_ROOT = '/var/busduct/cfg';

/**
 * Entry point exposed to Node-RED function nodes via
 * functionGlobalContext (see settings.js.example in this directory) so
 * the "BusbarTherm Config Manager" and "JointMasterBackEndNode"
 * function nodes can stay thin one-liners that just require() and
 * call into this library, per CLAUDE.md's standing instruction.
 */
function createStore(root = DEFAULT_ROOT) {
  return new ConfigStore({ root, validators: { modbus_joints: validateModbusJoints, alarms: validateAlarms, integration: validateIntegration } });
}

module.exports = { createStore, handleConfigManagerMessage, handleJointMasterMessage, handleModbusSettingsMessage, writeLegacyModbusGlobals, deriveLegacyBridge, appendLegacyAudit, processRemoteConfig, buildLegacyDrafts, buildNanoJobMessage, blacklist, resolveAmbient, planRecovery, alarmEmail, alarmSweep, processLogicJoints, channelDecode, wifi };
