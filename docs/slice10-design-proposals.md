# Slice 10 — design proposals for the two design-sensitive items

These two Slice 10 workstreams change contracts beyond the edge and
should be signed off in the companion design chat before implementation.
The other Slice 10 items (ambient outlier/fallback, R16 warning
surfacing, 3-digit `slave_id`) are built. Status: **proposal, not built.**

---

## A. Positional-array telemetry payload — **EDGE BUILT (off by default)**

**Update 2026-07-24:** the edge side is implemented in `Batcher`
(`positional` mode, column-oriented payload + self-versioning manifest,
index-range chunking), **OFF by default** — the live keyed format is
unchanged until the cloud is ready. Enable with
`publish.telemetry.encoding: 'positional'` in the edge config. Since the
cloud pipeline (IoT Rule → DB) isn't built yet, it will be written to
consume this format directly (no lockstep migration). The section below
is the format the cloud must match.


### Today
`src/cloud-gateway/batcher.js` emits **keyed JSON** and splits at
`max_payload_bytes` (4800):

```json
{ "timestamp": "...", "interval_min": 10,
  "joints": { "J01": { "dt_min": 1.1, "dt_max": 2.2, "dt_avg": 1.6,
                       "ror_max": 3.0, "t_avg": 42.1, "amb_avg": 31.0 }, ... } }
```

At 100 joints that's ~several messages per interval → several AWS IoT
**5 KB metering blocks** per interval per panel.

### Proposed
A per-panel **manifest** (index → joint_id), republished only on config
change, plus a compact **column-oriented** telemetry payload keyed by
index. Whole panel in one ~2.5 KB message.

Manifest (retained-style, sent on config change and on request):
```json
{ "type": "manifest", "manifest_version": 7,
  "joints": ["J01","J02", "...", "J100"] }
```

Telemetry (per interval):
```json
{ "timestamp": "...", "interval_min": 10, "manifest_version": 7,
  "dt_min":  [1.1, ...], "dt_max": [2.2, ...], "dt_avg": [1.6, ...],
  "ror_max": [3.0, ...], "t_avg":  [42.1, ...], "amb_avg": [31.0, ...] }
```
- Row *i* of every array is the joint at manifest index *i*.
- A non-measurable joint (blacklisted / no data this interval) is `null`
  at its index — length always equals the manifest.
- `manifest_version` lets the cloud detect a stale manifest and re-fetch.
- Chunk-splitting stays as a safety net for pathological sizes.

### Decisions for the design chat
1. **Column vs row layout** — column arrays (above) compress better and
   are trivial to parse; row-of-tuples (`m: [[...],[...]]`) is denser but
   positional-within-row. Recommend **column**.
2. **Manifest delivery** — options: (a) a retained MQTT topic
   `.../manifest`; (b) inline on the telemetry topic on config change +
   every N intervals as a heartbeat. AWS Basic Ingest can't retain, so a
   retained topic needs a normal (non-Basic-Ingest) publish. Recommend a
   dedicated `.../manifest` topic, QoS 1, published on config change and
   at boot.
3. **Cold-start ordering** — if the cloud sees telemetry before the
   manifest, it buffers by `manifest_version` until the manifest arrives.
4. **Field set + order is an append-only contract** — never reorder or
   repurpose a column; only append. Document it like the BMS map.
5. **Cloud-side parser** (IoT Rule → Lambda/Timestream) must be updated
   in lockstep — this is the actual reason it's a design-chat decision.

### Edge work once agreed
`Batcher.flush()` gains a positional mode (config-flagged so the old
keyed mode stays available for rollback); a manifest publisher on the
config-apply path; tests for both encodings + the null-at-index rule.

---

## B. Two-segment RS-485 (edge architecture change)

**Status (2026-08-08): the cloud-agnostic CORE and the COMMISSIONING UI
are built and unit-tested; the flow-side wiring of a second physical
pipeline is a documented runbook (below), pending a physical second Nano
to wire and live-test.**
A single-bus panel is byte-for-byte unchanged — every new parameter is
optional and defaults to the single-bus behaviour.

