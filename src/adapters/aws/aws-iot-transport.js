'use strict';

const fs = require('node:fs');

/** Dials past this many failures alternate with/without the Last Will - see _willFor(). */
const LWT_FALLBACK_AFTER_ATTEMPTS = 3;

/**
 * AWS IoT Core transport (Slice 6) implementing the cloud-agnostic
 * transport interface from src/cloud-gateway/transport.js:
 *   publish(topic, payload, qos) -> Promise<void>
 *   subscribe(topic, handler)
 *   isConnected() -> boolean
 *   onConnectionChange(callback)
 *
 * Built on mqtt.js (pure JS - no native aws-crt build on the Pi, no
 * AWS SDK anywhere, satisfying the cloud-agnostic rule by
 * construction). AWS IoT Core specifics live in the *configuration*,
 * not the protocol: TLS 1.2 mutual auth on 8883 with the device
 * cert/key + Amazon root CA, thing name as client ID, 300s keep-alive
 * (connection-minute cost), LWT, and exponential reconnect backoff
 * with full jitter (2..300s per busduct_edge_config.yaml) - AWS
 * throttles thundering-herd reconnects, hence the jitter. Because the
 * underlying protocol is plain MQTT+TLS, Slice 8's portability drill
 * (point the panel at local Mosquitto/EMQX via config only) works
 * with this same transport.
 *
 * Reconnect strategy: mqtt.js's built-in fixed reconnectPeriod is
 * disabled; this class schedules its own reconnect on 'close' with
 * delay = random(0, min(max_sec, initial_sec * 2^attempt)) (full
 * jitter), resetting the attempt counter on a successful connect.
 * Subscriptions are replayed after every reconnect (clean session).
 *
 * The LWT publishes {type:'lwt', thing_name} at QoS 1 on the STATUS
 * topic (topics.status), not telemetry. It used to share the telemetry
 * topic, which was wrong twice over: a disconnect is not a measurement,
 * and under Basic Ingest the telemetry topic is an IoT Rule ingress, so
 * the LWT arrived as a malformed telemetry record and could not be
 * subscribed to at all. The heartbeat/2-missed rule remains the primary
 * offline detector; the LWT just makes an unclean disconnect visible
 * immediately.
 */
class AwsIotTransport {
  /**
   * @param {object} opts
   * @param {string} opts.endpoint - ATS endpoint hostname
   * @param {number} [opts.port]
   * @param {string} opts.certPath - device certificate (PEM)
   * @param {string} opts.keyPath - device private key (PEM)
   * @param {string} opts.caPath - Amazon root CA (PEM)
   * @param {string} opts.clientId - AWS IoT thing name
   * @param {number} [opts.keepAliveSec]
   * @param {{initialSec?: number, maxSec?: number}} [opts.backoff]
   * @param {{topic: string, payload: object}} [opts.will] - LWT; omit to connect without one
   * @param {Function} [opts.mqttConnect] - injectable mqtt.connect (tests); defaults to require('mqtt').connect
   * @param {Function} [opts.random] - injectable Math.random (tests make backoff deterministic)
   */
  constructor({
    endpoint,
    port = 8883,
    certPath,
    keyPath,
    caPath,
    clientId,
    keepAliveSec = 300,
    backoff = {},
    will,
    mqttConnect,
    random = Math.random,
  }) {
    this.url = `mqtts://${endpoint}:${port}`;
    // Paths kept so credentials can be re-read for certificate rotation
    // (reloadCredentials below) - the constructor snapshots the bytes,
    // but a rotation writes new material to these same paths.
    this.certPath = certPath;
    this.keyPath = keyPath;
    this.caPath = caPath;
    this.connectOptions = {
      clientId,
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
      ca: fs.readFileSync(caPath),
      keepalive: keepAliveSec,
      protocolVersion: 4, // MQTT 3.1.1 - what AWS IoT Core speaks
      clean: true,
      reconnectPeriod: 0, // reconnects are ours (jittered backoff below)
      rejectUnauthorized: true,
    };
    // The will is kept separately from connectOptions so a dial can be made
    // without it - see _willFor().
    this.will = will ?? null;
    this.lwtActive = null;         // null until the first successful connect
    this.lwtSuppressedReason = null;
    this.backoffInitialSec = backoff.initialSec ?? 2;
    this.backoffMaxSec = backoff.maxSec ?? 300;
    this.mqttConnect = mqttConnect ?? require('mqtt').connect;
    this.random = random;

    this.client = null;
    this.connected = false;
    this.closedByUser = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.subscriptions = new Map(); // topic -> [handler, ...]
    this.connectionListeners = [];
  }

