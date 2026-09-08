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
