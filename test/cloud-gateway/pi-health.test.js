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
    assert.deepEqual(health, { cpu_temp_c: null, mac_id: null, ram_free_mb: null, ram_available_mb: null, low_voltage: null, network: null });
  });
});

const ROUTE_VIA = (iface) =>
  `Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\n${iface}\t00000000\tC0A80101\t0003\t0\t0\t100\t00000000\n${iface}\tC0A80100\t00000000\t0001\t0\t0\t100\tFFFFFF00\n`;

describe('collectPiHealth - network', () => {
  test('Wi-Fi uplink includes signal dBm and link quality from /proc/net/wireless', () => {
    const files = {
      ...PI_FILES,
      '/proc/net/route': ROUTE_VIA('wlan0'),
      '/proc/net/wireless':
        'Inter-| sta-|   Quality        |   Discarded packets               | Missed | WE\n face | tus | link level noise |  nwid  crypt   frag  retry   misc | beacon | 22\n wlan0: 0000   54.  -56.  -256        0      0      0      0      0        0\n',
    };
    const health = collectPiHealth({ fs: fakeFs(files), execFileSync: () => 'throttled=0x0\n', env: {} });
    assert.deepEqual(health.network, { interface: 'wlan0', type: 'wifi', wifi: { signal_dbm: -56, link_quality: 54 } });
  });

  test('ethernet uplink reports type only (no signal concept)', () => {
    const files = { ...PI_FILES, '/proc/net/route': ROUTE_VIA('eth0') };
    const health = collectPiHealth({ fs: fakeFs(files), execFileSync: () => 'throttled=0x0\n', env: {} });
    assert.deepEqual(health.network, { interface: 'eth0', type: 'ethernet' });
  });

  test('cellular uplink (SIM7600G as usb0) reads ModemManager percent and AT+CSQ dBm', () => {
    const files = { ...PI_FILES, '/proc/net/route': ROUTE_VIA('usb0') };
    const health = collectPiHealth({
      fs: fakeFs(files),
      execFileSync: (cmd, args) => {
        if (cmd === 'vcgencmd') return 'throttled=0x0\n';
        if (cmd === 'mmcli') return "  signal quality: '75' (recent)\n";
        if (cmd === 'stty') return '';
        if (cmd === 'sh') return 'AT+CSQ\r\r\n+CSQ: 22,0\r\n\r\nOK\r\n';
        throw new Error(`unexpected ${cmd}`);
      },
      env: { BUSDUCT_MODEM_AT_PORT: '/dev/ttyUSB2' },
    });
    assert.deepEqual(health.network, {
      interface: 'usb0',
      type: 'cellular',
      cellular: { signal_percent: 75, signal_dbm: -69, csq: 22 }, // -113 + 2*22
    });
  });

  test('cellular with neither ModemManager nor AT port still reports the uplink type', () => {
    const files = { ...PI_FILES, '/proc/net/route': ROUTE_VIA('ppp0') };
    const health = collectPiHealth({
      fs: fakeFs(files),
      execFileSync: (cmd) => {
        if (cmd === 'vcgencmd') return 'throttled=0x0\n';
        throw new Error('not installed');
      },
      env: {},
    });
    assert.deepEqual(health.network, {
      interface: 'ppp0',
      type: 'cellular',
      cellular: { signal_percent: null, signal_dbm: null, csq: null },
    });
  });

  test('no default route -> network null, nothing throws', () => {
    const health = collectPiHealth({ fs: fakeFs(PI_FILES), execFileSync: () => 'throttled=0x0\n', env: {} });
    assert.equal(health.network, null);
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
