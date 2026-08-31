# Internal message contracts (Slice 4)

Documents the shapes of the two internal streams tapped in Slice 4 —
`ProcessLogic`'s KPI stream and `Alarm Manager`'s alarm events — as
they exist today in `flows/flows_BBT.json` (`BusbarTherMo` tab). These
are read directly from the current function node source, not
inferred — see the node IDs below if you need to check them again.

Slice 4 only *taps* these outputs (new `link out` nodes, wired
alongside the existing outputs, no logic changes — see decision log).
Slice 5's Cloud Gateway batcher/alarm publisher are the intended
consumers, via matching `link in` nodes added later.

> **These are INTERNAL shapes. They are not what the panel publishes.**
> The device → cloud wire contract is a separate, versioned document:
> **`docs/aws/README.md` Part G** (machine-readable half:
> `src/cloud-gateway/message-types.js`). Do not infer one from the other
> — the same concept is deliberately named differently in each, because
> internally a field can be a rich object while on the wire it is one
> aggregated number.
>
> The trap, which caught us once (CR-OPEN-5, 2026-08-27): `ambient` here
> is an **object** `{slaveID, val, age_sec}` for a single reading, while
> the wire field is **`amb_avg`**, a bare number — the joint's mean
> ambient over the whole telemetry interval. Reusing the internal name on
> the wire is what let the two telemetry encodings drift apart unnoticed.

## KPI stream — `ProcessLogic` (node `39dad91df0c15744`)

Fires once per incoming sensor reading. Three outputs, mutually
exclusive per message (exactly one fires):

