'use strict';

/**
 * Slice 11 — BMS integration service (orchestration).
 *
 * Composes the pure pieces — register map, worst-joint latch, rollup,
 * register image — with the (injected) Modbus TCP slave adapter. Fed from
 * the SAME internal link-node bus as the cloud batcher (a peer adapter, not
 * a new data path): joint KPIs, active alarms, and blacklist joint states.
 * A periodic refresh recomputes the rollup, bumps the heartbeat, and pushes
 * the new image to the slave. Works with the internet down — nothing here
 * touches the cloud transport.
 *
 * Testable end-to-end with a fake serverFactory; the flow's thin function
 * nodes just call ingest/refresh on the process singleton (node-red/index).
 */

const { buildRegisterMap } = require('./register-map');
const { computeRollup, WorstJointLatch } = require('./rollup');
const { buildImage } = require('./holding-registers');
const { ModbusTcpSlave } = require('./modbus-tcp-slave');

class BmsService {
  /**
   * @param {object} opts
   * @param {object} opts.integrationDoc - cfg/integration
   * @param {object} opts.jointsDoc - cfg/joints (+ zones)
   * @param {Function} [opts.serverFactory] - Modbus server binder; when absent
   *   the service still computes images (bench/unit mode) but binds no socket.
   */
  constructor({ integrationDoc, jointsDoc, serverFactory } = {}) {
    this.serverFactory = serverFactory;
    this.latch = new WorstJointLatch();
    this._heartbeat = 0;
    this._joints = {}; // joint_id -> { zone_id, temp_c, deltaT, ror }
    this._activeAlarms = [];
    this._jointStates = {}; // joint_id -> 'LIVE'|'STALE'|'OFFLINE'
    this._systemFault = false;
    this._ackHandlers = [];
    this.reconfigure(integrationDoc, jointsDoc);
  }

  /** (Re)build the map from new config and re-point the slave at it. */
  reconfigure(integrationDoc, jointsDoc) {
    this.integrationDoc = integrationDoc;
    this.jointsDoc = jointsDoc;
    const map = buildRegisterMap(integrationDoc, jointsDoc);
    if (map.error) throw new Error(`cannot build BMS register map: ${map.error}`);
    this.map = map;

    const enabled = !!integrationDoc?.modbus_tcp?.enabled;
    if (this.slave) {
      this.slave.setMap(map);
    } else if (enabled && this.serverFactory) {
      this.slave = new ModbusTcpSlave({
        map,
        serverFactory: this.serverFactory,
        host: integrationDoc.modbus_tcp.bind_host || '0.0.0.0',
        port: integrationDoc.modbus_tcp.port,
        unitId: integrationDoc.modbus_tcp.unit_id,
      });
      for (const cb of this._ackHandlers) this.slave.onAck(cb);
    }
  }

  start() {
    if (this.slave) this.slave.start();
  }

  stop() {
    if (this.slave) this.slave.stop();
  }

  /** Route a decoded BMS ACK ({scope:'all'|'joint', ...}) to the alarm ACK path. */
  onAck(cb) {
    this._ackHandlers.push(cb);
    if (this.slave) this.slave.onAck(cb);
  }

  /** Ingest a ProcessLogic joint KPI message (internal-message-contracts.md). */
  ingestJoint(kpi) {
    if (!kpi || kpi.joint_id == null) return;
    this._joints[kpi.joint_id] = {
      zone_id: kpi.zone_id ?? null,
      temp_c: typeof kpi.emaTemp === 'number' ? kpi.emaTemp : (typeof kpi.val === 'number' ? kpi.val : null),
      deltaT: kpi.deltaT && typeof kpi.deltaT.ema === 'number' ? kpi.deltaT.ema : null,
      ror: typeof kpi.ror === 'number' ? kpi.ror : null,
    };
  }

  /** Replace the active-alarm set (Alarm Manager output 1 — full array). */
  ingestAlarmsActive(arr) {
    this._activeAlarms = Array.isArray(arr) ? arr : [];
  }

  /**
   * Apply blacklist-derived joint states + system fault flag.
   * @param {object} blacklistState - global.busduct_blacklist_state
   */
  ingestBlacklistState(blacklistState) {
    this._jointStates = {};
    const joints = blacklistState?.joints || {};
    for (const [jid, j] of Object.entries(joints)) this._jointStates[jid] = j.state || 'LIVE';
    const slaves = blacklistState?.slaves || {};
    this._systemFault = Object.values(slaves).some((s) => s.status === 'blacklisted' || s.status === 'probing');
  }

  /** Assemble the liveJoints array the rollup needs from ingested state. */
  _liveJoints() {
    const out = [];
    for (const j of this.jointsDoc?.joints || []) {
      const kpi = this._joints[j.joint_id] || {};
      out.push({
        joint_id: j.joint_id,
        zone_id: j.zone_id ?? kpi.zone_id ?? null,
        temp_c: kpi.temp_c ?? null,
        deltaT: kpi.deltaT ?? null,
        ror: kpi.ror ?? null,
        state: this._jointStates[j.joint_id] || 'LIVE',
      });
    }
    return out;
  }

  /**
   * Recompute the rollup + image, bump the heartbeat, push to the slave.
   * @returns {{image, rollup, heartbeat, map}}
   */
  refresh({ nowMs } = {}) {
    this._heartbeat = (this._heartbeat + 1) % 32768;
    const rollup = computeRollup(this._liveJoints(), this._activeAlarms, this.latch, { systemFault: this._systemFault });
    const image = buildImage(this.map, rollup, { heartbeat: this._heartbeat });
    if (this.slave) this.slave.setImage(image);
    return { image, rollup, heartbeat: this._heartbeat, map: this.map, nowMs: nowMs ?? Date.now() };
  }

  get heartbeat() {
    return this._heartbeat;
  }
}

module.exports = { BmsService };
