'use strict';

// readDomainCached - the memoised read behind every per-message config access.
//
// Measured live on ESBUSBBT06 (2026-09-09). `readDomain` does existsSync +
// readFileSync + JSON.parse + a full R1-R17 validation pass, and two nodes were
// calling it once per message. On a 71-device panel that was ~2 MB/s of reads
// (against serial ports capable of ~23 KB/s) and Node-RED at ~50 % of a core
// with no dashboard client connected. `read_bytes` never moved - it was the
// parse and the validation, not the disk.
//
// The properties that matter are (1) it stops doing that work, and (2) it stays
// CORRECT: an apply must be visible on the very next message, not after a TTL.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ConfigStore, atomicWriteJson, _resetAppliedCache } = require('../../src/config-service/store');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-applied-cache-'));
}

/** Counts how often the validator runs - the expensive half of an uncached read. */
function countingStore(root) {
  const calls = { n: 0 };
  const store = new ConfigStore({
    root,
    validators: {
      modbus_joints: (doc) => {
        calls.n += 1;
        return { valid: !doc.__forceInvalid, errors: [] };
      },
    },
  });
  return { store, calls };
}

const DOC = { config_domain_versions: { modbus: 1, joints: 1 }, modbus: { slaves: [] }, joints: [] };

describe('readDomainCached', () => {
  test('parses and validates once, however many times it is called', () => {
    _resetAppliedCache();
    const root = tmpRoot();
    const { store, calls } = countingStore(root);
    atomicWriteJson(path.join(root, 'modbus_joints.json'), DOC);

    const first = store.readDomainCached('modbus_joints');
    assert.equal(calls.n, 1);

    for (let i = 0; i < 50; i += 1) store.readDomainCached('modbus_joints');
    assert.equal(calls.n, 1, '50 further reads must cost no validation at all');
    assert.equal(first.doc.config_domain_versions.modbus, 1);
  });

  test('an apply is visible on the very next read, not after a timeout', () => {
    // This is the property a TTL cache does NOT have, and the reason the
    // invalidation is keyed on file identity rather than on a clock. A config
    // apply that takes effect "within 10 seconds" is a race with the alarm path.
    _resetAppliedCache();
    const root = tmpRoot();
    const { store, calls } = countingStore(root);
    const file = path.join(root, 'modbus_joints.json');

    atomicWriteJson(file, DOC);
    assert.equal(store.readDomainCached('modbus_joints').doc.config_domain_versions.modbus, 1);
    const afterFirst = calls.n;

    atomicWriteJson(file, { ...DOC, config_domain_versions: { modbus: 2, joints: 1 } });
    assert.equal(store.readDomainCached('modbus_joints').doc.config_domain_versions.modbus, 2,
      'the new document must be served immediately');
    assert.ok(calls.n > afterFirst, 'which means it really re-read, rather than getting lucky');
  });

  test('a same-size rewrite is still noticed', () => {
    // mtime granularity is coarse on some filesystems and the applied document
    // is often edited without changing its length (a single digit in a version,
    // a swapped joint label). The atomic write path is temp+rename, so the
    // inode changes even when size and second-resolution mtime do not - the
    // signature includes it for exactly this case.
    _resetAppliedCache();
    const root = tmpRoot();
    const { store } = countingStore(root);
    const file = path.join(root, 'modbus_joints.json');

    atomicWriteJson(file, { ...DOC, joints: [{ joint_id: 'J01' }] });
    assert.equal(store.readDomainCached('modbus_joints').doc.joints[0].joint_id, 'J01');

    atomicWriteJson(file, { ...DOC, joints: [{ joint_id: 'J02' }] });   // identical length
    assert.equal(store.readDomainCached('modbus_joints').doc.joints[0].joint_id, 'J02');
  });

  test('the returned document is frozen, since callers now share one object', () => {
    _resetAppliedCache();
    const root = tmpRoot();
    const { store } = countingStore(root);
    atomicWriteJson(path.join(root, 'modbus_joints.json'), DOC);

    const { doc } = store.readDomainCached('modbus_joints');
    assert.ok(Object.isFrozen(doc), 'top level');
    assert.ok(Object.isFrozen(doc.modbus), 'and nested - a shallow freeze would not protect slaves[]');
    assert.throws(() => { doc.joints.push({ joint_id: 'J99' }); },
      'a consumer that mutates the shared doc must fail loudly, not poison every other reader');
  });

  test('the LKG fallback still works, and stops being served once the primary is repaired', () => {
    // readDomain falls back to the last-known-good snapshot when the primary is
    // missing or invalid, so the snapshot is part of the cache signature too -
    // otherwise a panel repaired in the field would keep serving the fallback
    // until Node-RED was restarted.
    _resetAppliedCache();
    const root = tmpRoot();
    const { store } = countingStore(root);
    const file = path.join(root, 'modbus_joints.json');

    atomicWriteJson(path.join(root, 'modbus_joints.lkg.json'), { ...DOC, joints: [{ joint_id: 'LKG' }] });
    atomicWriteJson(file, { __forceInvalid: true, config_domain_versions: { modbus: 9, joints: 9 } });

    let res = store.readDomainCached('modbus_joints');
    assert.equal(res.source, 'last-known-good');
    assert.equal(res.doc.joints[0].joint_id, 'LKG');

    atomicWriteJson(file, { ...DOC, joints: [{ joint_id: 'FIXED' }] });
    res = store.readDomainCached('modbus_joints');
    assert.equal(res.source, 'current', 'a repaired primary must take over immediately');
    assert.equal(res.doc.joints[0].joint_id, 'FIXED');
  });

  test('an absent document does not get cached as if it were present', () => {
    _resetAppliedCache();
    const root = tmpRoot();
    const { store } = countingStore(root);

    assert.equal(store.readDomainCached('modbus_joints').doc, null);

    atomicWriteJson(path.join(root, 'modbus_joints.json'), DOC);
    assert.notEqual(store.readDomainCached('modbus_joints').doc, null,
      'a panel that is commissioned after boot must be picked up without a restart');
  });

  test('two roots do not share an entry', () => {
    // Tests, the migration tool and the live service can all hold stores at
    // once; a cache keyed by domain name alone would cross them over.
    _resetAppliedCache();
    const a = tmpRoot();
    const b = tmpRoot();
    atomicWriteJson(path.join(a, 'modbus_joints.json'), { ...DOC, joints: [{ joint_id: 'AAA' }] });
    atomicWriteJson(path.join(b, 'modbus_joints.json'), { ...DOC, joints: [{ joint_id: 'BBB' }] });

    assert.equal(countingStore(a).store.readDomainCached('modbus_joints').doc.joints[0].joint_id, 'AAA');
    assert.equal(countingStore(b).store.readDomainCached('modbus_joints').doc.joints[0].joint_id, 'BBB');
  });
});
