# Recovering the channel in the decode path — findings

**Status: BUILT AND LIVE-VERIFIED 2026-09-01 (steps 1-4).**
`src/config-service/channel-decode.js` decodes per channel, "Scale Nano Reading"
fans out one message per channel, and ProcessLogic matches on `(unit address,
channel)`. Confirmed on the panel against a real 4-channel module (§7).
Remaining gap: only the **consecutive** register layout has met hardware; the
sparse `channel_addrs` path is still simulation-only.

Asked 2026-09-01: can the
`(slave id, start address, data length)` combination identify the channel,
and map it to a sensor data object?

**Short answer: yes — and the frame already carries more than enough. But
the mapping is not the triple; it is an index into `val` computed from the
configuration. On the way to confirming that, a live defect turned up.**

---

## 1. What the frame actually contains

`firmware/Nano_IOT.ino` emits one JSON object per read packet:

```json
{"t":"r", "id":3, "sa":100, "len":4, "val":[2543,2601,2488,2550], "st":"ok"}
```

and `compileNanoJob` emits exactly **one contiguous read per slave**
(`nano-compiler.js:67`):

```js
const readTuples = slaves.map((s) => [s.unit_address, s.registers.temp_base_addr, readSpan(s)]);
```

So for a 4-channel module the Pi already receives all four values in one
frame. Nothing is lost on the wire — the decode path simply throws them
away.

## 2. The mapping

`readSpan` (`validate-modbus-joints.js:34`) covers two layouts, and each
inverts cleanly:

| Layout | Span emitted | Channel *k* is at |
|---|---|---|
| Sparse (`channel_addrs` present) | `max(addrs) - min(addrs) + word_count` | `val[ channel_addrs[k-1] - sa ]` |
| Consecutive (no `channel_addrs`) | `channels * word_count` | `val[ (k-1) * word_count ]` |

**R15 is what makes this well-defined.** It already requires
`min(channel_addrs) === temp_base_addr`, addresses unique and
non-overlapping, and `length === channels`. So `sa` is always the base
address, `val[0]` is always channel 1, and no two channels can claim the
same word. The validation rule written for commissioning turns out to be
exactly the invariant the decoder needs — no schema change is required.

For `temp_word_count: 2` (32-bit values) the channel takes
`val[i]`, `val[i+1]`, combined per `temp_scale`.

### Use `sa`/`len` as a check, not as a key

The proposal asked about the triple. `id` alone is enough to find the
slave — unit addresses are unique panel-wide, deliberately (CLAUDE.md).
`sa` and `len` earn their place as a **consistency check**:

```js
if (frame.sa !== slave.registers.temp_base_addr || frame.len !== readSpan(slave)) → discard
```

If they disagree, the Nano is still running a **previous job** — the
window between a config apply and the resend landing, or a resend that
never arrived. Today such a frame would be decoded against the new
configuration and silently mis-attributed. Checking the shape turns that
into a discarded reading plus a warning, which is the safe direction.

---

## 3. The defect this uncovered

`function 18` on the `BusbarTherMo` tab, the node immediately upstream of
ProcessLogic, is:

```js
var val = validateValue(msg.payload.val / 100)
```

`msg.payload.val` is an **array**. Dividing an array by 100 coerces it via
`toString()`:

| Channels | `val` | Result |
|---|---|---|
| 1 | `[2543]` | `"2543"/100` = **25.43** ✓ works by accident |
| 2 | `[2543,2601]` | `"2543,2601"/100` = `NaN` → **0** |
| 4 | `[2543,2601,2488,2550]` | `NaN` → **0** |

Verified by direct evaluation. **A multi-channel slave currently reads
0 °C**, and `validateValue` converts the `NaN` into a plausible-looking
zero rather than a fault — so it would present as a cold joint, not as an
error.

The panel is unaffected today: all six commissioned slaves are
single-channel. But the Modbus Settings dashboard has offered multi-channel
commissioning since 2026-07-14, and the schema supports up to 8 channels.
**The first multi-channel module commissioned would read zero.**

