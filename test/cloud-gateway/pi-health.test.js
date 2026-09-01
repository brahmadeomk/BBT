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
    // Every probe that reads the machine degrades to null. process_rss_mb is the
    // one exception - it reads this Node process, which always exists.
    for (const f of ['cpu_temp_c', 'mac_id', 'ram_free_mb', 'ram_available_mb', 'ram_total_mb',
                     'low_voltage', 'uptime_sec', 'load', 'disk', 'clock_synced', 'network']) {
      assert.equal(health[f], null, `${f} should be null off-Pi`);
    }
    assert.equal(typeof health.process_rss_mb, 'number');
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
    // No `iw` and no `iwgetid` here: the /proc fallback alone still yields signal.
    const health = collectPiHealth({
      fs: fakeFs(files),
      execFileSync: (cmd) => {
        if (cmd === 'vcgencmd') return 'throttled=0x0\n';
        throw new Error(`${cmd}: not found`);
      },
      env: {},
    });
    assert.deepEqual(health.network, {
      interface: 'wlan0',
      type: 'wifi',
      wifi: { ssid: null, bssid: null, signal_dbm: -56, link_quality: 54, freq_mhz: null, band: null, tx_bitrate_mbps: null },
    });
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
      cellular: {
        signal_percent: 75, signal_dbm: -69, csq: 22, // -113 + 2*22
        operator: null, access_tech: null, registration: null, modem_state: null,
      },
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
      cellular: {
        signal_percent: null, signal_dbm: null, csq: null,
        operator: null, access_tech: null, registration: null, modem_state: null,
      },
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

const IW_LINK = `Connected to dc:a6:32:11:22:33 (on wlan0)
	SSID: Godrej Plant Floor 2
	freq: 5180
	RX: 1234567 bytes (8901 packets)
	TX: 234567 bytes (3456 packets)
	signal: -58 dBm
	tx bitrate: 234.0 MBit/s VHT-MCS 8 80MHz short GI VHT-NSS 2
`;

describe('Wi-Fi association detail (user request 2026-09-01)', () => {
  const wifiFiles = {
    ...PI_FILES,
    '/proc/net/route': ROUTE_VIA('wlan0'),
    '/proc/net/wireless':
      'Inter-| sta-|   Quality        |   Discarded packets\n face | tus | link level noise |\n wlan0: 0000   61.  -58.  -256        0\n',
  };
  const withIw = (extra = {}) => collectPiHealth({
    fs: fakeFs(wifiFiles),
    execFileSync: (cmd, args) => {
      if (cmd === 'vcgencmd') return 'throttled=0x0\n';
      if (cmd === 'iw') { assert.deepEqual(args, ['dev', 'wlan0', 'link']); return IW_LINK; }
      throw new Error(`${cmd}: not found`);
    },
    env: {},
    ...extra,
  });

  test('reads SSID, BSSID, band and bitrate from a single `iw dev link` call', () => {
    const w = withIw().network.wifi;
    assert.equal(w.ssid, 'Godrej Plant Floor 2', 'SSIDs contain spaces - take the line, not a token');
    assert.equal(w.bssid, 'dc:a6:32:11:22:33');
    assert.equal(w.freq_mhz, 5180);
    assert.equal(w.band, '5GHz');
    assert.equal(w.signal_dbm, -58);
    assert.equal(w.tx_bitrate_mbps, 234);
  });

  test('link_quality still comes from /proc, which `iw` has no equivalent for', () => {
    assert.equal(withIw().network.wifi.link_quality, 61);
  });

  test('falls back to iwgetid for the SSID when `iw` is absent', () => {
    // wireless-tools is not installed by default on Bookworm, and `iw` is not on
    // every older image either - so neither source can be the only one.
    const health = collectPiHealth({
      fs: fakeFs(wifiFiles),
      execFileSync: (cmd) => {
        if (cmd === 'vcgencmd') return 'throttled=0x0\n';
        if (cmd === 'iwgetid') return 'Godrej Plant Floor 2\n';
        throw new Error(`${cmd}: not found`);
      },
      env: {},
    });
    assert.equal(health.network.wifi.ssid, 'Godrej Plant Floor 2');
    assert.equal(health.network.wifi.signal_dbm, -58, 'and /proc still supplies signal');
  });

  test('band is derived from frequency, not guessed', () => {
    for (const [freq, band] of [[2437, '2.4GHz'], [5180, '5GHz'], [5955, '6GHz']]) {
      const health = collectPiHealth({
        fs: fakeFs(wifiFiles),
        execFileSync: (cmd) => {
          if (cmd === 'vcgencmd') return 'throttled=0x0\n';
          if (cmd === 'iw') return IW_LINK.replace('freq: 5180', `freq: ${freq}`);
          throw new Error('nope');
        },
        env: {},
      });
      assert.equal(health.network.wifi.band, band, `${freq} MHz`);
    }
  });
});

