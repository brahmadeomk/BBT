'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { collectPiHealth } = require('../../src/cloud-gateway/pi-health');

const PI_FILES = {
  '/sys/class/thermal/thermal_zone0/temp': '48765\n',
  '/sys/class/net/eth0/address': 'dc:a6:32:ab:cd:ef\n',
  '/proc/meminfo': 'MemTotal:        3885396 kB\nMemFree:          214504 kB\nMemAvailable:    2837156 kB\nBuffers:          123456 kB\n',
};

function fakeFs(files = PI_FILES) {
  return {
    readFileSync: (p) => {
      if (files[p] == null) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
  };
}

describe('collectPiHealth', () => {
  test('reads temperature, MAC, RAM, and decodes an under-voltage throttled flag', () => {
    const health = collectPiHealth({
      fs: fakeFs(),
      execFileSync: () => 'throttled=0x50005\n',
    });
    assert.equal(health.cpu_temp_c, 48.8);
    assert.equal(health.mac_id, 'dc:a6:32:ab:cd:ef');
    assert.equal(health.ram_free_mb, 209);
    assert.equal(health.ram_available_mb, 2771);
    // 0x50005: bits 0+2 (under-voltage + throttled now), 16+18 (both since boot)
    assert.deepEqual(health.low_voltage, {
      now: true,
      since_boot: true,
      throttled_now: true,
      throttled_since_boot: true,
      raw: '0x50005',
    });
  });

  test('healthy panel decodes to all-false low_voltage', () => {
    const health = collectPiHealth({ fs: fakeFs(), execFileSync: () => 'throttled=0x0\n' });
    assert.deepEqual(health.low_voltage, { now: false, since_boot: false, throttled_now: false, throttled_since_boot: false, raw: '0x0' });
  });

  test('falls back to wlan0 when eth0 is absent', () => {
    const files = { ...PI_FILES };
    delete files['/sys/class/net/eth0/address'];
    files['/sys/class/net/wlan0/address'] = 'b8:27:eb:12:34:56\n';
    const health = collectPiHealth({ fs: fakeFs(files), execFileSync: () => 'throttled=0x0\n' });
    assert.equal(health.mac_id, 'b8:27:eb:12:34:56');
  });

  test('degrades to nulls off-Pi (no sysfs, no vcgencmd) without throwing', () => {
    const health = collectPiHealth({
      fs: fakeFs({}),
      execFileSync: () => {
        throw new Error('vcgencmd: not found');
      },
    });
    assert.deepEqual(health, { cpu_temp_c: null, mac_id: null, ram_free_mb: null, ram_available_mb: null, low_voltage: null });
  });
});

describe('heartbeat carries the system snapshot', () => {
  test('sendHeartbeat includes system fields and the queued payload carries them', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { createGateway, sendHeartbeat } = require('../../src/cloud-gateway/node-red');
    const gw = createGateway({ outboxDir: fs.mkdtempSync(path.join(os.tmpdir(), 'busduct-hb-test-')) });
    gw.outbox.stop();

    const status = sendHeartbeat(gw, { fwVersion: 'x', configVersions: { modbus: 1 } });
    assert.ok(status.system, 'status carries the snapshot');
    assert.ok('cpu_temp_c' in status.system && 'mac_id' in status.system && 'low_voltage' in status.system);

    await gw.outbox.drain();
    const hb = gw.transport.published[0];
    assert.ok(hb.payload.system, 'published heartbeat carries system');
    assert.ok('ram_available_mb' in hb.payload.system);
  });
});
