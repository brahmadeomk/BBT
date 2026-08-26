'use strict';

/**
 * REAL SOCKET test of the production jsmodbus factory.
 *
 * This exists because the first version of the factory was written against an
 * assumed jsmodbus API and shipped without ever opening a socket. jsmodbus in
 * fact serves reads itself from a `holding` Buffer; the per-request handlers
 * that version registered never ran, so every read threw inside the library and
 * the server reset the connection — a client saw ECONNRESET on a "working"
 * server. Only a genuine client→socket→server round trip catches that class of
 * bug, so this suite binds a real port and reads through a real Modbus client.
 *
 * Skipped when the optional `jsmodbus` dependency is absent, so CI stays green
 * on a machine that hasn't installed it.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { buildRegisterMap } = require('../../src/integration/register-map');
const { ModbusTcpSlave } = require('../../src/integration/modbus-tcp-slave');
const { validIntegrationDoc, jointsDocTwoZones } = require('./fixtures');

let modbus = null;
try { modbus = require('jsmodbus'); } catch { /* optional dependency absent */ }

const maybe = modbus ? describe : describe.skip;

/** An ephemeral port, so a busy 1502 on the dev box can't fail the suite. */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function connect(port, unitId = 1) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const client = new modbus.client.TCP(socket, unitId);
    socket.once('error', reject);
    socket.once('connect', () => resolve({ socket, client }));
    socket.connect({ host: '127.0.0.1', port });
  });
}

