# BusductTherMo — development status

**Share this document with the design chat.** It is the one-page current
position: what is running, what is built but unproven, what is blocked, and what
needs a decision. Detail lives elsewhere (§7) — this is the summary that should
be enough to hold a design conversation without reading the repository.

**As of 2026-09-07.** Update this file when a slice changes state; it is only
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
| Observed | multi-channel decode verified; **J10 reads 131 vs a Fluke 87V at 132.0 °C** | cover reaching 60 °C; WATCH on 1–2 joints; no false alarms |
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
| 10 | Scale hardening (110 devices, 2 segments, ambient fallback) | **Done** except positional telemetry, which is built and **off by default** — no cloud consumer yet. **⚠ Re-opened 2026-09-07**: HMI latency traced to a **297× over-sample** — `poll_interval_s` is validated and displayed but never sent to the Nano. Raising `inter_frame_ms` 10→500 on the 6-sensor panel cut node-red from **82 % to 35 %** of a core and readings from 3558 to 304/min. **The 71-device panel still needs its own fix** (a different value — see the decision log) and the compiler change that derives the delay from the configured interval |
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
- **Sensor plausibility gate made two-sided — built and tested, but HELD, not
  deployed.** The gate was `sensorVal > 300` only, so nothing rejected an
  implausibly *low* reading and a dead channel could present as a healthy cold
  joint. Now −40 … 300 plus a non-finite check. The defect is visible in the
  source independently of any device, which is why the fix is kept; but the
  panel that showed it (J19 −273, J09 exactly 0) **is not running current
  code**, so it is not field-validated. Re-check those joints after the update.
  See D2: the exact-zero case (J09) is deliberately still open.
  - Version-independent finding: both the legacy and current decode map raw
    `0x955C` to ≈ −273 °C (−272.99 vs −273.00), so **the module really is
    sending an absolute-zero sentinel** and updating will not make J19 read
    sensibly — it will only make it *classified* as a fault.

---

## 3b. HMI latency — root cause found and fixed (2026-09-07)

**The panel was sampling 297× faster than it was configured to.**
`slaves[].poll_interval_s` (default 30 s) is set by the operator, shown on the
dashboard and validated by R10 — but `compileNanoJob` never sends it. The only
rate control reaching the Nano is `bus.inter_frame_ms`, applied as a delay
between transactions while the firmware loops its read list continuously. There
is no per-slave scheduling in the firmware at all.

Fixed on the 6-sensor panel by raising `inter_frame_ms` from 10 ms to 500 ms — a
config change, no code:

| | Before | After |
|---|---|---|
| readings/min | 3558 | **304** |
| node-red %CPU | 82 | **35** |
| idle | 54-66 % | 82-84 % |
| SD writes | 83 GB/day | ~7 GB/day |

**Four candidates were eliminated by direct experiment before this one landed**,
three of them mine: the Alarm Manager's history stringify (the history is capped
at 100), the legacy InfluxDB feeder (already rate-limited), the historian write
path (disabling it moved CPU by *nothing* — but by 86 % of the disk writes), and
browser/editor websocket fan-out (4 points). Only the scan rate mattered.

### What is still open

- **~30 % of a core is a fixed cost**, independent of scan rate — the periodic
  work (BMS refresh, blacklist tick, applied-joints publish, health nodes,
  dashboard). Acceptable at 4 cores; it is the term that grows with panel size.
- **The 71-device panel is NOT fixed, and must not be given the same value.**
  `inter_frame_ms` is a *per-packet* delay, so 500 ms there means a **38 s
  sweep** — past its configured interval, near the Diagnostics 60 s "No Data"
  expiry, and pushing ambient age toward the 60 s `maxAgeSec` beyond which ΔT is
  silently dropped. ~50-100 ms is its region. It also needs its own measurement:
  at ifm=10 its sweep was already 3.3 s (~21 readings/s, *lower* than the small
  panel's 59/s) yet its node-red was higher, so its cost is mostly the fixed
  term.
- **~8.7 ms of CPU per reading** is still far more than the ~57 µs the four
  benchmarked function nodes account for. Harmless at 5 readings/s; it is why the
  panel was ever in trouble, and it would return at higher device counts.

### The proper fix (design chat — D7)

Derive the delay from the configured interval in `compileNanoJob`:

```
perPacket = max(inter_frame_ms, (min(poll_interval_s) * 1000 / slaveCount) - txEstimate)
```

**Compiler-only — no firmware reflash**; `comm[0]` is just microseconds between
transactions, stored in a `long` with no firmware cap, and the 500 ms limit lives
only in the JSON schema on a field named for the RS-485 inter-frame gap. Every
fielded panel would be corrected by a config re-apply. The correct value is a
function of slave count, which is precisely why no operator should be setting it
by hand.

**And the target interval needs deciding, not defaulting.** 30 s interacts with
`maxAgeSec` (60 s, beyond which ambient is rejected and ΔT silently stops) and
with blacklist detection (3 sweeps). ~5-10 s looks right on the numbers.

---

## 4. Decisions needed from the design chat

| # | Decision | Why it needs the chat |
|---|---|---|
| D1 | **Licence management** — see `docs/licence-management-proposal.md` §9 | Six open decisions. §1 is the blocking one and is a **business** call: what a lapsed licence may switch off. As specified it blinds both the HMI and the BMS at once, on a fire-safety monitor. Recommendation is to gate commercial value, never the alarm path |
| D2 | **"Reads implausibly cool" as a fault class** | Originally raised as a *detachment* rule: the magnetic clamp can lose grip when hot, and a detached sensor reads near ambient, i.e. as a *healthy cool joint*. **2026-09-05 made it broader** — a dead channel on the test panel produced the same signature (J19 −273, J09 exactly 0, unalarmed) by a different route. The bound fix catches −273; exact zero needs a rule, because 0 °C is real in an unheated panel. A sustained near-ambient or negative ΔT on a loaded joint is not physical. **New A-rule**, so it belongs here |
| D3 | **Alarm thresholds for cover-mounted sensing** | The sensor reads the *cover*, not the conductor — lower absolute, and RoR damped by the cover plus the 5 mm mounting plate. Thresholds inherited from conductor limits would read healthy while a joint overheats. Needs the E6 characterisation (§6) before numbers are trusted |
| D4 | **Cloud data pipeline** — IoT Rule → Timestream/S3, or alternative | Not started. Gates positional telemetry and any fleet view |
| D5 | **OTA update approach** | A/B scheme depends on the Pi's OS/boot layout |
| D6 | **HIRA sign-off** — `docs/hira-live-sensor-installation.md` | Needs a competent person and the duty holder. Currently a 9-revision draft; the electrical conclusion is settled (external cover mounting, intact enclosure), the open items are measurement questions |
| D7 | **Enforce the poll interval in the compiler, and choose its value** — see §3b | `poll_interval_s` is validated, displayed and never actuated; the operator-facing knob that *does* work is a per-packet delay whose correct value depends on slave count. Compiler-only fix, no reflash. The interval itself interacts with `maxAgeSec` and blacklist detection, so it is a monitoring-policy decision, not a default  **Also gates 240-sensor sizing** (decision log 2026-09-08): the 500 ms cap means fatter modules *raise* the reading rate, and `joints` maxItems 200 blocks 240 points outright. |

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
