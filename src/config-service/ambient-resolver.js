'use strict';

/**
 * Ambient outlier rejection + fallback (Slice 10 scale hardening).
 *
 * The 3-level ambient chain (R14: joint -> zone -> panel) decides WHICH
 * ambient sensor a joint uses for ΔT. This adds runtime robustness on the
 * VALUE: with 10 ambient sensors on a panel, a single failed or drifting
 * sensor must not silently poison ΔT for every joint that references it.
 *
 * Resolution order for a joint's effective ambient value:
 *   1. its configured ambient reading, if within the plausibility band;
 *   2. else the MEDIAN of the plausible ambient readings in the same zone;
 *   3. else the MEDIAN of all plausible ambient readings on the panel;
 *   4. else null (no usable ambient — ΔT can't be computed).
 *
 * Pure and side-effect-free; ProcessLogic passes in the live ambient
 * readings and the zone-of-each-ambient map.
 */

const DEFAULT_BAND = { min: -20, max: 80 }; // deg C: an electrical panel's ambient lives well inside this

function inBand(v, band) {
  return typeof v === 'number' && Number.isFinite(v) && v >= band.min && v <= band.max;
}

function median(nums) {
  const s = nums.slice().sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/**
 * @param {object} opts
 * @param {string|number|null} opts.configuredId - the joint's resolved ambient sensor id (R14 chain), or null
 * @param {string|null} opts.zoneId - the joint's zone
 * @param {Object<string,number>} opts.readings - live ambient readings keyed by ambient sensor id
 * @param {Object<string,string>} [opts.zoneOf] - zone id of each ambient sensor id
 * @param {{min:number,max:number}} [opts.band] - plausibility band
 * @returns {{val: number|null, source: 'configured'|'zone_median'|'panel_median'|'none', ambient_id?: string|number, count?: number, rejected: boolean}}
 */
function resolveAmbient({ configuredId, zoneId, readings = {}, zoneOf = {}, band = DEFAULT_BAND }) {
  const key = (id) => String(id);
  const plausible = (id) => inBand(readings[key(id)], band);

  // 1. configured sensor, if its reading is plausible
  if (configuredId != null && plausible(configuredId)) {
    return { val: readings[key(configuredId)], source: 'configured', ambient_id: configuredId, rejected: false };
  }

  // configured existed but is implausible/missing -> we're falling back
  const rejected = configuredId != null && !plausible(configuredId);

  // 2. zone median of the plausible ambients in this joint's zone
  if (zoneId != null) {
    const zoneVals = Object.keys(readings)
      .filter((id) => zoneOf[id] != null && String(zoneOf[id]) === String(zoneId) && plausible(id))
      .map((id) => readings[id]);
    if (zoneVals.length) {
      return { val: median(zoneVals), source: 'zone_median', count: zoneVals.length, rejected };
    }
  }

  // 3. panel median of all plausible ambients
  const panelVals = Object.keys(readings).filter((id) => plausible(id)).map((id) => readings[id]);
  if (panelVals.length) {
    return { val: median(panelVals), source: 'panel_median', count: panelVals.length, rejected };
  }

  // 4. nothing usable
  return { val: null, source: 'none', rejected };
}

module.exports = { resolveAmbient, median, inBand, DEFAULT_BAND };