describe('cellular dongle detail', () => {
  const MMCLI_K = `modem.generic.state                     : connected
modem.generic.signal-quality.value      : 68
modem.generic.access-technologies.value[1] : lte
modem.3gpp.operator-name                : Airtel
modem.3gpp.registration-state           : home
`;
  const cell = (execFileSync, env = {}) => collectPiHealth({
    fs: fakeFs({ ...PI_FILES, '/proc/net/route': ROUTE_VIA('wwan0') }),
    execFileSync, env,
  }).network.cellular;

  test('mmcli -K supplies operator, technology and registration, not just signal', () => {
    const c = cell((cmd, args) => {
      if (cmd === 'vcgencmd') return 'throttled=0x0\n';
      if (cmd === 'mmcli') { assert.deepEqual(args, ['-m', 'any', '-K']); return MMCLI_K; }
      throw new Error('nope');
    });
    assert.equal(c.signal_percent, 68);
    assert.equal(c.operator, 'Airtel');
    assert.equal(c.access_tech, 'lte');
    assert.equal(c.registration, 'home');
    assert.equal(c.modem_state, 'connected');
  });

  test('falls back to human mmcli output when -K is unsupported', () => {
    let calls = 0;
    const c = cell((cmd, args) => {
      if (cmd === 'vcgencmd') return 'throttled=0x0\n';
      if (cmd === 'mmcli') {
        calls += 1;
        if (args.includes('-K')) throw new Error('unrecognized option');
        return "  Status |   signal quality: '55' (recent)\n  3GPP | operator name: Vi India\n       | registration: roaming\n";
      }
      throw new Error('nope');
    });
    assert.equal(calls, 2, 'tries -K first, then the human form');
    assert.equal(c.signal_percent, 55);
    assert.equal(c.operator, 'Vi India');
    assert.equal(c.registration, 'roaming');
  });

  test('CSQ 99 means "unknown", and must not decode as a strong signal', () => {
    // -113 + 2*99 = +85 dBm, which would read as an impossibly good link.
    const c = cell((cmd) => {
      if (cmd === 'vcgencmd') return 'throttled=0x0\n';
      if (cmd === 'stty') return '';
      if (cmd === 'sh') return '\r\n+CSQ: 99,99\r\n\r\nOK\r\n';
      throw new Error('nope');
    }, { BUSDUCT_MODEM_AT_PORT: '/dev/ttyUSB2' });
    assert.equal(c.csq, 99);
    assert.equal(c.signal_dbm, null);
  });
});

describe('additional Pi health parameters', () => {
  const DF = 'Filesystem 1024-blocks     Used Available Capacity Mounted on\n/dev/root   30218364 11402544  17557988      40% /\n';
  const files = {
    ...PI_FILES,
    '/proc/uptime': '867543.21 3412345.67\n',
    '/proc/loadavg': '0.52 0.48 0.44 1/523 12345\n',
    '/proc/cpuinfo': 'processor\t: 0\n\nprocessor\t: 1\n\nprocessor\t: 2\n\nprocessor\t: 3\n\n',
  };
  const exec = (cmd, args) => {
    if (cmd === 'vcgencmd') return 'throttled=0x0\n';
    if (cmd === 'df') return DF;
    if (cmd === 'timedatectl') return 'yes\n';
    throw new Error(`${cmd}: not found`);
  };
  const health = (env = {}) => collectPiHealth({ fs: fakeFs(files), execFileSync: exec, env });

  test('disk free is reported per filesystem - the SD card holds both historian and outbox', () => {
    const [root] = health().disk;
    assert.equal(root.path, '/');
    assert.equal(root.free_mb, 17146);
    assert.equal(root.total_mb, 29510);
    assert.equal(root.used_pct, 41.9);
  });

  test('extra filesystems can be named for sites that split historian or outbox off', () => {
    const seen = [];
    collectPiHealth({
      fs: fakeFs(files),
      execFileSync: (cmd, args) => { if (cmd === 'df') seen.push(args[2]); return exec(cmd, args); },
      env: { BUSDUCT_HEALTH_DISK_PATHS: '/var/busduct:/var/lib/influxdb' },
    });
    assert.deepEqual(seen, ['/', '/var/busduct', '/var/lib/influxdb']);
  });

  test('uptime is reported so a reboot between heartbeats is detectable', () => {
    // An unexplained reboot is how an intermittent brown-out announces itself.
    assert.equal(health().uptime_sec, 867543);
  });

  test('load carries the core count it has to be read against', () => {
    assert.deepEqual(health().load, { avg1: 0.52, avg5: 0.48, avg15: 0.44, cpus: 4 });
  });

  test('RAM total is reported alongside free/available', () => {
    assert.equal(health().ram_total_mb, 3794);
  });

  test('clock sync is a boolean, since edge_utc timestamps depend on it', () => {
    assert.equal(health().clock_synced, true);
    const unsynced = collectPiHealth({
      fs: fakeFs(files),
      execFileSync: (cmd, args) => (cmd === 'timedatectl' ? 'no\n' : exec(cmd, args)),
      env: {},
    });
    assert.equal(unsynced.clock_synced, false);
  });

  test('a probe that fails takes only its own field down', () => {
    // The whole point: a health snapshot must never break the heartbeat carrying it.
    const partial = collectPiHealth({
      fs: fakeFs(files),
      execFileSync: (cmd, args) => {
        if (cmd === 'df' || cmd === 'timedatectl') throw new Error('boom');
        return exec(cmd, args);
      },
      env: {},
    });
    assert.equal(partial.disk, null);
    assert.equal(partial.clock_synced, null);
    assert.equal(partial.uptime_sec, 867543, 'unrelated fields survive');
    assert.equal(partial.load.cpus, 4);
  });
});