Built in the **Modbus Settings dashboard** (2026-08-08 — the operator can
now define the second segment; previously the schema allowed two buses
but there was no way to enter one):
- An **RS-485 Buses table** (was a single fixed bus form) with ADD BUS /
  DEL, one row per segment, each with its own port/baud/parity/stop
  bits/timeout/retries/inter-frame. Bus ids are allocated (`bus1`,
  `bus2`, …) rather than typed.
- A **Bus column on every slave channel row**, a dropdown over the
  defined buses.
- Apply-time guards: two buses may not share a serial port ("each RS-485
  segment needs its own Nano on its own port"); a bus can't be deleted
  while sensors sit on it (named); a slave can't reference an undefined
  bus; all channels of one unit must be on one bus.
- **Unit addresses must be unique across ALL buses on the panel**, not
  merely per-bus as Modbus itself requires. This is a deliberate,
  narrower-than-the-protocol rule: the surviving legacy decode pipeline
  (~40 function nodes on `modbusMaster_V2`) stores readings in
  `sensorData[<unit_address>][…]`, keyed by address alone, so the same
  address on two segments would silently overwrite itself. With 247
  addresses available the constraint costs nothing; making the legacy
  decode bus-aware would be a large change to the live data path.
- **Resend is decided per bus** (`resendBusIds`): the apply emits one
  `{payload:'apply', busId}` message per *changed* segment, so a
  bus2-only edit never glitches bus1's live polling (the firmware
  re-inits its Modbus timeout on every job update).
- `Send Nano Job` reads its own segment from `env BUSDUCT_BUS_ID`
  (default `bus1`) and ignores a resend aimed at another segment. On a
  single-bus panel the id is a *preference*, not a filter — renaming the
  sole bus can't stop the panel polling.
- The **legacy bridge is bus1-only** by design: `comm` globals and
  `paraRaw` (the legacy read-job builder's input, used by the
  serial-silence recovery path) describe/list bus1 only, because that's
  the only serial port the legacy job builders write to. `SlaveIDList`/
  `parameterName{i}`… keep every channel on every bus, since the decode
  side must handle a response from either Nano — which is exactly why
  addresses are forced unique panel-wide.

Built (in `/src`, fully unit-tested):
- `compileNanoJob(doc, {busId})` compiles one job per bus (filters
  `modbus.slaves` by `s.bus_id === bus.bus_id`), emits that bus's own
  `comm`, and errors with `specify {busId}` on a multi-bus doc when no
  `busId` is given — instead of the old flat "single bus" rejection.
- `nanoJobsEqual(docA, docB, busId)` compares per bus, so a bus2-only
  change doesn't force a bus1 resend and vice-versa.
- `buildNanoJobMessage(store, {busId})` threads `busId` through to the
  compiler for the Send Nano Job node.
- Blacklist handler: `unitToSlaveId(doc, unitAddress, busId)` resolves a
  response within its bus (Modbus only guarantees a unit address is
  unique per-bus — though this panel's commissioning UI additionally
  forces it unique panel-wide, see above), and `processReadResult` reads
  the segment tag from
  `ctx.busId ?? payload.bus_id`. One tracker still serves both buses —
  it keys by the globally-unique `slave_id`.

### Today (single physical pipeline)
One RTU bus, one Nano on `/dev/ttyACM0`, one `serial in`/`serial out`
pair, one Send Nano Job path, one response stream, one blacklist tracker.
The code now *accepts* a multi-bus document, but the shipping flow still
wires only bus1 — adding the bus2 pipeline is the runbook below.

### Why
R16 warns above ~87% unit-load at 110 devices on a single segment.
Splitting into two ~55-device segments gives ~43% loading each, halves
worst-case scan time, and halves the blast radius of one bad
transceiver (the J28 failure mode).

### The real work (and the decisions)
1. **Compiler** — `compileNanoJob(doc, {busId})` compiles one job per
   bus instead of rejecting multi-bus. The schema already allows up to 4
   buses with per-bus `port`.
