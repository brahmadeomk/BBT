'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { resolveThresholds, buildRuntimeProfiles } = require('../../src/alarms/threshold-resolver');

const dt = (w, wa, c) => ({ watch: w, warning: wa, critical: c });
const ror = (w, wa, c) => ({ watch: w, warning: wa, critical: c, timeWindowMin: 20 });
const per = (m) => ({ watchMin: m, warningMin: m, criticalMin: m });

const complete = (n) => ({ deltaT: dt(n, n + 5, n + 10), ror: ror(n, n + 5, n + 10), persistence: per(n) });

/** The shape the global carried before profiles were honoured. */
const FLAT = { ...complete(10) };

/** The shape it carries now: flat default PLUS the profiles map. */
const WITH_PROFILES = {
  ...complete(10),
  profiles: { default: complete(10), outdoor: complete(30), critical_riser: complete(5) },
};

test('threshold resolution', async (t) => {
  await t.test('a joint using a named profile gets that profile', () => {
    const r = resolveThresholds(WITH_PROFILES, 'outdoor');
    assert.equal(r.profile, 'outdoor');
    assert.equal(r.via, 'profile');
    assert.equal(r.deltaT.watch, 30);
    assert.equal(r.persistence.watchMin, 30);
  });

  await t.test('two joints on different profiles get different thresholds', () => {
    const a = resolveThresholds(WITH_PROFILES, 'outdoor');
    const b = resolveThresholds(WITH_PROFILES, 'critical_riser');
    assert.notDeepEqual(a.deltaT, b.deltaT);
    assert.equal(a.deltaT.watch, 30);
    assert.equal(b.deltaT.watch, 5);
  });

  await t.test('no profile named falls to default, and is not flagged as a fallback', () => {
    for (const name of [undefined, null, '', '   ', 'default']) {
      const r = resolveThresholds(WITH_PROFILES, name);
      assert.equal(r.profile, 'default');
      assert.equal(r.via, 'default', `via for ${JSON.stringify(name)}`);
    }
  });

  await t.test('a profile that no longer exists falls back to default rather than going unwatched', () => {
    const r = resolveThresholds(WITH_PROFILES, 'deleted_profile');
    assert.equal(r.profile, 'default');
    assert.equal(r.via, 'fallback_default', 'the fallback must be visible, not silent');
    assert.equal(r.deltaT.watch, 10);
  });

  await t.test('a malformed profile is rejected whole, never half-applied', () => {
    // deltaT present, ror missing: the schema makes all three required, so this
    // is a broken document, not a request to inherit ror from default.
    const cfg = { ...FLAT, profiles: { default: complete(10), broken: { deltaT: dt(1, 2, 3) } } };
    const r = resolveThresholds(cfg, 'broken');
    assert.equal(r.profile, 'default');
    assert.equal(r.deltaT.watch, 10, 'must not take the broken profile deltaT');
    assert.ok(r.ror && r.persistence);
  });
});

test('backward compatibility with the pre-profiles global', async (t) => {
  await t.test('the flat legacy shape still resolves', () => {
    const r = resolveThresholds(FLAT, 'outdoor');
    assert.equal(r.profile, 'default');
    assert.equal(r.via, 'fallback_flat');
    assert.equal(r.deltaT.watch, 10);
  });

  await t.test('flat shape with no profile named reports itself plainly', () => {
    assert.equal(resolveThresholds(FLAT, null).via, 'flat');
  });

  await t.test('an empty profiles map does not shadow the flat shape', () => {
    const r = resolveThresholds({ ...FLAT, profiles: {} }, 'outdoor');
    assert.equal(r.deltaT.watch, 10, 'must fall through to flat, not return null');
  });
});

