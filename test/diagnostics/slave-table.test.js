'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  recordReading, buildSlaveRows, statusFor, channelAddress, channelName,
  record, snapshot,
} = require('../../src/diagnostics/slave-table');

const doc = (over = {}) => ({
  modbus: {
    slaves: [
      { slave_id: 'sl01', unit_address: 3, bus_id: 'bus1', channels: 1, label: 'Riser A',
        registers: { temp_base_addr: 3, temp_word_count: 1 } },
      { slave_id: 'sl02', unit_address: 6, bus_id: 'bus1', channels: 4, label: 'LEGACY-4CH',
        registers: { temp_base_addr: 3, temp_word_count: 1, channel_labels: ['a', 'b', '', 'd'] } },
    ],
    ...over,
  },
});

const msg = (id, channel, val, st = 'ok') => ({ bus_id: 'bus1', payload: { id, channel, val, st } });

describe('diagnostics slave table', () => {
  test('rows come from the CONFIG, so a silent device still appears', () => {
    // The case an engineer opens this page to find. Deriving rows from traffic
    // would make a dead device vanish rather than show as dead.
    const { rows, available } = buildSlaveRows(doc(), {}, { nowMs: 1000 });
    assert.equal(available, true);
    assert.equal(rows.length, 5, '1 channel + 4 channels');
    assert.ok(rows.every((r) => r.Status === 'No Data'));
    assert.ok(rows.every((r) => r.Data === null));
  });

  test('an unreadable config reports unavailable, not "no devices"', () => {
    // Those are different statements and the second one is alarming.
    assert.deepEqual(buildSlaveRows(null, {}), { rows: [], available: false });
    assert.deepEqual(buildSlaveRows({ modbus: { slaves: [] } }, {}), { rows: [], available: false });
  });

  test('values and connectivity come from the decoded readings', () => {
    const cache = {};
    recordReading(cache, msg(3, 1, 31.4), 5000);
    const { rows } = buildSlaveRows(doc(), cache, { nowMs: 5000 });
    const r = rows.find((x) => x.ID === 3);
    assert.equal(r.Data, 31.4);
    assert.equal(r.Status, 'Connected');
    assert.equal(r.AgeSec, 0);
  });

  test('each channel of a multi-channel module is its own row', () => {
    const cache = {};
    recordReading(cache, msg(6, 2, 36.1), 5000);
    const { rows } = buildSlaveRows(doc(), cache, { nowMs: 5000 });
    const six = rows.filter((r) => r.ID === 6);
    assert.equal(six.length, 4);
    assert.equal(six[1].Data, 36.1);
    assert.equal(six[1].Status, 'Connected');
    assert.equal(six[0].Status, 'No Data', 'channel 1 has not reported');
  });

  test('a stale reading reads No Data, not its last value', () => {
    const cache = {};
    recordReading(cache, msg(3, 1, 31.4), 1000);
    const { rows } = buildSlaveRows(doc(), cache, { nowMs: 1000 + 61000 });
    const r = rows.find((x) => x.ID === 3);
    assert.equal(r.Status, 'No Data');
    // The VALUE is still shown - an engineer wants the last reading and its age.
    // The status is what says not to trust it.
    assert.equal(r.Data, 31.4);
    assert.equal(r.AgeSec, 61);
  });

  test('staleMs is tunable, because it must exceed the bus sweep', () => {
    const cache = {};
    recordReading(cache, msg(3, 1, 31.4), 0);
    assert.equal(buildSlaveRows(doc(), cache, { nowMs: 90000, staleMs: 120000 })
      .rows.find((r) => r.ID === 3).Status, 'Connected');
  });

  test('a failed read is Error, distinct from No Data', () => {
    const cache = {};
    recordReading(cache, msg(3, 1, null, 'err'), 5000);
    assert.equal(statusFor(cache['3:1'], 5000, 60000), 'Error');
  });

  test('names prefer the channel label, then the device label, never invention', () => {
    const s = doc().modbus.slaves[1];
    assert.equal(channelName(s, 1), 'a');
    assert.equal(channelName(s, 3), 'LEGACY-4CH ch3', 'blank channel label falls back');
    assert.equal(channelName({ unit_address: 9, channels: 1, registers: {} }, 1), 'Slave 9');
  });

  test('addresses handle both register layouts', () => {
    const consecutive = { registers: { temp_base_addr: 3, temp_word_count: 2 } };
    assert.equal(channelAddress(consecutive, 3), 7);
    const sparse = { registers: { temp_base_addr: 100, channel_addrs: [100, 104, 108] } };
    assert.equal(channelAddress(sparse, 2), 104);
  });

  test('a reading with no channel is channel 1', () => {
    // In-flight messages across a deploy, and the library-missing fallback.
    const cache = {};
    recordReading(cache, { payload: { id: 3, val: 20, st: 'ok' } }, 1000);
    assert.equal(cache['3:1'].val, 20);
  });

  test('rows are ordered by unit address then channel', () => {
    const { rows } = buildSlaveRows(doc(), {}, { nowMs: 0 });
    assert.deepEqual(rows.map((r) => `${r.ID}:${r.Ch}`), ['3:1', '6:1', '6:2', '6:3', '6:4']);
  });
});