2. **Port → bus mapping** — each bus's `port` field (e.g. `/dev/ttyACM0`,
   `/dev/ttyACM1`) drives a dedicated serial node pair. The flow's serial
   nodes are currently hardcoded to `/dev/ttyACM0`. **Decision:** how many
   segments to support in the shipping flow (2 is the ask) and whether to
   duplicate the decode pipeline per bus or genericize it.
3. **Response → slave identity** — the Nano's `{t:'r',id}` carries the
   *unit address*, which is **only unique within a bus**; two Nanos can
   both have unit 5. So each response must be **tagged with its bus** (by
   which serial-in it arrived on) before the blacklist tracker /
   decode maps it to a `slave_id`. The tracker keys by `slave_id`
   (globally unique), so one tracker still serves both buses once
   responses are bus-tagged.
4. **Recovery controller** — per-bus USB power-cycle (each Nano on its own
   `uhubctl` port); the serial-silence watchdog + resend must run per bus.
5. **Blacklist resend** — the exclude set is global by `slave_id`, but a
   resend must recompile+resend only the affected bus's job.

### Recommendation
Land this as: keep the current pipeline as **bus1**, add a parallel
**bus2** pipeline (second serial pair + Send Nano Job + response tap
tagged `bus2`), genericize `compileNanoJob`/`buildNanoJobMessage` by
`busId`, and make the recovery controller per-bus. It's a sizable flow
restructure, so agree the port-mapping and response-tagging approach
first, then build behind the existing single-bus behaviour (a
one-bus config keeps working unchanged). **The `/src` core recommended
here is now built (see Status above); what remains is the flow wiring.**

### Panel acceptance drill for the commissioning UI (no second Nano needed)

Two halves, because they check different things.

**1. The guards — `node tools/multibus-guard-drill.js` on the Pi.**
It reads the live `cfg/modbus+joints` **read-only**, rebuilds it in a temp
directory, and exercises every guard there, so it is safe to run on a panel
that is monitoring. It prints each rejection against your real slave names,
which is the point: a guard is only useful if a commissioning engineer can act
on its wording. It also asserts that a rejected apply does **not** bump the
config version. Expect `ALL GUARDS PASS`.

**2. The dashboard — click through it, because the script cannot.**
The script drives the handler directly; it says nothing about whether the UI
sends the right thing. On the Modbus Settings page:

| Step | Expected |
|---|---|
| Press **ADD BUS** | a `bus2` row appears, pre-filled `/dev/busduct-bus2` |
| Set bus2's port to bus1's port, **APPLY CONFIG** | alert: *"Two buses share the serial port …"*, nothing applied |
| Restore bus2's port, **APPLY CONFIG** | *"Modbus configuration applied"* — bus2 now exists, empty |
| Reload the page | the bus2 row is still there (it came from the applied config, not the browser) |
| Edit any sensor, set its **Bus** to `bus2`, SAVE, **APPLY** | rejected: unit address now on two buses — see the warning below before doing this deliberately |
| Press **DEL** on bus2 | removed (it carries nothing) |
| Look at **DEL** on bus1 once it is the only bus | **greyed out / disabled**, tooltip *"The panel needs at least one RS-485 bus"* — the UI does not let you attempt a delete that can only fail |

The last-bus rule cannot be exercised from the dashboard by design, so the
server-side guard behind it is covered by `tools/multibus-guard-drill.js`
instead ("delete the last remaining bus"). The guard stays in the handler
regardless of what the UI offers — the remote-config path and any future
scripted client reach it too.

**⚠ Do not move a live sensor onto bus2 on a production panel.** There is no
second Nano yet, so a sensor on bus2 is commissioned but **not polled**: its
joint goes dark and will blacklist, and if you move the *ambient* unit every
joint loses ΔT. The apply guards happen to block the common form of this (a
repeated unit address), but a genuinely unused address would go through. Move
it back and re-apply to recover.

**Committed vs rejected:** only the "APPLY an empty bus2" step changes the
applied config. Every guard step ends in a rejection, so nothing is written and
the panel keeps polling throughout. Adding an empty bus is itself harmless —
its resend message is addressed to `bus2` and the single `Send Nano Job` node
(env `BUSDUCT_BUS_ID` = `bus1`) drops it.

