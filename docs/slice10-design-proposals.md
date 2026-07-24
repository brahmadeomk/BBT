# Slice 10 — design proposals for the two design-sensitive items

These two Slice 10 workstreams change contracts beyond the edge and
should be signed off in the companion design chat before implementation.
The other Slice 10 items (ambient outlier/fallback, R16 warning
surfacing, 3-digit `slave_id`) are built. Status: **proposal, not built.**

---

## A. Positional-array telemetry payload (cloud wire-format change)

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

### Today
One RTU bus, one Nano on `/dev/ttyACM0`, one `serial in`/`serial out`
pair, one Send Nano Job path, one response stream, one blacklist tracker.
`compileNanoJob` **rejects** any document with more than one bus.

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
one-bus config keeps working unchanged).
