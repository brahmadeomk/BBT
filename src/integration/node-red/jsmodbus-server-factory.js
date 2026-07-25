'use strict';

/**
 * Production Modbus-TCP-server factory for ModbusTcpSlave, built on
 * `jsmodbus` (pure JS — no native aws-crt/serialport build on ARM). Loaded
 * LAZILY so a panel that hasn't `npm i jsmodbus` yet still runs everything
 * else (the BmsService then computes images but binds no socket). This is
 * the ONLY file that imports the Modbus server library; the adapter and the
 * pure core never do — same isolation discipline as src/adapters/aws.
 *
 * jsmodbus's ServerTCP exposes a `holding` Buffer it serves directly. We
 * mirror our register array into it on each read, and translate its
 * write events into ModbusTcpSlave.writeRegister so the ACK decode +
 * read-only enforcement stay in one place.
 *
 * Wiring/verification against a reference gateway: docs/bms-integration.md.
 */
function jsmodbusServerFactory({ host, port, unitId, io }) {
  // eslint-disable-next-line global-require
  const net = require('node:net');
  // eslint-disable-next-line global-require
  const modbus = require('jsmodbus'); // throws if not installed -> caught by caller

  const socket = new net.Server();
  const server = new modbus.server.TCP(socket, { unitId });

  server.on('connection', (client) => {
    client.on('readHoldingRegisters', (request, response, send) => {
      try {
        const values = io.readHoldingRegisters(request.body.start, request.body.count);
        response.body = new modbus.server.ReadHoldingRegistersResponseBody(values);
      } catch (e) {
        response.body = modbus.server.ExceptionResponseBody
          ? new modbus.server.ExceptionResponseBody(request.body.fc, e.modbusCode || 0x04)
          : response.body;
      }
      send(response);
    });
    const onWrite = (request, response, send) => {
      try {
        if (request.body.values != null && Array.isArray(request.body.values)) {
          request.body.values.forEach((v, i) => io.writeRegister(request.body.address + i, v));
        } else {
          io.writeRegister(request.body.address, request.body.value);
        }
      } catch { /* read-only / illegal address -> ignore write, gateway sees no change */ }
      send(response);
    };
    client.on('writeSingleRegister', onWrite);
    client.on('writeMultipleRegisters', onWrite);
  });

  socket.listen(port, host);
  return { close: () => { try { socket.close(); } catch { /* best effort */ } } };
}

module.exports = { jsmodbusServerFactory };
