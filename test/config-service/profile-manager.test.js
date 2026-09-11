'use strict';

/**
 * Named threshold profiles — the editor that made zone-wise thresholds usable.
 *
 * Profiles had been in cfg/alarms since Slice 2 and zones could bind to one from
 * 2026-09-11, but nothing could CREATE a second profile: the Alarm Config screen
 * only ever writes profiles.default. These are the checks that stand between an
 * operator and a config that would quietly move joints onto the wrong thresholds.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  precheckProfiles,
  buildProfilesDoc,
  profilesForUi,
  profileUsage,
  MAX_PROFILES,
} = require('../../src/config-service/profile-manager');

const complete = (n) => ({
  deltaT: { watch: n, warning: n + 5, critical: n + 10 },
  ror: { watch: n, warning: n + 5, critical: n + 10, timeWindowMin: 20 },
  persistence: { watchMin: 5, warningMin: 2, criticalMin: 1 },
});

const jointsDoc = (over = {}) => ({
  zones: [{ zone_id: 'z1', name: 'Zone1' }, { zone_id: 'z2', name: 'Outdoor', threshold_profile: 'outdoor' }],
  joints: [
    { joint_id: 'J01', zone_id: 'z1' },
    { joint_id: 'J07', zone_id: 'z1', threshold_profile: 'hot_riser' },
  ],
  ...over,
});

describe('precheckProfiles - refusing changes that would mis-monitor a joint', () => {
  const ok = { default: complete(10), outdoor: complete(30), hot_riser: complete(5) };

  test('accepts a map that keeps every referenced profile', () => {
    assert.deepEqual(precheckProfiles(ok, jointsDoc()), []);
  });

  test('refuses to delete a profile a ZONE still uses, naming the zone', () => {
    // The dangerous direction: a zone names a profile on behalf of every joint
    // in it, so removing it moves the whole zone, not one joint.
    const { outdoor, ...without } = ok;
    const errs = precheckProfiles(without, jointsDoc());
    assert.equal(errs.length, 1);
    assert.match(errs[0], /'outdoor' is still used by zone 'z2'/);
  });

  test('refuses to delete a profile a JOINT still uses, naming the joint', () => {
    const { hot_riser, ...without } = ok;
    assert.match(precheckProfiles(without, jointsDoc())[0], /still used by joint 'J07'/);
  });

  test('a rename is a delete plus an add, so it is caught by the same check', () => {
    const renamed = { default: ok.default, outdoors: ok.outdoor, hot_riser: ok.hot_riser };
    assert.match(precheckProfiles(renamed, jointsDoc())[0], /'outdoor' is still used by zone 'z2'/);
  });

  test('deleting an unreferenced profile is allowed', () => {
    const withSpare = { ...ok, spare: complete(20) };
    assert.deepEqual(precheckProfiles(withSpare, jointsDoc()), [], 'adding is fine');
    assert.deepEqual(precheckProfiles(ok, jointsDoc()), [], 'and removing it again is fine');
  });

  test("refuses to lose 'default', which every unbound joint resolves to", () => {
    const { default: _d, ...without } = ok;
    assert.match(precheckProfiles(without, jointsDoc())[0], /'default' profile cannot be deleted or renamed/);
  });

  test('rejects a name the schema would reject, before the schema sees it', () => {
    for (const bad of ['Outdoor', '2hot', 'has space', 'way_too_long_a_profile_name_here', '_lead']) {
      const errs = precheckProfiles({ ...ok, [bad]: complete(10) }, jointsDoc());
      assert.ok(errs.some((e) => e.includes(bad)), `expected ${bad} to be refused`);
    }
  });

  test('rejects an incomplete profile rather than half-applying it', () => {
    const errs = precheckProfiles({ ...ok, broken: { deltaT: complete(10).deltaT } }, jointsDoc());
    assert.match(errs.join(' '), /'broken' is incomplete/);
  });

  test('enforces the profile cap', () => {
    const many = { default: complete(10) };
    for (let i = 0; i < MAX_PROFILES; i += 1) many[`p${i}`] = complete(10);
    assert.match(precheckProfiles(many, jointsDoc()).join(' '), /Too many profiles/);
  });

  test('a missing or malformed payload changes nothing', () => {
    for (const bad of [undefined, null, 'nonsense', []]) {
      assert.match(precheckProfiles(bad, jointsDoc())[0], /Nothing has been changed/);
    }
  });

  test('no joints document means no in-use check, not a crash', () => {
    assert.deepEqual(precheckProfiles({ default: complete(10) }, undefined), []);
  });

  // Found 2026-09-11 by running the handler against a real store; every unit
  // test above passed while this hole was open. readDomain returns null for an
  // unreadable document, and both this check and A3 are gated on having it, so
  // with no document BOTH fail open and a profile a zone depends on could be
  // deleted - moving every joint in that zone onto the default without a word.
  describe('refuses to act on absent information', () => {
    const current = { profiles: { default: complete(10), outdoor: complete(30) } };

    test('a DELETE is refused when the joints document cannot be read', () => {
      const errs = precheckProfiles({ default: complete(10) }, null, current);
      assert.match(errs.join(' '), /Cannot delete 'outdoor'.*could not be read/);
    });

    test('but ADDING is still allowed - a fresh panel has no joints yet', () => {
      const proposed = { ...current.profiles, spare: complete(20) };
      assert.deepEqual(precheckProfiles(proposed, null, current), []);
    });

    test('and editing an existing profile in place is allowed', () => {
      const proposed = { default: complete(11), outdoor: complete(31) };
      assert.deepEqual(precheckProfiles(proposed, null, current), []);
    });

    test('a readable document that simply binds nothing still permits the delete', () => {
      // "no document" and "document says nothing is bound" are different
      // statements, and only the first is a reason to refuse.
      const empty = { zones: [], joints: [] };
      assert.deepEqual(precheckProfiles({ default: complete(10) }, empty, current), []);
    });
  });
});

describe('buildProfilesDoc - what actually gets applied', () => {
  const current = {
    config_domain_versions: { alarms: 7 },
    profiles: { default: { ...complete(10), description: 'Panel default' } },
    sensor_fault: { comm_timeout_s: 300 },
    notifications: { email: { enabled: true } },
  };

  test('bumps the domain version', () => {
    assert.equal(buildProfilesDoc(current, { default: complete(10) }).config_domain_versions.alarms, 8);
  });

  test('carries sensor_fault and notifications through untouched', () => {
    // They are panel-wide and have their own screens; dropping them here would
    // silently reset them on every profile edit.
    const out = buildProfilesDoc(current, { default: complete(10) });
    assert.deepEqual(out.sensor_fault, current.sensor_fault);
    assert.deepEqual(out.notifications, current.notifications);
  });

  test('keeps an existing description the editor did not send back', () => {
    const out = buildProfilesDoc(current, { default: complete(10) });
    assert.equal(out.profiles.default.description, 'Panel default');
  });

  test('an edited description wins', () => {
    const out = buildProfilesDoc(current, { default: { ...complete(10), description: 'Changed' } });
    assert.equal(out.profiles.default.description, 'Changed');
  });

  test('strips anything the schema does not allow on a profile', () => {
    const out = buildProfilesDoc(current, { default: { ...complete(10), used_by: ['zone z1'], removable: false } });
    assert.deepEqual(Object.keys(out.profiles.default).sort(), ['deltaT', 'description', 'persistence', 'ror']);
  });

  test('works from an empty store, so a fresh panel can create profiles', () => {
    const out = buildProfilesDoc(undefined, { default: complete(10) });
    assert.equal(out.config_domain_versions.alarms, 1);
    assert.equal(out.sensor_fault, undefined);
  });
});

describe('profilesForUi - what the editor renders', () => {
  const alarms = { profiles: { outdoor: complete(30), default: complete(10), hot_riser: complete(5) } };

  test('default sorts first, the rest alphabetically', () => {
    assert.deepEqual(profilesForUi(alarms, jointsDoc()).map((p) => p.name), ['default', 'hot_riser', 'outdoor']);
  });

  test('reports where each profile is in use', () => {
    const rows = profilesForUi(alarms, jointsDoc());
    assert.deepEqual(rows.find((r) => r.name === 'outdoor').used_by, ["zone 'z2'"]);
    assert.deepEqual(rows.find((r) => r.name === 'hot_riser').used_by, ["joint 'J07'"]);
  });

  test('marks removable only when nothing references it and it is not default', () => {
    const rows = profilesForUi({ profiles: { ...alarms.profiles, spare: complete(20) } }, jointsDoc());
    assert.equal(rows.find((r) => r.name === 'default').removable, false, 'A4 protects default');
    assert.equal(rows.find((r) => r.name === 'outdoor').removable, false, 'in use by a zone');
    assert.equal(rows.find((r) => r.name === 'spare').removable, true);
  });

  test('an empty store renders nothing rather than throwing', () => {
    assert.deepEqual(profilesForUi(undefined, undefined), []);
  });
});

describe('profileUsage', () => {
  test('lists zones before joints, because a zone moves more joints', () => {
    const usage = profileUsage({
      zones: [{ zone_id: 'z2', threshold_profile: 'shared' }],
      joints: [{ joint_id: 'J07', threshold_profile: 'shared' }],
    });
    assert.deepEqual(usage.get('shared'), ["zone 'z2'", "joint 'J07'"]);
  });

  test('ignores unbound joints and zones', () => {
    assert.equal(profileUsage(jointsDoc()).get('default'), undefined);
  });
});
