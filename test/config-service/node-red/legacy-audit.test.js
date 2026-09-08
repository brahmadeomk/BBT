'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

describe('sortAuditDesc (2026-09-08)', () => {
  const { sortAuditDesc } = require('../../../src/config-service/node-red/legacy-audit');

  test('newest first, matching the orderBy it replaced', () => {
    const out = sortAuditDesc([{ ts: '2026-01-01' }, { ts: '2026-03-01' }, { ts: '2026-02-01' }], 'ts');
    assert.deepEqual(out.map((e) => e.ts), ['2026-03-01', '2026-02-01', '2026-01-01']);
  });

  test('DOES NOT mutate the stored array', () => {
    // global.get hands back a live reference to the persisted audit log.
    // Sorting in place would permanently reorder a record that exists precisely
    // so its order can be trusted.
    const stored = [{ ts: 'a' }, { ts: 'c' }, { ts: 'b' }];
    const before = stored.map((e) => e.ts);
    sortAuditDesc(stored, 'ts');
    assert.deepEqual(stored.map((e) => e.ts), before);
  });

  test('entries missing the field sort last instead of throwing', () => {
    const out = sortAuditDesc([{ ts: 'b' }, {}, { ts: 'c' }], 'ts');
    assert.deepEqual(out.map((e) => e.ts), ['c', 'b', undefined]);
  });

  test('equal values keep their original order, so renders are stable', () => {
    const out = sortAuditDesc([{ ts: 'a', n: 1 }, { ts: 'a', n: 2 }, { ts: 'a', n: 3 }], 'ts');
    assert.deepEqual(out.map((e) => e.n), [1, 2, 3]);
  });

  test('a non-array is empty, never a crash on the live audit path', () => {
    assert.deepEqual(sortAuditDesc(undefined, 'ts'), []);
  });
});

describe('viewer cap of 20 (user request 2026-09-08)', () => {
  const { appendLegacyAudit, viewerRows, VIEWER_CAP } =
    require('../../../src/config-service/node-red/legacy-audit');

  const store = (seed = []) => {
    const m = { k: seed };
    return { get: (k) => m[k], set: (k, v) => { m[k] = v; }, _m: m };
  };

  test('the cap is 20', () => {
    assert.equal(VIEWER_CAP, 20);
  });

  test('appending drops the oldest beyond the cap', () => {
    const g = store([]);
    for (let i = 0; i < 30; i += 1) appendLegacyAudit(g, 'k', { ts: String(i).padStart(2, '0') });
    assert.equal(g._m.k.length, 20);
    assert.equal(g._m.k[0].ts, '10', 'the ten oldest are gone');
    assert.equal(g._m.k[19].ts, '29');
  });

  test('a panel already holding 200 renders only the newest 20 immediately', () => {
    // Read-side trimming matters: without it an existing panel would keep
    // rendering all 200 until its next config apply.
    const old = Array.from({ length: 200 }, (_, i) => ({ ts: String(i).padStart(3, '0') }));
    const rows = viewerRows(old, 'ts');
    assert.equal(rows.length, 20);
    assert.equal(rows[0].ts, '199', 'newest first');
    assert.equal(rows[19].ts, '180');
  });

  test('reading does not write back, and does not mutate the stored array', () => {
    // Writing on read would put an SD write on every page open; the stored
    // array converges on the next append instead.
    const old = Array.from({ length: 50 }, (_, i) => ({ ts: String(i) }));
    const before = old.length;
    viewerRows(old, 'ts');
    assert.equal(old.length, before);
    assert.equal(old[0].ts, '0', 'original order intact');
  });

  test('fewer than 20 entries are all shown', () => {
    assert.equal(viewerRows([{ ts: 'a' }, { ts: 'b' }], 'ts').length, 2);
  });
});
