# BusductTherMo — Edge Implementation Work Plan

*Coding Phase: Node-RED / Raspberry Pi Cloud Enablement — Executed with Claude Code*
*Brahmadeo Kamble, Head of Digital & Industry 4.0, Godrej | Version 1.0 | July 2026*

## 1. Purpose
This plan translates the approved designs into working code on the BusductTherMo edge stack (Raspberry Pi + Node-RED + Arduino Nano 33 IoT Modbus master). It is organised as vertical slices: each slice is independently testable, leaves the system in a working state, and maps to the phases of the Edge Cloud Readiness Workplan. Implementation is done in Claude Code against a git repository; this chat project remains the venue for design decisions and review.
Architecture recap: the Nano 33 IoT remains the autonomous Modbus polling layer and is unchanged except for regenerated job JSON. All cloud work happens on the Pi. Safety-critical alarming stays fully local; the cloud is an observer and configurator (analytics, fleet view, remote threshold tuning), never in the safety loop.
## 2. Reference Artifacts (Repo Inputs)

| Artifact | Role in implementation |
| --- | --- |
| busduct_edge_config.yaml | Edge runtime configuration spec: identity, MQTT, publish policy, buffering, retention |
| busduct_modbus_joint_config.schema.json | cfg/modbus + cfg/joints domain schema; validation rules R1–R13 |
| busduct_alarms_config.schema.json | cfg/alarms domain schema: profiles, persistence, notifications; rules A1–A10 |
| BusductTherMo_Edge_Cloud_Readiness_Workplan.docx | Phase-level plan, cloud-agnostic principles, acceptance criteria |
| flows_BBT.json | Current production flows (BusbarTherMo™, Alert system, Settings tabs are in scope; modbusMaster_V2 is legacy) |
| Nano_IOT sketch (.txt) | Serial job protocol contract: read/write/transfer/comm JSON format |
| CLAUDE.md | Standing instructions for Claude Code: adapter-only AWS rule, mandatory validation rules, test-first slices |

## 3. Proposed Repository Layout

| Path | Contents |
| --- | --- |
| /docs | All design artifacts above; decision log |
| /config/schemas | The three JSON Schemas (source of truth) |
| /config/examples | Reference instances per domain; migration snapshots |
| /src/config-service | Config store, validator (R1–R13, A1–A10), version manager, audit writer, Nano job compiler |
| /src/cloud-gateway | Batcher, alarm publisher, heartbeat, outbox (store-and-forward), transport interface |
| /src/adapters/aws | AWS-specific: endpoint config, Fleet Provisioning, Basic Ingest mapping, optional Shadow |
| /flows | Node-RED flow exports: refactored tabs + new Cloud Gateway tab (importable JSON) |
| /test | Unit tests (validator, compiler, batcher), soak/network-pull scripts, portability drill config |
| /tools | Migration script (Desktop txt files + global context → /var/busduct/cfg), commissioning helper |

## 4. Work Slices

### Slice 1 — Repo Bootstrap & CLAUDE.md (Day 1–2)
- Initialise repo with layout above; commit all reference artifacts.
- Write CLAUDE.md: cloud-agnostic rule (no AWS SDK outside /src/adapters/aws), validation rules mandatory, every slice ships with tests, Node-RED function nodes kept as thin wrappers around tested library code.
- Set up Node.js project with test runner; CI-style test script runnable on dev machine and on the Pi.

**Done when:** repo builds, empty test suite runs, CLAUDE.md reviewed in project chat.

### Slice 2 — Config Service: Store, Validator, Migration (Week 1)
- Implement file-backed config store at /var/busduct/cfg: one JSON file per domain (modbus, joints, alarms) + last-known-good snapshots + atomic write (write-temp, fsync, rename).
- Implement schema validation (ajv or equivalent) + cross-field validators R1–R13 and A1–A10 as pure, unit-tested functions.
- Implement version manager (monotonic per domain) and audit writer appending to the existing audit-trail format.
- Write migration tool: read current global-context config, joint master, and Desktop txt files; emit the three domain files; verify against schemas; keep originals untouched.
- Refactor Config Manager and JointMasterBackEndNode function nodes to call the config service (via Node-RED function node requiring the library) instead of raw global context.

**Done when:** all validator unit tests pass (including rejection cases for every rule); migration produces valid domain files from the real flows_BBT context; UI save/apply paths work unchanged.

