'use strict';

/**
 * Alarms raised against the APPLIED configuration (user decision 2026-09-01).
 *
 * ProcessLogic read the legacy DRAFT while the alarm sweep cleared against the
 * applied document - two sources of truth for one lifecycle, which produced
 * both stuck alarms and raise/clear churn, and let a joint id the schema would
 * reject raise alarms anyway.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildProcessLogicJoints, diffDraftVsApplied } = require('../../src/config-service/process-logic-joints');

const doc = (over = {}) => ({
  config_version: 7,
  modbus: {
    ambient_sensor: 'sl21',
    slaves: [
      { slave_id: 'sl01', unit_address: 1, label: 'Sensor1' },
      { slave_id: 'sl02', unit_address: 2, label: 'Sensor2' },
      { slave_id: 'sl21', unit_address: 101, label: 'AmbientPanel' },
      { slave_id: 'sl22', unit_address: 102, label: 'AmbientZone' },
    ],
  },
  zones: [{ zone_id: 'z1', name: 'Zone1' }, { zone_id: 'z2', name: 'Riser' }],
  joints: [
    { joint_id: 'J01', slave_id: 'sl01', channel: 1, zone_id: 'z1', label: 'Riser bend' },
    { joint_id: 'J02', slave_id: 'sl02', channel: 1, zone_id: 'z1' },
  ],
  ...over,
});

describe('buildProcessLogicJoints - the row shape ProcessLogic consumes', () => {
  test('maps slave_id to the unit address the reading stream actually carries', () => {
    // ProcessLogic matches `j.slaveID === sensorID`, and sensorID is the Nano
    // frame's `id` - a unit address, not the internal slave_id.
    const { joints } = buildProcessLogicJoints(doc());
    assert.deepEqual(joints.map((j) => j.slaveID), [1, 2]);
  });

  test('carries the operator label as joint_name, falling back to the id', () => {
    const { joints } = buildProcessLogicJoints(doc());
    assert.equal(joints[0].joint_name, 'Riser bend');
    assert.equal(joints[1].joint_name, 'J02', 'unnamed joints keep working');
  });

  test('resolves the zone name, which the alarm object and HMI both need', () => {
    assert.equal(buildProcessLogicJoints(doc()).joints[0].zone_name, 'Zone1');
  });

  test('skips disabled joints', () => {
    const d = doc();
    d.joints[1].enabled = false;
    assert.deepEqual(buildProcessLogicJoints(d).joints.map((j) => j.joint_id), ['J01']);
  });
});

describe('buildProcessLogicJoints - the R14 ambient chain, which the draft never honoured', () => {
  // Keys are "<unit>:<channel>": a flat unit address cannot distinguish channel 3
  // of a 4-channel module used as the zone ambient from channel 1.
  test('panel-wide default applies when nothing overrides it', () => {
    const { joints } = buildProcessLogicJoints(doc());
    assert.deepEqual(joints.map((j) => j.ambientKey), ['101:1', '101:1']);
  });

  test('a zone override beats the panel default', () => {
    const d = doc();
    d.zones[0].ambient_sensor = 'sl22';
    assert.equal(buildProcessLogicJoints(d).joints[0].ambientKey, '102:1');
  });

  test('a joint override beats both', () => {
    const d = doc();
    d.zones[0].ambient_sensor = 'sl22';
    d.joints[0].ambient_sensor = 'sl21';
    assert.equal(buildProcessLogicJoints(d).joints[0].ambientKey, '101:1');
  });

  test('an object-form reference carries its channel into the key', () => {
    const d = doc();
    d.joints[0].ambient_sensor = { slave_id: 'sl22', channel: 3 };
    assert.equal(buildProcessLogicJoints(d).joints[0].ambientKey, '102:3');
  });

  test('a bare slave_id means channel 1', () => {
    const d = doc();
    d.joints[0].ambient_sensor = 'sl22';
    assert.equal(buildProcessLogicJoints(d).joints[0].ambientKey, '102:1');
  });

  test('no ambient anywhere yields null, not a fabricated reference', () => {
    const d = doc();
    delete d.modbus.ambient_sensor;
    assert.equal(buildProcessLogicJoints(d).joints[0].ambientKey, null);
  });
});

describe('buildProcessLogicJoints - multi-channel slaves (steps 3-4)', () => {
  test('several joints on ONE slave are all monitored, one row per channel', () => {
    // Before the fan-out only the lowest channel survived, because the frame
    // carried no channel. It does now, so this is what the schema always meant.
    const d = doc();
    d.modbus.slaves[0].channels = 3;
    d.joints = [
      { joint_id: 'JB', slave_id: 'sl01', channel: 2, zone_id: 'z1' },
      { joint_id: 'JA', slave_id: 'sl01', channel: 1, zone_id: 'z1' },
      { joint_id: 'JC', slave_id: 'sl01', channel: 3, zone_id: 'z1' },
    ];
    const { joints, warnings } = buildProcessLogicJoints(d);
    assert.deepEqual(joints.map((j) => `${j.joint_id}@${j.slaveID}:${j.channel}`),
      ['JA@1:1', 'JB@1:2', 'JC@1:3']);
    assert.deepEqual(warnings, [], 'no collision - they are different sensors');
  });

  test('a duplicate (slave, channel) pair is still refused', () => {
    // R7 rejects this at apply time, so it can only reach here on a document
    // that bypassed validation - but it must not silently double-count.
    const d = doc();
    d.joints = [
      { joint_id: 'JA', slave_id: 'sl01', channel: 1, zone_id: 'z1' },
      { joint_id: 'JDUP', slave_id: 'sl01', channel: 1, zone_id: 'z1' },
    ];
    const { joints, warnings } = buildProcessLogicJoints(d);
    assert.deepEqual(joints.map((j) => j.joint_id), ['JA']);
    assert.match(warnings[0], /both claim unit 1 channel 1/);
  });

  test('a single-channel joint defaults to channel 1', () => {
    const d = doc();
    delete d.joints[0].channel;
    assert.equal(buildProcessLogicJoints(d).joints[0].channel, 1);
  });

  test('a joint on an uncommissioned slave is dropped, with a warning naming it', () => {
    const d = doc();
    d.joints.push({ joint_id: 'J99', slave_id: 'sl77', channel: 1, zone_id: 'z1' });
    const { joints, warnings } = buildProcessLogicJoints(d);
    assert.deepEqual(joints.map((j) => j.joint_id), ['J01', 'J02']);
    assert.match(warnings[0], /J99: slave sl77 is not commissioned/);
  });
});

describe('buildProcessLogicJoints - refuses to act on absent information', () => {
  test('an unreadable or empty document returns null, never an empty list', () => {
    // An empty list published to the global would stop monitoring the entire
    // panel. The caller is told to keep whatever it already had.
    for (const bad of [undefined, null, {}, 'nonsense', { joints: [] }]) {
      const r = buildProcessLogicJoints(bad);
      assert.equal(r.joints, null, `doc=${JSON.stringify(bad)}`);
      assert.match(r.warnings[0], /unreadable or empty/);
    }
  });
});

describe('diffDraftVsApplied - making the new gap visible', () => {
  const applied = () => buildProcessLogicJoints(doc()).joints;

  test('a joint saved but never applied is reported as not monitored', () => {
    // This is the behaviour change: before, an unapplied row was monitored
    // anyway. It must announce itself rather than being discovered later.
    const draft = [{ joint_id: 'J01' }, { joint_id: 'J02' }, { joint_id: 'J03' }];
    const d = diffDraftVsApplied(draft, applied());
    assert.deepEqual(d.notApplied, ['J03']);
    assert.equal(d.inSync, false);
  });

  test('an in-sync configuration reports clean', () => {
    const d = diffDraftVsApplied([{ joint_id: 'J01' }, { joint_id: 'J02' }], applied());
    assert.deepEqual(d.notApplied, []);
    assert.deepEqual(d.notInDraft, []);
    assert.equal(d.inSync, true);
  });

  test('a half-typed row with no id yet is not counted as unapplied', () => {
    // Mid-edit rows are unfinished, not pending - flagging them would make the
    // banner cry wolf every time someone clicks ADD.
    const draft = [{ joint_id: 'J01' }, { joint_id: 'J02' }, { joint_id: '', editing: true }];
    assert.deepEqual(diffDraftVsApplied(draft, applied()).notApplied, []);
  });

  test('applied-but-not-in-the-table is reported separately, not as an error', () => {
    const d = diffDraftVsApplied([{ joint_id: 'J01' }], applied());
    assert.deepEqual(d.notInDraft, ['J02']);
  });

  test('malformed inputs do not throw', () => {
    for (const bad of [undefined, null, 'x', 42]) {
      assert.doesNotThrow(() => diffDraftVsApplied(bad, bad));
    }
  });
});

describe('joint name survives the move to the applied document', () => {
  // Live regression 2026-09-01: repointing ProcessLogic at the applied doc sent
  // the alarm e-mails back to "Joint: J02". The operator types the name into a
  // MANDATORY column, but the joint-table apply never persisted it as
  // `joints[].label`, so it existed only in the legacy draft.
  const noLabel = () => ({
    modbus: { slaves: [{ slave_id: 'sl02', unit_address: 2 }] },
    zones: [{ zone_id: 'z1', name: 'Zone1' }],
    joints: [{ joint_id: 'J02', slave_id: 'sl02', channel: 1, zone_id: 'z1' }],
  });
  const fallback = new Map([['J02', 'Dc/07/Fl_0/Tx/Line_1']]);

  test('a document applied before the fix recovers the name from the draft', () => {
    assert.equal(buildProcessLogicJoints(noLabel(), { labelFallback: fallback }).joints[0].joint_name,
      'Dc/07/Fl_0/Tx/Line_1');
  });

  test('a persisted label always wins over the draft', () => {
    // The applied config is the source of truth; the draft is only a stopgap
    // for documents that predate the field.
    const d = noLabel();
    d.joints[0].label = 'Riser bend';
    assert.equal(buildProcessLogicJoints(d, { labelFallback: fallback }).joints[0].joint_name, 'Riser bend');
  });

  test('with neither, it falls back to the id rather than inventing one', () => {
    assert.equal(buildProcessLogicJoints(noLabel()).joints[0].joint_name, 'J02');
  });

  test('a malformed fallback is not an error', () => {
    for (const bad of [undefined, null, {}, new Map()]) {
      assert.doesNotThrow(() => buildProcessLogicJoints(noLabel(), { labelFallback: bad }));
    }
  });
});

test('published joints carry threshold_profile (2026-09-10)', async (t) => {
  // Without this the Alarm Manager has no way to know which profile a joint is
  // on, and silently evaluates every joint against the panel-wide default -
  // which is exactly the no-op this field was added to fix.
  const withProfiles = doc({
    joints: [
      { joint_id: 'J01', slave_id: 'sl01', channel: 1, zone_id: 'z1', label: 'A', threshold_profile: 'outdoor' },
      { joint_id: 'J02', slave_id: 'sl02', channel: 1, zone_id: 'z1', label: 'B' },
    ],
  });

  await t.test('a joint on a named profile publishes that name', () => {
    const { joints } = buildProcessLogicJoints(withProfiles);
    assert.equal(joints.find((j) => j.joint_id === 'J01').threshold_profile, 'outdoor');
  });

  await t.test('an unset profile publishes null, not a fabricated default', () => {
    // The resolver owns what "unset" means; writing 'default' here would be a
    // second place to change it, and the two could disagree.
    const { joints } = buildProcessLogicJoints(withProfiles);
    assert.equal(joints.find((j) => j.joint_id === 'J02').threshold_profile, null);
  });
});

test('zone-wise thresholds: joint -> zone -> unset (2026-09-10)', async (t) => {
  // Same 3-level shape as the ambient chain, resolved in the same place so the
  // two cannot drift into different precedence rules.
  const zoned = (over = {}) => doc({
    zones: [
      { zone_id: 'z1', name: 'Riser AC', threshold_profile: 'indoor' },
      { zone_id: 'z2', name: 'Outdoor', ...over },
    ],
    joints: [
      { joint_id: 'J01', slave_id: 'sl01', channel: 1, zone_id: 'z1' },
      { joint_id: 'J02', slave_id: 'sl02', channel: 1, zone_id: 'z1', threshold_profile: 'hot_riser' },
    ],
  });

  await t.test('a joint with no profile of its own inherits its zone', () => {
    const { joints } = buildProcessLogicJoints(zoned());
    assert.equal(joints.find((j) => j.joint_id === 'J01').threshold_profile, 'indoor');
  });

  await t.test('a joint override beats its zone', () => {
    const { joints } = buildProcessLogicJoints(zoned());
    assert.equal(joints.find((j) => j.joint_id === 'J02').threshold_profile, 'hot_riser');
  });

  await t.test('neither set publishes null, leaving the fallback to the resolver', () => {
    const plain = doc({
      zones: [{ zone_id: 'z1', name: 'Zone1' }],
      joints: [{ joint_id: 'J01', slave_id: 'sl01', channel: 1, zone_id: 'z1' }],
    });
    assert.equal(buildProcessLogicJoints(plain).joints[0].threshold_profile, null);
  });

  await t.test('a joint in an unknown zone falls through rather than throwing', () => {
    const orphan = doc({
      zones: [{ zone_id: 'z1', name: 'Zone1', threshold_profile: 'indoor' }],
      joints: [{ joint_id: 'J01', slave_id: 'sl01', channel: 1, zone_id: 'zXX' }],
    });
    assert.equal(buildProcessLogicJoints(orphan).joints[0].threshold_profile, null);
  });

  await t.test('a joint explicitly on default is not overridden by its zone', () => {
    // 'default' is a real selection, not an absence - the operator chose the
    // panel-wide set for this joint and the zone must not take it back.
    const d = doc({
      zones: [{ zone_id: 'z1', name: 'Zone1', threshold_profile: 'indoor' }],
      joints: [{ joint_id: 'J01', slave_id: 'sl01', channel: 1, zone_id: 'z1', threshold_profile: 'default' }],
    });
    assert.equal(buildProcessLogicJoints(d).joints[0].threshold_profile, 'default');
  });
});

describe('drift detection sees CHANGED rows, not just added and removed (2026-09-19)', () => {
  // Live report from ESBUSBBT06: the operator bound Zone1 to a threshold profile
  // and J02 to another, the tables showed both, no RoR alarm ever fired, and the
  // Configuration Status banner printed the GREEN "applied and in sync" line the
  // whole time. The diff compared joint_id MEMBERSHIP only, so a row present on
  // both sides was "in sync" however much its content differed - and the tables
  // render the DRAFT while the panel runs on the APPLIED document.
  const draft = (over = {}) => ({ joint_id: 'J01', slaveID: 1, channel: 1, zone_id: 'Z1', threshold_profile: '', ...over });
  const live = (over = {}) => ({ joint_id: 'J01', slaveID: 1, channel: 1, zone_id: 'z1', threshold_profile: null, ...over });
  const zones = (p) => [{ zone_id: 'Z1', threshold_profile: p }];

  test('the panel case: a zone bound to a profile that was never applied', () => {
    const d = diffDraftVsApplied([draft()], [live()], { draftZones: zones('zone_1_alarm_profile') });
    assert.equal(d.inSync, false, 'the banner must NOT say in sync');
    assert.deepEqual(d.changed, [{ joint_id: 'J01', fields: ['alarm profile'] }]);
  });

  test('and reports in sync once it HAS been applied', () => {
    const d = diffDraftVsApplied([draft()], [live({ threshold_profile: 'zone_1_alarm_profile' })], { draftZones: zones('zone_1_alarm_profile') });
    assert.equal(d.inSync, true);
    assert.deepEqual(d.changed, []);
  });

  test("a joint's own profile is compared too", () => {
    const d = diffDraftVsApplied([draft({ threshold_profile: 'joint_profile' })], [live()], { draftZones: zones(null) });
    assert.deepEqual(d.changed, [{ joint_id: 'J01', fields: ['alarm profile'] }]);
  });

  test('a joint override beats its zone on the draft side, exactly as on the applied side', () => {
    const d = diffDraftVsApplied(
      [draft({ threshold_profile: 'joint_profile' })],
      [live({ threshold_profile: 'joint_profile' })],
      { draftZones: zones('zone_1_alarm_profile') }
    );
    assert.equal(d.inSync, true, 'the zone must not make an overridden joint look changed');
  });

  test("a zone set to 'default' is NOT a binding, so it is not drift", () => {
    // applyJoints deliberately stores nothing for a zone on 'default'; the draft
    // side has to resolve it the same way or every such zone reads as changed.
    const d = diffDraftVsApplied([draft()], [live()], { draftZones: zones('default') });
    assert.equal(d.inSync, true);
  });

  test('slave, channel and zone changes are caught as well', () => {
    assert.deepEqual(diffDraftVsApplied([draft({ slaveID: 7 })], [live()]).changed, [{ joint_id: 'J01', fields: ['slave'] }]);
    assert.deepEqual(diffDraftVsApplied([draft({ channel: 3 })], [live()]).changed, [{ joint_id: 'J01', fields: ['channel'] }]);
    assert.deepEqual(diffDraftVsApplied([draft({ zone_id: 'Z2' })], [live()]).changed, [{ joint_id: 'J01', fields: ['zone'] }]);
  });

  test('several fields on one row are listed together', () => {
    const d = diffDraftVsApplied([draft({ slaveID: 7, channel: 2 })], [live()]);
    assert.deepEqual(d.changed[0].fields, ['slave', 'channel']);
  });

  test('zone ids compare case-insensitively, since apply lowercases them', () => {
    assert.equal(diffDraftVsApplied([draft({ zone_id: 'Z1' })], [live({ zone_id: 'z1' })]).inSync, true);
  });

  test('a row that is not applied at all is reported once, as notApplied', () => {
    const d = diffDraftVsApplied([draft({ joint_id: 'J09' })], [live()]);
    assert.deepEqual(d.notApplied, ['J09']);
    assert.deepEqual(d.changed, [], 'not double-reported as changed');
  });

  test('the ambient is deliberately NOT compared', () => {
    // The legacy draft carries one flat ambientSlaveID per joint while the
    // applied document resolves a joint -> zone -> panel chain, so the two
    // legitimately differ on a correctly-applied config.
    const d = diffDraftVsApplied([draft({ ambientSlaveID: 101 })], [live({ ambientKey: '999:1' })]);
    assert.equal(d.inSync, true);
  });

  test('no zone draft at all does not invent drift for inheriting joints', () => {
    assert.equal(diffDraftVsApplied([draft()], [live()]).inSync, true);
  });
});

describe('drift: an absent draft field is not a difference', () => {
  // Caught by an older test in this file when `changed` was added: a row that
  // does not carry `slaveID` was compared as NaN !== 1 and flagged. Absent means
  // the draft does not say, not that it says something else - and a draft row
  // written before a column existed would otherwise light the banner forever.
  const live = { joint_id: 'J01', slaveID: 1, channel: 1, zone_id: 'z1', threshold_profile: null };

  test('a row carrying only an id is not "changed"', () => {
    assert.deepEqual(diffDraftVsApplied([{ joint_id: 'J01' }], [live]).changed, []);
  });

  test('a row with no channel is read as channel 1, the documented default', () => {
    assert.deepEqual(diffDraftVsApplied([{ joint_id: 'J01', slaveID: 1, zone_id: 'z1' }], [live]).changed, []);
    assert.deepEqual(diffDraftVsApplied([{ joint_id: 'J01', slaveID: 1, zone_id: 'z1' }], [{ ...live, channel: 2 }]).changed,
      [{ joint_id: 'J01', fields: ['channel'] }]);
  });

  test('but an absent PROFILE is still compared - absent there means inherit', () => {
    assert.deepEqual(
      diffDraftVsApplied([{ joint_id: 'J01' }], [{ ...live, threshold_profile: 'hot_riser' }]).changed,
      [{ joint_id: 'J01', fields: ['alarm profile'] }]
    );
  });
});

describe('a joint on a device switched off in Modbus Settings (2026-09-24)', () => {
  // The device is not polled at all, so the joint would otherwise sit in the
  // monitored set holding its last reading for ever, and an alarm raised before
  // it was switched off could never clear.
  const offDoc = () => {
    const d = doc();
    d.modbus.slaves = d.modbus.slaves.map((s) => (s.slave_id === 'sl01' ? { ...s, enabled: false } : s));
    return d;
  };

  test('it is not published for monitoring', () => {
    const before = buildProcessLogicJoints(doc()).joints.map((j) => j.joint_id);
    const after = buildProcessLogicJoints(offDoc()).joints.map((j) => j.joint_id);
    assert.ok(before.includes('J01'));
    assert.ok(!after.includes('J01'));
  });

  test('and says so, rather than vanishing silently', () => {
    // The Configuration Status banner surfaces these warnings; a joint that is
    // configured and deliberately dark must be distinguishable from one that
    // was never commissioned.
    const { warnings } = buildProcessLogicJoints(offDoc());
    assert.ok(warnings.some((w) => /J01.*switched off/.test(w)), warnings.join(' | '));
  });

  test('joints on devices that are still in service are unaffected', () => {
    const ids = buildProcessLogicJoints(offDoc()).joints.map((j) => j.joint_id);
    assert.ok(ids.includes('J02'), 'J02 is on sl21, which is still on');
  });

  test('absent `enabled` on a slave means in service', () => {
    assert.deepEqual(
      buildProcessLogicJoints(doc()).joints.map((j) => j.joint_id).sort(),
      ['J01', 'J02']
    );
  });
});

describe('isJointMonitored - one definition, three consumers (2026-09-24)', () => {
  const { isJointMonitored } = require('../../src/config-service/process-logic-joints');
  const d = () => ({
    modbus: { slaves: [{ slave_id: 'sl01', unit_address: 1 }, { slave_id: 'sl02', unit_address: 2, enabled: false }] },
    joints: [],
  });
  const j = (over = {}) => ({ joint_id: 'J01', slave_id: 'sl01', channel: 1, zone_id: 'z1', ...over });

  test('watched when both switches are on, or absent', () => {
    assert.equal(isJointMonitored(d(), j()), true);
    assert.equal(isJointMonitored(d(), j({ enabled: true })), true);
  });

  test("not watched when the joint's own box is unticked", () => {
    assert.equal(isJointMonitored(d(), j({ enabled: false })), false);
  });

  test('not watched when its DEVICE is switched off', () => {
    // The gap this helper was extracted to close: device_health checked only
    // the joint's own box, so a joint on a dark device was reported live.
    assert.equal(isJointMonitored(d(), j({ slave_id: 'sl02' })), false);
  });

  test('not watched when its slave is not commissioned at all', () => {
    assert.equal(isJointMonitored(d(), j({ slave_id: 'sl99' })), false);
  });

  test('a malformed joint or document is not watched, rather than throwing', () => {
    assert.equal(isJointMonitored(d(), null), false);
    assert.equal(isJointMonitored(null, j()), false);
    assert.equal(isJointMonitored({}, j()), false);
  });
});
