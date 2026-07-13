'use strict';

/**
 * The cloud-agnostic transport interface (CLAUDE.md's cloud-agnostic
 * rule): everything in cloud-gateway/ talks to the cloud through this
 * shape only. AWS-specific code (Slice 6) implements the same
 * interface in src/adapters/aws/ - nothing here or upstream of it may
 * import an AWS SDK.
 *
 * A transport implementation must provide:
 *   - publish(topic, payload, qos) -> Promise<void>
 *   - subscribe(topic, handler) -> void
 *   - isConnected() -> boolean
 *   - onConnectionChange(callback: (connected: boolean) => void) -> void
 */

/**
 * In-memory transport for tests and bench soak runs - no MQTT yet
 * (that's the AWS adapter, Slice 6). Records every publish and lets
 * tests flip connection state to simulate link loss/recovery.
 */
class LoopbackTransport {
  constructor() {
    this.published = [];
    this.subscribers = new Map();
    this.connectionListeners = [];
    this.connected = true;
  }

  publish(topic, payload, qos = 0) {
    if (!this.connected) {
      return Promise.reject(new Error('transport is disconnected'));
    }
    this.published.push({ topic, payload, qos, publishedAt: Date.now() });
    for (const handler of this.subscribers.get(topic) || []) handler(payload);
    return Promise.resolve();
  }

  subscribe(topic, handler) {
    if (!this.subscribers.has(topic)) this.subscribers.set(topic, []);
    this.subscribers.get(topic).push(handler);
  }

  isConnected() {
    return this.connected;
  }

  onConnectionChange(callback) {
    this.connectionListeners.push(callback);
  }

  /** Test/soak-only: simulate a link going down or recovering. */
  setConnected(connected) {
    if (connected === this.connected) return;
    this.connected = connected;
    for (const listener of this.connectionListeners) listener(connected);
  }
}

module.exports = { LoopbackTransport };
