'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { validateIntegration } = require('../../src/config-service/validate-integration');
const { validIntegrationDoc, jointsDocTwoZones } = require('../integration/fixtures');

describe('validate-integration — I1 schema', () => {
  test('a valid document passes', () => {
    const r = validateIntegration(validIntegrationDoc(), { jointsDoc: jointsDocTwoZones() });
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  test('schema violation (missing modbus_tcp) fails I1', () => {
    const doc = validIntegrationDoc();
    delete doc.modbus_tcp;
    const r = validateIntegration(doc);
    assert.equal(r.valid, false);
    assert.equal(r.errors[0].rule, 'schema');
  });

  test('out-of-range exposure_tier fails the schema enum', () => {
    const r = validateIntegration(validIntegrationDoc({ exposure_tier: 4 }));
    assert.equal(r.valid, false);
  });
});

describe('validate-integration — I2 privileged port (warning)', () => {
  test('port < 1024 warns but stays valid', () => {
    const r = validateIntegration(validIntegrationDoc({ modbus_tcp: { enabled: true, port: 502, unit_id: 1 } }), { jointsDoc: jointsDocTwoZones() });
    assert.equal(r.valid, true);
    assert.ok(r.warnings.some((w) => w.rule === 'I2'));
  });

  test('port >= 1024 has no I2 warning', () => {
    const r = validateIntegration(validIntegrationDoc(), { jointsDoc: jointsDocTwoZones() });
    assert.ok(!r.warnings.some((w) => w.rule === 'I2'));
  });
});

describe('validate-integration — I3 tier vs zones', () => {
  test('tier 2 with no zones in cfg/joints fails I3', () => {
    const joints = jointsDocTwoZones();
    joints.zones = [];
    joints.joints = joints.joints.map((j) => ({ ...j, zone_id: undefined }));
    const r = validateIntegration(validIntegrationDoc({ exposure_tier: 2 }), { jointsDoc: joints });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.rule === 'I3'));
  });

  test('tier 2 with zones passes I3', () => {
    const r = validateIntegration(validIntegrationDoc({ exposure_tier: 2 }), { jointsDoc: jointsDocTwoZones() });
    assert.ok(!r.errors.some((e) => e.rule === 'I3'));
  });
});

describe('validate-integration — I4 append-only point-map version', () => {
  test('a decreased point_map_version fails I4', () => {
    const r = validateIntegration(validIntegrationDoc({ point_map_version: 2 }), { jointsDoc: jointsDocTwoZones(), appliedPointMapVersion: 3 });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.rule === 'I4'));
  });

  test('an equal or advanced point_map_version passes I4', () => {
    const r = validateIntegration(validIntegrationDoc({ point_map_version: 3 }), { jointsDoc: jointsDocTwoZones(), appliedPointMapVersion: 3 });
    assert.ok(!r.errors.some((e) => e.rule === 'I4'));
  });

  test('domain version must advance (I4 monotonicity)', () => {
    const r = validateIntegration(validIntegrationDoc({ config_domain_versions: { integration: 1 } }), { jointsDoc: jointsDocTwoZones(), appliedVersion: 1 });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.rule === 'I4'));
  });
});

describe('validate-integration — I5 register-map capacity', () => {
  test('a layout that overflows the fixed region fails I5', () => {
    const joints = jointsDocTwoZones();
    joints.zones = [];
    for (let i = 0; i < 60; i++) joints.zones.push({ zone_id: `Z${i}`, name: `z${i}` });
    joints.joints = joints.joints.map((j, i) => ({ ...j, zone_id: `Z${i}` }));
    const r = validateIntegration(validIntegrationDoc({ exposure_tier: 2 }), { jointsDoc: joints });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.rule === 'I5'));
  });

  test('a normal panel builds within capacity (no I5 error)', () => {
    const r = validateIntegration(validIntegrationDoc({ exposure_tier: 3 }), { jointsDoc: jointsDocTwoZones() });
    assert.ok(!r.errors.some((e) => e.rule === 'I5'));
  });
});