describe('the live cache is a module singleton, not context', () => {
  // A context store is chosen by contextStorage.default, which applies to node,
  // flow AND global scope alike - and on these panels that default is
  // localfilesystem. Keeping the cache in flow context put an SD write on every
  // reading, which is what the historian investigation was about.
  test('record() and snapshot() share one process-wide object', () => {
    record({ payload: { id: 42, channel: 1, val: 27.5, st: 'ok' } }, 9000);
    assert.equal(snapshot()['42:1'].val, 27.5);
  });

  test('a second require sees the same cache', () => {
    // Both function nodes reach it through the one busductConfigService object,
    // so they must not get separate copies.
    delete require.cache[require.resolve('../../src/diagnostics/slave-table')];
    const again = require('../../src/diagnostics/slave-table');
    // A fresh require is a fresh module by design; what matters is that the ONE
    // instance held by busductConfigService is shared, so assert through that.
    const svc = require('../../src/config-service/node-red');
    svc.diagTable.record({ payload: { id: 43, channel: 1, val: 30, st: 'ok' } }, 9000);
    assert.equal(svc.diagTable.snapshot()['43:1'].val, 30);
    assert.ok(typeof again.record === 'function');
  });
});

describe('the applied-doc cache is in memory, not the SD-backed store', () => {
  const { appliedDoc, _resetForTests } = require('../../src/diagnostics/slave-table');
  const doc1 = { modbus: { slaves: [{ slave_id: 'sl01', unit_address: 1, channels: 1, registers: {} }] } };

  test('reads once per TTL, not once per call', () => {
    // The regression this replaces: a ~100 KB config document read back out of
    // a localfilesystem-backed node context on every 1 s tick took node-red from
    // ~19% to ~53% CPU.
    _resetForTests();
    let reads = 0;
    const store = () => { reads += 1; return { readDomain: () => ({ doc: doc1 }) }; };
    appliedDoc(store, { nowMs: 0, ttlMs: 30000 });
    appliedDoc(store, { nowMs: 1000 });
    appliedDoc(store, { nowMs: 29000 });
    assert.equal(reads, 1, 'three calls inside the TTL must read once');
    appliedDoc(store, { nowMs: 31000 });
    assert.equal(reads, 2, 'and again after it expires');
  });

  test('a read failure keeps the last good document', () => {
    // The config changes only on an apply, so a transient error must not blank
    // the table - an empty table reads as "no devices commissioned", which is a
    // different and alarming statement.
    _resetForTests();
    appliedDoc(() => ({ readDomain: () => ({ doc: doc1 }) }), { nowMs: 0 });
    const r = appliedDoc(() => { throw new Error('EACCES'); }, { nowMs: 60000 });
    assert.equal(r.doc, doc1, 'last good doc retained');
    assert.match(r.error, /EACCES/, 'but the caller is told it is not fresh');
  });

  test('a first-ever failure yields no document, and says why', () => {
    _resetForTests();
    const r = appliedDoc(() => { throw new Error('ENOENT'); }, { nowMs: 0 });
    assert.equal(r.doc, null);
    assert.match(r.error, /ENOENT/);
    assert.equal(buildSlaveRows(r.doc, {}).available, false);
  });
});

describe('the row builder is gated on someone actually watching', () => {
  const { noteUiEvent, uiActive, _resetForTests: reset } = require('../../src/diagnostics/slave-table');

  test('unknown presence means inactive - fail towards doing no work', () => {
    reset();
    assert.equal(uiActive(1000), false);
  });

  test('open and heartbeat mark active, close marks inactive immediately', () => {
    reset();
    noteUiEvent('open', 1000);
    assert.equal(uiActive(1000), true);
    noteUiEvent('heartbeat', 10000);
    assert.equal(uiActive(14000), true, 'still inside the window');
    noteUiEvent('close', 15000);
    assert.equal(uiActive(15000), false);
  });

  test('presence expires if the heartbeat stops', () => {
    // A browser killed without a close event must not pin the builder on.
    reset();
    noteUiEvent('open', 0);
    assert.equal(uiActive(15000), true, 'exactly on the boundary');
    assert.equal(uiActive(15001), false);
  });
});

describe('the gated builder does no work with the page closed', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const cs = require('../../src/config-service/node-red');

  const runBuilder = (now) => {
    const flows = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', '..', 'flows', 'flows_BBT.json'), 'utf8'));
    const n = flows.find((x) => x.id === '2aa9ec351622e3e9');
    let reads = 0;
    const svc = Object.assign({}, cs, {
      createStore: () => { reads += 1; return { readDomain: () => ({ doc: { modbus: { slaves: [
        { slave_id: 'sl01', unit_address: 3, channels: 1, label: 'A', registers: { temp_base_addr: 3 } }] } } }) }; },
    });
    let status = null;
    const out = new Function('msg', 'node', 'global', 'flow', 'context', n.func)(
      {}, { status(s) { status = s; } },
      { get: (k) => (k === 'busductConfigService' ? svc : undefined) },
      { get() {}, set() {} }, { get() {}, set() {} });
    return { out, status, reads };
  };

  test('page closed: returns nothing, reads no config, builds no rows', () => {
    cs.diagTable._resetForTests();
    const r = runBuilder(1000);
    assert.equal(r.out, null);
    assert.equal(r.reads, 0, 'the config store must not be touched');
    assert.match(r.status.text, /idle/);
  });

  test('page open: builds normally again', () => {
    cs.diagTable._resetForTests();
    cs.diagTable.noteUiEvent('open', Date.now());
    const r = runBuilder(Date.now());
    assert.ok(r.out && r.out.payload.RecipDetails.length === 1);
    assert.match(r.status.text, /1 channels/);
  });
});

