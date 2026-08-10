'use strict';

/**
 * Per-segment USB recovery decisions for the flow's RECOVERY CONTROLLER.
 *
 * Each RS-485 segment is its own Nano on its own USB port (Slice 10
 * two-segment), so a wedged bus2 Nano must be power-cycled without touching
 * bus1's live polling: separate COMM alarm keys, separate retry/cooldown
 * state, separate `uhubctl` locations.
 *
 * Pure and timing-injected — the function node supplies the current active
 * alarms, the persisted state, the clock, and the configured hub locations.
 *
 * The escalation ladder per bus (unchanged from the single-bus original):
 *   COMM alarm appears        -> note the time, do nothing
 *   still there after 90 s    -> power-cycle that bus's hub port
 *   60 s cooldown between attempts, 3 attempts max
 *   after the 3rd             -> one email, then stop
 *   alarm clears              -> state resets, ladder starts over
 */

// bus1 keeps the original COMM alarm key and the original RESET_n instanceId
// so its alarm identity, history and ACK state are continuous across this
// change. Its hub port stays hardcoded in the exec node (`-l 1-1`); only a
// second segment needs its location supplied, because that is site wiring.
const BUSES = [
  { busId: 'bus1', commKey: 'SYSTEM|MODULE|COMM_FAILURE', resetSubject: 'MODULE', needsPort: false },
  { busId: 'bus2', commKey: 'SYSTEM|BUS2|COMM_FAILURE', resetSubject: 'BUS2', needsPort: true },
];

const FIRST_RESET_DELAY_MS = 90_000;
const COOLDOWN_MS = 60_000;
const MAX_RETRIES = 3;

// A uhubctl location: "1-1", "3-2", "1-1.4". The value reaches a root shell by
// string concatenation in the exec node, so anything else is refused rather
// than run — a typo in the environment file must not become a command.
const PORT_RE = /^[0-9]+(-[0-9]+)*(\.[0-9]+)*$/;

function blankState() {
  return { firstSeen: 0, lastReset: 0, retries: 0, emailSent: false, warned: false };
}

/**
 * @param {object} args
 * @param {Array<{instanceId: string}>} args.alarms - currently active alarms
 * @param {object} args.states - persisted per-bus state (from node context)
 * @param {number} args.nowMs
 * @param {object} [args.ports] - { [busId]: uhubctl location }, for buses that need one
 * @param {Array} [args.buses] - override the bus table (tests)
 * @returns {{states: object, resets: Array<{busId: string, port: string|null}>,
 *   alarmEvents: Array<object>, emails: Array<object>, warnings: string[], errors: string[]}}
 */
function planRecovery({ alarms = [], states = {}, nowMs, ports = {}, buses = BUSES }) {
  const next = { ...states };
  const resets = [];
  const alarmEvents = [];
  const emails = [];
  const warnings = [];
  const errors = [];

  for (const bus of buses) {
    const state = { ...blankState(), ...(next[bus.busId] || {}) };
    const commActive = alarms.some((a) => a && a.instanceId === bus.commKey);

    // Recovered (or never failed): forget everything, so the next episode
    // gets a full ladder rather than inheriting a spent retry count.
    if (!commActive) {
      next[bus.busId] = blankState();
      continue;
    }

    if (!state.firstSeen) {
      state.firstSeen = nowMs;
      next[bus.busId] = state;
      continue;
    }

    if (nowMs - state.firstSeen < FIRST_RESET_DELAY_MS) {
      next[bus.busId] = state;
      continue;
    }

    if (state.retries >= MAX_RETRIES) {
      if (!state.emailSent) {
        state.emailSent = true;
        emails.push({
          subject: `🚨 USB Module Failure (${bus.busId})`,
          body: `Communication module on ${bus.busId} failed after ${MAX_RETRIES} attempts.\nTime: ${new Date(nowMs).toISOString()}`,
        });
      }
      next[bus.busId] = state;
      continue;
    }

    if (nowMs - state.lastReset < COOLDOWN_MS) {
      next[bus.busId] = state;
      continue;
    }

    let port = null;
    if (bus.needsPort) {
      port = ports[bus.busId] || null;
      if (!port) {
        // Nothing to power-cycle. Say so once per episode rather than every
        // tick; the COMM alarm itself is already in front of the operator.
        if (!state.warned) {
          state.warned = true;
          warnings.push(`${bus.busId} COMM failure: no hub port configured, cannot power-cycle its Nano`);
        }
        next[bus.busId] = state;
        continue;
      }
      if (!PORT_RE.test(port)) {
        errors.push(`${bus.busId} hub port "${port}" is not a uhubctl location - refusing to run it`);
        next[bus.busId] = state;
        continue;
      }
    }

    state.retries += 1;
    state.lastReset = nowMs;
    next[bus.busId] = state;

    resets.push({ busId: bus.busId, port });
    alarmEvents.push({
      instanceId: `SYSTEM|${bus.resetSubject}|RESET_${state.retries}`,
      category: 'SYSTEM',
      joint_id: 'SYSTEM',
      alarm_type: 'COMM_RESET',
      level: 'INFO',
      description: `USB reset attempt ${state.retries} on ${bus.busId}`,
    });
  }

  return { states: next, resets, alarmEvents, emails, warnings, errors };
}

module.exports = {
  BUSES,
  PORT_RE,
  FIRST_RESET_DELAY_MS,
  COOLDOWN_MS,
  MAX_RETRIES,
  blankState,
  planRecovery,
};