### Slice 3 — Nano Job Compiler & Resend Path (Week 2)
- Implement compiler: cfg/modbus + cfg/joints → Nano job JSON ({read:[...], comm:[polling, baud, timeout]}), byte-identical to the format the sketch parses.
- Implement R10 capacity check using real numbers: baud, polling delay, timeout, packet list → computed worst-case scan time; reject configs that cannot fit.
- Wire resend triggers: on boot, after RECOVERY CONTROLLER USB power-cycle, and after any accepted modbus/joints config apply.
- Report recovery events as SYSTEM alarms so they reach the historian (and later, cloud).

**Done when:** compiler output matches the current hand-configured job JSON for the reference panel; a config change regenerates and resends; Nano polls correctly after simulated recovery.

### Slice 4 — Internal Bus Refactor (Week 2–3)
- Introduce link-out nodes at the outputs of ProcessLogic (KPI stream) and Alarm Manager (alarm events); no logic changes.
- Document the internal message contracts (KPI message, alarm event message) in /docs.
- Regression-check against the recorded baseline: HMI, historian, and email behaviour identical.

**Done when:** flows export cleanly, baseline comparison shows zero behavioural change.

### Slice 5 — Cloud Gateway Tab: Batcher, Outbox, Heartbeat (Week 3–4)
- Batcher: subscribe (link-in) to KPI stream; aggregate per joint per interval (min/max/avg ΔT, max RoR, max T, ambient); emit one payload per panel per interval; enforce 4,800-byte budget.
- Alarm publisher: subscribe to alarm events; publish on state transition only, QoS 1 semantics via outbox priority class.
- Outbox: disk-backed queue at /var/busduct/outbox with alarm/telemetry priority classes, 200 MB cap, drop-oldest telemetry, never-drop alarms, controlled drain (5 msg/s), edge UTC timestamps in payload.
- Heartbeat: hourly liveness message with fw/config versions.
- All of the above publish to the transport interface (publish/subscribe/connection-state) with a loopback implementation for testing — no MQTT yet.

**Done when:** 24-hour soak on the bench shows correct aggregates vs. historian, alarm parity, and clean outbox growth/drain under simulated link loss (1 h, 24 h pulls).

### Slice 6 — AWS Adapter & Provisioning (Week 4–5)
- Implement AWS adapter behind the transport interface: TLS 1.2 mutual auth MQTT client, endpoint/cert paths from busduct_edge_config.yaml, LWT, jittered backoff (2–300 s), keep-alive 300 s.
- Topic templates resolved from identity: dt/{c}/{s}/{p}/tel, /alarm; optional Basic Ingest rewrite behind a config flag.
- Provisioning: commissioning helper performing Fleet Provisioning (claim cert → operational cert), writing identity + certs with correct permissions.
- Per-device IoT policy template locking each panel to its own namespace (deliverable for the cloud side).

**Done when:** reference panel publishes batched telemetry and alarms to AWS IoT Core; connection survives router reboot and 24 h link pull with full outbox recovery.

### Slice 7 — Remote Config Channel (Week 5–6)
- Subscribe cmd/{c}/{s}/{p}/config; route payloads to the config service; respond on /config/ack with applied versions or rejection reason (rule references in the reason).
- Enforce the maintenance-mode gate for modbus/joints domains (R12); alarms domain freely tunable (A-rules).
- On accepted modbus/joints change: trigger Nano job recompile + resend (Slice 3 path).
- Live re-evaluation of active alarms after threshold change per A10 (normal clear path, no mass-clear).

**Done when:** end-to-end test pushes valid and invalid configs from AWS; invalid pushes are rejected with correct rule IDs; audit trail records everything; thresholds change without alarm-state corruption.

### Slice 8 — Hardening, Portability Drill & Pilot (re-sequenced, see Addendum A)

**Split as of 2026-07-24.** Slice 8a runs at its original point in the
sequence; Slice 8b is deferred to the **final** slice, after Slices 9–11,
because a pilot should exercise the system at its real scale (110
devices, blacklisting, BMS interface) rather than the 19-joint shape.

#### Slice 8a — Security hardening (NOT deferred)
- Remove hardcoded sudo password (scoped sudoers entries for the
  specific commands only).
- Secure the Node-RED editor: adminAuth + https, or disable remote
  editor access.
- Credential hygiene in flow exports.

**Why this does not wait:** the panel is being given a network route
outward. Deferring a known credential exposure until after three more
build slices is the wrong trade regardless of pilot timing.

**Done when:** no credentials in the repo or flow exports; editor
requires authentication; sudoers scoped to named commands.

#### Slice 8b — Portability drill, pilot & rollout (FINAL slice)
- Portability drill: point the panel at local Mosquitto/EMQX via config
  only; all functions must work (Basic Ingest and Shadow flags off).
  Fix any leaked AWS dependency.
