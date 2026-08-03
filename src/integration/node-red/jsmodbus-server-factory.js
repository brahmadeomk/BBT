'use strict';

/**
 * Production Modbus-TCP-server factory for ModbusTcpSlave, built on
 * `jsmodbus` (pure JS — no native build on ARM). Loaded LAZILY so a panel that
 * hasn't `npm i jsmodbus` yet still runs everything else (the BmsService then
 * computes images but binds no socket). This is the ONLY file that imports the
 * Modbus server library; the adapter and the pure core never do — the same
 * isolation discipline as src/adapters/aws.
 *
 * HOW jsmodbus ACTUALLY WORKS (learned the hard way, 2026-08):
 * `ModbusServer` serves reads **itself, straight out of a `holding` Buffer**
 * passed in its options — `ReadHoldingRegistersResponseBody.fromRequest(body,
 * server.holding)`. The per-request events (`readHoldingRegisters`,
 * `writeSingleRegister`) only fire when that buffer is ABSENT, as a fallback.
 * The first cut of this file registered `client.on('readHoldingRegisters', …)`
 * and tried to build response bodies by hand; that handler never ran, the
 * request threw inside the library, and the server tore the socket down —
 * a client saw the TCP connect succeed and then **ECONNRESET**.
 *
 * So: we own a Buffer, mirror the slave's authoritative register array into it
 * on every image update, and let jsmodbus answer reads at wire speed. Writes
 * are picked up through `postWriteSingleRegister` /
 * `postWriteMultipleRegisters` and routed back into the slave, which enforces
 * read-only addresses and decodes the ACK command.
 *
 * Wiring/verification against a reference gateway: docs/bms-integration.md.
 */
function jsmodbusServerFactory({ host, port, unitId, io }) {
  // eslint-disable-next-line global-require
  const net = require('node:net');
  // eslint-disable-next-line global-require
  const modbus = require('jsmodbus'); // throws if not installed -> caught by caller

  const size = typeof io.size === 'function' ? io.size() : 1024;
  const holding = Buffer.alloc(size * 2); // 2 bytes per 16-bit register

  const netServer = new net.Server();
  const server = new modbus.server.TCP(netServer, { holding, unitId });

  /** Mirror the slave's authoritative registers into the served buffer. */
  const sync = (regs) => {
    const n = Math.min(regs.length, size);
    for (let i = 0; i < n; i++) holding.writeUInt16BE(regs[i] & 0xffff, i * 2);
  };

  // jsmodbus has ALREADY written the value into `holding` by the time these
  // fire. Hand it to the slave, which decides whether it was legal: the ACK
  // register dispatches an alarm ack, anything else is read-only and throws —
  // in which case we restore the buffer from the authoritative array so a
  // gateway can't leave a stray value visible until the next refresh.
  const applyWrite = (addr, value) => {
    try {
      io.writeRegister(addr, value);
    } catch {
      if (typeof io.registers === 'function') sync(io.registers());
    }
  };

  server.on('postWriteSingleRegister', (request) => {
    try {
      applyWrite(request.body.address, request.body.value);
    } catch { /* never let a malformed frame kill the server */ }
  });

  server.on('postWriteMultipleRegisters', (request) => {
    try {
      const start = request.body.address;
      const values = request.body.values || request.body.valuesAsArray || [];
      values.forEach((v, i) => applyWrite(start + i, v));
    } catch { /* as above */ }
  });

  netServer.on('error', (e) => {
    // Binding failures (EADDRINUSE, EACCES on a privileged port) must not take
    // Node-RED down with an unhandled 'error' event.
    // eslint-disable-next-line no-console
    console.error(`[bms] Modbus TCP server error on ${host}:${port}: ${e.message}`);
  });

  netServer.listen(port, host);

  // Serve whatever the slave already holds, so a gateway polling immediately
  // after a restart doesn't read an all-zero image.
  if (typeof io.registers === 'function') sync(io.registers());

  return {
    close: () => { try { netServer.close(); } catch { /* best effort */ } },
    sync,
  };
}

module.exports = { jsmodbusServerFactory };
