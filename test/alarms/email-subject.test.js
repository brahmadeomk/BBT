'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildAlarmSubject, toMailMessage, oneLine, MAX_SUBJECT } = require('../../src/alarms/email-subject');

const CTX = { projectName: 'BusductTherMo', siteId: 'S0001', panelId: 'P0001' };

describe('alarm email subject', () => {
  test('names the panel, the level, the device and what happened', () => {
    const s = buildAlarmSubject(
      { instanceId: 'PROCESS|J01|DELTA_T|CRITICAL', kind: 'RAISE', description: 'deltaT 29.48 >= 25' },
      CTX
    );
    assert.equal(s, 'BusductTherMo S0001 | P0001 | CRITICAL | J01 - deltaT 29.48 >= 25');
  });

  test('a cleared alarm says CLEARED, not its old severity', () => {
    // "CRITICAL" in a clear notification reads as a fresh alarm on a phone.
    const s = buildAlarmSubject(
      { instanceId: 'PROCESS|J01|DELTA_T|CRITICAL', kind: 'CLEAR', description: 'deltaT 29.48 >= 25' },
      CTX
    );
    assert.equal(s, 'BusductTherMo S0001 | P0001 | CLEARED | J01 - deltaT 29.48 >= 25');
  });

  test('a SYSTEM alarm names the device from segment 1, same parse as a joint alarm', () => {
    const s = buildAlarmSubject(
      { instanceId: 'SYSTEM|sl21|BLACKLIST', kind: 'RAISE', level: 'CRITICAL',
        deviceLabel: 'Slave 101 (AMBIENT_101)', description: 'ambient reference for joint(s) J01, J02 - deltaT unavailable' },
      CTX
    );
    assert.equal(s, 'BusductTherMo S0001 | P0001 | CRITICAL | Slave 101 (AMBIENT_101) - ambient reference for joint(s) J01, J02 - deltaT unavailable');
  });

  test('falls back to the alarm type when there is no description', () => {
    const s = buildAlarmSubject({ instanceId: 'SYSTEM|PANEL|COMM', kind: 'RAISE', level: 'CRITICAL' }, CTX);
    assert.equal(s, 'BusductTherMo S0001 | P0001 | CRITICAL | PANEL - COMM');
  });

  test('survives a missing instanceId rather than producing an empty subject', () => {
    // An email with no meta must still be recognisably from this panel - a blank
    // subject is worse than a vague one.
    const s = buildAlarmSubject({}, CTX);
    assert.equal(s, 'BusductTherMo S0001 | P0001 | ALARM | panel');
  });

  test('drops a missing id rather than leaving an empty segment', () => {
    // A panel with a site but no panel id must not read "… S0001 |  | WATCH …".
    assert.equal(
      buildAlarmSubject({ instanceId: 'PROCESS|J02|ROR|WATCH', description: 'RoR 4.2 >= 4' },
        { projectName: 'BusductTherMo', siteId: 'S0001' }),
      'BusductTherMo S0001 | WATCH | J02 - RoR 4.2 >= 4'
    );
    assert.equal(
      buildAlarmSubject({ instanceId: 'PROCESS|J02|ROR|WATCH', description: 'RoR 4.2 >= 4' },
        { projectName: 'BusductTherMo', panelId: 'P0001' }),
      'BusductTherMo | P0001 | WATCH | J02 - RoR 4.2 >= 4'
    );
  });

  test('works on an unprovisioned panel with no identity at all', () => {
    const s = buildAlarmSubject({ instanceId: 'PROCESS|J02|ROR|WATCH', description: 'RoR 4.2 >= 4' }, {});
    assert.equal(s, 'WATCH | J02 - RoR 4.2 >= 4');
  });

  test('collapses a multi-line description and caps the subject length', () => {
    assert.equal(oneLine('line one\n  line two\t\tline three', 100), 'line one line two line three');
    const long = buildAlarmSubject(
      { instanceId: 'PROCESS|J01|DELTA_T|CRITICAL', description: 'x'.repeat(500) },
      { projectName: 'y'.repeat(200), siteId: 'S0001', panelId: 'P0001' }
    );
    assert.ok(long.length <= MAX_SUBJECT, `got ${long.length}`);
  });

  test('toMailMessage puts the subject on msg.topic, which is what the e-mail node sends', () => {
    const m = toMailMessage(
      { body: 'Zone: Zone1\nJoint: J01', meta: { instanceId: 'PROCESS|J01|DELTA_T|WARNING', kind: 'RAISE', description: 'dT 26 >= 25' } },
      { ...CTX, to: ['ops@example.com'] }
    );
    assert.equal(m.topic, 'BusductTherMo S0001 | P0001 | WARNING | J01 - dT 26 >= 25');
    assert.equal(m.payload, 'Zone: Zone1\nJoint: J01');
    assert.deepEqual(m.to, ['ops@example.com']);
    assert.ok(!('attachments' in m), 'no attachments key when the email has none');
  });

  test('toMailMessage carries attachments through (the CSV batch mail)', () => {
    const m = toMailMessage({ body: 'batch', attachments: [{ filename: 'a.csv' }] }, CTX);
    assert.deepEqual(m.attachments, [{ filename: 'a.csv' }]);
  });
});
