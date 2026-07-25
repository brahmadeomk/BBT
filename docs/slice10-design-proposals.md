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

**Status (2026-07-25): the cloud-agnostic CORE is built and unit-tested;
the flow-side wiring of a second physical pipeline is a documented
runbook (below), pending a physical second Nano to wire and live-test.**
A single-bus panel is byte-for-byte unchanged — every new parameter is
optional and defaults to the single-bus behaviour.

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
  response within its bus (unit addresses are unique per-bus, not
  globally), and `processReadResult` reads the segment tag from
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

### Flow-wiring runbook (per second physical Nano)
The `/src` core is bus-aware; wiring a real second segment into
`flows_BBT.json` means duplicating the bus1 pipeline for bus2 and
tagging bus2's responses. Do this once a second Nano is physically
present on `/dev/ttyACM1` (the two-segment config must have a `bus2`
entry with its own `port`, and its slaves' `bus_id: 'bus2'`):

1. **Config** — in the Modbus Settings dashboard, commission bus2's
   slaves with `bus_id: 'bus2'`. `compileNanoJob(doc, {busId:'bus2'})`
   then compiles that segment on its own; bus1 is unaffected.
2. **Second serial pair** — clone the `modbusMaster_V2` `serial in`/
   `serial out` nodes, pointing the new pair at `/dev/ttyACM1` @ the
   bus2 baud. Keep the same `json`-node framing before the serial out.
3. **Second Send Nano Job** — clone the `Send Nano Job` function node;
   have it call `buildNanoJobMessage(store, {busId:'bus2', excludeSlaveIds})`
   and feed the bus2 `json`/`serial out`. Wire its three triggers
   (boot inject, post-USB-power-cycle delay, post-apply link) exactly
   as bus1's, but off the bus2 recovery/serial nodes.
4. **Bus-tag the bus2 response tap** — on the bus2 `serial in` →
   `json` path, set `msg.bus_id = 'bus2'` in a tiny function node
   before the Device Health "Data Out" tap. `processReadResult` reads
   `payload.bus_id`, so a bus2 unit-5 response records against the
   `bus2` slave, not the `bus1` slave with the same address. (bus1's
   tap needs no tag — `busId` omitted matches the single-bus path.)
5. **Per-bus resend on blacklist** — the exclude set is global by
   `slave_id`; when the Device Health engine decides a resend, recompile
   **only the affected bus** (`busId` of the slave whose state changed)
   so the other segment's polling isn't glitched.
6. **Per-bus recovery controller** — give bus2 its own `uhubctl` port
   in the RECOVERY CONTROLLER exec node and its own serial-silence
   watchdog, so a wedged bus2 Nano is power-cycled without touching
   bus1.

Verify on the bench with two Nanos before the panel: pull bus2's link
and confirm only bus2 slaves go OFFLINE/blacklisted while bus1 keeps
polling, then restore and confirm bus2 recovers independently.
