'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CLASSES = ['alarm', 'telemetry'];

function itemSizeBytes(item) {
  return Buffer.byteLength(JSON.stringify(item), 'utf8');
}

/**
 * Disk-backed store-and-forward queue (busduct_edge_config.yaml
 * §5 STORE-AND-FORWARD BUFFER): two priority classes, alarm and
 * telemetry. Telemetry drops oldest-first once the size cap is hit;
 * alarms are never dropped - they evict telemetry to make room
 * instead. Drains at a controlled rate only while the transport
 * reports connected, so link loss just grows the queue (up to the
 * cap) instead of losing data or hammering a dead connection.
 */
class Outbox {
  /**
   * @param {object} opts
   * @param {string} opts.dir - directory to persist queued messages in (one JSON-lines file per class)
   * @param {import('./transport').LoopbackTransport} opts.transport
   * @param {number} [opts.maxSizeBytes] - total cap across both classes (default 200MB, matching buffer.max_size_mb)
   * @param {number} [opts.drainRateMsgsPerSec] - default 5, matching buffer.drain_rate_msgs_per_sec
   */
  constructor({ dir, transport, maxSizeBytes = 200 * 1024 * 1024, drainRateMsgsPerSec = 5 }) {
    this.dir = dir;
    this.transport = transport;
    this.maxSizeBytes = maxSizeBytes;
    this.drainRateMsgsPerSec = drainRateMsgsPerSec;
    this.queues = { alarm: [], telemetry: [] };
    this._intervalHandle = null;

    fs.mkdirSync(this.dir, { recursive: true });
    for (const cls of CLASSES) {
      this.queues[cls] = this._readClassFile(cls);
    }
  }

  _classFilePath(cls) {
    return path.join(this.dir, `${cls}.jsonl`);
  }

  _readClassFile(cls) {
    const file = this._classFilePath(cls);
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  _persistClass(cls) {
    const file = this._classFilePath(cls);
    const lines = this.queues[cls].map((item) => JSON.stringify(item)).join('\n');
    fs.writeFileSync(file, lines.length ? lines + '\n' : '');
  }

  totalSizeBytes() {
    return CLASSES.reduce((sum, cls) => sum + this.queues[cls].reduce((s, item) => s + itemSizeBytes(item), 0), 0);
  }

  counts() {
    return { alarm: this.queues.alarm.length, telemetry: this.queues.telemetry.length };
  }

  /**
   * Queues a message for publish. `timestamp` should be the original
   * edge_utc event time (busduct_edge_config.yaml: timestamp_source:
   * edge_utc) - set by the caller, not the outbox, since it must
   * reflect when the event actually happened, not when it was queued.
   *
   * @param {'alarm'|'telemetry'} priorityClass
   * @param {string} topic
   * @param {object} payload
   * @param {number} qos
   */
  enqueue(priorityClass, topic, payload, qos) {
    if (!CLASSES.includes(priorityClass)) {
      throw new Error(`unknown outbox priority class '${priorityClass}'`);
    }
    const item = { id: crypto.randomUUID(), topic, payload, qos, enqueuedAt: Date.now() };
    // Both classes make room by evicting telemetry (oldest first) - alarms never evict alarms.
    const fits = this._makeRoomFor(item, ['telemetry']);

    if (!fits && priorityClass === 'telemetry') {
      return; // nothing left to evict and it still doesn't fit - drop this one (telemetry: drop_oldest policy)
    }
    // alarms are enqueued even if !fits - never_drop policy; the cap is a soft limit for telemetry only.

    this.queues[priorityClass].push(item);
    this._persistClass(priorityClass);
  }

  _wouldExceedCap(candidateItem) {
    return this.totalSizeBytes() + itemSizeBytes(candidateItem) > this.maxSizeBytes;
  }

  /** Evicts oldest items from `evictFrom` classes until candidateItem fits under the cap. Returns whether it now fits. */
  _makeRoomFor(candidateItem, evictFrom) {
    while (this._wouldExceedCap(candidateItem)) {
      const evictableClass = evictFrom.find((cls) => this.queues[cls].length > 0);
      if (!evictableClass) return false; // nothing left we're allowed to evict
      this.queues[evictableClass].shift(); // drop oldest
      this._persistClass(evictableClass);
    }
    return true;
  }

  /**
   * Publishes up to `maxMessages` queued messages (alarms first, then
   * telemetry - alarms are QoS1/critical), stopping early if the
   * transport is disconnected or a publish fails. Successfully
   * published messages are removed from the queue; a failed one stays
   * queued and drain stops there (preserves order).
   *
   * @param {number} [maxMessages]
   * @returns {Promise<number>} number of messages actually published
   */
  async drain(maxMessages = this.drainRateMsgsPerSec) {
    if (!this.transport.isConnected()) return 0;

    let published = 0;
    for (const cls of ['alarm', 'telemetry']) {
      while (published < maxMessages && this.queues[cls].length > 0) {
        const item = this.queues[cls][0];
        try {
          await this.transport.publish(item.topic, item.payload, item.qos);
        } catch {
          return published; // stop draining on first failure - preserves order, nothing lost
        }
        this.queues[cls].shift();
        this._persistClass(cls);
        published++;
      }
    }
    return published;
  }

  /** Starts an automatic drain loop, once per second, for production use (tests should call drain() directly). */
  start() {
    if (this._intervalHandle) return;
    this._intervalHandle = setInterval(() => {
      this.drain().catch(() => {});
    }, 1000);
    this._intervalHandle.unref?.();
  }

  stop() {
    if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = null;
    }
  }
}

module.exports = { Outbox };
