# BusductTherMo — development status

**Share this document with the design chat.** It is the one-page current
position: what is running, what is built but unproven, what is blocked, and what
needs a decision. Detail lives elsewhere (§7) — this is the summary that should
be enough to hold a design conversation without reading the repository.

**As of 2026-09-08.** Update this file when a slice changes state; it is only
useful if it is current.

---

## 1. Where the project is

Slices 1–11 are built. **Slices 1–9 are live-verified on real hardware**;
Slice 10 is verified apart from positional telemetry (deliberately off); Slice 11
is verified on Modbus TCP but not against a real BACnet gateway. Slice 8b — the
portability drill, pilot and rollout — has not started and is deliberately last.

Two deployments exist:

| | Test panel | Commercial building |
|---|---|---|
| Joints | 9 (incl. a 4-channel module) | 35 |
| Load | bench | ~2000 A, 430 V LV |
| Running since | continuous development | ~2 months |
| Observed | multi-channel decode verified; **two independent reference checks: J10 131 vs a Fluke 87V at 132.0 °C, and a bench comparison against a contact-type sensor agreeing within ±1 °C** | cover reaching 60 °C; WATCH on 1–2 joints; no false alarms |
| **Code version** | tracks `claude/code-handoff-strategy-y551k2` | **UNKNOWN — needs confirming (§5)** |

---

## 2. Slice status

| Slice | What | Status |
|---|---|---|
| 1 | Foundations | **Done**, live |
| 2 | Config service (schemas, R1–R16, A1–A10, audit) | **Done**, live |
| 3 | Nano job compiler + resend wiring | **Done**, live |
| 4 | Internal bus link-out taps | **Done**, live |
| 5 | Cloud Gateway (batcher, outbox, heartbeat) | **Done**, 24 h soak passed |
| 6 | AWS adapter + Fleet Provisioning | **Done**, live connect + soak passed |
| 7 | Remote config channel | **Done**, live-verified end to end |
| 8a | Security hardening (PINs from env, sudoers, kiosk) | **Done**, live-verified |
| 9 | Device blacklisting + recovery | **Done**, live-verified |
| 10 | Scale hardening (110 devices, 2 segments, ambient fallback) | **Done** except positional telemetry, which is built and **off by default** — no cloud consumer yet. **Re-opened then closed 2026-09-08**: HMI latency on both panels traced to oversampling defects and fixed — node-red **106 % → ~23 %** at 71 devices, **82 % → 35 %** at 6. See §3b. Headroom at 110 is no longer in doubt; 240 is gated by schema caps, not CPU |
| 11 | BMS integration (Modbus TCP + MGate CSV) | **Core done**, live on Modbus TCP. **Not verified against a real BACnet gateway** — needs the hardware |
| 8b | Portability drill, pilot, rollout | **Not started** — deliberately last, so the pilot runs against the shipping configuration |

### Built but not verified

| Item | State |
|---|---|
| Certificate rotation (Readiness Phase 1) | Built. **OFF by default** (`BUSDUCT_CERT_ROTATION=1`) — subscribing before the AWS policy grants it drops the whole connection. Live pass not done |
| `device_health` message | Publishing correctly from the panel. **AWS-side receipt unconfirmed** |
| LWT on `status/` topic | Code done. **Blocked on the AWS policy push** (§5) |
| Positional telemetry | Built, off. Waiting on the cloud pipeline |
| Channel decode — sparse register layout | Simulation-verified only. The installed modules are consecutive-layout, which decodes correctly either way |

### Not built

- **OTA update** (Readiness Phase 6) — A/B dual-bank, signed packages, auto-rollback. Substantial; depends on the Pi's boot layout. Design-chat item before implementation.
- **Cloud data pipeline** (IoT Rule → Timestream/S3) — a design-chat decision, not started.
- **Licence management** — proposal only (§4).

---

## 3. What changed on 2026-09-01 (all live-verified)