| Output | Link-out tap | Fires when |
|---|---|---|
| 1 | `KPI Stream - Joint (link out)` | the sensor is mapped to a real joint |
| 2 | `KPI Stream - Ambient (link out)` | the sensor's slave ID appears in some joint's `ambientSlaveID` (it's a dedicated ambient reference, not itself a joint) |
| 3 | `KPI Stream - Unassigned (link out)` | the sensor matches neither a joint nor an ambient reference |

### Output 1 — joint (`msg.topic = "joint"`)

```jsonc
{
  "joint_name": "J01",
  "joint_id": "J01",
  "zone_id": "Z1",              // or "UNKNOWN" if the joint has no zone
  "zone_name": "Zone1",         // or "Unknown"
  "slaveID": 1,
  "val": 42.3,                   // raw sensor reading, degC
  "emaTemp": 42.1,                // EMA-smoothed temperature
  "ror": 3.256,                   // rate of rise, degC/hr (EMA-based)
  "ambient": { "slaveID": 101, "val": 31.06, "age_sec": 0.8 } || null,   // NB: publishes as `amb_avg` (a number) - see the note above
  "deltaT": { "raw": 11.2, "ema": 10.9 } || null,
  "sample_dt_sec": 1.7,           // time since last sample for this joint, clamped [0.5, 300]
  "timestamp": "2026-07-10T10:45:56.454Z",
  "sensor_status": "OK",          // "OK" | "Sensor_Error" | "Communication_Error"
  "isAmbient": false,
  "isProcessSensor": true
}
```

`ambient`/`deltaT` are `null` when the joint has no `ambientSlaveID`
configured or that ambient sensor hasn't reported a value yet.

### Output 2 — ambient (`msg.topic = "ambient"`)

```jsonc
{
  "joint_id": "AMBIENT_101",
  "joint_name": "AMBIENT_101",
  "zone_id": "AMBIENT",
  "zone_name": "Ambient",
  "slaveID": 101,
  "val": 31.06,
  "sensor_status": "OK",
  "isAmbient": true,
  "isProcessSensor": false,
  "timestamp": "2026-07-10T10:45:56.454Z"
}
```

### Output 3 — unassigned (`msg.topic = "unassigned"`)

```jsonc
{
  "sensor_id": 55,
  "val": 24.1,
  "sensor_status": "OK",
  "type": "UNASSIGNED",
  "zone_id": null,
  "zone_name": "Unassigned",
  "timestamp": "2026-07-10T10:45:56.454Z"
}
```

Diagnostic only (a sensor reporting that isn't wired into any joint or
ambient reference yet) - not part of the KPI aggregation the Cloud
Gateway batcher needs.

## Alarm events — `Alarm Manager` (node `de6fcc55794afd9e`)

Only fires a given output when that output's content actually changed
since the last message (`buildOutputs` in the source) - so consumers
naturally only see state transitions, not a poll-driven repeat.

| Output | Link-out tap | Content |
|---|---|---|
| 1 | `Alarm Events - Active (link out)` | full current active-alarms array, only when it changed |
| 2 | `Alarm Events - Cleared (link out)` | just-cleared alarms from this message only |
| 3 | `Alarm Events - Historian (link out)` | full historian array, only when it changed |
| 4 | `Alarm Events - Email (link out)` | email(s) to send from this message only |

All four carry `msg.payload` as an **array** of items in the shape
below (outputs 1/3 can be large/whole-state; outputs 2/4 are
just-this-message deltas).

### Alarm event object (outputs 1-3)

```jsonc
{
  "instanceId": "PROCESS|J01|DELTA_T|WARNING",   // "PROCESS|<joint_id>|<alarm_type>|<level>" or "SYSTEM|<joint_id>|<type>"
  "category": "PROCESS",                          // "PROCESS" | "SYSTEM"
  "joint_id": "J01",
  "joint_name": "Riser bend, above ACB-8",         // operator-facing location (schema joints[].label); null when unnamed, absent on panel/device SYSTEM alarms
  "zone_id": "Z1",
  "zone_name": "Zone1",
  "alarm_type": "DELTA_T",                        // "DELTA_T" | "ROR" | "COMMUNICATION" | "SENSOR_FAULT" | "COMM_MODULE" | "COMM_RESET"
  "level": "WARNING",                             // "WATCH" | "WARNING" | "CRITICAL" | "INFO"
  "status": "ACTIVE_NACK",                        // "ACTIVE_NACK" | "CLEARED" | "EVENT"
  "raisedTs": "2026-07-03T05:13:53.166Z",
  "clearedTs": "2026-07-04T04:36:05.444Z",         // present once cleared
  "description": "J01: ΔT 29.48 ≥ 25",          // joint-scoped alarms lead with the joint id; panel/device SYSTEM alarms are unprefixed
  "reason": "CONFIG_REMOVED",                       // present only on auto-clear (joint removed from config)
  "kpi": { "state": "No Data" },                   // present only on some SYSTEM alarms
  "value": 29.48,                                   // PROCESS (ROR/DELTA_T) alarms only - the evaluated reading (ror or deltaT.ema)
  "threshold": 25,                                  // PROCESS alarms only - the threshold it crossed
  "persistence_min": 15,                            // PROCESS alarms only - persistence_min from cfg/alarms for this level
  "absolute_temp_c": 55.2                           // PROCESS alarms only - the raw sensor reading (val) at evaluation time, distinct from `value`
}
```

`joint_name` (added 2026-08-31) is the location the operator typed in the
Joint Config table — a mandatory column, stored as schema
`joints[].label` ("Riser bend, above ACB-8"). It is `null` when the joint
is unnamed and **absent** on panel- and device-scoped `SYSTEM` alarms
(`SYSTEM|MODULE|COMM_FAILURE`, `SYSTEM|<slave>|BLACKLIST`,
`SYSTEM|PI|POWER`), which belong to no joint. It is deliberately not
echoed from `joint_id` when missing — a fabricated name would be
indistinguishable from a real one, so consumers apply their own fallback
(`joint_name || joint_id`).

`description` **leads with the joint id** on joint-scoped alarms
(`J01: ΔT 29.48 ≥ 25`, user request 2026-08-31) — it is the one field
that travels everywhere intact, including e-mail subject lines, the CSV
export and the cloud snapshot, several of which render it with no joint
column beside it. The **id**, not the name: it matches the `instanceId`
and stays short. Panel- and device-scoped `SYSTEM` alarms are not
prefixed, since they belong to no joint. Nothing keys on this string
(dedupe is by `instanceId`, historian matching by `instanceId` +
`raisedTs`), so read it as prose, never as an identifier — parse
`joint_id` for that.

`value`/`threshold`/`persistence_min`/`absolute_temp_c` are only
present on `PROCESS` alarms (`ROR`/`DELTA_T`). `value`/`threshold`/
`persistence_min` are the same numbers already baked into
`description`, now also available as structured fields for the Cloud
Gateway's alarm publisher (`busduct_edge_config.yaml`'s
`publish.alarm.include_context`). `absolute_temp_c` is the raw sensor
reading (`val` in the KPI message) at the moment the alarm was
evaluated — for a `ROR` alarm, `value` is the rate-of-rise number and
`absolute_temp_c` is the temperature that produced it; for a `DELTA_T`
alarm, `value` is the delta-T itself and `absolute_temp_c` is the
underlying absolute reading. `SYSTEM` alarms (comm timeout, sensor
fault) don't evaluate a numeric threshold, so all four are simply
absent there, not fabricated.

