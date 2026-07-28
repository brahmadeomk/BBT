'use strict';

/**
 * Ambient outlier rejection + fallback (Slice 10 scale hardening).
 *
 * The 3-level ambient chain (R14: joint -> zone -> panel) decides WHICH
 * ambient sensor a joint uses for ΔT. This adds runtime robustness on the
 * VALUE: with 10 ambient sensors on a panel, a single failed or drifting
 * sensor must not silently poison ΔT for every joint that references it.
 *
 * A reading counts as usable only if it is:
 *   - within the plausibility band, AND
 *   - not stale (fresher than maxAgeSec, when age is supplied), AND
 *   - not flagged with a non-OK sensor status (when status is supplied).
 * The last two matter because a DEAD sensor commonly reads a plausible-looking
 * value (e.g. 0 °C, which sits inside the band) while its reads are failing —
 * a band check alone would accept it and compute ΔT against 0. (Live 2026-07-28:
 * an unplugged ambient read 0 °C for ~3 min and raised false ΔT alarms until
 * staleness + status filtering were added.)
 *
 * Resolution order for a joint's effective ambient value:
 *   1. its configured ambient reading, if usable;
 *   2. else the MEDIAN of the usable ambient readings in the same zone;
 *   3. else the MEDIAN of all usable ambient readings on the panel;
 *   4. else null (no usable ambient — ΔT is NOT computed, rather than fabricated).
 *
 * Pure and side-effect-free; ProcessLogic passes in the live ambient
 * readings (value + age + status) and the zone-of-each-ambient map.
 *
 * A reading in `readings` may be a plain number (legacy/tests) or an object
 * `{ val, age_sec, status }`. Plain numbers have no age/status, so with the
 * default `maxAgeSec: null` they behave exactly as before this change.
 */

const DEFAULT_BAND = { min: -20, max: 80 }; // deg C: an electrical panel's ambient lives well inside this
const DEFAULT_MAX_AGE_SEC = 60; // ProcessLogic passes this; a good ambient updates far faster

function inBand(v, band) {
  return typeof v === 'number' && Number.isFinite(v) && v >= band.min && v <= band.max;
}

function median(nums) {
  const s = nums.slice().sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** The numeric value of a reading, whether it's a bare number or {val,...}. */
function readingValue(r) {
  if (typeof r === 'number') return r;
  if (r && typeof r === 'object') return r.val;
  return undefined;
}

/** Whether a reading is fresh + healthy + in-band and may be trusted. */
function isUsable(r, band, maxAgeSec) {
  if (!inBand(readingValue(r), band)) return false;
  if (r && typeof r === 'object') {
    if (r.status != null && String(r.status).trim().toUpperCase() !== 'OK') return false;
    if (maxAgeSec != null && Number.isFinite(r.age_sec) && r.age_sec > maxAgeSec) return false;
  }
  return true;
}

/**
 * @param {object} opts
 * @param {string|number|null} opts.configuredId - the joint's resolved ambient sensor id (R14 chain), or null
 * @param {string|null} opts.zoneId - the joint's zone
 * @param {Object<string, number|{val:number,age_sec?:number,status?:string}>} opts.readings - live ambient readings keyed by ambient sensor id
 * @param {Object<string,string>} [opts.zoneOf] - zone id of each ambient sensor id
 * @param {{min:number,max:number}} [opts.band] - plausibility band
 * @param {number|null} [opts.maxAgeSec] - reject readings older than this (seconds); null disables the age check
 * @returns {{val: number|null, source: 'configured'|'zone_median'|'panel_median'|'none', ambient_id?: string|number, count?: number, rejected: boolean}}
 */
function resolveAmbient({ configuredId, zoneId, readings = {}, zoneOf = {}, band = DEFAULT_BAND, maxAgeSec = null }) {
  const key = (id) => String(id);
  const usable = (id) => isUsable(readings[key(id)], band, maxAgeSec);

  // 1. configured sensor, if its reading is usable
  if (configuredId != null && usable(configuredId)) {
    return { val: readingValue(readings[key(configuredId)]), source: 'configured', ambient_id: configuredId, rejected: false };
  }

  // configured existed but is unusable (implausible / stale / faulted / missing) -> we're falling back
  const rejected = configuredId != null && !usable(configuredId);

  // 2. zone median of the usable ambients in this joint's zone
  if (zoneId != null) {
    const zoneVals = Object.keys(readings)
      .filter((id) => zoneOf[id] != null && String(zoneOf[id]) === String(zoneId) && usable(id))
      .map((id) => readingValue(readings[id]));
    if (zoneVals.length) {
      return { val: median(zoneVals), source: 'zone_median', count: zoneVals.length, rejected };
    }
  }

  // 3. panel median of all usable ambients
  const panelVals = Object.keys(readings).filter((id) => usable(id)).map((id) => readingValue(readings[id]));
  if (panelVals.length) {
    return { val: median(panelVals), source: 'panel_median', count: panelVals.length, rejected };
  }

  // 4. nothing usable
  return { val: null, source: 'none', rejected };
}

module.exports = { resolveAmbient, median, inBand, isUsable, readingValue, DEFAULT_BAND, DEFAULT_MAX_AGE_SEC };
