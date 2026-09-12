'use strict';

/**
 * ZONE-WISE THRESHOLDS, END TO END (2026-09-12).
 *
 * Every hop of this chain already has unit tests. None of them crosses a seam,
 * and every defect this feature has produced has lived in a seam: `applyJoints`
 * hardcoding `threshold_profile: 'default'`; an empty dropdown being stored as
 * `'default'` (which two of my own unit tests had ENCODED, and passed); the
 * `$watch` rebuild dropping `profile_names` so the dropdown had no options.
 * Each of those passed every unit test on both sides of the join.
 *
 * So this walks the whole operator sequence through the real handlers and a real
 * store, and asserts on the number the Alarm Manager would actually compare a
 * reading against:
 *
 *   Alarm Config: create a second profile   -> handleConfigManagerMessage
 *   Joint Config: bind the ZONE to it,      -> handleJointMasterMessage
 *                 leave one joint blank,
 *                 pin another to 'default'
 *   Publisher:    applied doc -> runtime    -> buildProcessLogicJoints
 *   Alarm Manager: profile name -> numbers  -> resolveThresholds
 *
 * The point of the last assertion is that the two joints end up on DIFFERENT
 * numbers. Everything short of that was true the whole time the feature was a
 * no-op.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ConfigStore } = require('../../src/config-service/store');
const { validateModbusJoints } = require('../../src/config-service/validate-modbus-joints');
const { validateAlarms } = require('../../src/config-service/validate-alarms');
const { handleConfigManagerMessage } = require('../../src/config-service/node-red/config-manager-handler');
const { handleJointMasterMessage } = require('../../src/config-service/node-red/joint-master-handler');
const { buildProcessLogicJoints } = require('../../src/config-service/process-logic-joints');
const { resolveThresholds } = require('../../src/alarms/threshold-resolver');

const SLAVE = (id, unit) => ({
  slave_id: id,
  bus_id: 'bus1',
  unit_address: unit,
  model: 'LEGACY-1CH',
  channels: 1,
  poll_interval_s: 30,
  registers: { function_code: 3, temp_base_addr: 3, temp_word_count: 1, temp_scale: 0.1 },
});

/** A commissioned panel: two joints in one zone, plus an ambient. */
function commissionedStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-zone-e2e-'));
  const store = new ConfigStore({
    root,
    validators: { modbus_joints: validateModbusJoints, alarms: validateAlarms },
  });
  const result = store.applyIfValid('modbus_joints', {
    config_domain_versions: { modbus: 1, joints: 1 },
    modbus: {
      buses: [{ bus_id: 'bus1', type: 'rtu', port: '/dev/ttyUSB0', baud: 9600, parity: 'N', stop_bits: 2, timeout_ms: 1000, retries: 2, inter_frame_ms: 10 }],
      slaves: [SLAVE('sl01', 1), SLAVE('sl02', 2), SLAVE('sl21', 101)],
      ambient_sensor: { slave_id: 'sl21', channel: 1 },
    },
    joints: [
      { joint_id: 'J01', slave_id: 'sl01', channel: 1, zone_id: 'z1', enabled: true },
      { joint_id: 'J02', slave_id: 'sl02', channel: 1, zone_id: 'z1', enabled: true },
    ],
    zones: [{ zone_id: 'z1', name: 'Zone1' }],
  });
  assert.ok(result.applied, `seed must apply: ${JSON.stringify(result.errors)}`);
  return store;
}

const PANEL_DEFAULT = {
  deltaT: { watch: 15, warning: 25, critical: 35 },
  ror: { watch: 15, warning: 30, critical: 60, timeWindowMin: 20 },
  persistence: { watchMin: 30, warningMin: 15, criticalMin: 5 },
};

/** A zone the operator wants watched harder: every number lower. */
const HOT_RISER = {
  deltaT: { watch: 8, warning: 12, critical: 18 },
  ror: { watch: 5, warning: 10, critical: 20, timeWindowMin: 10 },
  persistence: { watchMin: 10, warningMin: 5, criticalMin: 2 },
};

const slaveList = () => [
  { slaveID: 1, parameterName: 'Sensor1' },
  { slaveID: 2, parameterName: 'Sensor2' },
  { slaveID: 101, parameterName: 'AmbientT' },
];

/** What the Alarm Config screen sends: the whole map, every time. */
function applyProfiles(store, profiles) {
  return handleConfigManagerMessage({ payload: { action: 'profiles_apply', profiles, user: 'op' } }, store);
}

/** What the Joint Config screen sends: the whole table, every time. */
function applyJointTable(store, { zoneProfile, jointProfiles }) {
  return handleJointMasterMessage(
    { payload: { action: 'apply' } },
    {
      store,
      slaveList: slaveList(),
      zones: [{ zone_id: 'Z1', zone_name: 'Zone1', threshold_profile: zoneProfile }],
      joints: [
        { joint_name: 'J01', joint_id: 'J01', slaveID: 1, ambientSlaveID: 101, zone_id: 'Z1', editing: false, threshold_profile: jointProfiles.J01 },
        { joint_name: 'J02', joint_id: 'J02', slaveID: 2, ambientSlaveID: 101, zone_id: 'Z1', editing: false, threshold_profile: jointProfiles.J02 },
      ],
    }
  );
}

/** The last hop: what the Alarm Manager compares a reading against. */
function thresholdsFor(store, runtimeConfig, jointId) {
  const { joints, warnings } = buildProcessLogicJoints(store.readDomain('modbus_joints').doc);
  assert.deepEqual(warnings, [], 'the publisher must not drop a joint');
  const row = joints.find((j) => j.joint_id === jointId);
  assert.ok(row, `${jointId} must reach the runtime`);
  return { row, th: resolveThresholds(runtimeConfig, row.threshold_profile) };
}

