'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStore, handleConfigManagerMessage, handleJointMasterMessage } = require('../../../src/config-service/node-red');

describe('node-red entry point', () => {
  test('createStore builds a working ConfigStore at a given root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-nr-index-test-'));
    const store = createStore(root);
    assert.deepEqual(store.getAppliedVersions('alarms'), {});
  });

  test('exports both message handlers', () => {
    assert.equal(typeof handleConfigManagerMessage, 'function');
    assert.equal(typeof handleJointMasterMessage, 'function');
  });
});
