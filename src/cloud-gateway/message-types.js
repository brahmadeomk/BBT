'use strict';

/**
 * The `type` discriminator carried by EVERY device -> cloud message.
 *
 * WHY THIS EXISTS. Four different message shapes used to share the telemetry
 * topic - the interval aggregate, the hourly heartbeat, the positional
 * manifest and the LWT - and only the manifest said what it was. A cloud
 * consumer had to discriminate by sniffing field presence (`fwVersion` =>
 * heartbeat, `start_index` => positional, ...), which decodes today and
 * mis-routes silently the moment anyone adds a field. Every publish now
 * carries `type` as its first property, so one rule reads the whole contract:
 *
 *     SELECT * FROM 'dt/+/+/+/tel' WHERE type = 'telemetry'
 *
 * RULES FOR CHANGING THIS FILE.
 *  - Values are a wire contract. Adding one is additive and safe; renaming or
 *    removing one breaks every deployed consumer. Treat it like the register
 *    map: append-only.
 *  - A new message shape needs a new value here, never a reused one with an
 *    extra flag - that is the mistake this file exists to prevent.
 *
 * The LWT is the one payload the device cannot compose at send time (the
 * broker publishes it on the device's behalf, from a payload fixed at connect),
 * so it carries no timestamp. Everything else does.
 */
/**
 * Contract version, carried as `v` on every message.
 *
 * WHY A VERSION AT ALL, given `type` already says what a message is: `type`
 * identifies the SHAPE, `v` identifies the REVISION of that shape. The two
 * answer different questions and a consumer needs both.
 *
 * WHY IT EARNS ITS KEEP HERE SPECIFICALLY: OTA update is not built yet
 * (Readiness Workplan Phase 6), so a panel is updated by visiting it. A fleet
 * therefore runs mixed firmware for months at a time, and the cloud has to
 * parse two revisions simultaneously - which is a certainty, not a risk. The
 * alternative is sniffing which fields are present, the exact habit the `type`
 * discriminator was added to end.
 *
 * WHEN TO BUMP. Only on a BREAKING change to any message:
 *   - a field renamed or removed
 *   - a field's meaning, unit or type changed
 *   - a value that consumers switch on gaining a meaning it did not have
 * Adding an optional field is NOT breaking and must NOT bump: consumers are
 * required to ignore unknown fields. Bumping for additive changes trains people
 * to ignore the number.
 *
 * ONE GLOBAL NUMBER, not one per message type. A consumer routes on `type`
 * first and applies `v` inside that branch, so a bump caused by a telemetry
 * change is a no-op for an alarm consumer - while per-type counters would make
 * everyone track seven of them and could not express an envelope-wide change.
 *
 * A consumer that meets a `v` it does not know must FAIL LOUDLY rather than
 * guess: an unrecognised revision means fields may have moved underneath it.
 *
 * v1 (2026-08-27): the first contract with `type` on every message, frozen
 * telemetry field names (dt_min dt_max dt_avg ror_max t_max amb_avg), the LWT
 * on its own status topic, and device_health.
 */
const SCHEMA_VERSION = 1;

const MESSAGE_TYPES = Object.freeze({
  /** Interval aggregate of joint KPIs. Carries `encoding` (see below). */
  TELEMETRY: 'telemetry',
  /** Index -> joint_id map that positional telemetry is decoded against. */
  MANIFEST: 'manifest',
  /** Periodic liveness + what firmware/config the panel is actually running. */
  HEARTBEAT: 'heartbeat',
  /** Alarm state transition: RAISE / CLEAR / ACK. */
  ALARM: 'alarm',
  /**
   * Panel self-diagnosis: blacklisted devices, joint LIVE/STALE/OFFLINE,
   * per-segment bus liveness, Pi supply health. A complete STATE snapshot,
   * not an event - the newest message always wins.
   */
  DEVICE_HEALTH: 'device_health',
  /** Result of a remote config push. */
  CONFIG_ACK: 'config_ack',
  /** Result of a certificate rotation. */
  CERT_ACK: 'cert_ack',
  /** Broker-published Last Will: the panel dropped without a clean disconnect. */
  LWT: 'lwt',
});

/**
 * How a telemetry payload lays out its joint data. Both are `type:'telemetry'`
 * because they carry the same information for the same interval - a consumer
 * that only wants "the aggregate" should not have to know which encoding the
 * panel was configured for, and a panel can be switched between them without
 * the cloud re-subscribing.
 */
const TELEMETRY_ENCODINGS = Object.freeze({
  /** `joints: { J01: {...} }` - self-describing, no manifest needed. */
  KEYED: 'keyed',
  /** Index-aligned column arrays + `start_index`; decode against the manifest. */
  POSITIONAL: 'positional',
});

module.exports = { MESSAGE_TYPES, TELEMETRY_ENCODINGS, SCHEMA_VERSION };
