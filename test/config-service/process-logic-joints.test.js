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
