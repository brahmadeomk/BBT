'use strict';

const KPI_BY_ALARM_TYPE = {
  DELTA_T: 'delta_t',
  ROR: 'rate_of_rise',
};

/**
 * Subscribes to Alarm Manager's alarm-events outputs (see
 * docs/internal-message-contracts.md) and publishes on state
 * transition only - RAISE when an alarm becomes newly active, CLEAR
 * when it clears - matching busduct_edge_config.yaml's
 * publish.alarm policy (mode: on_state_transition, qos: 1).
 *
 * Alarm Manager's "active" output fires with the *entire* current
 * active-alarms array whenever anything about it changes, not just
 * the newly-raised one - so this class tracks previously-seen
 * instanceIds itself and only treats genuinely new ones as a RAISE,
 * to honor "no repeats". "clearedNow" is already a
 * just-this-message delta by construction, so every item there is a
 * CLEAR.
 *
 * Gap, flagged rather than worked around: busduct_edge_config.yaml's
 * publish.alarm.include_context also asks for `value`, `threshold`,
 * and `persistence_min`, but the current Alarm Manager alarm objects
 * don't carry these as structured fields - only baked into a
 * human-readable `description` string (e.g. "ΔT 29.48 ≥ 25").
 * Rather than regex-parse that string (fragile, and the two alarm
 * types already use different wording), this publisher includes only
 * the fields that actually exist as data: `joint_id`, `level`, `kpi`
 * (mapped from `alarm_type`), plus the rest of the alarm object for
 * context. Extending Alarm Manager to emit structured value/threshold
 * fields is a design decision for the companion chat, not something
 * to invent here.
 */
class AlarmPublisher {
  /**
   * @param {object} opts
   * @param {import('./outbox').Outbox} opts.outbox
   * @param {string} opts.topic - alarm topic (e.g. resolved from busduct_edge_config.yaml's topics.alarm)
   */
  constructor({ outbox, topic }) {
    this.outbox = outbox;
    this.topic = topic;
    this.knownActiveIds = new Set();
  }

  /** Feed Alarm Manager's "active" output (msg.payload, the full current active-alarms array). */
  ingestActiveAlarms(activeAlarms) {
    const incomingIds = new Set(activeAlarms.map((a) => a.instanceId));
    for (const alarm of activeAlarms) {
      if (!this.knownActiveIds.has(alarm.instanceId)) {
        this._publish('RAISE', alarm);
      }
    }
    this.knownActiveIds = incomingIds;
  }

  /** Feed Alarm Manager's "clearedNow" output (msg.payload, this message's just-cleared alarms only). */
  ingestClearedAlarms(clearedAlarms) {
    for (const alarm of clearedAlarms) {
      this.knownActiveIds.delete(alarm.instanceId);
      this._publish('CLEAR', alarm);
    }
  }

  _publish(action, alarm) {
    const event = {
      action, // "RAISE" | "CLEAR"
      joint_id: alarm.joint_id,
      level: alarm.level,
      kpi: KPI_BY_ALARM_TYPE[alarm.alarm_type] ?? null,
      timestamp: action === 'CLEAR' ? alarm.clearedTs : alarm.raisedTs,
      alarm, // full context snapshot
    };
    this.outbox.enqueue('alarm', this.topic, event, 1); // qos 1, per publish.alarm.qos - must not be lost
  }
}

module.exports = { AlarmPublisher };