A second, smaller issue in the same line: `/100` is hardcoded, while the
schema carries `registers.temp_scale` (1 / 0.1 / 0.01) per slave. Any
module that is not centi-degrees is already mis-scaled.

### 3a. …and honouring `temp_scale` turned out to be the wrong fix

Fixing that second issue **broke the panel**, and the reason is worth
recording. `tools/migrate-legacy-config.js:60` writes `temp_scale: 0.1`
with its own warning attached:

> *"slaves[].registers.temp_scale assumed 0.1 (raw/10 = degC) — legacy
> data does not record scaling, verify against the sensor datasheet"*

The legacy pipeline hardcoded the divisor and never recorded it, so the
migration had to guess — and guessed wrong for this hardware, which is
centi-degrees. **Nothing had ever read the field**, so the wrong guess sat
in the applied config undetected from migration until the decoder trusted
it. A joint at 31 °C (raw 3100) decoded as 310 °C, past ProcessLogic's 300
limit, raising *"Sensor value out of valid range"* on every joint at once.

So `useConfigScale` is **off by default**. Readings decode on the legacy
`0.01`, and a configured scale that disagrees is **reported, not applied** —
throttled to once per unit per five minutes, because the condition is true
of every frame and unthrottled it would fill the SD card the historian and
outbox share.

**The general lesson:** a config field that nothing reads is not "unused",
it is *unverified*. Migrating a value nobody consumes records a guess with
the authority of a measurement. The first consumer of any such field should
default to the previous hardcoded behaviour and report the difference,
rather than assume the stored value is right.

---

## 4. Proposed decoder

Replace `function 18` with a thin node over a pure library —
`src/config-service/channel-decode.js`:

```js
decodeFrame(frame, doc) -> { readings: [{ unit_address, channel, val, status }], warnings: [] }
```

- looks the slave up by `frame.id` in the **applied** document;
- verifies `sa`/`len` against `temp_base_addr`/`readSpan` (§2);
- emits one reading per channel, indexed per the table above;
- applies that slave's own `temp_scale`/`temp_offset`, not a hardcoded
  divisor;
- carries `st:"err"` through as a per-channel fault rather than a value.

The node then **fans out one message per channel**, because ProcessLogic
consumes one reading per message. A 4-channel slave becomes 4 messages
carrying `{id, channel, val, st}`.

### Then, and only then

`buildProcessLogicJoints` can stop collapsing joints onto the unit address
(`process-logic-joints.js`), and ProcessLogic's lookup becomes:

```js
joints.find(j => j.slaveID === sensorID && j.channel === sensorChannel)
```

which is what the schema has modelled all along — R7 exists specifically
to reject duplicate `(slave, channel)` pairs. The "lowest channel wins"
compromise and its warning are then deleted.

---

## 5. Blast radius — much smaller than estimated

**The original estimate in this section was wrong, and the correction is the
reason steps 3-4 were a day's work rather than a week's.**

`global.sensorData` is **already keyed per channel**. The legacy `/100` node on
`modbusMaster_V2` writes:

```js
sensorData[sID][sAddr] = op;        // [unit address][register address]
```

and its readers do `global.get('sensorData[1][3]')` — unit 1, register 3. Since
`channel_addrs` *are* register addresses, that structure already distinguishes
channels. **None of those ~28 nodes needed changing.**

Only ONE path ever lost the channel: `Data Out → json → Scale Nano Reading →
ProcessLogic`, which collapsed a whole frame into a single coerced number. The
fan-out is therefore contained to that node and its consumer.

The lesson for next time: measure the blast radius before quoting it. "~40 nodes
key `sensorData` by unit address" was inferred from a note in CLAUDE.md rather
than read out of the flow, and the note was describing a different concern
(per-bus uniqueness).

## 5a. The original blast-radius estimate (superseded)