  /** Opens the connection and keeps it alive (jittered backoff) until close() is called. */
  connect() {
    this.closedByUser = false;
    this._dial();
  }

  /**
   * Whether THIS dial should carry the Last Will, and the mqtt.js option for it.
   *
   * A broker can refuse the whole CONNECT because of the will topic alone -
   * AWS IoT authorises it as part of establishing the connection, so a policy
   * that has not yet been updated to grant publish on status/{c}/{s}/{p} takes
   * the panel completely dark. Nothing distinguishes that from any other
   * connect failure at the client, and our reconnect loop would retry forever,
   * so the panel would stay dark indefinitely while looking like a certificate
   * fault.
   *
   * So once the first few attempts have failed, dials ALTERNATE: even attempts
   * carry the will, odd ones do not. Whichever succeeds is the truth.
   *  - Will topic unauthorized  -> only the no-will dials connect; we come up
   *    with telemetry flowing and report lwtActive:false with a reason.
   *  - Anything else (network, certs, endpoint) -> both kinds fail equally,
   *    and when the real problem clears a with-will dial connects normally.
   * That last property is why this alternates rather than latching: a
   * transient outage must not leave the panel permanently without an LWT.
   */
  _willFor(attempt) {
    if (!this.will) return { include: false, option: {} };
    const include = attempt < LWT_FALLBACK_AFTER_ATTEMPTS || attempt % 2 === 0;
    return {
      include,
      option: include
        ? { will: { topic: this.will.topic, payload: JSON.stringify(this.will.payload), qos: 1, retain: false } }
        : {},
    };
  }

  _dial() {
    const { include: withWill, option: willOption } = this._willFor(this.reconnectAttempts);
    const client = this.mqttConnect(this.url, { ...this.connectOptions, ...willOption });
    this.client = client;

    client.on('connect', () => {
      if (this.will) {
        this.lwtActive = withWill;
        this.lwtSuppressedReason = withWill
          ? null
          : `connected WITHOUT a Last Will: ${this.reconnectAttempts} connect attempt(s) carrying the will were ` +
            `refused. The broker most likely does not authorise publish on '${this.will.topic}' - push the current ` +
            'iot-policy-panel.template.json as a new ACTIVE policy version, then restart. Telemetry is unaffected; ' +
            'only immediate unclean-disconnect detection is lost (missed heartbeats still detect an offline panel).';
      }
      this.reconnectAttempts = 0;
      this._setConnected(true);
      for (const topic of this.subscriptions.keys()) {
        client.subscribe(topic, { qos: 1 });
      }
    });

    client.on('message', (topic, payloadBuf) => {
      const handlers = this.subscriptions.get(topic);
      if (!handlers) return;
      let payload;
      try {
        payload = JSON.parse(payloadBuf.toString());
      } catch {
        payload = payloadBuf.toString();
      }
      for (const handler of handlers) handler(payload);
    });

    client.on('close', () => {
      // A redial (reconnect backoff or reloadCredentials) replaces
      // this.client; a stale client's late 'close' must not drive the
      // live connection's state or schedule a duplicate reconnect.
      if (this.client !== client) return;
      this._setConnected(false);
      if (!this.closedByUser) this._scheduleReconnect();
    });

    client.on('error', () => {
      // 'close' follows and drives the backoff; swallowing here stops
      // mqtt.js error events from crashing the Node-RED process.
    });
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    const capSec = Math.min(this.backoffMaxSec, this.backoffInitialSec * 2 ** this.reconnectAttempts);
    const delayMs = Math.max(1, Math.round(this.random() * capSec * 1000)); // full jitter: random(0, cap)
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUser) this._dial();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  _setConnected(connected) {
    if (connected === this.connected) return;
    this.connected = connected;
    for (const listener of this.connectionListeners) listener(connected);
  }

