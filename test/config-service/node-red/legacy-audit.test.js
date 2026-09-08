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
