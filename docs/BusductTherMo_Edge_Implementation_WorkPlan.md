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

### Slice 8 — Hardening, Portability Drill & Pilot (Week 6–8+)
- Security: remove hardcoded sudo password (scoped sudoers entries); secure Node-RED editor (adminAuth + https or disable remote editor); credential hygiene in flow exports.
- Portability drill: point the panel at local Mosquitto/EMQX via config only; all functions must work (Basic Ingest and Shadow flags off). Fix any leaked AWS dependency.
- Pilot: parallel run on one production panel for 3–4 weeks; daily alarm parity and telemetry reconciliation; MQTT message counts vs. cost model.
- Template the validated image + commissioning procedure for rollout.

**Done when:** acceptance checklist from the Readiness Workplan (Section 6) passes in full.
## 5. Timeline Summary

| Week | Slices | Key milestone |
| --- | --- | --- |
| 1 | S1, S2 | Config trilogy live on Pi; validators tested; migration done |
| 2 | S3, S4 start | Nano compiler byte-identical; recovery resend proven |
| 3 | S4, S5 | Internal bus in place; batcher + outbox on loopback |
| 4 | S5, S6 | 24 h bench soak passed; first publish to AWS IoT Core |
| 5 | S6, S7 | Provisioning flow done; remote config end-to-end |
| 6 | S7, S8 | Maintenance gate + A10 verified; security hardening |
| 7–8 | S8 | Portability drill passed; pilot panel commissioned |
| 9–12 | S8 | Parallel run, reconciliation, rollout template |

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