  publish(topic, payload, qos = 0) {
    if (!this.connected || !this.client) {
      return Promise.reject(new Error('transport is disconnected'));
    }
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      this.client.publish(topic, body, { qos }, (err) => (err ? reject(err) : resolve()));
    });
  }

  subscribe(topic, handler) {
    if (!this.subscriptions.has(topic)) {
      this.subscriptions.set(topic, []);
      if (this.connected && this.client) this.client.subscribe(topic, { qos: 1 });
    }
    this.subscriptions.get(topic).push(handler);
  }

  /**
   * Like subscribe(), but resolves only once the broker has ACKed the
   * subscription (SUBACK). Needed by request/response flows over MQTT
   * (Fleet Provisioning): publishing the request before the response
   * subscription is ACKed silently loses the response - seen live as
   * intermittent "no response from AWS IoT within 30000ms".
   */
  subscribeAsync(topic, handler) {
    if (!this.subscriptions.has(topic)) this.subscriptions.set(topic, []);
    this.subscriptions.get(topic).push(handler);
    if (!this.connected || !this.client) {
      return Promise.resolve(); // replayed (and ACKed) on the next connect
    }
    return new Promise((resolve, reject) => {
      this.client.subscribe(topic, { qos: 1 }, (err) => (err ? reject(err) : resolve()));
    });
  }

  isConnected() {
    return this.connected;
  }

  onConnectionChange(callback) {
    this.connectionListeners.push(callback);
  }

  offConnectionChange(callback) {
    const i = this.connectionListeners.indexOf(callback);
    if (i >= 0) this.connectionListeners.splice(i, 1);
  }

  /**
   * Certificate rotation (Readiness Workplan Phase 1): re-reads the
   * cert/key/CA from the SAME on-disk paths - a rotation writes the new
   * material there atomically first (see CertRotator) - and force-redials
   * with them. Resolves `true` once the broker accepts the new
   * certificate (a real 'connect'), or `false` if no successful connect
   * happens within verifyTimeoutSec. The caller uses that boolean to
   * decide commit vs rollback; rollback restores the old files and calls
   * this again. Publishing is naturally held by the outbox across the
   * brief reconnect (publish rejects while disconnected).
   */
  reloadCredentials({ verifyTimeoutSec = 60 } = {}) {
    this.connectOptions.cert = fs.readFileSync(this.certPath);
    this.connectOptions.key = fs.readFileSync(this.keyPath);
    this.connectOptions.ca = fs.readFileSync(this.caPath);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.offConnectionChange(onChange);
        resolve(ok);
      };
      const onChange = (connected) => {
        if (connected) finish(true);
      };
      // Not unref'd: during a rotation this timeout is the only thing
      // guaranteeing the verify promise settles; it's cleared as soon as
      // the new connection is accepted (finish()).
      const timer = setTimeout(() => finish(false), verifyTimeoutSec * 1000);
      this.onConnectionChange(onChange);
      this._redial();
    });
  }

  /** Tears down the current client and dials fresh with the current connectOptions. */
  _redial() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    this.closedByUser = false;
    const old = this.client;
    this.client = null; // old client's late 'close' now no-ops (guard in _dial)
    this._setConnected(false);
    if (old) old.end(true);
    this._dial();
  }

  /** Graceful shutdown - no LWT fires, no reconnect scheduled. */
  close() {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.client?.end(true);
    this._setConnected(false);
  }
}

module.exports = { AwsIotTransport };