test('fail-safe: never silently stops alarming', async (t) => {
  await t.test('null only when there are no usable thresholds anywhere', () => {
    assert.equal(resolveThresholds(null, 'x'), null);
    assert.equal(resolveThresholds(undefined, 'x'), null);
    assert.equal(resolveThresholds({}, 'x'), null);
    assert.equal(resolveThresholds({ deltaT: dt(1, 2, 3) }, 'x'), null, 'partial flat is not usable');
  });

  await t.test('a broken default still resolves through the flat shape', () => {
    const r = resolveThresholds({ ...FLAT, profiles: { default: { deltaT: dt(1, 2, 3) } } }, 'default');
    assert.ok(r, 'must not go unwatched because the default profile is malformed');
    assert.equal(r.deltaT.watch, 10);
  });

  await t.test('returns only the three groups, never profile metadata', () => {
    const cfg = { profiles: { default: { ...complete(10), clear_hysteresis_pct: 20, description: 'x' } } };
    const r = resolveThresholds(cfg, 'default');
    assert.deepEqual(Object.keys(r).sort(), ['deltaT', 'persistence', 'profile', 'ror', 'via']);
  });
});

test('buildRuntimeProfiles', async (t) => {
  await t.test('carries every complete profile, stripped to the three groups', () => {
    const out = buildRuntimeProfiles({
      profiles: { default: { ...complete(10), description: 'd' }, outdoor: complete(30) },
    });
    assert.deepEqual(Object.keys(out).sort(), ['default', 'outdoor']);
    assert.deepEqual(Object.keys(out.default).sort(), ['deltaT', 'persistence', 'ror']);
    assert.equal(out.outdoor.deltaT.watch, 30);
  });

  await t.test('drops malformed profiles rather than publishing them', () => {
    const out = buildRuntimeProfiles({ profiles: { default: complete(10), broken: { deltaT: dt(1, 2, 3) } } });
    assert.deepEqual(Object.keys(out), ['default']);
  });

  await t.test('null (not {}) when there is nothing to publish, so callers can spread it away', () => {
    assert.equal(buildRuntimeProfiles(null), null);
    assert.equal(buildRuntimeProfiles({}), null);
    assert.equal(buildRuntimeProfiles({ profiles: {} }), null);
    assert.equal(buildRuntimeProfiles({ profiles: { broken: {} } }), null);
  });
});

test('sensor plausibility limits', async (t) => {
  const { resolveSensorLimits, DEFAULT_SENSOR_MAX_C, DEFAULT_SENSOR_MIN_C } =
    require('../../src/alarms/threshold-resolver');

  await t.test('defaults come from the sensor datasheet, not the old hardcoded 300', () => {
    // NTC element specified -80..+150 degC. 300 was inherited, never derived.
    assert.equal(DEFAULT_SENSOR_MAX_C, 150);
    const r = resolveSensorLimits(undefined);
    assert.equal(r.maxC, 150);
    assert.equal(r.configured, false);
  });

  await t.test('the floor is the application floor, not the sensor capability', () => {
    // -80 is what the element can measure; -40 is what a busduct panel can
    // plausibly be. The band wants the intersection, so -40 binds.
    assert.equal(DEFAULT_SENSOR_MIN_C, -40);
    assert.equal(resolveSensorLimits({ sensor_fault: { sensor_error_above_c: 200 } }).minC, -40);
  });

  await t.test('a configured ceiling inside the schema bounds is honoured', () => {
    const r = resolveSensorLimits({ sensor_fault: { sensor_error_above_c: 200 } });
    assert.equal(r.maxC, 200);
    assert.equal(r.configured, true);
  });

  await t.test('an out-of-range ceiling falls back rather than being obeyed', () => {
    // Read from a mutable global: a corrupt or hand-edited 99999 would silently
    // disable sensor-fault detection on a fire-safety monitor.
    for (const bad of [99999, 0, -1, 99, 501, NaN, Infinity, '200', null, {}]) {
      const r = resolveSensorLimits({ sensor_fault: { sensor_error_above_c: bad } });
      assert.equal(r.maxC, 150, `ceiling ${JSON.stringify(bad)} must not be obeyed`);
      assert.equal(r.configured, false);
    }
  });

  await t.test('the schema bounds are the ones enforced', () => {
    assert.equal(resolveSensorLimits({ sensor_fault: { sensor_error_above_c: 100 } }).maxC, 100);
    assert.equal(resolveSensorLimits({ sensor_fault: { sensor_error_above_c: 500 } }).maxC, 500);
  });

  await t.test('a config with no sensor_fault block still yields a usable band', () => {
    const r = resolveSensorLimits({ deltaT: {}, ror: {}, persistence: {} });
    assert.equal(r.maxC, 150);
    assert.equal(r.minC, -40);
  });
});