`INJECT_EVENT`-sourced entries (e.g. the `RECOVERY CONTROLLER`'s
`SYSTEM|MODULE|RESET_N` events) use `status: "EVENT"` with
`raisedTs === clearedTs` - a point-in-time log entry, not an
active/cleared pair.

### Email object (output 4)

```jsonc
{
  "subject": "🚨 Active Alarm: PROCESS|J01|DELTA_T|WARNING",
  "body": "Zone: Zone1\nJoint: J01\n...",
  "attachments": [{ "filename": "alarm_history_....csv", "content": "..." }]  // only on the 100-event CSV batch email
}
```

## Segment tag — `msg.bus_id` (Slice 10 two-segment)

On a two-segment panel each RS-485 bus is its own Nano on its own serial
port. Frames from the **second** segment are tagged by `Tag Bus2` at the
serial edge — the only place that knows which wire a frame arrived on:

```jsonc
msg.bus_id = "bus2"     // top-level msg property, NOT msg.payload.bus_id
```

It has to be top-level: at that point `payload` is still the raw serial
string, and the `json` node downstream rewrites `payload` while leaving other
msg properties alone, so the tag survives to the blacklist tap.

Who reads it:

- **Blacklist Engine** passes it to `processReadResult` as `ctx.busId`, so a
  response resolves against a slave on the segment it actually came from.
- Nothing else needs it. **ProcessLogic ignores it**, because joints are keyed
  by unit address and the commissioning UI forces addresses unique across all
  buses — which is exactly why one decode chain and one ProcessLogic serve
  both segments.

bus1 frames are **not** tagged: an absent `bus_id` means "the single-bus
path", which is how every one-segment panel keeps working unchanged.

Two related fields travel the other way, on messages heading *toward* a Nano:

- `msg.busId` (camelCase, on resend messages) — which segment a resend is
  addressed to. Each `Send Nano Job` drops a message naming another segment;
  a resend with no `busId` is meant for every segment.
- `msg.payload.busId` — on COMM watchdog messages into the Alarm Manager,
  which derives the alarm key from it (`SYSTEM|BUS2|COMM_FAILURE`; absent or
  `bus1` keeps the original `SYSTEM|MODULE|COMM_FAILURE`).

## What Slice 4 did *not* touch

- No changes to either function node's logic - verified byte-identical
  against the pre-Slice-4 source (see decision log).
- The new `link out` nodes all have an empty `links` array (no
  consumer yet) - they're inert until Slice 5 adds matching `link in`
  nodes, so this change cannot affect current HMI/historian/email
  behavior by construction.