maybe('jsmodbus server factory — real socket round trip', () => {
  test('a Modbus client reads the served registers (no ECONNRESET)', async () => {
    const { jsmodbusServerFactory } = require('../../src/integration/node-red/jsmodbus-server-factory');
    const map = buildRegisterMap(validIntegrationDoc({ exposure_tier: 3 }), jointsDocTwoZones());
    const port = await freePort();
    const slave = new ModbusTcpSlave({ map, serverFactory: jsmodbusServerFactory, host: '127.0.0.1', port, unitId: 1 });
    slave.start();
    const hb = map.tier1.points.find((p) => p.key === 'heartbeat').addr;
    const maxT = map.tier1.points.find((p) => p.key === 'panel_max_temp').addr;
    slave.setImage({ [hb]: 42, [maxT]: 615 });

    const { socket, client } = await connect(port);
    try {
      const res = await client.readHoldingRegisters(0, 12);
      const values = res.response.body.values;
      assert.equal(values.length, 12);
      assert.equal(values[hb], 42, 'heartbeat read back over the wire');
      assert.equal(values[maxT], 615, '61.5 C x10');
    } finally {
      socket.end();
      slave.stop();
    }
  });

  test('a negative value serves as unsigned two-complement on the wire', async () => {
    const { jsmodbusServerFactory } = require('../../src/integration/node-red/jsmodbus-server-factory');
    const map = buildRegisterMap(validIntegrationDoc({ exposure_tier: 1 }), jointsDocTwoZones());
    const port = await freePort();
    const slave = new ModbusTcpSlave({ map, serverFactory: jsmodbusServerFactory, host: '127.0.0.1', port, unitId: 1 });
    slave.start();
    const wj = map.tier1.points.find((p) => p.key === 'worst_joint_index').addr;
    slave.setImage({ [wj]: -1 });

    const { socket, client } = await connect(port);
    try {
      const res = await client.readHoldingRegisters(wj, 1);
      assert.equal(res.response.body.values[0], 0xffff, '-1 on the wire');
    } finally {
      socket.end();
      slave.stop();
    }
  });

  test('a write to the ACK register reaches the ack handler', async () => {
    const { jsmodbusServerFactory } = require('../../src/integration/node-red/jsmodbus-server-factory');
    const map = buildRegisterMap(validIntegrationDoc({ exposure_tier: 3 }), jointsDocTwoZones());
    const port = await freePort();
    const slave = new ModbusTcpSlave({ map, serverFactory: jsmodbusServerFactory, host: '127.0.0.1', port, unitId: 1 });
    const acks = [];
    slave.onAck((cmd) => acks.push(cmd));
    slave.start();

    const { socket, client } = await connect(port);
    try {
      await client.writeSingleRegister(map.control.ack, 1);
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(acks, [{ scope: 'all', source: 'bms' }]);
    } finally {
      socket.end();
      slave.stop();
    }
  });

  test('a write to a read-only register is reverted, not left visible', async () => {
    const { jsmodbusServerFactory } = require('../../src/integration/node-red/jsmodbus-server-factory');
    const map = buildRegisterMap(validIntegrationDoc({ exposure_tier: 1 }), jointsDocTwoZones());
    const port = await freePort();
    const slave = new ModbusTcpSlave({ map, serverFactory: jsmodbusServerFactory, host: '127.0.0.1', port, unitId: 1 });
    slave.start();
    const maxT = map.tier1.points.find((p) => p.key === 'panel_max_temp').addr;
    slave.setImage({ [maxT]: 615 });

    const { socket, client } = await connect(port);
    try {
      await client.writeSingleRegister(maxT, 999); // jsmodbus writes it into its buffer first
      await new Promise((r) => setTimeout(r, 50));
      const res = await client.readHoldingRegisters(maxT, 1);
      assert.equal(res.response.body.values[0], 615, 'restored from the authoritative array');
    } finally {
      socket.end();
      slave.stop();
    }
  });

  // Documents REAL jsmodbus behaviour (verified, not assumed): it applies no
  // bounds check on reads - ReadHoldingRegistersResponseBody.fromRequest just
  // slices the holding Buffer - so an out-of-range read returns an EMPTY
  // response rather than Modbus exception 0x02. The socket survives, which is
  // what matters; gateway integrators need to know they get a short frame, not
  // an error. (docs/bms-register-map.md says so too.)
  test('reads past the map return an empty response and leave the socket usable', async () => {
    const { jsmodbusServerFactory } = require('../../src/integration/node-red/jsmodbus-server-factory');
    const map = buildRegisterMap(validIntegrationDoc({ exposure_tier: 1 }), jointsDocTwoZones());
    const port = await freePort();
    const slave = new ModbusTcpSlave({ map, serverFactory: jsmodbusServerFactory, host: '127.0.0.1', port, unitId: 1 });
    slave.start();

    const { socket, client } = await connect(port);
    try {
      const oor = await client.readHoldingRegisters(map.extent + 500, 2);
      assert.equal(oor.response.body.values.length, 0, 'short/empty frame, not an exception');
      // the connection must survive, so a gateway probing a wrong range recovers
      const res = await client.readHoldingRegisters(0, 1);
      assert.equal(res.response.body.values.length, 1, 'socket still usable afterwards');
    } finally {
      socket.end();
      slave.stop();
    }
  });

  // The BACnet integration depends on this: the MGate 5217 presents each Modbus
  // DEVICE as its own BACnet device (6-digit instance = port | devSequence |
  // base). To give the BMS one BACnet device per zone instead of one flat device
  // with ~1200 objects, the gateway is configured with several Modbus devices at
  // the SAME ip:port, differing only by unit id - each carrying that zone's
  // commands. That works only because our server answers regardless of unit id,
  // which is normal for Modbus TCP (the unit id is a serial-gateway artefact).
  //
  // Pinned here because it is now load-bearing: swapping the server library for
  // one that filters on unit id would silently break the BACnet grouping while
  // every one of our own tools kept working.
  test('serves any unit id - the BACnet per-zone grouping relies on it', async () => {
    const { jsmodbusServerFactory } = require('../../src/integration/node-red/jsmodbus-server-factory');
    const map = buildRegisterMap(validIntegrationDoc({ exposure_tier: 1 }), jointsDocTwoZones());
    const port = await freePort();
    const slave = new ModbusTcpSlave({ map, serverFactory: jsmodbusServerFactory, host: '127.0.0.1', port, unitId: 1 });
    slave.start();
    const hb = map.tier1.points.find((p) => p.key === 'heartbeat').addr;
    slave.setImage({ [hb]: 42 });

    for (const unitId of [1, 2, 9, 32, 247]) {
      const { socket, client } = await connect(port, unitId);
      try {
        const res = await client.readHoldingRegisters(hb, 1);
        assert.equal(res.response.body.values[0], 42, `unit id ${unitId} must be served`);
      } finally { socket.end(); }
    }
    slave.stop();
  });
});
