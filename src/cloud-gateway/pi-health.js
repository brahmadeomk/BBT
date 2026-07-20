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
 */
function collectPiHealth({ fs = nodeFs, execFileSync = nodeExecFileSync } = {}) {
  const health = {
    cpu_temp_c: null,
    mac_id: null,
    ram_free_mb: null,
    ram_available_mb: null,
    low_voltage: null,
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

module.exports = { collectPiHealth };
