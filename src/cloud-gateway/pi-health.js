'use strict';

const nodeFs = require('node:fs');
const { execFileSync: nodeExecFileSync } = require('node:child_process');

/**
 * Probe spawns swallow stderr. Every command here is expected to be missing on
 * some machine (vcgencmd off-Pi, iw with no radio, mmcli with no modem), and a
 * probe that prints to Node-RED's log once an hour is worse than useless.
 */
const QUIET = ['ignore', 'pipe', 'ignore'];


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
 *   ram_total_mb   /proc/meminfo MemTotal - the denominator the two above are
 *                  meaningless without on a fleet of 1/2/4/8 GB Pis
 *   uptime_sec     /proc/uptime - a value that RESETS between heartbeats is a
 *                  reboot, which is how an intermittent brown-out announces
 *                  itself (see the 2026-07 firmware note in CLAUDE.md)
 *   load           /proc/loadavg 1/5/15 plus the CPU count to read it against
 *   disk           df -P -k per filesystem. The panel writes the InfluxDB
 *                  historian AND the cloud outbox to one SD card; a full disk
 *                  stops trend recording and stops the outbox holding messages
 *                  through an outage, and nothing else here would show it
 *   clock_synced   timedatectl NTPSynchronized - timestamps are edge_utc, so an
 *                  unsynchronised clock corrupts historian and cloud
 *                  correlation silently
 *   process_rss_mb Node-RED's own RSS - the only signal that catches a slow
 *                  leak; MemAvailable looks fine until the OOM killer arrives
 *   network        active default-route interface (/proc/net/route) classified
 *                  as wifi/ethernet/cellular.
 *                  Wi-Fi: `iw dev <if> link` for SSID/BSSID/freq/signal/bitrate
 *                  (one call, and `iw` ships on Raspberry Pi OS), falling back
 *                  to `iwgetid -r` + /proc/net/wireless.
 *                  Cellular (e.g. the SIM7600G USB modem, usually
 *                  usb0/wwan0/ppp0): ModemManager `mmcli -m any -K` for signal
 *                  percent, operator, access technology and registration;
 *                  if BUSDUCT_MODEM_AT_PORT is set (e.g. /dev/ttyUSB2 - the
 *                  SIM7600's spare AT port, safe to query during a data
 *                  session), AT+CSQ adds rssi in dBm.
 *
 * NOTE: `wifi.ssid`/`bssid` name the site's own network and are published to
 * the cloud in the heartbeat. That is deliberate - diagnosing a marginal link
 * remotely needs to know which AP the panel is on - but it is site information,
 * so it belongs in the same access-controlled place as the rest of the telemetry.
 */
function collectPiHealth({ fs = nodeFs, execFileSync = nodeExecFileSync, env = process.env } = {}) {
  const health = {
    cpu_temp_c: null,
    mac_id: null,
    ram_free_mb: null,
    ram_available_mb: null,
    ram_total_mb: null,
    low_voltage: null,
    uptime_sec: null,
    load: null,
    disk: null,
    clock_synced: null,
    process_rss_mb: null,
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
    const total = kb('MemTotal');
    if (free != null) health.ram_free_mb = Math.round(free / 1024);
    if (available != null) health.ram_available_mb = Math.round(available / 1024);
    // Without the denominator, "2771 MB available" cannot be read as healthy or
    // desperate across a fleet mixing 1/2/4/8 GB Pis.
    if (total != null) health.ram_total_mb = Math.round(total / 1024);
  } catch {
    /* no /proc/meminfo */
  }

  try {
    const out = execFileSync('vcgencmd', ['get_throttled'], { encoding: 'utf8', timeout: 2000, stdio: QUIET });
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

  try {
    // /proc/uptime: "12345.67 98765.43". An uptime that RESETS between two
    // heartbeats is the cheapest possible reboot detector - and an unexplained
    // reboot is exactly the under-voltage signature that cost a week in 2026-07.
    const secs = parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(/\s+/)[0]);
    if (Number.isFinite(secs)) health.uptime_sec = Math.round(secs);
  } catch {
    /* no /proc/uptime */
  }

  try {
    // /proc/loadavg: "0.52 0.48 0.44 1/523 12345". Reported WITH the core count,
    // because "load 3.5" means nothing until you know whether the Pi has 4 cores
    // or 1. Sustained load above cores is when Modbus polls start slipping.
    const cols = fs.readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/);
    const [a1, a5, a15] = cols.slice(0, 3).map(parseFloat);
    if (Number.isFinite(a1)) {
      health.load = { avg1: a1, avg5: a5, avg15: a15, cpus: countCpus(fs) };
    }
  } catch {
    /* no /proc/loadavg */
  }

  health.disk = collectDisk({ execFileSync, paths: diskPaths(env) });

  try {
    // Timestamps are edge_utc: the historian and the cloud both correlate on
    // them, so an unsynchronised clock corrupts trends silently and is invisible
    // from every other signal here.
    const out = execFileSync('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: QUIET,
    }).trim();
    if (out) health.clock_synced = out === 'yes';
  } catch {
    /* not systemd, or timedatectl unavailable */
  }

  try {
    // Node-RED's OWN resident memory - this code runs inside it. A slow leak
    // across a multi-week run shows up here and nowhere else; MemAvailable
    // stays healthy right up until the OOM killer arrives.
    health.process_rss_mb = Math.round(process.memoryUsage().rss / 1048576);
  } catch {
    /* memoryUsage unavailable */
  }

  return health;
}