- Pilot: parallel run on one production panel for 3–4 weeks; daily alarm
  parity and telemetry reconciliation; MQTT message counts vs. cost
  model.
- Template the validated image + commissioning procedure for rollout.

**Done when:** acceptance checklist from the Readiness Workplan
(Section 6) passes in full — assessed against the full-scale
configuration including blacklisting (Slice 9), the positional telemetry
payload (Slice 10) and, where the customer requires it, the BMS
interface (Slice 11).
## 5. Timeline Summary

| Week | Slices | Key milestone |
| --- | --- | --- |
| 1 | S1, S2 | Config trilogy live on Pi; validators tested; migration done |
| 2 | S3, S4 start | Nano compiler byte-identical; recovery resend proven |
| 3 | S4, S5 | Internal bus in place; batcher + outbox on loopback |
| 4 | S5, S6 | 24 h bench soak passed; first publish to AWS IoT Core |
| 5 | S6, S7 | Provisioning flow done; remote config end-to-end |
| 6 | S7, S8a | Maintenance gate + A10 verified; security hardening |
| 7–8 | S9, S10 | Blacklisting live; 110-device config validates; one telemetry message per interval |
| 9–10 | S11 | BMS Modbus TCP map validated against a reference gateway |
| 11–12 | S8b | Portability drill passed; pilot panel commissioned at full scale |
| 13–16 | S8b | Parallel run, reconciliation, rollout template |

*Revised 2026-07-24: Slice 8 split; 8b (drill/pilot/rollout) moved to
last so the pilot runs against the shipping configuration. See
Addendum A.*

## 6. Working Agreement (Claude Code)
- Design decisions and reviews happen in the Claude project chat; code happens in Claude Code against the repo. Each slice ends with a review of diffs and test results in the project.
- No AWS SDK import outside /src/adapters/aws — enforced by a lint rule or grep check in the test script.
- Validation rules R1–R13 and A1–A10 each have at least one passing and one failing unit test.
- Node-RED function nodes stay thin: real logic lives in required library modules under /src so it is unit-testable outside Node-RED.
- Never modify the production Pi directly: changes flow through repo → tested → deployed; flows_BBT.json in the repo is the deployable artifact.
## 7. Coding-Phase Risks

| Risk | Mitigation |
| --- | --- |
| Regression in alarm behaviour during refactor | Recorded baseline from reference panel; parity check after every slice; Slice 4 makes zero logic changes by design |
| Context-store data loss during migration | Migration tool is read-only on sources; snapshots kept; rollback = re-import original flows |
| Nano job format drift breaks polling | Byte-identical compiler test against current working job JSON before any live use |
| Outbox flash wear on Pi SD card | Size cap, batched writes, consider dedicated partition or USB storage; monitor write volume in soak test |
| Scope creep into cloud-side services | This plan is edge-only; cloud rules/storage/dashboards are a separate plan |

---

# Addendum A — Scale & Integration Slices (added 2026-07-24)

Slices 1–8 were scoped for the original 19-joint reference panel and an
AWS-only integration target. Two changes since then add scope:

1. **Provisioning target raised to 100 joint sensors + 10 ambient
   sensors per panel.** Schema limits, telemetry payload size, ambient
   handling and dead-device tolerance all change at this scale.
2. **Customer BMS integration is now in scope** — Modbus TCP first,
   with an off-the-shelf Modbus→BACnet gateway, and native BACnet/IP
   deferred until panel volume justifies it.

Slices 9–11 below are additive; Slices 1–8 are unchanged. Slice 9 is
sequenced ahead of the others because dead-device tolerance is a
correctness issue at 110 devices, not an enhancement.

Rule numbering note: cross-field rules now run **R1–R16** (R14 ambient
referential integrity, R15 per-channel register integrity, R16 RS-485
bus loading) and **A1–A10**. Section 6's working agreement should be
read as "R1–R16 and A1–A10".

---

## Slice 9 — Device Blacklisting & Recovery (highest priority)

Full design: `docs/blacklist-recovery-spec.md`. That spec is the source
of truth for behaviour; the steps below are the build order.

1. **Firmware prerequisite:** re-initialise `Serial1` / Modbus timeout
   only when `comm` parameters actually change, not on every job update.
   Without this, every blacklist and probe glitches the bus. Small,
   self-contained, and worth doing on its own merit.
2. Implement failure tracking per slave (consecutive failure count) and
   the blacklist decision (default: 3 consecutive failures).
