'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateScanGate, DEFAULT_DEADLINE_MS } = require('../../src/config-service/scan-gate');

describe('scan gate in front of the measurement path', () => {
  const now = 1_000_000;

  test('no scan: everything passes', () => {
    const r = evaluateScanGate({ scanActive: 0, startedAt: null, nowMs: now });
    assert.equal(r.pass, true);
    assert.equal(r.clear, false);
  });

  test('a live scan pauses bus1 measurement, as intended', () => {
    const r = evaluateScanGate({ scanActive: 1, startedAt: now - 5000, nowMs: now, busId: 'bus1' });
    assert.equal(r.pass, false);
    assert.match(r.reason, /5s/);
  });

  test('SCOPED: a bus1 scan never blocks another segment', () => {
    // The scan job is written through the legacy paraRaw path, which is bus1
    // only. Blocking bus2 for a bus1 scan was pure collateral - and on a panel
    // whose sensors are all on bus2 it stopped everything for a scan that could
    // never complete.
    const r = evaluateScanGate({ scanActive: 1, startedAt: now - 5000, nowMs: now, busId: 'bus2' });
    assert.equal(r.pass, true);
    assert.equal(r.clear, false, 'and does not disturb the running scan');
  });

  test('an absent bus_id is treated as bus1', () => {
    // Only bus2 frames carry a tag; bus1 arrives untagged.
    assert.equal(evaluateScanGate({ scanActive: 1, startedAt: now, nowMs: now }).pass, false);
  });

  test('BOUNDED: a scan past the deadline releases the gate and clears the flag', () => {
    const r = evaluateScanGate({ scanActive: 1, startedAt: now - DEFAULT_DEADLINE_MS - 1, nowMs: now });
    assert.equal(r.pass, true);
    assert.equal(r.clear, true);
    assert.match(r.reason, /exceeded/);
  });

  test('FAILS OPEN: a flag with no start time is released, not honoured', () => {
    // The state the live panel was found in - latched by a scan that predates
    // this code, or whose context was lost. Treating it as "just started" would
    // keep measurement off forever, which is exactly the bug.
    for (const startedAt of [undefined, null, NaN, 'x']) {
      const r = evaluateScanGate({ scanActive: 1, startedAt, nowMs: now });
      assert.equal(r.pass, true, String(startedAt));
      assert.equal(r.clear, true, String(startedAt));
    }
  });

  test('the deadline is generous but finite', () => {
    // 127 addresses at a 500 ms worst-case timeout is ~64 s; a scan is a
    // foreground operation an operator waits for, not a background task.
    assert.ok(DEFAULT_DEADLINE_MS >= 90000 && DEFAULT_DEADLINE_MS <= 300000);
  });

  test('exactly at the deadline is still scanning; one ms past releases', () => {
    assert.equal(evaluateScanGate({ scanActive: 1, startedAt: now - DEFAULT_DEADLINE_MS, nowMs: now }).pass, false);
    assert.equal(evaluateScanGate({ scanActive: 1, startedAt: now - DEFAULT_DEADLINE_MS - 1, nowMs: now }).pass, true);
  });
});

describe('the flow node wires the gate up correctly', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const flows = () => JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'flows', 'flows_BBT.json'), 'utf8'));

  test('a missing library passes data through rather than blocking it', () => {
    // The lesson of the bug: never let a helper's absence stop measurement.
    const fn = flows().find((n) => n.id === '1241460384b2ddaa').func;
    const body = fn.replace(/\/\/[^\n]*/g, '');
    const i = body.indexOf('!cs.scanGate');
    assert.ok(i > 0, 'guards on the library');
    assert.match(body.slice(i, i + 220), /return msg;/, 'and returns the message, not null');
  });

  test('releasing the gate also restores normal polling', () => {
    // The scan replaces paraRaw with its 1..127 list. Clearing the flag without
    // restoring the backup would leave the Nano scanning addresses forever.
    const fn = flows().find((n) => n.id === '1241460384b2ddaa').func;
    assert.match(fn, /paraRaw_backup/);
    assert.match(fn, /flow\.set\('paraRaw', paraBackup\)/);
  });

  test('the scan start stamps a start time', () => {
    const fn = flows().find((n) => n.id === '90be626aa22b4467').func;
    assert.match(fn, /flow\.set\("scanStartedAt", Date\.now\(\)\)/);
  });
});
