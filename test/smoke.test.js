const { test } = require('node:test');
const assert = require('node:assert/strict');

test('test runner is wired up', () => {
  assert.equal(1 + 1, 2);
});