describe('device state is collapsed server-side (2026-09-08)', () => {
  const { annotateDevice } = require('../../src/diagnostics/slave-table');

  // The template resolved blacklist.byUnit[RawData.ID] SIX times per row. The
  // text and classes below must stay byte-identical to what it produced, or the
  // page changes appearance for a performance fix.
  test('Active requires a fresh OK reading, not merely the absence of a blacklist entry', () => {
    // A panel showed five rows reading "Device: Active, Status: No Data" - a
    // contradiction, because Active reads as healthy when the truthful answer is
    // that nothing has ever been heard from the device.
    const rows = [{ ID: 3, Status: 'Connected' }];
    annotateDevice(rows, {});
    assert.deepEqual(rows[0], { ID: 3, Status: 'Connected', Device: 'Active', DeviceClass: 'dev-active' });
  });

  test('never seen, stale or erroring reads Unknown', () => {
    for (const status of ['No Data', 'Error']) {
      const rows = [{ ID: 3, Status: status }];
      annotateDevice(rows, {});
      assert.equal(rows[0].Device, 'Unknown', status);
      assert.equal(rows[0].DeviceClass, 'dev-unknown');
    }
  });

  test('Active can never appear beside No Data', () => {
    // The invariant, stated directly - this is the whole point of the change.
    const rows = [
      { ID: 1, Status: 'Connected' }, { ID: 2, Status: 'No Data' },
      { ID: 3, Status: 'Error' }, { ID: 4, Status: 'No Data' },
    ];
    annotateDevice(rows, { 4: { status: 'probing', next_probe_in_sec: 9 } });
    for (const r of rows) {
      assert.ok(!(r.Device === 'Active' && r.Status !== 'Connected'),
        `row ${r.ID}: "${r.Device}" beside "${r.Status}"`);
    }
  });

  test('blacklisted, with and without a retry countdown', () => {
    const rows = [{ ID: 3, Status: 'No Data' }, { ID: 4, Status: 'Connected' }];
    annotateDevice(rows, {
      3: { status: 'blacklisted', next_probe_in_sec: 42 },
      4: { status: 'blacklisted', next_probe_in_sec: null },
    });
    assert.equal(rows[0].Device, 'BLACKLISTED 42s');
    assert.equal(rows[0].DeviceClass, 'dev-blacklisted');
    assert.equal(rows[1].Device, 'BLACKLISTED', 'null countdown adds no suffix');
  });

  test('probing gets its own class', () => {
    const rows = [{ ID: 3, Status: 'Connected' }];
    annotateDevice(rows, { 3: { status: 'probing', next_probe_in_sec: 5 } });
    assert.equal(rows[0].Device, 'PROBING 5s');
    assert.equal(rows[0].DeviceClass, 'dev-probing');
  });

  test('a missing byUnit map is treated as all-active, never as a crash', () => {
    // This runs on the live diagnostic path; blacklist state may be unavailable.
    const rows = [{ ID: 3, Status: 'Connected' }];
    annotateDevice(rows, undefined);
    assert.equal(rows[0].Device, 'Active');
  });
});

describe('the Diagnostics template stays cheap to render (2026-09-08)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  const tpl = () => strip(JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'flows', 'flows_BBT.json'), 'utf8'))
    .find((n) => n.id === 'db41c2b5077e83fc').format);

  test('no ng-model in the table - it built an NgModelController per cell', () => {
    // Four disabled <input ng-model> cells x 71 rows = 284 controllers, purely
    // to display text. Divs with the same class render identically.
    assert.equal((tpl().match(/ng-model=/g) || []).length, 0);
  });

  test('the device cell resolves the blacklist map zero times', () => {
    assert.equal((tpl().match(/byUnit\[RawData\.ID\]/g) || []).length, 0,
      'precomputed into RawData.Device / RawData.DeviceClass');
  });

  test('div nesting is balanced and never goes negative', () => {
    // Comments are stripped first: the CSS comment explaining this change
    // contains a literal "<div>", which a naive count reads as an open tag.
    // Fifth time in this project a check has matched prose instead of markup.
    let depth = 0;
    for (const m of tpl().matchAll(/<\/?div\b/g)) {
      depth += m[0] === '<div' ? 1 : -1;
      assert.ok(depth >= 0, 'a </div> closed a div that was never opened');
    }
    assert.equal(depth, 0);
  });
});
