'use strict';

/**
 * Slice 11 — Modbus TCP slave (server) adapter.
 *
 * Holds the served holding-register image and turns gateway reads/writes
 * into library-agnostic operations. The actual socket-binding library is
 * INJECTED as a `serverFactory` (the same dependency-injection pattern as
 * the cloud transport interface and the cert rotator's reconnect callback),
 * so:
 *   - unit tests inject a fake factory and drive reads/writes directly, and
 *   - production wires a real Modbus-TCP-server library (jsmodbus — pure JS,
 *     no native build on ARM) without this module ever importing it.
 *
 * This keeps all the testable behaviour (register serving, ACK decode,
 * out-of-range handling) here, and confines the untestable socket I/O to a
 * thin factory documented in docs/bms-integration.md.
 *
 * The register image is Modbus holding registers (function code 3), 16-bit
 * unsigned on the wire. The ACK control register (function codes 6/16) is
 * the one writable point; a write to it is decoded and dispatched, and the
 * written value is retained so a gateway can read back what it wrote.
 */

const { decodeAck } = require('./ack');

class ModbusTcpSlave {
  /**
   * @param {object} opts
   * @param {object} opts.map - current register map (register-map.buildRegisterMap)
   * @param {(io: object) => {close: Function}} opts.serverFactory - binds a
   *   socket server and calls back into io.readHoldingRegisters /
   *   io.writeRegister. Given { host, port, unitId, io }.
   * @param {string} [opts.host]
   * @param {number} [opts.port]
   * @param {number} [opts.unitId]
   */
  constructor({ map, serverFactory, host = '0.0.0.0', port = 502, unitId = 1 }) {
    this.map = map;
    this.serverFactory = serverFactory;
    this.host = host;
    this.port = port;
    this.unitId = unitId;
    this._regs = new Uint16Array(map.extent);
    this._ackHandlers = [];
    this._server = null;
  }

  /** The authoritative register array (unsigned 16-bit), for a server factory. */
  registers() {
    return this._regs;
  }

  /** Number of registers served (== map extent). */
  size() {
    return this._regs.length;
  }

  /** Push the current registers to the server, if it mirrors them (jsmodbus does). */
  _syncServer() {
    if (this._server && typeof this._server.sync === 'function') this._server.sync(this._regs);
  }

  /** Replace the served image. `image` is the sparse signed map from buildImage. */
  setImage(image) {
    const next = new Uint16Array(this.map.extent);
    for (const [addr, v] of Object.entries(image)) {
      const a = Number(addr);
      if (a >= 0 && a < next.length) next[a] = v & 0xffff;
    }
    // preserve the last-written ACK register value (a pending BMS write must
    // not be stomped by a telemetry refresh before it's processed)
    const ackAddr = this.map.control?.ack;
    if (ackAddr != null && ackAddr < next.length) next[ackAddr] = this._regs[ackAddr];
    this._regs = next;
    this._syncServer();
  }

  /** Re-point at a new register map (config re-apply changed the layout). */
  setMap(map) {
    this.map = map;
    const resized = new Uint16Array(map.extent);
    resized.set(this._regs.subarray(0, Math.min(this._regs.length, resized.length)));
    this._regs = resized;
    this._syncServer();
  }

  onAck(cb) {
    this._ackHandlers.push(cb);
  }

  /** Server read callback (FC 3). Modbus errors are signalled by throwing. */
  readHoldingRegisters(start, quantity) {
    if (start < 0 || quantity < 1 || start + quantity > this._regs.length) {
      const e = new Error(`illegal data address: ${start}..${start + quantity - 1} outside 0..${this._regs.length - 1}`);
      e.modbusCode = 0x02; // Illegal Data Address
      throw e;
    }
    return Array.from(this._regs.subarray(start, start + quantity));
  }

  /** Server write callback (FC 6/16). Only the ACK control register is writable. */
  writeRegister(addr, value) {
    const ackAddr = this.map.control?.ack;
    if (addr !== ackAddr) {
      const e = new Error(`register ${addr} is read-only (only the ACK register ${ackAddr} is writable)`);
      e.modbusCode = 0x02;
      throw e;
    }
    this._regs[addr] = value & 0xffff;
    const cmd = decodeAck(this.map, addr, value);
    if (cmd) for (const cb of this._ackHandlers) cb(cmd);
    return true;
  }

  isRunning() {
    return this._server != null;
  }

  start() {
    if (this._server) return;
    this._server = this.serverFactory({
      host: this.host,
      port: this.port,
      unitId: this.unitId,
      io: {
        readHoldingRegisters: (s, q) => this.readHoldingRegisters(s, q),
        writeRegister: (a, v) => this.writeRegister(a, v),
        // A buffer-mirroring server (jsmodbus) needs the whole array + its size
        // up front rather than a per-request callback.
        registers: () => this._regs,
        size: () => this._regs.length,
      },
    });
    this._syncServer();
  }

  stop() {
    if (this._server) {
      try { this._server.close(); } catch { /* best effort */ }
      this._server = null;
    }
  }
}

module.exports = { ModbusTcpSlave };
