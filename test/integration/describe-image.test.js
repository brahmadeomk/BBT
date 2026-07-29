'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildRegisterMap } = require('../../src/integration/register-map');
const { WorstJointLatch, computeRollup } = require('../../src/integration/rollup');
const { buildImage } = require('../../src/integration/holding-registers');
const { describeImage, formatImage } = require('../../src/integration/describe-image');
const { validIntegrationDoc, jointsDocTwoZones, activeAlarm } = require('./fixtures');

const joints = [
  { joint_id: 'J01', zone_id: 'Z1', temp_c: 61.5, deltaT: 28.2, ror: 4.1, state: 'LIVE' },
  { joint_id: 'J02', zone_id: 'Z1', temp_c: 45, deltaT: 12, ror: 1, state: 'LIVE' },
  { joint_id: 'J03', zone_id: 'Z2', temp_c: null, deltaT: null, ror: null, state: 'OFFLINE' },
];

function dump(overrides = { exposure_tier: 3 }, alarms = [activeAlarm({ joint_id: 'J01', level: 'WARNING' })]) {
  const map = buildRegisterMap(validIntegrationDoc(overrides), jointsDocTwoZones());
  const rollup = computeRollup(joints, alarms, new WorstJointLatch());
  const image = buildImage(map, rollup, { heartbeat: 7 });
  return { map, image, d: describeImage(map, image) };
}

describe('describeImage', () => {
  test('renders x10 points in engineering units, not raw counts', () => {
    const { d } = dump();
    const r = d.rows.find((x) => x.point === 'panel_max_temp');
    assert.equal(r.raw, 615);
    assert.equal(r.value, '61.5 °C', 'the whole point: 615 is not a temperature');
  });

  test('RoR carries its own unit', () => {
    const { d } = dump();
    assert.equal(d.rows.find((x) => x.point === 'panel_max_ror').value, '4.1 °C/hr');
  });

  test('the NO_DATA sentinel reads as "no data", never as a temperature', () => {
    const { d } = dump();
    const j3 = d.rows.find((x) => x.block === 'Tier 3' && x.label === 'J03' && x.point === 'temp');
    assert.equal(j3.value, 'no data', '-32768 must not render as -3276.8 °C');
  });

  test('enumerations are named, not left as bare numbers', () => {
    const { d } = dump();
    assert.equal(d.rows.find((x) => x.point === 'highest_alarm_level').value, '2 (WARNING)');
    assert.equal(d.rows.find((x) => x.point === 'system_health').value, '0 (OK)');
    const st = d.rows.find((x) => x.block === 'Tier 3' && x.label === 'J03' && x.point === 'state');
    assert.equal(st.value, '2 (OFFLINE)');
  });

  test('worst_joint_index explains its sentinels', () => {
    const noAlarms = dump({ exposure_tier: 3 }, []);
    assert.equal(noAlarms.d.rows.find((x) => x.point === 'worst_joint_index').value, '-1 (none)');
    const tier1 = dump({ exposure_tier: 1 });
    assert.equal(tier1.d.rows.find((x) => x.point === 'worst_joint_index').value, '-2 (set, Tier 3 not exposed)');
  });

  test('the writable ACK register is always listed, even though the image never writes it', () => {
    const { map, d } = dump();
    const ack = d.rows.find((x) => x.block === 'Control');
    assert.equal(ack.addr, map.control.ack);
    assert.match(ack.label, /ack all/);
  });

  test('rows are address-ordered and labelled with their zone/joint', () => {
    const { d } = dump();
    const addrs = d.rows.map((r) => r.addr);
    assert.deepEqual(addrs, [...addrs].sort((a, b) => a - b));
    assert.ok(d.rows.some((r) => r.block === 'Tier 2' && r.label === 'Z2'));
    assert.ok(d.rows.some((r) => r.block === 'Tier 3' && r.label === 'J02'));
  });

  test('tier 1 exposes only the summary + control blocks', () => {
    const { d } = dump({ exposure_tier: 1 });
    assert.ok(!d.rows.some((r) => r.block === 'Tier 2' || r.block === 'Tier 3'));
    assert.equal(d.exposure_tier, 1);
  });

  test('the bitmap block names the joints packed into each register', () => {
    const { d } = dump({ exposure_tier: 3, severity_bitmap: { enabled: true } });
    const b = d.rows.find((r) => r.block === 'Bitmap');
    assert.match(b.label, /J01/);
  });

  test('formatImage produces an aligned text dump with a header', () => {
    const { map, image } = dump();
    const txt = formatImage(map, image);
    assert.match(txt, /point_map_version 1/);
    assert.match(txt, /panel_max_temp/);
    assert.match(txt, /61\.5 °C/);
  });
});