describe('zone-wise thresholds, operator sequence end to end', () => {
  test('a zone binding moves its joints onto different numbers', () => {
    const store = commissionedStore();

    // 1. Alarm Config: add a second profile beside the mandatory default.
    const created = applyProfiles(store, { default: PANEL_DEFAULT, hot_riser: HOT_RISER });
    assert.equal(created.msg.payload.error, undefined, created.msg.payload.error);
    assert.ok(created.runtimeConfig, 'the apply must publish a runtime config');
    const runtimeConfig = created.runtimeConfig;
    assert.deepEqual(Object.keys(runtimeConfig.profiles).sort(), ['default', 'hot_riser']);

    // 2. Joint Config: bind the ZONE, leave J01 blank, pin J02 to 'default'.
    const applied = applyJointTable(store, {
      zoneProfile: 'hot_riser',
      jointProfiles: { J01: '', J02: 'default' },
    });
    assert.equal(applied.msg.payload.error, undefined, applied.msg.payload.error);

    // The applied document is the only durable record - the drafts are not.
    const doc = store.readDomain('modbus_joints').doc;
    assert.equal(doc.zones[0].threshold_profile, 'hot_riser');
    assert.equal('threshold_profile' in doc.joints.find((j) => j.joint_id === 'J01'), false,
      'a blank dropdown must store NOTHING, or it would beat the zone');
    assert.equal(doc.joints.find((j) => j.joint_id === 'J02').threshold_profile, 'default');

    // 3+4. Publisher resolves the chain; the resolver turns the name into numbers.
    const j01 = thresholdsFor(store, runtimeConfig, 'J01');
    const j02 = thresholdsFor(store, runtimeConfig, 'J02');

    assert.equal(j01.row.threshold_profile, 'hot_riser', 'J01 inherits its zone');
    assert.equal(j02.row.threshold_profile, 'default', "J02's own choice beats the zone");

    // THE ASSERTION THE WHOLE FEATURE IS FOR.
    assert.deepEqual(j01.th.deltaT, HOT_RISER.deltaT);
    assert.deepEqual(j02.th.deltaT, PANEL_DEFAULT.deltaT);
    assert.notDeepEqual(j01.th.deltaT, j02.th.deltaT);
    assert.deepEqual(j01.th.ror, HOT_RISER.ror);
    assert.deepEqual(j01.th.persistence, HOT_RISER.persistence);
  });

  test('rebinding the zone alone moves the joint that inherits, and only that one', () => {
    // Proves the ZONE is doing the work. If the joint had silently been pinned,
    // both joints would stay put and this would still look correct in the table.
    const store = commissionedStore();
    const runtimeConfig = applyProfiles(store, { default: PANEL_DEFAULT, hot_riser: HOT_RISER }).runtimeConfig;
    applyJointTable(store, { zoneProfile: 'hot_riser', jointProfiles: { J01: '', J02: 'default' } });

    const before = {
      J01: thresholdsFor(store, runtimeConfig, 'J01').th.deltaT,
      J02: thresholdsFor(store, runtimeConfig, 'J02').th.deltaT,
    };

    // Operator clears the zone's override; nothing else on the table changes.
    applyJointTable(store, { zoneProfile: '', jointProfiles: { J01: '', J02: 'default' } });

    assert.deepEqual(before.J01, HOT_RISER.deltaT);
    assert.deepEqual(thresholdsFor(store, runtimeConfig, 'J01').th.deltaT, PANEL_DEFAULT.deltaT,
      'J01 falls back to the panel-wide set when its zone stops naming one');
    assert.deepEqual(thresholdsFor(store, runtimeConfig, 'J02').th.deltaT, before.J02,
      'J02 was never on the zone, so it must not move');
  });

  test('the profile a zone depends on cannot be deleted out from under it', () => {
    const store = commissionedStore();
    applyProfiles(store, { default: PANEL_DEFAULT, hot_riser: HOT_RISER });
    applyJointTable(store, { zoneProfile: 'hot_riser', jointProfiles: { J01: '', J02: '' } });

    const refused = applyProfiles(store, { default: PANEL_DEFAULT });
    assert.match(refused.msg.payload.error ?? '', /hot_riser/);
    assert.match(refused.msg.payload.error ?? '', /zone 'z1'/);
    assert.equal(refused.runtimeConfig, null, 'a refused edit must not republish the runtime');
    // And the store is untouched, so the zone's joints keep their thresholds.
    assert.ok(store.readDomain('alarms').doc.profiles.hot_riser);
  });

  test('a joint whose zone names a profile that is gone still gets watched', () => {
    // Fail-safe. The resolver, not the publisher, decides what a dangling name
    // means - and it must mean "the panel-wide set", never "no thresholds".
    const store = commissionedStore();
    const runtimeConfig = applyProfiles(store, { default: PANEL_DEFAULT, hot_riser: HOT_RISER }).runtimeConfig;
    applyJointTable(store, { zoneProfile: 'hot_riser', jointProfiles: { J01: '', J02: '' } });

    // A runtime global from BEFORE hot_riser existed - what a panel actually has
    // in the window between an alarms apply and the next global write.
    const stale = { ...PANEL_DEFAULT, profiles: { default: PANEL_DEFAULT } };
    const { th } = thresholdsFor(store, stale, 'J01');
    assert.deepEqual(th.deltaT, PANEL_DEFAULT.deltaT);
    assert.equal(th.via, 'fallback_default', 'and it says so, rather than passing silently');
    assert.ok(resolveThresholds(runtimeConfig, 'hot_riser'), 'sanity: the live global does have it');
  });
});
