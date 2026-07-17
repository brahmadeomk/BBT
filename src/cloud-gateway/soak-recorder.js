'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Soak-run evidence recorder (combined Slice 5+6 soak). Enabled by
 * setting BUSDUCT_SOAK_LOG=<dir> in Node-RED's environment; completely
 * inert otherwise. While enabled, the gateway appends JSON-lines files
 * capturing both ends of the pipeline so tools/soak-verify.js can
 * mechanically check the soak acceptance criteria afterwards:
 *
 *   kpi.jsonl          every joint KPI sample entering the batcher (ground truth)
 *   alarm-taps.jsonl   every active/cleared alarm tap delivery (ground truth)
 *   flush-status.jsonl the status object of every telemetry flush
 *   published.jsonl    every message actually accepted by the transport (with drain time)
 *   connection.jsonl   every transport connect/disconnect transition
 *
 * Volumes are Pi-friendly: at ~1-2 KPI samples/sec a 24h run is a few
 * hundred thousand lines / tens of MB. appendFileSync per line keeps
 * the recorder crash-safe (each line either fully lands or doesn't).
 * Recorder errors are swallowed - evidence collection must never take
 * down the gateway.
 */
class SoakRecorder {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  _append(file, obj) {
    try {
      fs.appendFileSync(path.join(this.dir, file), JSON.stringify(obj) + '\n');
    } catch {
      /* never disrupt the gateway for evidence collection */
    }
  }

  kpi(sample) {
    this._append('kpi.jsonl', { recorded_at: new Date().toISOString(), sample });
  }

  alarmTap(kind, alarms) {
    this._append('alarm-taps.jsonl', { recorded_at: new Date().toISOString(), kind, alarms });
  }

  flushStatus(status) {
    this._append('flush-status.jsonl', { recorded_at: new Date().toISOString(), ...status });
  }

  published(topic, payload, qos) {
    this._append('published.jsonl', { published_at: new Date().toISOString(), topic, qos, payload });
  }

  connection(connected) {
    this._append('connection.jsonl', { at: new Date().toISOString(), connected });
  }
}

/** Returns a SoakRecorder when BUSDUCT_SOAK_LOG is set, else null. */
function createSoakRecorder(env = process.env) {
  return env.BUSDUCT_SOAK_LOG ? new SoakRecorder(env.BUSDUCT_SOAK_LOG) : null;
}

/**
 * Decorates a transport so every successful publish is recorded with
 * its drain time (published_at vs the payload's own edge timestamp is
 * what proves hold-and-drain behavior during link pulls). Everything
 * else passes through; the loopback's `published` record stays
 * reachable for the flush status.
 */
function wrapTransportForSoak(transport, recorder) {
  if (!recorder) return transport;
  return {
    publish: (topic, payload, qos) =>
      transport.publish(topic, payload, qos).then((result) => {
        recorder.published(topic, payload, qos);
        return result;
      }),
    subscribe: (topic, handler) => transport.subscribe(topic, handler),
    ...(typeof transport.subscribeAsync === 'function'
      ? { subscribeAsync: (topic, handler) => transport.subscribeAsync(topic, handler) }
      : {}),
    isConnected: () => transport.isConnected(),
    onConnectionChange: (cb) => transport.onConnectionChange(cb),
    get published() {
      return transport.published;
    },
    ...(typeof transport.close === 'function' ? { close: () => transport.close() } : {}),
    ...(typeof transport.setConnected === 'function' ? { setConnected: (c) => transport.setConnected(c) } : {}),
  };
}

module.exports = { SoakRecorder, createSoakRecorder, wrapTransportForSoak };