3. Implement probe scheduling with backoff (30 s → 1 m → 2 m → 5 m cap)
   and restore on 3 consecutive good reads (hysteresis against flapping).
4. Extend the job compiler to omit blacklisted slaves; ensure R10
   capacity math continues to use the **configured** slave list, not the
   active one.
5. Introduce joint states `LIVE` / `STALE` / `OFFLINE` and the
   hold-don't-clear rule for active alarms on non-measurable joints.
6. Extend the existing `Sensor_Error` freeze path in ProcessLogic to
   cover blacklist: freeze KPI updates, **reset the EMA baseline on
   restore**, pause and restart persistence timers.
7. Raise one ACK-able SYSTEM alarm per blacklisted slave naming the
   affected joints; publish to cloud; reflect in HMI and BMS health
   points; record the full cycle in the audit trail.

**Done when:** the 8 acceptance criteria in the spec pass, including the
20-minute-blackout / 8 °C-change test producing no spurious RoR alarm,
and a device failing every other probe not flapping.

---

## Slice 10 — Scale Hardening for 100+10 (parallel with Slice 9)

1. **Positional-array telemetry payload.** The batcher currently emits
   keyed JSON and correctly splits above 4,800 bytes — but at 100 joints
   that is several messages and several AWS 5 KB metering blocks per
   interval. Switch to positional arrays with an index→`joint_id`
   manifest published only on config change; target the whole panel in
   one message (~2.5 KB). Chunk-splitting stays as a safety net.
2. **Ambient outlier rejection and fallback.** The three-level ambient
   chain (R14: panel → zone → joint) models 10 sensors well, but there
   is no runtime fallback. Add: reject readings outside a plausibility
   band, then fall back to zone median, then panel median. A single
   drifting ambient must not silently corrupt ΔT for every joint that
   references it.
3. **Two-segment RS-485 support end-to-end.** `buses.maxItems` is
   already 4 and R16 now warns above 80% loading; verify the compiler,
   resend path and recovery controller all behave correctly with two
   serial ports and two Nanos.
4. Re-run the 24 h soak at full scale (or the closest available bench
   approximation) and re-check outbox growth, SD-card write volume and
   scan timing against R10.

**Done when:** a 110-device config validates with only the expected R16
loading warning, one telemetry message per interval covers the whole
panel, and a forced ambient fault does not disturb ΔT on other joints.

---

## Slice 11 — BMS Integration: Modbus TCP + Gateway

Approach agreed: **Modbus TCP slave on the Pi + off-the-shelf
Modbus→BACnet gateway** first (certified stack, no development risk,
no BOM commitment). Native BACnet/IP on the Pi is a later product
investment; the point model designed here carries over to it unchanged.

1. **New config domain `cfg/integration`** with its own schema and
   version: enabled protocols, TCP port, exposure tier, point-map
   version, zone rollup rules. Follows the same store/validate/audit
   path as the other three domains.
2. **Modbus TCP slave service** fed from the same internal link-node bus
   as the cloud batcher — a **peer adapter**, not a new data path.
   Must work with the internet down; the BMS is often the customer's
   alarm path of record.
3. **Register map builder** generated from `cfg/joints` +
   `cfg/integration` so joint-count changes need no code edit. Tiered:
   - Tier 1 — summary block (~12 points): highest alarm level, worst
     joint (latched), active alarm count, per-level counts, panel max
     ΔT / RoR / temp, system health, live joint count, **heartbeat
     counter**
   - Tier 2 — per-zone block
   - Tier 3 — per-joint detail (temp, ΔT, RoR, level)
   All signed 16-bit, ×10 scaling, contiguous blocks, fixed stride —
   so a cheap gateway can map it with no custom work.
4. **Rollup semantics:** worst-joint **latched** with deterministic
   tiebreak (first-raised wins; reassign only on clear) to stop the
   point oscillating when two joints are at the same level. Per-level
   counts prevent a Warning being masked by a Critical. Optional
   per-joint severity **bitmap** registers give full detail in ~6
   registers for point-licence-sensitive customers.
5. **Heartbeat counter** incremented every scan — Modbus has no liveness
   concept, and without it a frozen Pi presents as healthy steady values
   indefinitely.
6. **ACK write point** routed through the same alarm ACK path as the HMI
   so the audit trail captures BMS-originated acknowledgements. Summary
   ACK acknowledges **all currently active** alarms; define and document
   this explicitly.
7. **Customer-facing register map document**, versioned, with the
   **append-only** rule stated on page 1 — never renumber, only append.
   One renumber breaks every deployed gateway configuration.
