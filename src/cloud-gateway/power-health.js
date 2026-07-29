'use strict';

/**
 * Local Pi power/throttling alarm (2026-07-29).
 *
 * WHY THIS EXISTS: the "Nano stops transmitting after some hours" fault chased
 * through 2026-07-22..29 turned out to be Raspberry Pi UNDER-VOLTAGE, not
 * firmware. The panel had been sampling exactly the right signal since Slice 6
 * (`collectPiHealth().low_voltage`, from `vcgencmd get_throttled`) — but only
 * inside the CLOUD heartbeat, with no local surface. The one diagnostic that
 * would have named the fault in minutes was invisible on the panel, so it was
 * instead diagnosed (wrongly) from source code. This turns that signal into a
 * local SYSTEM alarm + HMI tile, so a brown-out announces itself.
 *
 * Pure and state-injected: the caller owns the previous state (a Node-RED
 * function node keeps it in flow context), so this is fully unit-testable with
 * no clock, no fs and no vcgencmd.
 *
 * Semantics:
 *  - RAISE immediately on the first bad sample. Power faults are urgent and the
 *    `now` bits are already momentary — debouncing the raise would hide exactly
 *    the short brown-outs that wedge a USB device.
 *  - CLEAR only after `clearSamples` consecutive good samples, so a supply
 *    hovering at the threshold doesn't flap the alarm.
 *  - Under-voltage is CRITICAL; throttling *without* under-voltage is WARNING
 *    (that can be thermal rather than supply-related).
 */

const POWER_KEY = 'SYSTEM|PI|POWER';
const DEFAULT_CLEAR_SAMPLES = 3;

/** @returns {{active:boolean, goodStreak:number, level:string|null, supported:boolean}} */
function initialState() {
  return { active: false, goodStreak: 0, level: null, supported: false };
}

function describe(lv) {
  const raw = lv.raw ? ` (vcgencmd throttled=${lv.raw})` : '';
  if (lv.now) {
    return `Raspberry Pi UNDER-VOLTAGE detected${raw} - check the PSU and cable. ` +
      'A sagging supply can wedge USB devices (the Nano link) and corrupt the SD card.';
  }
  return `Raspberry Pi is being THROTTLED${raw} - check supply and cooling.`;
}

/**
 * @param {object|null} health - a collectPiHealth() snapshot
 * @param {object} [prev] - previous state from this function
 * @param {object} [opts]
 * @param {number} [opts.clearSamples=3] - consecutive good samples before clearing
 * @returns {{alarm: object|null, state: object, status: object}}
 */
function derivePowerAlarm(health, prev = initialState(), { clearSamples = DEFAULT_CLEAR_SAMPLES } = {}) {
  const lv = health && health.low_voltage;
  const state = { ...initialState(), ...prev };

  // Not a Pi / vcgencmd unavailable -> nothing to assert either way. Never
  // fabricate a "healthy" verdict from a missing probe (the 0-as-no-data trap).
  if (!lv) {
    state.supported = false;
    return { alarm: null, state, status: { supported: false, ok: null, text: 'power: unknown (no vcgencmd)' } };
  }
  state.supported = true;

  const bad = Boolean(lv.now || lv.throttled_now);
  const level = lv.now ? 'CRITICAL' : 'WARNING';

  let alarm = null;
  if (bad) {
    state.goodStreak = 0;
    // Re-raise if the severity escalated (throttling -> under-voltage).
    if (!state.active || state.level !== level) {
      alarm = {
        action: 'raise',
        key: POWER_KEY,
        level,
        description: describe(lv),
        raw: lv.raw ?? null,
        under_voltage: Boolean(lv.now),
        throttled: Boolean(lv.throttled_now),
      };
      state.active = true;
      state.level = level;
    }
  } else {
    state.goodStreak = (state.goodStreak || 0) + 1;
    if (state.active && state.goodStreak >= clearSamples) {
      alarm = { action: 'clear', key: POWER_KEY, description: 'Raspberry Pi power back to normal' };
      state.active = false;
      state.level = null;
    }
  }

  return { alarm, state, status: summarizePower(health, state) };
}

/** Compact view for the Device Health HMI tile. */
function summarizePower(health, state = initialState()) {
  const lv = health && health.low_voltage;
  if (!lv) return { supported: false, ok: null, text: 'power: unknown (no vcgencmd)' };
  const ok = !(lv.now || lv.throttled_now);
  const flags = [];
  if (lv.now) flags.push('UNDER-VOLTAGE NOW');
  if (lv.throttled_now) flags.push('THROTTLED NOW');
  // The since-boot bits are the ones that catch a fault that already happened
  // and recovered - exactly the intermittent case that is otherwise invisible.
  if (lv.since_boot) flags.push('under-voltage since boot');
  if (lv.throttled_since_boot) flags.push('throttled since boot');
  return {
    supported: true,
    ok,
    under_voltage_now: Boolean(lv.now),
    throttled_now: Boolean(lv.throttled_now),
    under_voltage_since_boot: Boolean(lv.since_boot),
    throttled_since_boot: Boolean(lv.throttled_since_boot),
    raw: lv.raw ?? null,
    alarm_active: Boolean(state.active),
    text: flags.length ? `power: ${flags.join(', ')}` : 'power: OK',
  };
}

module.exports = { derivePowerAlarm, summarizePower, initialState, POWER_KEY, DEFAULT_CLEAR_SAMPLES };
