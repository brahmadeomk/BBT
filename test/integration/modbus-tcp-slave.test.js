'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildRegisterMap } = require('../../src/integration/register-map');
const { ModbusTcpSlave } = require('../../src/integration/modbus-tcp-slave');
const { validIntegrationDoc, jointsDocTwoZones } = require('./fixtures');

function fakeFactory() {
  const calls = { started: 0, closed: 0 };
  const factory = (args) => { calls.started++; calls.io = args.io; return { close: () => calls.closed++ }; };
  return { factory, calls };
}

function newSlave(overrides) {
  const map = buildRegisterMap(validIntegrationDoc(overrides), jointsDocTwoZones());
  const { factory, calls } = fakeFactory();
  const slave = new ModbusTcpSlave({ map, serverFactory: factory, port: 1502, unitId: 1 });
  return { slave, map, calls };
}

describe('ModbusTcpSlave — serve + write', () => {
  test('start/stop drive the injected factory', () => {
    const { slave, calls } = newSlave();
    slave.start();
    assert.equal(calls.started, 1);
    assert.equal(slave.isRunning(), true);
    slave.stop();
    assert.equal(calls.closed, 1);
    assert.equal(slave.isRunning(), false);
  });

  test('setImage then readHoldingRegisters returns the served values', () => {
    const { slave, map } = newSlave({ exposure_tier: 1 });
    const hbAddr = map.tier1.points.find((p) => p.key === 'heartbeat').addr;
    slave.setImage({ [hbAddr]: 42 });
    const [v] = slave.readHoldingRegisters(hbAddr, 1);
    assert.equal(v, 42);
  });

  test('a signed value serves as unsigned two-complement', () => {
    const { slave, map } = newSlave({ exposure_tier: 1 });
    const addr = map.tier1.points.find((p) => p.key === 'worst_joint_index').addr;
    slave.setImage({ [addr]: -1 });
    assert.equal(slave.readHoldingRegisters(addr, 1)[0], 0xffff);
  });

  test('reading outside the map throws an illegal-data-address error', () => {
    const { slave, map } = newSlave({ exposure_tier: 1 });
    assert.throws(() => slave.readHoldingRegisters(map.extent, 1), /illegal data address/);
  });

  test('writing the ACK register fires the ack handler; other registers are read-only', () => {
    const { slave, map } = newSlave({ exposure_tier: 3 });
    const acks = [];
    slave.onAck((cmd) => acks.push(cmd));
    slave.writeRegister(map.control.ack, 1);
    assert.deepEqual(acks, [{ scope: 'all', source: 'bms' }]);
    assert.throws(() => slave.writeRegister(8, 1), /read-only/);
  });

  test('setImage preserves a pending ACK write (not stomped by a refresh)', () => {
    const { slave, map } = newSlave({ exposure_tier: 1 });
    slave.onAck(() => {});
    slave.writeRegister(map.control.ack, 1);
    const hbAddr = map.tier1.points.find((p) => p.key === 'heartbeat').addr;
    slave.setImage({ [hbAddr]: 9 }); // a refresh that doesn't touch ACK
    assert.equal(slave.readHoldingRegisters(map.control.ack, 1)[0], 1, 'ACK value retained');
  });
});