### Second segment: BUILT in the flow (2026-08-10)

A second Nano is physically connected on `/dev/ttyACM1`, and the bus2
pipeline is now wired in `flows_BBT.json` on the `modbusMaster_V2` tab.
What exists:

- **`serial-port` config** `/dev/ttyACM1` @115200, framing identical to
  bus1's (`\n` newline, char output, 10 s response timeout).
- **`bus2 Nano in` → `Tag Bus2`** → the *same shared* decode / UI /
  Data-Out chain bus1 uses. Sharing is deliberate and safe: the decode
  pipeline keys `sensorData` by unit address and the commissioning UI
  forces addresses unique across **all** buses, so one chain can serve
  both Nanos without duplicating ~40 nodes.
- **`Tag Bus2`** stamps `msg.bus_id = 'bus2'` — a **top-level msg
  property, not `msg.payload.bus_id`**. At the serial edge (the only
  place that knows which wire a frame arrived on) the payload is still a
  raw string; the `json` node downstream rewrites `payload` but leaves
  other msg properties alone, so the tag survives to the blacklist tap.
  The **Blacklist Engine** passes it through as `ctx.busId`.
- **`Send Nano Job (bus1)` / `(bus2)`**, each naming its segment, each
  dropping a resend whose `msg.busId` belongs to the other. Both are fed
  by the shared `Resend Nano Job (in)` link and the boot inject.
- **A separate 30 s serial-silence watchdog per segment.** bus2 traffic
  must never keep bus1's watchdog alive, or a dead bus1 would look
  healthy. bus2's watchdog recovers by resending **its own compiled
  job**, not the legacy `paraRaw` read-job builder (which is bus1-only
  by design — see the legacy-bridge note above).

`test/two-segment-flow-wiring.test.js` asserts each of these properties,
because the flow is hand-imported JSON and a half-wired segment fails
silently: it just stops polling half the panel.

#### Correction: the bus id is a LITERAL, not an env var

An earlier version of this runbook said to clone `Send Nano Job` and set
`BUSDUCT_BUS_ID=bus2` "in the clone's env tab". **That is not possible.**
Function nodes have no per-node environment in Node-RED: `env.get()`
resolves from the enclosing *group*, then the *tab*, then the process
environment. Both `Send Nano Job` nodes live on the same tab, so an env
var could never differ between them — it would have silently given both
segments the same identity, and bus2's Nano would have been sent bus1's
job. Each node now declares `const MY_BUS = 'bus1' | 'bus2'` as a
literal, and the wiring test rejects any reintroduction of the env
lookup.

#### Alarm generation for the second segment (2026-08-10)

The wiring above carries bus2's *data*. Raising an *alarm* about bus2 needed
a further layer, because most of what decides an alarm was per-panel state
that looks correct right up until a whole segment dies.

- **ΔT / RoR alarms needed nothing.** bus2's frames reach ProcessLogic
  through the shared chain, and ProcessLogic is keyed by unit address — which
  is unique panel-wide. This is what the shared-chain decision bought.
- **One COMM watchdog per segment, and they must not cross-feed.** The
  transport wiring routed bus2's raw frames into bus1's `Data Out`, which
  feeds *the* COMM watchdog. That watchdog is then satisfied while **either**
  Nano is talking — so a live bus2 masked a dead bus1 and vice versa, and
  neither segment's total failure could raise a COMM alarm at all. bus2 now
  has its own `Data Out 2 (bus2)` → `Data In 2 (bus2)` → **COMM watchdog
  bus2**, emitting `{commTimeout, busId:'bus2'}`.
- **The Alarm Manager keys the COMM alarm by segment.** No `busId` (or
  `bus1`) still yields `SYSTEM|MODULE|COMM_FAILURE` — byte-identical, so
  bus1's alarm identity, history and ACK state are continuous. Anything else
  yields `SYSTEM|BUS2|COMM_FAILURE`, raised and cleared independently.