- Alarms carry the joint **name** as well as its id — HMI, e-mails, CSV, cloud
- Joint-scoped alarm descriptions lead with the joint id (`J02: ΔT 29.48 ≥ 25`)
- **ProcessLogic now reads the applied configuration**, not the legacy draft, so alarms are raised and swept against one source of truth. New "Configuration Status" banner names joints saved-but-not-applied
- **Multi-channel sensors work end to end** — per-channel decode, fan-out, `(unit, channel)` joint keying, composite ambient keys. Verified against a real 4-channel module
- Extended Pi/uplink health (disk, uptime, load, clock sync, Wi-Fi SSID/signal, cellular operator) + a **Panel & Uplink** tile on Diagnostics
- Blacklist alarm text now follows the joint mapping as channels are commissioned
- Sticky table headers across the config and diagnostic tables

Five regressions were introduced and fixed the same day; each is recorded in the
decision log with the cause. The recurring pattern — worth the design chat
knowing — is **trusting a stored value or an estimate that had never been
verified**: a migrated `temp_scale` that was a documented guess, a blast-radius
estimate taken from a note rather than the code, and an Angular directive's
semantics.

---

## 3a. What changed on 2026-09-05

- **First independent reference check**: J10 read 131 against a Fluke 87V
  thermocouple at 132.0 °C. Agreement is within the *reference's* uncertainty
  (±2.5–3 °C at that temperature), which is the most a working multimeter gives.
  It rules out gross scale, sign and offset error at a reading far above the
  working band — including the wrong `temp_scale` this panel still carries.
- **Sensor plausibility gate made two-sided.** The gate was `sensorVal > 300`
  only, so nothing rejected an implausibly *low* reading and a dead channel
  could present as a healthy cold joint. Now −40 … 300 plus a non-finite check.
  **Status corrected 2026-09-08: it was marked HELD, but ESBUSBBT04 and
  ESBUSBBT06 have since pulled and deployed several times, so it is live on
  both.** It remains **not field-validated**: the panel that showed J19 −273 and
  J09 exactly 0 was on unknown, older code, and was never identified as one of
  those two. Re-check those joints on that panel. See D2: the exact-zero case
  (J09) is deliberately still open.
  - Version-independent finding: both the legacy and current decode map raw
    `0x955C` to ≈ −273 °C (−272.99 vs −273.00), so **the module really is
    sending an absolute-zero sentinel** and updating will not make J19 read
    sensibly — it will only make it *classified* as a fault.

---

## 3b. HMI latency — resolved (2026-09-08)

**node-red 106 % → ~23 % of a core on the 71-device panel; 82 % → 35 % on the
6-sensor panel.** The first two fixes turned out to be the same bug in two
places: **work driven at a rate unrelated to the rate the data changes.**

| Cause | Oversampling | Fix |
|---|---|---|
| `poll_interval_s` set to 30 s, actually polling every 0.17 s — validated by R10, shown on the dashboard, **never sent to the Nano** | **297×** | `inter_frame_ms` raised per panel (250 ms on the 71-device panel, 500 ms on the 6-sensor one) |
| Legacy decode dispatcher re-running at **10 Hz** against values that change every ~20 s, fanning each sensor out to 21 branch filters with 20 message clones | **~200×** | one output per branch (21 wires → 1) + tick 0.1 s → 2 s |

| Panel | Before | After |
|---|---|---|
| ESBUSBBT04 (6 sensors) | 82 % | **35 %** |
| ESBUSBBT06 (71 sensors) | 106 % | **~23 %** |

**The two panels were limited by different halves.** The small one had a fast
sweep, so its cost was per-reading and the scan fix transformed it. The large one
already swept in 3.3 s, so its cost was the timer-driven dispatcher, which scales
with sensor count and ignores the scan rate — the scan fix moved it by nothing.
Same code, opposite bottlenecks.

A third fix followed on the same day: the Diagnostics table was cut over from the
legacy `sensorData` globals to the decoded readings plus the applied
`cfg/modbus` document. That briefly regressed node-red to 53 % by caching the
config in **node context** — which uses `contextStorage.default`, localfilesystem
on these panels, so a ~100 KB document was read off the SD card every second.
Moving it to module scope restored 23.4 %. **The rule: in this deployment
"context" means the SD card unless a store is named** — node, flow and global
scope are all the same store, and module scope is the only free memory.

**Four candidates were eliminated by direct experiment first**, three of them
mine: the Alarm Manager's history stringify (capped at 100), the legacy InfluxDB
feeder (already rate-limited), the historian write path (disabling it moved CPU
by *nothing* — but by 86 % of the disk writes), and browser/editor websocket
fan-out (4 points).

