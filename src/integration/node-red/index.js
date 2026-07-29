'use strict';

/**
 * Slice 11 — Node-RED entry point for the BMS integration, exposed to
 * function nodes via functionGlobalContext as `busductIntegration`
 * (settings.js.example updated). Thin function nodes on the "BMS
 * Integration" flow tab just require() and call into here.
 *
 * The BmsService is a PROCESS-WIDE SINGLETON (like getGateway / getTracker):
 * it holds the worst-joint latch, heartbeat counter, and the live Modbus
 * server socket, none of which may pass through Node-RED's localfilesystem
 * context store (that JSON-serialises and would strip the class + drop the
 * socket).
 */

const { BmsService } = require('../bms-service');
const { buildRegisterMap, mapExtent } = require('../register-map');
const { computeRollup, WorstJointLatch } = require('../rollup');
const { buildImage } = require('../holding-registers');
const { decodeAck } = require('../ack');
const { describeImage, formatImage } = require('../describe-image');
// Re-exported so the flow's thin function nodes can pass a production server
// factory without require()ing a path themselves (function nodes can't).
// jsmodbus itself is required lazily INSIDE the factory, so importing this
// module never hard-depends on the optional package.
const { jsmodbusServerFactory } = require('./jsmodbus-server-factory');

let _service = null;

/**
 * Build (once) or return the BMS service singleton. Reads cfg/integration +
 * cfg/joints from the config store. Returns null when cfg/integration hasn't
 * been applied yet (BMS is optional; local monitoring runs without it).
 *
 * @param {object} store - ConfigStore
 * @param {object} [opts]
 * @param {Function} [opts.serverFactory] - injected Modbus server binder. In
 *   production the flow passes jsmodbusServerFactory; omit for bench/image-only.
 */
function getBmsService(store, opts = {}) {
  if (_service) return _service;
  const integrationDoc = store.readDomain('integration').doc;
  if (!integrationDoc) return null;
  const jointsDoc = store.readDomain('modbus_joints').doc;
  _service = new BmsService({ integrationDoc, jointsDoc, serverFactory: opts.serverFactory });
  _service.start();
  return _service;
}

/** For tests / a config re-apply that needs a fresh singleton. */
function _resetBmsService() {
  if (_service) _service.stop();
  _service = null;
}

/**
 * Config-apply handler for the cfg/integration domain (mirrors the other
 * config-manager handlers): validate + apply through the store, then
 * reconfigure the live singleton so the register map/socket follow the new
 * config. Returns a friendly result for the dashboard.
 */
function handleIntegrationMessage(store, msg, opts = {}) {
  const doc = msg?.payload;
  const jointsDoc = store.readDomain('modbus_joints').doc;
  const res = store.applyIfValid('integration', doc, { jointsDoc, source: msg?.source || 'local' }, msg?.user || 'hmi');
  if (!res.applied) {
    return { applied: false, errors: res.errors, toast: `BMS config rejected: ${res.errors.map((e) => `${e.rule}: ${e.message}`).join('; ')}` };
  }
  const svc = getBmsService(store, opts);
  if (svc) svc.reconfigure(doc, jointsDoc);
  const warn = (res.warnings || []).map((w) => `${w.rule}: ${w.message}`).join('; ');
  return { applied: true, appliedVersions: res.appliedVersions, toast: `BMS config applied${warn ? ` (warnings: ${warn})` : ''}` };
}

module.exports = {
  getBmsService,
  _resetBmsService,
  handleIntegrationMessage,
  // re-export the pure pieces so function nodes / HMI can use them directly
  buildRegisterMap,
  mapExtent,
  computeRollup,
  WorstJointLatch,
  buildImage,
  decodeAck,
  describeImage,
  formatImage,
  jsmodbusServerFactory,
};