/** Physical/logical CPUs, for reading `load` against. */
function countCpus(fs) {
  try {
    const n = (fs.readFileSync('/proc/cpuinfo', 'utf8').match(/^processor\s*:/gm) || []).length;
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Filesystems to report. Root by default; a site with the historian or the
 * outbox on a separate partition lists them in BUSDUCT_HEALTH_DISK_PATHS
 * (colon-separated), since the panel cannot know that layout from here.
 */
function diskPaths(env) {
  const extra = String(env.BUSDUCT_HEALTH_DISK_PATHS || '')
    .split(':')
    .map((p) => p.trim())
    .filter(Boolean);
  return [...new Set(['/', ...extra])];
}

/**
 * Free space per filesystem.
 *
 * The most valuable addition here, and the one nothing else covers: this panel
 * writes an InfluxDB historian (7d raw + 90d + ~5y rollups) and the cloud outbox
 * to the same SD card. A full disk stops the historian recording AND stops the
 * outbox holding messages through a link outage - the two things that are
 * supposed to make an offline panel harmless - and neither failure raises
 * anything today.
 *
 * `df -P -k` rather than fs.statfsSync: POSIX output is stable, and statfsSync
 * only arrived in Node 18.15 while the stated floor is Node 18.
 */
function collectDisk({ execFileSync, paths }) {
  const out = [];
  for (const path of paths) {
    try {
      const df = execFileSync('df', ['-P', '-k', path], { encoding: 'utf8', timeout: 3000, stdio: QUIET });
      const row = df.trim().split('\n')[1];
      if (!row) continue;
      // Filesystem 1024-blocks Used Available Capacity Mounted-on
      const cols = row.trim().split(/\s+/);
      const total = parseInt(cols[1], 10);
      const avail = parseInt(cols[3], 10);
      if (!Number.isFinite(total) || !Number.isFinite(avail) || total <= 0) continue;
      out.push({
        path,
        mount: cols[5] ?? null,
        free_mb: Math.round(avail / 1024),
        total_mb: Math.round(total / 1024),
        used_pct: Math.round(((total - avail) / total) * 1000) / 10,
      });
    } catch {
      /* path absent or df unavailable */
    }
  }
  return out.length ? out : null;
}

function classifyInterface(iface) {
  if (/^wl/.test(iface)) return 'wifi';
  if (/^(eth|en)/.test(iface)) return 'ethernet';
  if (/^(ppp|wwan|usb)/.test(iface)) return 'cellular'; // SIM7600G shows up as usb0 (RNDIS), wwan0 (QMI) or ppp0
  return 'unknown';
}

/** 2412 -> "2.4GHz". Bands, not raw MHz, are what a site survey argues about. */
function bandFor(freqMhz) {
  if (!Number.isFinite(freqMhz)) return null;
  if (freqMhz < 3000) return '2.4GHz';
  if (freqMhz < 5926) return '5GHz';
  return '6GHz';
}

/**
 * Wi-Fi association detail. `iw dev <iface> link` is the one call that returns
 * SSID, BSSID, frequency, signal and negotiated bitrate together, and `iw` ships
 * on Raspberry Pi OS; /proc/net/wireless + `iwgetid` is the fallback for images
 * where it does not (wireless-tools is not installed by default on Bookworm).
 */
function collectWifi({ fs, execFileSync, iface }) {
  const wifi = {
    ssid: null, bssid: null, signal_dbm: null,
    link_quality: null, freq_mhz: null, band: null, tx_bitrate_mbps: null,
  };

  try {
    const out = execFileSync('iw', ['dev', iface, 'link'], { encoding: 'utf8', timeout: 3000, stdio: QUIET });
    // "Connected to dc:a6:32:11:22:33 (on wlan0)" - the AP's MAC, not ours
    const bssid = out.match(/Connected to ([0-9a-f:]{17})/i);
    if (bssid) wifi.bssid = bssid[1].toLowerCase();
    // SSIDs may contain spaces, so take the rest of the line rather than a token
    const ssid = out.match(/^\s*SSID:\s*(.+?)\s*$/m);
    if (ssid) wifi.ssid = ssid[1];
    const freq = out.match(/^\s*freq:\s*(\d+)/m);
    if (freq) wifi.freq_mhz = parseInt(freq[1], 10);
    const signal = out.match(/^\s*signal:\s*(-?\d+)/m);
    if (signal) wifi.signal_dbm = parseInt(signal[1], 10);
    const rate = out.match(/^\s*tx bitrate:\s*([\d.]+)/m);
    if (rate) wifi.tx_bitrate_mbps = parseFloat(rate[1]);
  } catch {
    /* no iw, or not associated */
  }

  if (wifi.ssid == null) {
    try {
      const out = execFileSync('iwgetid', ['-r'], { encoding: 'utf8', timeout: 2000, stdio: QUIET }).trim();
      if (out) wifi.ssid = out;
    } catch {
      /* wireless-tools absent */
    }
  }

  try {
    // "wlan0: 0000   54.  -56.  -256 ..." -> link quality, level dBm. Kept even
    // when iw succeeded: link_quality is the driver's own 0-70 figure and has no
    // equivalent in `iw link`.
    const row = fs
      .readFileSync('/proc/net/wireless', 'utf8')
      .split('\n')
      .find((l) => l.trim().startsWith(`${iface}:`));
    if (row) {
      const cols = row.trim().split(/\s+/);
      const quality = parseFloat(cols[2]);
      const level = parseFloat(cols[3]);
      if (Number.isFinite(quality)) wifi.link_quality = quality;
      if (wifi.signal_dbm == null && Number.isFinite(level)) wifi.signal_dbm = level;
    }
  } catch {
    /* wireless stats unavailable */
  }

  wifi.band = bandFor(wifi.freq_mhz);
  return wifi;
}

/**
 * Cellular modem detail. ModemManager's `-K` key-value output is machine-
 * readable and stable across versions; the human output is parsed as a fallback
 * for older mmcli builds.
 *
 * Deliberately only ONE AT command (+CSQ) is sent on the spare port. Each
 * exchange on a modem carrying a live data session is a small risk, and
 * everything else worth knowing - operator, technology, roaming - is already in
 * ModemManager when it is installed.
 */
function collectCellular({ execFileSync, env }) {
  const cellular = {
    signal_percent: null, signal_dbm: null, csq: null,
    operator: null, access_tech: null, registration: null, modem_state: null,
  };

  const mm = (args) => execFileSync('mmcli', args, { encoding: 'utf8', timeout: 3000, stdio: QUIET });
  let parsed = false;
  try {
    const out = mm(['-m', 'any', '-K']);
    const kv = (key) => {
      const m = out.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm'));
      const v = m ? m[1].trim() : null;
      return v && v !== '--' ? v : null;
    };
    const pct = kv('modem\\.generic\\.signal-quality\\.value');
    if (pct != null) cellular.signal_percent = parseInt(pct, 10);
    cellular.operator = kv('modem\\.3gpp\\.operator-name');
    cellular.access_tech = kv('modem\\.generic\\.access-technologies\\.value\\[1\\]');
    cellular.registration = kv('modem\\.3gpp\\.registration-state');
    cellular.modem_state = kv('modem\\.generic\\.state');
    parsed = cellular.signal_percent != null || cellular.operator != null;
  } catch {
    /* no ModemManager, or an mmcli too old for -K */
  }

  if (!parsed) {
    try {
      const out = mm(['-m', 'any']);
      const sig = out.match(/signal quality:\s*'?(\d+)/i);
      if (sig) cellular.signal_percent = parseInt(sig[1], 10);
      const op = out.match(/operator name:\s*'?([^'\n]+?)'?\s*$/im);
      if (op) cellular.operator = op[1].trim();
      const reg = out.match(/registration:\s*'?([a-z-]+)/i);
      if (reg) cellular.registration = reg[1];
    } catch {
      /* no ModemManager at all - AT below may still work */
    }
  }

  const atPort = env.BUSDUCT_MODEM_AT_PORT;
  if (atPort) {
    try {
      // SIM7600G keeps a spare AT port (typically /dev/ttyUSB2) usable during a
      // data session. stty raw + short read; +CSQ: <rssi>,<ber>, rssi 0-31 -> dBm.
      execFileSync('stty', ['-F', atPort, 'raw', '-echo', '115200'], { timeout: 2000, stdio: QUIET });
      const out = execFileSync('sh', ['-c', `printf 'AT+CSQ\\r' > ${atPort}; timeout 2 head -c 128 ${atPort}`], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: QUIET,
      });
      const m = out.match(/\+CSQ:\s*(\d+),/);
      if (m) {
        const csq = parseInt(m[1], 10);
        cellular.csq = csq;
        // 99 is the modem's "not known or not detectable", NOT a strong signal.
        if (csq >= 0 && csq <= 31) cellular.signal_dbm = -113 + 2 * csq;
      }
    } catch {
      /* AT port busy/absent */
    }
  }

  return cellular;
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

  if (type === 'wifi') network.wifi = collectWifi({ fs, execFileSync, iface });
  if (type === 'cellular') network.cellular = collectCellular({ execFileSync, env });

  return network;
}

/**
 * Display summary of collectPiHealth(), for the Device Health dashboard.
 *
 * The heartbeat already carries all of this, but hourly and only when the link
 * is up - which is exactly wrong for the technician standing at the panel
 * wondering why the uplink is marginal. This renders the same snapshot locally,
 * every 30 s, with no internet involved.
 *
 * Pure formatting plus threshold judgement: no I/O, so it is unit-testable and
 * the Node-RED function node calling it stays thin.
 */

/** SD card. InfluxDB compaction needs headroom, so "nearly full" is a real fault, not a nag. */
const DISK_WARN_PCT = 85;
const DISK_CRIT_PCT = 92;
/** Wi-Fi RSSI. Above -67 is a solid link; below -75 retries start dominating. */
const WIFI_GOOD_DBM = -67;
const WIFI_POOR_DBM = -75;
/** Modem signal quality percent, as ModemManager reports it. */
const CELL_GOOD_PCT = 50;
const CELL_POOR_PCT = 25;
/** A Pi throttles at 80 C; 70 is the point at which it is worth looking at. */
const CPU_WARN_C = 70;

function formatUptime(sec) {
  if (!Number.isFinite(sec)) return null;
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const gb = (mb) => (mb >= 1024 ? `${Math.round(mb / 102.4) / 10} GB` : `${mb} MB`);

/** Wi-Fi/cellular headline + detail + a three-step quality judgement. */
function describeUplink(network) {
  if (!network) return { type: null, label: 'No uplink', detail: 'no default route', quality: 'unknown' };

  const { type, interface: iface, wifi, cellular } = network;

  if (type === 'wifi' && wifi) {
    const dbm = wifi.signal_dbm;
    const bits = [];
    if (dbm != null) bits.push(`${dbm} dBm`);
    if (wifi.band) bits.push(wifi.band);
    if (wifi.tx_bitrate_mbps != null) bits.push(`${wifi.tx_bitrate_mbps} Mbps`);
    return {
      type,
      // The SSID is the point of this whole tile: "-58 dBm" does not tell a
      // technician whether the panel is on the right AP.
      label: `Wi-Fi${wifi.ssid ? ` \u00b7 ${wifi.ssid}` : ''}`,
      detail: bits.join(' \u00b7 ') || iface,
      quality: dbm == null ? 'unknown' : dbm >= WIFI_GOOD_DBM ? 'good' : dbm >= WIFI_POOR_DBM ? 'fair' : 'poor',
      ssid: wifi.ssid ?? null,
      signal_dbm: dbm ?? null,
    };
  }

  if (type === 'cellular' && cellular) {
    const pct = cellular.signal_percent;
    const bits = [];
    if (pct != null) bits.push(`${pct}%`);
    if (cellular.signal_dbm != null) bits.push(`${cellular.signal_dbm} dBm`);
    if (cellular.access_tech) bits.push(String(cellular.access_tech).toUpperCase());
    if (cellular.registration === 'roaming') bits.push('ROAMING');
    return {
      type,
      label: `Cellular${cellular.operator ? ` \u00b7 ${cellular.operator}` : ''}`,
      detail: bits.join(' \u00b7 ') || iface,
      quality: pct == null ? 'unknown' : pct >= CELL_GOOD_PCT ? 'good' : pct >= CELL_POOR_PCT ? 'fair' : 'poor',
      operator: cellular.operator ?? null,
      signal_percent: pct ?? null,
    };
  }

  if (type === 'ethernet') {
    // No signal concept - a wired link is up or it is not, and if it were not
    // there would be no default route to have found.
    return { type, label: 'Ethernet', detail: iface, quality: 'good' };
  }

  return { type: type ?? null, label: iface || 'Unknown uplink', detail: '', quality: 'unknown' };
}

function summarizeSystemHealth(health, nowIso = new Date().toISOString()) {
  const h = health || {};
  const uplink = describeUplink(h.network);
  const warnings = [];

  const rootDisk = Array.isArray(h.disk) ? h.disk.find((d) => d.path === '/') || h.disk[0] : null;
  if (rootDisk) {
    if (rootDisk.used_pct >= DISK_CRIT_PCT) {
      // Both the historian and the outbox live here; this is not cosmetic.
      warnings.push(`Disk ${rootDisk.used_pct}% full - historian and outbox at risk`);
    } else if (rootDisk.used_pct >= DISK_WARN_PCT) {
      warnings.push(`Disk ${rootDisk.used_pct}% full`);
    }
  }
  if (h.clock_synced === false) warnings.push('Clock not synchronised - timestamps unreliable');
  if (h.cpu_temp_c != null && h.cpu_temp_c >= CPU_WARN_C) warnings.push(`CPU ${h.cpu_temp_c} \u00b0C`);
  if (h.load && h.load.cpus && h.load.avg5 > h.load.cpus) {
    warnings.push(`Load ${h.load.avg5} on ${h.load.cpus} cores`);
  }
  if (uplink.quality === 'poor') warnings.push(`Weak ${uplink.type === 'wifi' ? 'Wi-Fi' : 'signal'} - ${uplink.detail}`);

  return {
    uplink,
    cpu_temp: h.cpu_temp_c != null ? `${h.cpu_temp_c} \u00b0C` : null,
    ram: h.ram_available_mb != null && h.ram_total_mb != null
      ? `${gb(h.ram_available_mb)} free of ${gb(h.ram_total_mb)}`
      : null,
    disk: rootDisk ? `${gb(rootDisk.free_mb)} free \u00b7 ${rootDisk.used_pct}% used` : null,
    uptime: formatUptime(h.uptime_sec),
    load: h.load ? `${h.load.avg1} / ${h.load.avg5} / ${h.load.avg15}${h.load.cpus ? ` (${h.load.cpus} cores)` : ''}` : null,
    warnings,
    ok: warnings.length === 0,
    updatedTs: nowIso,
  };
}

module.exports = { collectPiHealth, summarizeSystemHealth, describeUplink };
