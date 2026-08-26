'use strict';

/**
 * The MGate CSV generator. These tests encode the manual's constraints, because
 * every one of them is a rule the gateway enforces at IMPORT time — after the
 * whole sheet has been built — rather than at runtime.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildRegisterMap } = require('../../src/integration/register-map');
const {
  buildMgatePlan, toCsv, headerFromTemplate, sanitizeDescription,
  objectTypeFor, UNIT_DEGREES_CELSIUS, UNIT_NO_UNITS, DESCRIPTION_MAX,
} = require('../../src/integration/mgate-csv');

const panel = (nj = 6, nz = 2) => ({
  joints: Array.from({ length: nj }, (_, i) => ({
    joint_id: `J${String(i + 1).padStart(2, '0')}`, slave_id: 'sl01', channel: 1,
    zone_id: `z${1 + (i % nz)}`, enabled: true, threshold_profile: 'default',
  })),
  zones: Array.from({ length: nz }, (_, i) => ({ zone_id: `z${i + 1}`, name: `Zone ${i + 1}` })),
});

const mapFor = (jointsDoc, tier = 3) => buildRegisterMap({
  config_domain_versions: { integration: 1 }, point_map_version: 1, exposure_tier: tier,
  severity_bitmap: { enabled: false }, modbus_tcp: { enabled: true, port: 1502, unit_id: 1 },
}, jointsDoc);

const planFor = (jointsDoc, opts = {}) => buildMgatePlan(mapFor(jointsDoc), { jointsDoc, ...opts });

describe('MGate CSV — object types (manual p59)', () => {
  test('a READ command never uses Analog Value — that type is write-only', () => {
    // p59: Analog Value is legal only for cmdFunc 5/6/15/16. Every measurement
    // we expose is FC 3, so getting this wrong fails the whole import.
    const plan = planFor(panel());
    const reads = plan.commands.filter((c) => c.cmdFunc === 3);
    assert.ok(reads.length > 0);
    for (const c of reads) {
      assert.notEqual(c.bacnetObjectType, 'Analog Value', `${c.cmdName} is a read but typed Analog Value`);
      assert.ok(['Analog Input', 'Integer Value', 'Positive Integer Value', 'Multi-state Input']
        .includes(c.bacnetObjectType), `${c.cmdName}: ${c.bacnetObjectType} is not legal on FC 3`);
    }
  });

  test('the ACK point is the only write, and uses a writable object type', () => {
    const plan = planFor(panel());
    const writes = plan.commands.filter((c) => c.cmdFunc === 6);
    assert.equal(writes.length, 1, 'exactly one writable point');
    assert.equal(writes[0].bacnetObjectType, 'Analog Value');
    assert.notEqual(writes[0].cmdWriteStartAddr, '*', 'a write command needs a write address');
    assert.equal(writes[0].cmdReadStartAddr, '*', 'and no read address');
  });

  test('scaled points become Analog Input in degrees-celsius; unscaled do not', () => {
    const plan = planFor(panel());
    const temp = plan.commands.find((c) => c.cmdName === 'J01 temp');
    const level = plan.commands.find((c) => c.cmdName === 'J01 level');
    assert.equal(temp.bacnetObjectType, 'Analog Input');
    assert.equal(temp.bacnetUnit, UNIT_DEGREES_CELSIUS);
    assert.equal(level.bacnetObjectType, 'Multi-state Input');
    assert.equal(level.bacnetUnit, UNIT_NO_UNITS);
  });

  test('object type is derived from the map\'s scale, not a hardcoded key list', () => {
    assert.equal(objectTypeFor({ key: 'anything_new', scale: 10 }), 'Analog Input');
    assert.equal(objectTypeFor({ key: 'anything_new', scale: 1 }), 'Integer Value');
  });
});

describe('MGate CSV — field limits the firmware enforces', () => {
  test('descriptions drop the characters the manual forbids (p61)', () => {
    // `- " ' # * , [ ]` are rejected, and the panel's own point descriptions
    // contain "ΔT" and "°C", which are not ASCII.
    const s = sanitizeDescription('ΔT 29.5 °C - "J01" #1, [x] *');
    assert.ok(!/[-"'#*,\[\]]/.test(s), `still has a forbidden character: ${s}`);
    assert.ok(/^[\x20-\x7E]*$/.test(s), `non-ASCII survived: ${s}`);
    assert.match(s, /deltaT/);
  });

  test('every generated description and name is within its length limit', () => {
    const plan = planFor(panel(20, 4));
    for (const c of plan.commands) {
      assert.ok(c.bacnetDescription.length <= DESCRIPTION_MAX, c.bacnetDescription);
      assert.ok(c.cmdName.length <= 39, c.cmdName);
      assert.ok(!/[-"'#*,\[\]]/.test(c.bacnetDescription), c.bacnetDescription);
    }
  });

  test('bacnetInstance is unique within each object type (p60)', () => {
    const plan = planFor(panel(20, 4));
    const seen = new Map();
    for (const c of plan.commands) {
      const key = `${c.bacnetObjectType}#${c.bacnetInstance}`;
      assert.ok(!seen.has(key), `duplicate instance ${key} (${c.cmdName} and ${seen.get(key)})`);
      seen.set(key, c.cmdName);
    }
  });

  test('cmdIndex starts at 1 and increases in order (p57)', () => {
    const plan = planFor(panel(12, 3));
    plan.commands.forEach((c, i) => assert.equal(c.cmdIndex, i + 1));
  });
});

describe('MGate CSV — capacity', () => {
  test('refuses to emit more points than the model licenses', () => {
    const plan = planFor(panel(200, 8), { pointLimit: 1200 });
    assert.ok(plan.commands.length > 1200);
    assert.equal(plan.errors.length, 1);
    assert.match(plan.errors[0], /exceeds the 1200-point model/);
  });

  test('dropping absolute_temp saves exactly one point per joint', () => {
    const full = planFor(panel(200, 8));
    const lean = planFor(panel(200, 8), { skipAbsoluteTemp: true });
    assert.equal(full.commands.length - lean.commands.length, 200);
    assert.equal(lean.errors.length, 0, 'and that is what brings it under the limit');
  });

  test('flags the COV guidance once the panel is big (p21)', () => {
    const plan = planFor(panel(100, 8));
    assert.ok(plan.warnings.some((w) => /300 COV subscriptions/.test(w)));
  });

  test('always flags that the x10 scaling is not in the CSV', () => {
    const plan = planFor(panel(4, 2));
    assert.ok(plan.warnings.some((w) => /Data scaling \(multiplication\)" = 0\.1/.test(w)));
  });
});

describe('MGate CSV — virtual devices and the two-gateway split', () => {
  test('zone grouping makes one Modbus device per zone, plus the summary', () => {
    const plan = planFor(panel(8, 3));
    assert.deepEqual(plan.devices.map((d) => d.devName), ['Panel Summary', 'Zone 1', 'Zone 2', 'Zone 3']);
    // devSequence is the 2nd-3rd digit of the BACnet instance (p57)
    assert.deepEqual(plan.devices.map((d) => d.devSequence), [1, 2, 3, 4]);
    const zone1 = plan.devices.find((d) => d.devName === 'Zone 1');
    const its = plan.commands.filter((c) => c.cmdDevIndex === zone1.devIndex);
    assert.ok(its.some((c) => c.cmdName.startsWith('J01 ')), 'J01 is in zone 1');
    assert.ok(!its.some((c) => c.cmdName.startsWith('J02 ')), 'J02 is in zone 2, not here');
  });

  test('flat grouping puts everything on one device', () => {
    const plan = planFor(panel(8, 3), { grouping: 'flat' });
    assert.equal(plan.devices.length, 2, 'summary + one joints device');
  });

  test('gateway B takes the later joints, no panel block, but keeps a heartbeat', () => {
    const a = planFor(panel(10, 2), { jointFrom: 0, jointTo: 4 });
    const b = planFor(panel(10, 2), { jointFrom: 5, includePanel: false });

    // Commands come out grouped BY ZONE, so the joint order within a gateway is
    // zone order, not index order - sort before comparing membership.
    const jointsIn = (p) => [...new Set(p.commands.map((c) => /^(J\d+) /.exec(c.cmdName)?.[1]).filter(Boolean))].sort();
    assert.deepEqual(jointsIn(a), ['J01', 'J02', 'J03', 'J04', 'J05']);
    assert.deepEqual(jointsIn(b), ['J06', 'J07', 'J08', 'J09', 'J10']);

    // the ACK must exist on exactly one gateway - two writers on one register
    // is the thing the split rule exists to prevent
    assert.equal(a.commands.filter((c) => c.cmdFunc === 6).length, 1);
    assert.equal(b.commands.filter((c) => c.cmdFunc === 6).length, 0);

    // ...but B still needs liveness of its own
    assert.ok(b.commands.some((c) => /heartbeat/i.test(c.cmdName)), 'gateway B needs a heartbeat');
  });

  test('splitting by ZONE keeps each zone rollup on exactly one gateway', () => {
    // A zone's Tier-2 rollup covers every joint in that zone, wherever it lives.
    // Splitting by joint index would emit the same rollup on BOTH gateways -
    // two BACnet objects reporting one register, which is worse than useless.
    const doc = panel(16, 4);
    const a = buildMgatePlan(mapFor(doc), { jointsDoc: doc, zoneFrom: 0, zoneTo: 1 });
    const b = buildMgatePlan(mapFor(doc), { jointsDoc: doc, zoneFrom: 2, includePanel: false });

    assert.deepEqual(a.devices.map((d) => d.devName), ['Panel Summary', 'Zone 1', 'Zone 2']);
    assert.deepEqual(b.devices.map((d) => d.devName), ['Panel Heartbeat', 'Zone 3', 'Zone 4']);

    // no register is polled by both gateways
    const addrs = (p) => new Set(p.commands.map((c) => c._addr));
    const overlap = [...addrs(a)].filter((x) => addrs(b).has(x));
    assert.deepEqual(overlap, [0], 'only the heartbeat (register 0) is deliberately on both');
  });
});

describe('MGate CSV — output', () => {
  test('emits both sections with the documented header when no template is given', () => {
    const csv = toCsv(planFor(panel(2, 1)));
    assert.match(csv, /\[device_parameters\]/);
    assert.match(csv, /\[command_parameters\]/);
    assert.match(csv, /cmdIndex,cmdEnable,cmdName/);
    assert.ok(!csv.includes('_scale'), 'internal fields must not leak into the CSV');
    assert.ok(!csv.includes('_addr'));
  });

  test('a template header is honoured, and unknown columns become the "not used" marker', () => {
    // The CSV format is versioned (p54) and the manual's column list omits the
    // scaling fields the web console has - so the gateway's own export wins.
    const template = [
      '[device_parameters]', 'devIndex,devName,devIpAddr,devPort',
      '', '[command_parameters]', 'cmdIndex,cmdReadStartAddr,bacnetDescription,someNewFirmwareColumn',
    ].join('\n');
    const ch = headerFromTemplate(template, 'command_parameters');
    assert.deepEqual(ch, ['cmdIndex', 'cmdReadStartAddr', 'bacnetDescription', 'someNewFirmwareColumn']);

    const csv = toCsv(planFor(panel(1, 1)), {
      commandHeader: ch, deviceHeader: headerFromTemplate(template, 'device_parameters'),
    });
    // Look inside [command_parameters] specifically - a device row is also 4
    // columns wide here and would otherwise match.
    const cmdSection = csv.slice(csv.indexOf('[command_parameters]'));
    const line = cmdSection.split('\n').find((l) => /^1,/.test(l));
    assert.ok(line, 'a command row matching the template width');
    assert.deepEqual(line.split(','), ['1', '0', 'Panel heartbeat', '*'],
      'known columns filled from the plan, unknown column gets the not-used marker');
  });

  test('headerFromTemplate returns null rather than guessing when the section is absent', () => {
    assert.equal(headerFromTemplate('[master_parameters]\na,b\n', 'command_parameters'), null);
    assert.equal(headerFromTemplate('', 'command_parameters'), null);
  });
});
