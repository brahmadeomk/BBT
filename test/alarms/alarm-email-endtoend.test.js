'use strict';

/**
 * Drives the REAL "Alarm Manager" function-node source out of flows_BBT.json
 * and feeds its email output through the real mailer module.
 *
 * This exists because the two bugs it guards against were both invisible to
 * unit tests of either half on its own:
 *   - the Alarm Manager built a per-alarm subject that the Email node silently
 *     overwrote with a constant, and
 *   - the Email node read only emails[0], dropping every other alarm queued in
 *     the same tick.
 * Only running the two together shows what actually lands in a mailbox.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { toMailMessage } = require('../../src/alarms/email-subject');

const flows = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'flows', 'flows_BBT.json'), 'utf8'));
const src = (id) => flows.find((n) => n.id === id).func;

const ALARM_MANAGER = 'de6fcc55794afd9e';
const EMAIL_NODE = 'a8107ca53afafd14';

/** Minimal Node-RED function-node harness: context/global stores + node API. */
function makeEnv(globals = {}) {
  const ctxStore = new Map();
  const globalStore = new Map(Object.entries(globals));
  const warnings = [];
  const sent = [];
  return {
    sent,
    warnings,
    context: { get: (k) => ctxStore.get(k), set: (k, v) => ctxStore.set(k, v) },
    global: {
      get: (k, _store) => globalStore.get(k),
      set: (k, v, _store) => globalStore.set(k, v),
    },
    node: {
      warn: (m) => warnings.push(m),
      error: (m) => warnings.push(m),
      status: () => {},
      send: (m) => sent.push(m),
    },
  };
}

function runAlarmManager(msg, globals) {
  const env = makeEnv(globals);
  const fn = new Function('msg', 'node', 'global', 'env', 'flow', 'context', src(ALARM_MANAGER));
  const out = fn(msg, env.node, env.global, { get: () => undefined }, { get: () => undefined, set: () => {} }, env.context);
  return { out, env };
}

/**
 * The live shape: the Alarm Manager evaluates ONE joint per message
 * (docs/internal-message-contracts.md, KPI Stream - Joint), against a flat
 * threshold config with `persistence.<level>Min` in minutes.
 */
const SYSTEM_CONFIG = {
  deltaT: { watch: 10, warning: 20, critical: 25 },
  ror: { watch: 4, warning: 8, critical: 12 },
  persistence: { watchMin: 0, warningMin: 0, criticalMin: 0 },
  clear_hysteresis_pct: 10,
  clear_persistence_min: 0,
};

/** A joint over BOTH the deltaT and RoR critical thresholds - two alarms, two
 *  emails, from a single message. This is the realistic multi-email tick, and
 *  the one the old `data[0]` mailer truncated to a single mail. */
const jointOverBothThresholds = (joint_id) => ({
  joint_id, joint_name: joint_id, zone_id: 'Z1', zone_name: 'Zone1', slaveID: 1,
  val: 61.5, emaTemp: 61.4, ror: 15.0,
  ambient: { slaveID: 101, val: 31.0, age_sec: 1 },
  deltaT: { raw: 30.5, ema: 30.4 },
  sample_dt_sec: 1.7, timestamp: new Date().toISOString(),
  sensor_status: 'OK', isAmbient: false, isProcessSensor: true,
});

describe('alarm email, end to end through the real Alarm Manager source', () => {
  test('every queued email is stamped with the meta the subject needs', () => {
    const { out } = runAlarmManager({ payload: jointOverBothThresholds('J01') }, {
      busbartherm_system_config: SYSTEM_CONFIG,
      project_config: { project_name: 'BusductTherMo' },
    });

    const emailMsg = out && out[3];
    assert.ok(emailMsg, 'the Alarm Manager must emit on its email output');
    const emails = emailMsg.payload;
    assert.ok(Array.isArray(emails) && emails.length >= 2,
      `expected one email per raised alarm, got ${JSON.stringify(emails && emails.length)}`);

    for (const e of emails) {
      assert.ok(e.meta, `every queued email needs meta, missing on: ${e.subject}`);
      assert.ok(e.meta.instanceId, 'meta.instanceId identifies the device');
      assert.ok(e.meta.kind === 'RAISE' || e.meta.kind === 'CLEAR');
    }
  });

  test('the subject names the panel, level, device and description - all of them distinct', () => {
    const { out } = runAlarmManager({ payload: jointOverBothThresholds('J01') }, {
      busbartherm_system_config: SYSTEM_CONFIG,
      project_config: { project_name: 'BusductTherMo' },
    });

    const subjects = out[3].payload.map((e) => toMailMessage(e, { projectName: 'BusductTherMo', siteId: 'S0001', panelId: 'P0001' }).topic);

    // the whole point: two simultaneous alarms are distinguishable in an inbox
    assert.equal(new Set(subjects).size, subjects.length, `subjects must differ: ${JSON.stringify(subjects)}`);
    for (const s of subjects) {
      assert.match(s, /^BusductTherMo S0001 \| P0001 \| /, `site then panel identity first: ${s}`);
      assert.match(s, /\| (WATCH|WARNING|CRITICAL|CLEARED|ALARM) \|/, `severity present: ${s}`);
    }
    assert.ok(subjects.every((s) => s.includes('J01')), `device id present: ${JSON.stringify(subjects)}`);
    // and none of them is the old constant
    assert.ok(!subjects.some((s) => /Alerts$/.test(s)), 'the constant subject must be gone');
  });

  test('the Email node forwards EVERY queued email, not just the first', () => {
    const env = makeEnv({
      busductConfigService: { alarmEmail: require('../../src/alarms/email-subject') },
      project_config: { project_name: 'BusductTherMo' },
      EmailID: ['ops@example.com'],
    });
    const fn = new Function('msg', 'node', 'global', 'env', 'flow', 'context', src(EMAIL_NODE));
    fn({ payload: [
      { body: 'one', meta: { instanceId: 'PROCESS|J01|DELTA_T|CRITICAL', kind: 'RAISE', description: 'dT 30 >= 25' } },
      { body: 'two', meta: { instanceId: 'PROCESS|J02|DELTA_T|WARNING', kind: 'RAISE', description: 'dT 28 >= 20' } },
      { body: 'three', meta: { instanceId: 'SYSTEM|sl21|BLACKLIST', kind: 'RAISE', level: 'CRITICAL', description: 'device dark' } },
    ] }, env.node, env.global, {}, {}, env.context);

    assert.equal(env.sent.length, 3, 'one mail per queued email');
    assert.deepEqual(env.sent.map((m) => m.payload), ['one', 'two', 'three']);
    assert.equal(new Set(env.sent.map((m) => m.topic)).size, 3, 'each with its own subject');
    for (const m of env.sent) assert.deepEqual(m.to, ['ops@example.com']);
  });

  test('a missing library still delivers the mail, loudly', () => {
    // An alarm mail must never be lost because functionGlobalContext was not
    // reloaded (the restart-vs-Deploy mistake).
    const env = makeEnv({ project_config: { project_name: 'BusductTherMo' }, EmailID: ['ops@example.com'] });
    const fn = new Function('msg', 'node', 'global', 'env', 'flow', 'context', src(EMAIL_NODE));
    fn({ payload: [{ body: 'one', meta: {} }, { body: 'two', meta: {} }] }, env.node, env.global, {}, {}, env.context);

    assert.equal(env.sent.length, 2, 'both still delivered');
    assert.equal(env.warnings.length, 1, 'and the failure is reported');
    assert.match(env.warnings[0], /RESTART Node-RED/);
  });
});