- **Per-bus blacklist resend** (closes outstanding item 2 below).
  `_finalize` now returns `resendBusIds` — the buses of the slaves that
  entered or left the exclude set — and the Device Health engine emits one
  resend per affected segment.
- **Per-bus USB recovery** (closes item 3). The RECOVERY CONTROLLER is now
  thin over `src/config-service/bus-recovery.js` (`planRecovery` — pure,
  timing-injected), running the same ladder (90 s → cycle → 60 s cooldown →
  3 attempts → one email) independently per segment, with a 4th output
  driving bus2's own `exec`. bus1 keeps its hardcoded `-l 1-1` and its
  `SYSTEM|MODULE|RESET_n` events.

`test/flows-bus2-alarms.test.js` pins these; the transport properties stay in
`test/two-segment-flow-wiring.test.js`.

#### Two fixes from the first panel drill (2026-08-10)

- **The silence watchdog now retries.** It was a `trigger` node, which fires
  once and then needs an input message to re-arm — and its input is the very
  frame stream that has gone quiet. A Nano that missed that single resend
  (still booting its USB CDC, or re-enumerated) would never be handed a job
  again and stayed dark. Replaced with a liveness stamp written by `Tag Bus2`
  plus a 15 s check that resends every 30 s for as long as the segment is
  silent.
- **The Diag status column expires.** `global.Status[addr]` is written only
  when a frame for that device is decoded, and nothing expired it — so a
  device that stopped being polled at all (blacklisted, or its segment down)
  kept showing its last good value forever, and a dead segment rendered as an
  all-green panel. Each write is now stamped; an entry older than 60 s reads
  **"No Data"** and renders as a fault. 60 s is comfortably longer than any
  configured poll interval, so a live device never flickers.

#### Operator steps before the drill

1. **Commission bus2's sensors** — Modbus Settings → the bus2 row already
   exists; set each bus2 sensor's **Bus** column and APPLY. Until a sensor is
   moved, bus2's Nano is polled with an empty read list.
2. **`BUSDUCT_UHUBCTL_BUS2`** — the hub location of the second Nano
   (`sudo uhubctl` lists them, e.g. `1-2`), in `/etc/busduct/nodered.env`.
   Unset means bus2 alarms normally but is never power-cycled; the controller
   warns once per episode rather than silently doing nothing. The value is
   pattern-validated before it reaches the root shell. If you have pinned
   exact sudo arguments, note bus2's cycle command has a different form than
   bus1's — see `deploy/sudoers.d/busduct-nodered`.
3. **Restart** Node-RED, not just Deploy — `planRecovery` is new in
   `functionGlobalContext`, which is only re-required at startup.

#### Two-segment acceptance drill

| Step | Expected |
|---|---|
| Boot | both Nanos get a job; sensors on both segments report |
| Unplug **bus2's RS-485 link** | only bus2's devices blacklist; bus1's joints keep updating |
| Leave bus2's **Nano** unplugged 60 s | `SYSTEM\|BUS2\|COMM_FAILURE` raises; `SYSTEM\|MODULE\|COMM_FAILURE` does **not** |
| A further 90 s, with `BUSDUCT_UHUBCTL_BUS2` set | only bus2's hub port cycles; bus1 never stops polling |
| Reconnect bus2 | its COMM alarm clears, devices restore, joints leave STALE/OFFLINE |
| Edit a bus2 sensor and APPLY | only bus2 resends |
| Blacklist a bus1 device | the resend names bus1 only |

⚠ **Two things that will confuse the drill if you do not expect them.**
A disconnected transmitter on this hardware can keep answering Modbus with a
fresh, in-band, status-OK `0.0 °C` for **~20 minutes** before the bus finally
comm-fails (documented 2026-07-28, and why the ambient resolver has a zero
sentinel). Nothing blacklists during that window. And USB enumeration order is
not stable across reboots — two identical Nanos can swap `ttyACM0`/`ttyACM1`,
which sends each segment the other's read list. Check
`ls -l /dev/serial/by-id/` before starting; a udev rule pinning each board's
serial to a stable symlink is the permanent fix.
