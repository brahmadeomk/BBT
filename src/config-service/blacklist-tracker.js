'use strict';

/**
 * Device blacklisting & recovery (Slice 9) — the pure decision core.
 * Full design: docs/blacklist-recovery-spec.md.
 *
 * Consumes per-slave Modbus read results (ok/err) off the Nano's response
 * stream and decides which slaves to blacklist (temporarily remove from
 * the scan so one dead device can't tax every cycle) and when to probe
 * them for recovery. Cloud-agnostic, timing-injected (every method takes
 * `nowMs`), no I/O — the Node-RED handler feeds it results/ticks and acts
 * on the events (recompile the Nano job, raise/clear the SYSTEM alarm,
 * audit). Keyed by the stable logical `slave_id`, not the Modbus unit
 * address, so it survives address changes.
 *
 * Per-slave lifecycle:
 *
 *   active ──(N consecutive failures)──▶ blacklisted ──(probe due)──▶ probing
 *     ▲                                                                   │
 *     └──────────────(M consecutive good reads while probing)────────────┘
 *   probing ──(any failed read)──▶ blacklisted (backoff bumped)
 *
 * - `blacklisted` slaves are OMITTED from the compiled job (not polled).
 * - `probing` slaves ARE polled (re-included) and must return M consecutive
 *   good reads to restore — hysteresis so a flapping device (J28) that fails
 *   every other probe never restores and never flaps the scan.
 * - Backoff between probe attempts grows 30s → 1m → 2m → 5m (capped).
 */

const DEFAULTS = {
  blacklistAfterFailures: 3,
  probeBackoffS: [30, 60, 120, 300],
  restoreAfterGoodReads: 3,
};

class BlacklistTracker {
  constructor(opts = {}) {
    this.blacklistAfterFailures = opts.blacklistAfterFailures ?? DEFAULTS.blacklistAfterFailures;
    this.probeBackoffS = opts.probeBackoffS ?? DEFAULTS.probeBackoffS.slice();
    this.restoreAfterGoodReads = opts.restoreAfterGoodReads ?? DEFAULTS.restoreAfterGoodReads;
    this.state = new Map(); // slaveId -> { status, fails, goods, backoffIndex, nextProbeMs, blacklistedAtMs }
    // busId -> epoch ms of the most recent frame from that segment. Recorded
    // here rather than in the flow because the flow's silence watchdogs keep
    // their stamp in FLOW context on modbusMaster_V2, which the Cloud Gateway
    // tab cannot read. Derived from the slave the frame came from, not from
    // msg.bus_id: only bus2 frames are tagged, and unit addresses are unique
    // panel-wide, so the slave resolves the segment exactly either way.
    this.busSeen = {};
  }

  /** Record that a segment produced a frame. */
  recordBusSeen(busId, nowMs) {
    if (busId) this.busSeen[busId] = nowMs;
  }

  _slot(slaveId) {
    let s = this.state.get(slaveId);
    if (!s) {
      s = { status: 'active', fails: 0, goods: 0, backoffIndex: -1, nextProbeMs: null, blacklistedAtMs: null };
      this.state.set(slaveId, s);
    }
    return s;
  }

  _backoffMs(index) {
    const i = Math.max(0, Math.min(index, this.probeBackoffS.length - 1));
    return this.probeBackoffS[i] * 1000;
  }

  /**
   * Record one read result for a slave.
   * @returns {null | {type, slaveId, ...}} an event when the slave's status changed
   */
  recordResult(slaveId, ok, nowMs) {
    const s = this._slot(slaveId);

    if (s.status === 'active') {
      if (ok) {
        s.fails = 0;
        return null;
      }
      s.fails += 1;
      if (s.fails >= this.blacklistAfterFailures) {
        s.status = 'blacklisted';
        s.goods = 0;
        s.backoffIndex = 0;
        s.blacklistedAtMs = nowMs;
        s.nextProbeMs = nowMs + this._backoffMs(0);
        return { type: 'blacklisted', slaveId, at: nowMs, failures: s.fails, nextProbeMs: s.nextProbeMs };
      }
      return null;
    }

    if (s.status === 'probing') {
      if (ok) {
        s.goods += 1;
        if (s.goods >= this.restoreAfterGoodReads) {
          s.status = 'active';
          s.fails = 0;
          s.goods = 0;
          s.backoffIndex = -1;
          s.nextProbeMs = null;
          s.blacklistedAtMs = null;
          return { type: 'restored', slaveId, at: nowMs };
        }
        return null;
      }
      // a bad read during probing: back to blacklisted with a longer backoff
      s.goods = 0;
      s.backoffIndex = Math.min(s.backoffIndex + 1, this.probeBackoffS.length - 1);
      s.status = 'blacklisted';
      s.nextProbeMs = nowMs + this._backoffMs(s.backoffIndex);
      return { type: 'probe_failed', slaveId, at: nowMs, nextProbeMs: s.nextProbeMs, backoffS: this.probeBackoffS[s.backoffIndex] };
    }

    // status 'blacklisted' — not polled; a stray result is ignored.
    return null;
  }

  /**
   * Promote any blacklisted slave whose probe is due to `probing` (so the
   * next compiled job re-includes it). Call periodically.
   * @returns {Array<{type:'probing', slaveId, at}>} events (empty if nothing due)
   */
  tick(nowMs) {
    const events = [];
    for (const [slaveId, s] of this.state) {
      if (s.status === 'blacklisted' && s.nextProbeMs != null && nowMs >= s.nextProbeMs) {
        s.status = 'probing';
        s.goods = 0;
        events.push({ type: 'probing', slaveId, at: nowMs });
      }
    }
    return events;
  }

  /** Slaves currently removed from the scan (blacklisted, not probing). */
  blacklistedSlaveIds() {
    return [...this.state].filter(([, s]) => s.status === 'blacklisted').map(([id]) => id);
  }

  /** Configured ids minus the blacklisted ones (probing slaves are included). */
  activeSlaveIds(configuredIds) {
    return configuredIds.filter((id) => (this.state.get(id)?.status ?? 'active') !== 'blacklisted');
  }

  /** True only when the slave is fully trusted (active) — not blacklisted or mid-probe. */
  isMeasurable(slaveId) {
    return (this.state.get(slaveId)?.status ?? 'active') === 'active';
  }

  status(slaveId) {
    return this.state.get(slaveId)?.status ?? 'active';
  }

  /** Serializable view for the HMI / audit trail. */
  snapshot() {
    const out = {};
    for (const [slaveId, s] of this.state) {
      out[slaveId] = {
        status: s.status,
        fails: s.fails,
        goods: s.goods,
        backoffIndex: s.backoffIndex,
        nextProbeMs: s.nextProbeMs,
        blacklistedAtMs: s.blacklistedAtMs,
      };
    }
    return out;
  }
}

module.exports = { BlacklistTracker, DEFAULTS };
