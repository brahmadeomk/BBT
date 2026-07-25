'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { BmsService } = require('../../src/integration/bms-service');
const { validIntegrationDoc, jointsDocTwoZones, activeAlarm } = require('./fixtures');

function fakeFactory() {
  const state = { io: null, closed: 0 };
  const factory = (args) => { state.io = args.io; return { close: () => state.closed++ }; };
  return { factory, state };
}

describe('BmsService — end-to-end with a fake server', () => {
  test('ingest + refresh builds an image and bumps the heartbeat', () => {
    const { factory } = fakeFactory();
    const svc = new BmsService({ integrationDoc: validIntegrationDoc({ exposure_tier: 3 }), jointsDoc: jointsDocTwoZones(), serverFactory: factory });
    svc.ingestJoint({ joint_id: 'J01', zone_id: 'Z1', emaTemp: 61, deltaT: { ema: 28 }, ror: 5 });
    svc.ingestAlarmsActive([activeAlarm({ joint_id: 'J01', level: 'WARNING' })]);

    const r1 = svc.refresh({ nowMs: 1000 });
    assert.equal(r1.heartbeat, 1);
    assert.equal(r1.rollup.highest_level, 2);
    const tempAddr = r1.map.tier3.joints.find((j) => j.joint_id === 'J01').points.find((p) => p.key === 'temp').addr;
    assert.equal(r1.image[tempAddr], 610, '61C x10');

    const r2 = svc.refresh({ nowMs: 2000 });
    assert.equal(r2.heartbeat, 2, 'heartbeat increments every refresh');
  });

  test('served registers are readable through the fake server after refresh', () => {
    const { factory, state } = fakeFactory();
    const svc = new BmsService({ integrationDoc: validIntegrationDoc({ exposure_tier: 1 }), jointsDoc: jointsDocTwoZones(), serverFactory: factory });
    svc.start();
    svc.refresh({ nowMs: 1 });
    const hbAddr = svc.map.tier1.points.find((p) => p.key === 'heartbeat').addr;
    assert.equal(state.io.readHoldingRegisters(hbAddr, 1)[0], 1);
  });

  test('a BMS ACK write flows to the onAck handler', () => {
    const { factory, state } = fakeFactory();
    const svc = new BmsService({ integrationDoc: validIntegrationDoc(), jointsDoc: jointsDocTwoZones(), serverFactory: factory });
    const acks = [];
    svc.onAck((cmd) => acks.push(cmd));
    svc.start();
    state.io.writeRegister(svc.map.control.ack, 1);
    assert.deepEqual(acks, [{ scope: 'all', source: 'bms' }]);
  });

  test('blacklist state marks joints OFFLINE/STALE and flags DEGRADED', () => {
    const { factory } = fakeFactory();
    const svc = new BmsService({ integrationDoc: validIntegrationDoc({ exposure_tier: 3 }), jointsDoc: jointsDocTwoZones(), serverFactory: factory });
    svc.ingestJoint({ joint_id: 'J01', zone_id: 'Z1', emaTemp: 61, ror: 5 });
    svc.ingestBlacklistState({
      slaves: { sl02: { status: 'blacklisted' } },
      joints: { J03: { state: 'OFFLINE', slave_id: 'sl02' } },
    });
    const r = svc.refresh({ nowMs: 1 });
    assert.equal(r.rollup.system_health, 1, 'DEGRADED — a device is blacklisted');
    const j3 = r.map.tier3.joints.find((j) => j.joint_id === 'J03');
    assert.equal(r.image[j3.points.find((p) => p.key === 'state').addr], 2, 'OFFLINE');
  });

  test('image-only mode (no serverFactory) still computes without binding a socket', () => {
    const svc = new BmsService({ integrationDoc: validIntegrationDoc(), jointsDoc: jointsDocTwoZones() });
    const r = svc.refresh({ nowMs: 1 });
    assert.ok(r.image);
    assert.equal(svc.slave, undefined);
  });

  test('reconfigure re-points at a new map when a joint is added', () => {
    const { factory } = fakeFactory();
    const svc = new BmsService({ integrationDoc: validIntegrationDoc({ exposure_tier: 3 }), jointsDoc: jointsDocTwoZones(), serverFactory: factory });
    const before = svc.map.tier3.joints.length;
    const joints = jointsDocTwoZones();
    joints.joints.push({ joint_id: 'J09', slave_id: 'sl02', channel: 1, zone_id: 'Z2', enabled: true, threshold_profile: 'default' });
    svc.reconfigure(validIntegrationDoc({ exposure_tier: 3, config_domain_versions: { integration: 2 }, point_map_version: 2 }), joints);
    assert.equal(svc.map.tier3.joints.length, before + 1);
  });
});
