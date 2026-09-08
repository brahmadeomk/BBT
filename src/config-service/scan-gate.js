'use strict';

/**
 * Whether a Nano frame may proceed into the measurement path while a slave
 * address scan is running.
 *
 * THE DEFECT THIS REPLACES (found live 2026-09-08). "function 14" on
 * `modbusMaster_V2` was:
 *
 *     if (flow.get("scanActive") != 1) { return msg }
 *
 * — a fail-CLOSED gate in front of everything: ProcessLogic, the Alarm Manager,
 * the historian, the BMS image, the cloud gateway and the diagnostics table all
 * sit downstream of it. `scanActive` is set by the Start Scan button and cleared
 * in exactly one place: when the scan's frame counter reaches `scanTotal` (127).
 *
 * Every one of these leaves it latched at 1 forever:
 *
 *  - the counter only starts once a frame with `id == 1` has been seen, so if
 *    address 1 never answers, it never begins;
 *  - a single dropped frame leaves the count short of 127;
 *  - the scan writes its job through the LEGACY paraRaw path, which is bus1
 *    only - on a panel whose Nano and sensors are on bus2 the scan can never
 *    complete;
 *  - Node-RED restarting mid-scan: flow context is localfilesystem-backed here,
 *    so the flag SURVIVES while the scan that would clear it does not.
 *
 * The panel then looks entirely healthy — HMI up, BMS serving, heartbeat
 * advancing — while monitoring nothing at all, with no alarm and no indication,
 * across reboots. On a fire-safety monitor that is the worst possible failure
 * shape, and it is the third instance in this project of a flag whose lifetime
 * outlives the thing that would reset it (stale blacklist alarm, stale exclude
 * set, now this).
 *
 * THREE PROPERTIES, all of which the old gate lacked:
 *
 *  1. **Bounded.** A scan that has run past `deadlineMs` releases the gate and
 *     clears the flag. A scan is a foreground operation an operator waits for;
 *     it cannot legitimately last minutes.
 *  2. **Scoped.** The scan only ever touches bus1, so traffic from any other
 *     segment is never gated. Blocking bus2 for a bus1 scan was pure collateral.
 *  3. **Fails open on missing information.** No start time — a scan begun before
 *     this code, or context lost — is treated as expired, not as "just started".
 *     Measurement resuming is always the safer error.
 */

/** A scan of 127 addresses at a 500 ms worst-case timeout is ~64 s. */
const DEFAULT_DEADLINE_MS = 120000;

/** The legacy scan job is written to bus1's serial port only. */
const SCANNED_BUS = 'bus1';

/**
 * @param {object} opts
 * @param {*} opts.scanActive - flow `scanActive` (1 while scanning)
 * @param {number|null} opts.startedAt - flow `scanStartedAt`, epoch ms
 * @param {number} opts.nowMs
 * @param {string|null} [opts.busId] - msg.bus_id; absent means bus1
 * @param {number} [opts.deadlineMs]
 * @returns {{pass: boolean, clear: boolean, reason: string}}
 *   `pass` - forward the frame; `clear` - reset scanActive as a side effect
 */
function evaluateScanGate({ scanActive, startedAt, nowMs, busId = null, deadlineMs = DEFAULT_DEADLINE_MS }) {
  if (Number(scanActive) !== 1) return { pass: true, clear: false, reason: 'no scan' };

  // Scoped: a bus1 scan says nothing about any other segment.
  const bus = busId || SCANNED_BUS;
  if (bus !== SCANNED_BUS) return { pass: true, clear: false, reason: `scan is ${SCANNED_BUS}-only` };

  // Fails open on missing information.
  if (!Number.isFinite(startedAt)) {
    return { pass: true, clear: true, reason: 'scan flag set with no start time - releasing' };
  }

  const ageMs = nowMs - startedAt;
  if (ageMs > deadlineMs) {
    return { pass: true, clear: true, reason: `scan exceeded ${Math.round(deadlineMs / 1000)}s - releasing` };
  }

  return { pass: false, clear: false, reason: `scan active ${Math.round(ageMs / 1000)}s` };
}

module.exports = { evaluateScanGate, DEFAULT_DEADLINE_MS, SCANNED_BUS };
