'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Small persisted runtime settings for the gateway - the knobs the
 * remote config channel (Slice 7) can turn that aren't part of the
 * two schema-validated config domains. First (and so far only) knob:
 * the telemetry batch interval (busduct_edge_config.yaml
 * publish.telemetry.interval_min, default 10).
 *
 * Persisted as one small JSON file inside the outbox directory (which
 * already exists and survives restarts), written atomically.
 */
const DEFAULTS = { telemetry_interval_min: 10 };
const MIN_INTERVAL = 1;
const MAX_INTERVAL = 1440;

class RuntimeSettings {
  constructor({ dir }) {
    this.file = path.join(dir, 'gateway-settings.json');
    this.values = { ...DEFAULTS };
    try {
      const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Number.isInteger(loaded.telemetry_interval_min)) {
        this.values.telemetry_interval_min = Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, loaded.telemetry_interval_min));
      }
    } catch {
      /* first run / unreadable -> defaults */
    }
  }

  get telemetryIntervalMin() {
    return this.values.telemetry_interval_min;
  }

  /** @returns {string|null} error message, or null when applied+persisted */
  setTelemetryIntervalMin(min) {
    if (!Number.isInteger(min) || min < MIN_INTERVAL || min > MAX_INTERVAL) {
      return `telemetry_interval_min must be an integer ${MIN_INTERVAL}-${MAX_INTERVAL} (got ${JSON.stringify(min)})`;
    }
    this.values.telemetry_interval_min = min;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.values));
    fs.renameSync(tmp, this.file);
    return null;
  }
}

module.exports = { RuntimeSettings, DEFAULTS, MIN_INTERVAL, MAX_INTERVAL };
