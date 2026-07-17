'use strict';

const fs = require('node:fs');

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
 * The LWT publishes {lwt: true, thing_name} on the telemetry topic at
 * QoS 1 - the yaml defines no dedicated status topic, and the
 * heartbeat/2-missed rule remains the primary offline detector; the
 * LWT just makes an unclean disconnect visible immediately. (A
 * dedicated status topic is a cloud-side design question for the
 * companion chat.)
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
      ...(will ? { will: { topic: will.topic, payload: JSON.stringify(will.payload), qos: 1, retain: false } } : {}),
    };
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

  _dial() {
    const client = this.mqttConnect(this.url, this.connectOptions);
    this.client = client;

    client.on('connect', () => {
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
