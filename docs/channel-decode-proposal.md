# Recovering the channel in the decode path — findings

**Status: EXPLORATION + PROPOSAL, not built.** Asked 2026-09-01: can the
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

## 5. Blast radius — the reason this is a proposal

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

## 6. Open questions

1. **Is there a multi-channel module to test against?** Everything above
   is derived from the firmware source, the compiler and the schema; none
   of it has been exercised against real multi-channel hardware.
2. **`sensorData` shape** — nested by channel, or a `"3:2"` composite key?
   Nested is cleaner; composite is a smaller diff across ~40 nodes.
3. **Should a shape-mismatched frame (§2) raise an alarm**, or only warn?
   It means the Nano is running a stale job, which the resend logic is
   supposed to make impossible — so it firing at all is a real signal.
