'use strict';

const nodeFs = require('node:fs');
const { execFileSync: nodeExecFileSync } = require('node:child_process');

/**
 * Raspberry Pi health snapshot for the heartbeat (user requirement
 * 2026-07-18): CPU temperature, MAC id, free/available RAM, and the
 * Pi's low-voltage/throttling state. Everything degrades to null on
 * non-Pi machines or read failures - a health probe must never break
 * the heartbeat that carries it.
 *
 * Sources (no extra packages):
 *   cpu_temp_c     /sys/class/thermal/thermal_zone0/temp (millidegrees)
 *   mac_id         /sys/class/net/eth0/address, falling back to wlan0
 *   ram_free_mb / ram_available_mb   /proc/meminfo MemFree / MemAvailable
 *                  (free = truly unused; available = what the kernel could
 *                   give applications right now, counting reclaimable cache -
 *                   the number that matters for "are we running out")
 *   low_voltage    vcgencmd get_throttled bit flags: bit 0 = under-voltage
 *                  right now, bit 16 = has occurred since boot; bits 2/18
 *                  the same for actual throttling. Raw hex included for
 *                  cloud-side decoding of the remaining bits.
 *   network        active default-route interface (/proc/net/route) classified
 *                  as wifi/ethernet/cellular. Wi-Fi adds signal from
 *                  /proc/net/wireless (level dBm + link quality). Cellular
 *                  (e.g. the SIM7600G USB modem, usually usb0/wwan0/ppp0)
 *                  adds signal via ModemManager (`mmcli -m any`, percent) when
 *                  installed; if BUSDUCT_MODEM_AT_PORT is set (e.g.
 *                  /dev/ttyUSB2 - the SIM7600's spare AT port, safe to query
 *                  during a data session), AT+CSQ is queried directly for
 *                  rssi_dbm as well.
 */
function collectPiHealth({ fs = nodeFs, execFileSync = nodeExecFileSync, env = process.env } = {}) {
  const health = {
    cpu_temp_c: null,
    mac_id: null,
    ram_free_mb: null,
    ram_available_mb: null,
    low_voltage: null,
    network: collectNetwork({ fs, execFileSync, env }),
  };

  try {
    const milli = parseInt(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim(), 10);
    if (Number.isFinite(milli)) health.cpu_temp_c = Math.round(milli / 100) / 10;
  } catch {
    /* not a Pi / no thermal zone */
  }

  for (const iface of ['eth0', 'wlan0']) {
    try {
      const mac = fs.readFileSync(`/sys/class/net/${iface}/address`, 'utf8').trim();
      if (/^[0-9a-f:]{17}$/i.test(mac)) {
        health.mac_id = mac;
        break;
      }
    } catch {
      /* interface absent */
    }
  }

  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const kb = (field) => {
      const m = meminfo.match(new RegExp(`^${field}:\\s+(\\d+) kB`, 'm'));
      return m ? parseInt(m[1], 10) : null;
    };
    const free = kb('MemFree');
    const available = kb('MemAvailable');
    if (free != null) health.ram_free_mb = Math.round(free / 1024);
    if (available != null) health.ram_available_mb = Math.round(available / 1024);
  } catch {
    /* no /proc/meminfo */
  }

  try {
    const out = execFileSync('vcgencmd', ['get_throttled'], { encoding: 'utf8', timeout: 2000 });
    const m = out.match(/throttled=0x([0-9a-fA-F]+)/);
    if (m) {
      const bits = parseInt(m[1], 16);
      health.low_voltage = {
        now: Boolean(bits & 0x1),
        since_boot: Boolean(bits & 0x10000),
        throttled_now: Boolean(bits & 0x4),
        throttled_since_boot: Boolean(bits & 0x40000),
        raw: `0x${m[1]}`,
      };
    }
  } catch {
    /* vcgencmd absent (non-Pi) or firmware query failed */
  }

  return health;
}

function classifyInterface(iface) {
  if (/^wl/.test(iface)) return 'wifi';
  if (/^(eth|en)/.test(iface)) return 'ethernet';
  if (/^(ppp|wwan|usb)/.test(iface)) return 'cellular'; // SIM7600G shows up as usb0 (RNDIS), wwan0 (QMI) or ppp0
  return 'unknown';
}

/** Active default-route interface + signal strength for wifi/cellular uplinks. */
function collectNetwork({ fs, execFileSync, env }) {
  let iface = null;
  try {
    // /proc/net/route: pick the interface of the default route (Destination 00000000)
    const lines = fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1);
    for (const line of lines) {
      const cols = line.trim().split(/\s+/);
      if (cols[1] === '00000000') {
        iface = cols[0];
        break;
      }
    }
  } catch {
    return null;
  }
  if (!iface) return null;

  const type = classifyInterface(iface);
  const network = { interface: iface, type };

  if (type === 'wifi') {
    try {
      // /proc/net/wireless data row: "wlan0: 0000   54.  -56.  -256 ..." -> link quality, level dBm
      const row = fs
        .readFileSync('/proc/net/wireless', 'utf8')
        .split('\n')
        .find((l) => l.trim().startsWith(`${iface}:`));
      if (row) {
        const cols = row.trim().split(/\s+/);
        const quality = parseFloat(cols[2]);
        const level = parseFloat(cols[3]);
        network.wifi = {
          signal_dbm: Number.isFinite(level) ? level : null,
          link_quality: Number.isFinite(quality) ? quality : null,
        };
      }
    } catch {
      /* wireless stats unavailable */
    }
  }

  if (type === 'cellular') {
    const cellular = { signal_percent: null, signal_dbm: null, csq: null };
    try {
      // ModemManager, when present, is the least invasive source
      const out = execFileSync('mmcli', ['-m', 'any'], { encoding: 'utf8', timeout: 3000 });
      const m = out.match(/signal quality:\s*'?(\d+)'?/i);
      if (m) cellular.signal_percent = parseInt(m[1], 10);
    } catch {
      /* no ModemManager */
    }
    const atPort = env.BUSDUCT_MODEM_AT_PORT;
    if (atPort) {
      try {
        // SIM7600G keeps a spare AT port (typically /dev/ttyUSB2) usable during a
        // data session. stty raw + short read; +CSQ: <rssi>,<ber>, rssi 0-31 -> dBm.
        execFileSync('stty', ['-F', atPort, 'raw', '-echo', '115200'], { timeout: 2000 });
        const out = execFileSync('sh', ['-c', `printf 'AT+CSQ\\r' > ${atPort}; timeout 2 head -c 128 ${atPort}`], {
          encoding: 'utf8',
          timeout: 5000,
        });
        const m = out.match(/\+CSQ:\s*(\d+),/);
        if (m) {
          const csq = parseInt(m[1], 10);
          cellular.csq = csq;
          if (csq >= 0 && csq <= 31) cellular.signal_dbm = -113 + 2 * csq;
        }
      } catch {
        /* AT port busy/absent */
      }
    }
    network.cellular = cellular;
  }

  return network;
}

module.exports = { collectPiHealth };
