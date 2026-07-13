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
  "ambient": { "slaveID": 101, "val": 31.06, "age_sec": 0.8 } || null,
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
  "zone_id": "Z1",
  "zone_name": "Zone1",
  "alarm_type": "DELTA_T",                        // "DELTA_T" | "ROR" | "COMMUNICATION" | "SENSOR_FAULT" | "COMM_MODULE" | "COMM_RESET"
  "level": "WARNING",                             // "WATCH" | "WARNING" | "CRITICAL" | "INFO"
  "status": "ACTIVE_NACK",                        // "ACTIVE_NACK" | "CLEARED" | "EVENT"
  "raisedTs": "2026-07-03T05:13:53.166Z",
  "clearedTs": "2026-07-04T04:36:05.444Z",         // present once cleared
  "description": "ΔT 29.48 ≥ 25",
  "reason": "CONFIG_REMOVED",                       // present only on auto-clear (joint removed from config)
  "kpi": { "state": "No Data" }                    // present only on some SYSTEM alarms
}
```

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

## What Slice 4 did *not* touch

- No changes to either function node's logic - verified byte-identical
  against the pre-Slice-4 source (see decision log).
- The new `link out` nodes all have an empty `links` array (no
  consumer yet) - they're inert until Slice 5 adds matching `link in`
  nodes, so this change cannot affect current HMI/historian/email
  behavior by construction.