### Still open

- **The HMI itself is unconfirmed.** Every number says the server has headroom;
  whether the buttons respond is a separate observation. The client side —
  Chromium rendering 71-row tables on the Pi — has never been measured
  independently of the server.
- **Deleting the 20 unused decode branches.** Not done: the type names come from
  `Parameter.txt` on the Pi, so which a panel uses cannot be decided from this
  repo. After the routing fix an unused branch is never sent a message and costs
  nothing, so this is cosmetic. Read `parameterTypeName` and `parameterID0..N`
  from the context sidebar to produce a confirmed list.
- **SD wear** on panels that run the historian: ~29 TB/year at the old scan rate,
  now ~2.5. The write path is one HTTP POST per point; batching remains an
  optional further fix.

### D7 still stands

The interim fix is a hand-set per-packet delay whose correct value depends on
slave count — 500 ms suits 6 slaves and would give 71 slaves a 38 s sweep. The
compiler should derive it from `poll_interval_s`, and the interval itself needs
choosing against `maxAgeSec` (60 s) and blacklist detection (3 sweeps).

---

## 3c. A stuck scan flag was disabling all measurement (2026-09-08)

`function 14` on `modbusMaster_V2` gated the **entire** measurement path on
`scanActive != 1` — fail-closed, with the flag cleared only by a scan counter
reaching 127. If address 1 never answered, a frame was dropped, Node-RED
restarted mid-scan, or the panel's sensors were on **bus2** (the scan job is
bus1-only), the flag latched forever — and flow context is localfilesystem-backed,
so it survived reboots. The panel looked healthy while monitoring nothing.

Fixed with `src/config-service/scan-gate.js`: **bounded** (releases after 120 s
and restores the polling job), **scoped** (a bus1 scan never blocks bus2), and
**fails open** on missing information or a missing library. **Live-verified
2026-09-08** — data flowed immediately on deploy.

**Only the blast radius was fixed, not the scan itself.** Start Scan still writes
its job through the bus1-only legacy `paraRaw` path and still detects completion
by counting exactly 127 frames from address 1 upward, so on a bus2 panel it
cannot work — it now releases after 120 s instead of disabling the panel. Routing
it through the compiler is the same bus1-only legacy dependency as **D7**; worth
doing as one piece of work.

**Third instance of the same pattern** — after the stuck blacklist alarm and the
stale exclude set. Worth stating as a rule: *state whose clearing depends on an
event that may never arrive needs a deadline, not just a clearer.*

---

## 4. Decisions needed from the design chat

| # | Decision | Why it needs the chat |
|---|---|---|
| D1 | **Licence management** — see `docs/licence-management-proposal.md` §9 | Six open decisions. §1 is the blocking one and is a **business** call: what a lapsed licence may switch off. As specified it blinds both the HMI and the BMS at once, on a fire-safety monitor. Recommendation is to gate commercial value, never the alarm path |
| D2 | **"Reads implausibly cool" as a fault class** | Originally raised as a *detachment* rule: the magnetic clamp can lose grip when hot, and a detached sensor reads near ambient, i.e. as a *healthy cool joint*. **2026-09-05 made it broader** — a dead channel on the test panel produced the same signature (J19 −273, J09 exactly 0, unalarmed) by a different route. The bound fix catches −273; exact zero needs a rule, because 0 °C is real in an unheated panel. A sustained near-ambient or negative ΔT on a loaded joint is not physical. **New A-rule**, so it belongs here |
| D3 | **Alarm thresholds for cover-mounted sensing** | **Not closed by the 2026-09-08 reference checks** — those validate the sensor and its decode chain, not the cover-to-joint transfer function. The sensor reads the *cover*, not the conductor — lower absolute, and RoR damped by the cover plus the 5 mm mounting plate. Thresholds inherited from conductor limits would read healthy while a joint overheats. Needs the E6 characterisation (§6) before numbers are trusted |
| D4 | **Cloud data pipeline** — IoT Rule → Timestream/S3, or alternative | Not started. Gates positional telemetry and any fleet view |
| D5 | **OTA update approach** | A/B scheme depends on the Pi's OS/boot layout |
| D6 | **HIRA sign-off** — `docs/hira-live-sensor-installation.md` | Needs a competent person and the duty holder. Currently a 9-revision draft; the electrical conclusion is settled (external cover mounting, intact enclosure), the open items are measurement questions |
| D7 | **Enforce the poll interval in the compiler, and choose its value** — see §3b | `poll_interval_s` is validated, displayed and never actuated; the operator-facing knob that *does* work is a per-packet delay whose correct value depends on slave count. Compiler-only fix, no reflash. The interval itself interacts with `maxAgeSec` and blacklist detection, so it is a monitoring-policy decision, not a default  **Also gates 240-sensor sizing** (decision log 2026-09-08): the 500 ms cap means fatter modules *raise* the reading rate, and `joints` maxItems 200 blocks 240 points outright. |
| D8 | **No absolute temperature alarm exists** — found 2026-09-08 | The alarms schema defines only `deltaT` and `ror` (plus the 300 °C plausibility bound). A joint can sit at a dangerous absolute temperature with a small ΔT and a flat RoR — a panel-wide ambient rise, or a drift that has already stabilised — and the Alarm Manager says nothing. The **only** absolute alerting today is the legacy `SMS and Email for alerts` node reading `global.sensorData`, which is on the decode chain now proposed for deletion. Needs a new A-rule before that chain goes |

