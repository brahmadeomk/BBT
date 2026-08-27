'use strict';

const { MESSAGE_TYPES } = require('./message-types');

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
 * `value`/`threshold`/`persistence_min` (busduct_edge_config.yaml's
 * publish.alarm.include_context) are promoted from the alarm object
 * when present - Alarm Manager's PROCESS alarms (ROR/DELTA_T) now
 * carry these as structured fields alongside their existing
 * `description` string. SYSTEM alarms (comm timeout, sensor fault)
 * don't evaluate a numeric threshold, so these are simply absent
 * there rather than fabricated. `absolute_temp_c` (the raw sensor
 * reading at evaluation time, distinct from `value` - which is the
 * rate-of-rise or delta-T number depending on alarm_type) is promoted
 * the same way, PROCESS alarms only.
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
    this.knownActive = new Map(); // instanceId -> last seen status
  }

  /**
   * Feed Alarm Manager's "active" output (msg.payload, the full current
   * active-alarms array). Emits RAISE for genuinely new instanceIds and
   * ACK when a known alarm's status transitions ACTIVE_NACK ->
   * ACTIVE_ACK (operator pressed the ACK button) - completing the
   * publish.alarm mode "RAISE, CLEAR, ACK only" from the edge config.
   */
  ingestActiveAlarms(activeAlarms) {
    const incoming = new Map(activeAlarms.map((a) => [a.instanceId, a.status]));
    for (const alarm of activeAlarms) {
      if (!this.knownActive.has(alarm.instanceId)) {
        this._publish('RAISE', alarm);
      } else if (this.knownActive.get(alarm.instanceId) === 'ACTIVE_NACK' && alarm.status === 'ACTIVE_ACK') {
        this._publish('ACK', alarm);
      }
    }
    this.knownActive = incoming;
  }

  /** Feed Alarm Manager's "clearedNow" output (msg.payload, this message's just-cleared alarms only). */
  ingestClearedAlarms(clearedAlarms) {
    for (const alarm of clearedAlarms) {
      this.knownActive.delete(alarm.instanceId);
      this._publish('CLEAR', alarm);
    }
  }

  _publish(action, alarm) {
    const event = {
      type: MESSAGE_TYPES.ALARM,
      action, // "RAISE" | "CLEAR" | "ACK"
      joint_id: alarm.joint_id,
      level: alarm.level,
      kpi: KPI_BY_ALARM_TYPE[alarm.alarm_type] ?? null,
      timestamp: action === 'CLEAR' ? alarm.clearedTs : action === 'ACK' ? alarm.ackTs ?? alarm.raisedTs : alarm.raisedTs,
      alarm, // full context snapshot
    };
    if (typeof alarm.value === 'number') event.value = alarm.value;
    if (typeof alarm.threshold === 'number') event.threshold = alarm.threshold;
    if (typeof alarm.persistence_min === 'number') event.persistence_min = alarm.persistence_min;
    if (typeof alarm.absolute_temp_c === 'number') event.absolute_temp_c = alarm.absolute_temp_c;

    this.outbox.enqueue('alarm', this.topic, event, 1); // qos 1, per publish.alarm.qos - must not be lost
  }
}

module.exports = { AlarmPublisher };
