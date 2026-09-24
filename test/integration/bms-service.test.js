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

describe('BmsService.snapshot — read-only', () => {
  const { factory } = fakeFactory();
  function svcWithAlarm() {
    const svc = new BmsService({ integrationDoc: validIntegrationDoc({ exposure_tier: 3 }), jointsDoc: jointsDocTwoZones(), serverFactory: factory });
    svc.ingestJoint({ joint_id: 'J01', zone_id: 'Z1', emaTemp: 61, ror: 5 });
    svc.ingestAlarmsActive([activeAlarm({ joint_id: 'J01', level: 'WARNING', raisedTs: '2026-07-29T10:00:00Z' })]);
    svc.refresh();
    return svc;
  }

  test('does not advance the heartbeat (the BMS liveness signal)', () => {
    const svc = svcWithAlarm();
    const hb = svc.heartbeat;
    svc.snapshot();
    svc.snapshot();
    assert.equal(svc.heartbeat, hb, 'a diagnostic view must not look like a live scan');
  });

  test('does not push to the slave', () => {
    const svc = svcWithAlarm();
    const before = svc.slave.readHoldingRegisters(0, 12).join(',');
    svc.snapshot();
    assert.equal(svc.slave.readHoldingRegisters(0, 12).join(','), before);
  });

  test('does not reassign the latched worst joint', () => {
    const svc = svcWithAlarm();
    assert.equal(svc.latch.current.joint_id, 'J01');
    // a joint that raised LATER at the same level must not steal the point via a view
    svc.ingestAlarmsActive([
      activeAlarm({ joint_id: 'J02', level: 'WARNING', raisedTs: '2026-07-29T11:00:00Z', instanceId: 'PROCESS|J02|DELTA_T|WARNING' }),
    ]);
    svc.snapshot();
    assert.equal(svc.latch.current.joint_id, 'J01', 'the real latch is untouched by a read-only view');
  });

  test('still reports the current image contents', () => {
    const svc = svcWithAlarm();
    const s = svc.snapshot();
    const addr = s.map.tier3.joints.find((j) => j.joint_id === 'J01').points.find((p) => p.key === 'temp').addr;
    assert.equal(s.image[addr], 610);
  });
});

describe('an unwatched joint reads NO_DATA at the BMS (2026-09-24)', () => {
  // Without this the service goes on presenting the joint's LAST temperature as
  // a live point for ever - a BMS reading a stale number as current on a
  // fire-safety point is worse than reading nothing.
  const { isJointMonitored } = require('../../src/config-service/process-logic-joints');

  test('the shared rule says it is not watched', () => {
    const doc = {
      modbus: { slaves: [{ slave_id: 'sl01', unit_address: 1, enabled: false }] },
      joints: [{ joint_id: 'J01', slave_id: 'sl01', channel: 1, zone_id: 'z1' }],
    };
    assert.equal(isJointMonitored(doc, doc.joints[0]), false);
  });

  test('bms-service consults it rather than defaulting to LIVE', () => {
    // Pinned as source, because building the whole service here would test the
    // harness more than the behaviour: the failure mode was a literal
    // `|| 'LIVE'` default that ignored configuration entirely.
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'integration', 'bms-service.js'), 'utf8');
    assert.ok(/const watched = isJointMonitored\(this\.jointsDoc, j\)/.test(src));
    assert.ok(/state: watched \? \(this\._jointStates\[j\.joint_id\] \|\| 'LIVE'\) : 'OFFLINE'/.test(src));
    assert.ok(/temp_c: watched \? \(kpi\.temp_c \?\? null\) : null/.test(src));
  });
});