---

## 5. Blocked on us / waiting

| Item | On whom |
|---|---|
| **AWS policy push** — grant publish on `status/{c}/{s}/{p}` as a new active policy version | Site/AWS admin. Gates the LWT and confirming `device_health` receipt |
| **Scale column → `0.01`** in Modbus Settings on the test panel | Site. Clears a standing warning and stops the config carrying a value the next reader would trust |
| **Confirm what code version each deployment runs** | Site. Not currently known for the commercial building, and on 2026-09-05 an out-of-date *test* panel led to a field observation being read as current-code behaviour. Record the build before drawing conclusions from a screen |
| **Apply the poll-interval fix to ESBUSBBT06 (71 devices)** — ~50-100 ms, not the 500 ms used on the small panel | Site. See §3b: the value does not transfer, and that panel needs its own before/after measurement |
| **Re-check J09 / J19 after updating the test panel** | Site. Confirms the held plausibility-gate fix, and settles whether J09's zero is a sentinel or a fabricated default |
| **Reference BACnet gateway hardware** | Procurement. Gates Slice 11's last acceptance criterion and the first real MGate CSV import |
| **Thermography on the 1–2 flagged joints** | Site. See §6 — the single highest-value action available right now |

---

## 6. The one thing most worth doing next

**Thermography on the 1–2 joints currently at WATCH, against their neighbours.**

It delivers three things at once and the opportunity disappears when the flags
clear:

1. **Validates the flag** — is the joint itself hotter, or only its cover?
2. **Gives the cover-to-joint transfer function at two points** — a normal joint
   and a warm one, so the *slope* is known and not just an offset. This is what
   D3 needs.
3. **It is the closest available test of detection capability** without waiting
   for a real fault.

Two months without alarms evidences that the system runs. The WATCH on 1–2 of 35
evidences that it **discriminates** between joints — which is genuinely
encouraging, and partly answers the worry that cover mounting would damp the
signal away. Neither evidences that it would **detect a real fault**, because
none has occurred. Thermography is the nearest substitute.

---

## 7. Where the detail is

| Topic | Document |
|---|---|
| The plan and its acceptance criteria | `docs/BusductTherMo_Edge_Implementation_WorkPlan.md` |
| Phase-level plan; §6 is Slice 8b's exit gate | `docs/BusductTherMo_Edge_Cloud_Readiness_Workplan.md` |
| Every decision and its reasoning, chronological | `docs/decision-log.md` (long) |
| Standing rules and current state, for the implementer | `CLAUDE.md` |
| Device → cloud wire contract | `docs/aws/README.md` Part G + `src/cloud-gateway/message-types.js` |
| BMS register map (customer-facing, append-only) | `docs/bms-register-map.md` |
| Operator/technician guide | `docs/edge-user-manual.md` |
| Licence proposal | `docs/licence-management-proposal.md` |
| Channel decode findings | `docs/channel-decode-proposal.md` |
| Installation HIRA | `docs/hira-live-sensor-installation.md` |