The decode path is the **live measurement path**, and the fan-out changes
message shape for everything downstream.

The real weight is the **~40 legacy function nodes on `modbusMaster_V2`**
that key `global.sensorData[<unit_address>]` by address alone. They feed
the Diagnostics table, the alert/SMS nodes and the legacy dashboards. A
per-channel model needs `sensorData[<unit_address>][<channel>]`, or a
composite key, and every one of those readers has to be found and changed
together — CLAUDE.md already flags this as the reason unit addresses were
made unique panel-wide rather than per-bus.

Suggested sequencing, so nothing is at risk for long:

1. **Fix the scaling and the array bug first**, single-channel behaviour
   unchanged. Small, independently testable, removes the 0 °C trap even if
   the rest is deferred.
2. Build `decodeFrame` as a pure library with tests, wired to emit a
   single channel-1 reading — byte-identical behaviour on this panel.
3. Turn on fan-out, and migrate the legacy `sensorData` readers in the
   same change.
4. Switch ProcessLogic and `buildProcessLogicJoints` to the `(slave,
   channel)` key.

Steps 1–2 are safe on a live panel. Steps 3–4 want a bench run against a
real multi-channel module before they go near one.

## 6. What was built

| Piece | Where |
|---|---|
| Per-channel decode, sign handling, scale/offset, stale-job check | `src/config-service/channel-decode.js` |
| Fan-out, one message per channel | flow node `2390b9df3335021b` "Scale Nano Reading" |
| Joint rows keyed `(unit, channel)`; ambient keyed `"<unit>:<channel>"` | `src/config-service/process-logic-joints.js` |
| Joint lookup on `(slaveID, channel)`; ambient state keyed the same | ProcessLogic `39dad91df0c15744` |

Two compatibility choices worth knowing:

- **A message with no `channel` is treated as channel 1.** That covers messages
  in flight across a deploy and the library-missing fallback path. Every slave
  on this panel is single-channel, so it is also the correct reading.
- **The channel-1 ambient keeps its original `AMBIENT_<unit>` id**; only
  channels 2+ get the `AMBIENT_<unit>_<channel>` form. Historian tags and any
  alarm already raised against an existing ambient survive untouched.

`sensorData` was left exactly as it is — it was already per-channel, so the
"nested vs composite key" question in the original draft was moot.

## 7. Live verification (2026-09-01)

A `LEGACY-4CH` module was commissioned at unit address **6**, carrying four
joints on registers 3/4/5/6, alongside eight single-channel slaves and the
ambient at 101. Nine joints monitored, configuration in sync.

Diagnostics showed all four channels distinctly — 31.06 / 36.06 / 41.06 /
46.06 — and the KPI stream for the second channel read:

```jsonc
{ "joint_name": "multich_1", "joint_id": "J07",
  "zone_id": "z1", "zone_name": "Zone1",
  "slaveID": 6, "channel": 2, "val": 36.12, "emaTemp": 36.09, "ror": 0.187,
  "ambient": { "slaveID": "101:1", "val": 31.72, "age_sec": 0, "source": "configured" },
  "deltaT": { "raw": 4.4, "ema": 4.18 },
  "sensor_status": "ok" }
```

That single message confirms every part at once: the fan-out (channel 2 arriving
as its own reading), the `(unit, channel)` joint match, the composite ambient key
`"101:1"` resolving through R14, ΔT computed per channel, and `joint_name`
persisted by the joint-table apply.

**Still simulation-only: the sparse layout.** This module's channels are
*consecutive* from the base address, which is the branch that would still decode
correctly even if the `channel_addrs` indexing were subtly wrong. A module with
non-consecutive addresses (100/104/108) remains the one case never exercised
against hardware.
2. **Should a shape-mismatched frame (§2) raise an alarm**, or only warn?
   It means the Nano is running a stale job, which the resend logic is
   supposed to make impossible — so it firing at all is a real signal.