8. Validate against one reference gateway (e.g. Intesis INMBSBAC or
   Babel Buster) before first customer delivery.

**Done when:** a reference gateway reads Tier 1 and presents it as
BACnet objects with no custom mapping; a frozen Pi is detectable via the
heartbeat; a BMS-originated ACK appears in the audit trail.

---

## Revised sequencing

Slice 8 is **split** (see its section above): 8a (security hardening)
keeps its original early position; **8b (portability drill, pilot,
rollout) is deferred to the final slice**, so the pilot exercises the
system at real scale — 110 devices with blacklisting, the positional
telemetry payload, and the BMS interface where required — rather than
validating a 19-joint shape that will not be shipped.

Slice numbers are **stable identifiers, not execution order**. Slice 8
is not renumbered: ~19 references to "Slice 8" exist across source
comments, `CLAUDE.md` and this decision log (almost all pointing at the
portability drill, i.e. 8b), and renumbering would invalidate them for
no benefit.

| Order | Slice | Note |
|---|---|---|
| 1 | **8a — Security hardening** | Not deferred; live credential exposure on a device about to gain outward network access |
| 2 | **9 — Blacklisting** | Correctness at 110 devices; firmware `comm`-change guard first |
| 3 | **10 — Scale hardening** | Parallel with 9 except the two-segment item |
| 4 | **11 — BMS integration** | No cloud dependency; demoable to customers on its own |
| 5 (last) | **8b — Portability drill, pilot & rollout** | Assessed against the full-scale configuration |

## Additional risks introduced

| Risk | Mitigation |
|---|---|
| RoR/A2 alarms firing for the first time (RoR was pinned at 0 until 22 July) — thresholds never validated against live data | Watch closely for false positives; re-record the ProcessLogic regression baseline, which the RoR fix invalidated; be ready to retune 15/30/60 °C/hr |
| Blacklist churn glitching the bus | Firmware `comm`-change guard is a prerequisite, not an optimisation (Slice 9 step 1) |
| Held (`STALE`) alarms mistaken for live ones | Distinct HMI/BMS/cloud representation with `last_valid_ts`; omit stale values from telemetry rather than repeating them |
| BMS register map churn breaking deployed gateways | Versioned, append-only map; never renumber |
| Gateway BOM cost at volume | Point model designed to carry over to a native BACnet/IP server; revisit when panel volume justifies development |

---

# Addendum B — Cloud message contract (added 2026-08-27)

Slice 5's "emit one payload per panel per interval" (§Slice 5) said what
the panel sends but not how a consumer identifies it. A design review
found four different message shapes sharing the telemetry topic —
interval aggregate, heartbeat, positional manifest and the LWT — with
only the manifest carrying a `type` field. Resolved before cloud
development began, so no deployed consumer had to migrate.

**The published contract is now `docs/aws/README.md` Part G**, with
`src/cloud-gateway/message-types.js` as its machine-readable half
(required by every publisher, so code and docs cannot drift).

Three properties this adds to the Slice 5/6 deliverable:

1. **Every message carries `type` and `v`.** `type` identifies the shape
   (`telemetry`, `manifest`, `heartbeat`, `alarm`, `device_health`,
   `config_ack`, `cert_ack`, `lwt`); `v` identifies the revision of that
   shape. `v` is not optional decoration: **OTA is not built** (Readiness
   Phase 6), so panels are updated by visiting them and a fleet runs mixed
   firmware for months — the cloud will parse two revisions at once.
   Bump only on breaking changes; consumers must ignore unknown fields and
   must fail loudly on an unknown `v`.

2. **Telemetry field names are frozen** — `dt_min dt_max dt_avg ror_max
   t_max amb_avg`, identical in the keyed and positional encodings. The
   two had drifted (`ambient` vs `amb_avg`), and §Slice 5's own summary
   above still describes the aggregate informally as "ambient"; the
   authoritative list is Part G.

3. **New message type: `device_health`.** The risk table above commits to
   a "distinct HMI/BMS/cloud representation" for held/STALE alarms, but
   nothing in Slices 5–7 actually published device state — blacklisted
   units, joint LIVE/STALE/OFFLINE and per-segment bus liveness reached
   the HMI and the BMS register map only. `device_health` closes that for
   the cloud tier. It is a complete **state snapshot**, not an event,
   because an alarm stream cannot tell a late or restarted consumer what
   is *currently* blacklisted without replaying history.

The LWT also moved off the telemetry topic to `status/{c}/{s}/{p}`. See
Part G for the deployment-ordering consequence (the device policy must
grant the new topic) and the connect-time fallback that keeps a panel
online if that step is missed.
