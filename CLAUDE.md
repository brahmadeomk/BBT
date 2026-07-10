# BBT — Busduct Cloud/Edge Monitoring

This repo implements the cloud-to-edge monitoring system for busduct joint
temperature ("BusductTherMo") and Modbus sensor data: an Arduino Nano 33
IoT Modbus RTU master, a Raspberry Pi running Node-RED at the edge, and a
cloud gateway tier above it. Architecture and schema design happens in a
companion Claude project chat; this repo is where that design gets built,
tested, and deployed.

**The authoritative implementation plan is
`docs/BusductTherMo_Edge_Implementation_WorkPlan.md`. Read it before
starting any slice — this file only summarizes standing rules that apply
across all of them.**

## Standing instructions

- **Work in the slice order the workplan defines** (Slice 1 → Slice 8).
  Each slice has a "Done when" acceptance line — don't start the next
  slice until the current one meets it. Slice 1 (repo bootstrap) and
  Slice 2 (config service: store, validator, migration) are furthest
  along; Slice 3 (Nano job compiler) is next and touches existing edge
  behavior directly, so it needs the most care and the most tests.

- **Cloud-agnostic rule**: no AWS SDK (or any single-cloud SDK) may be
  imported outside `/src/adapters/aws`. Everything else — config
  service, Nano job compiler, cloud-gateway batcher/outbox/heartbeat —
  talks through the transport interface only. Enforce this with a lint
  rule or grep check in the test script (per the workplan's Working
  Agreement), not just by convention.

- **Edge validation rules R1–R13** (`cfg/modbus` + `cfg/joints`, in
  `config/schemas/busduct_modbus_joint_config.schema.json`) and **A1–A10**
  (`cfg/alarms`, in `config/schemas/busduct_alarms_config.schema.json`)
  are mandatory. Every rule needs at least one passing and one failing
  unit test. Do not relax or bypass a rule without explicit instruction.

- **Node-RED function nodes stay thin.** Real logic lives in
  unit-testable library modules under `/src`; function nodes just
  `require()` and call them.

- **Never modify the production Pi directly.** Changes flow repo →
  tested → deployed. `flows/flows_BBT.json` in the repo is the
  deployable artifact.

## Repo layout

Per the workplan (§3), realigned from the original ad-hoc scaffolding:

| Path | Contents |
|---|---|
| `/docs` | Design artifacts, decision log |
| `/config/schemas` | The JSON Schemas — source of truth for `cfg/modbus`, `cfg/joints`, `cfg/alarms` |
| `/config/examples` | Reference config instances per domain; migration snapshots (empty — Slice 2) |
| `/src/config-service` | Config store, validator (R1–R13, A1–A10), version manager, audit writer, Nano job compiler (empty — Slice 2+) |
| `/src/cloud-gateway` | Batcher, alarm publisher, heartbeat, outbox, transport interface (empty — Slice 5+) |
| `/src/adapters/aws` | AWS-specific: endpoint config, Fleet Provisioning, Basic Ingest mapping (empty — Slice 6+) |
| `/flows` | Node-RED flow exports — `flows_BBT.json` is the current production flow |
| `/test` | Unit tests, soak/network-pull scripts, portability drill config (empty — Slice 2+) |
| `/tools` | Migration script, commissioning helper (empty — Slice 2/6) |
| `/firmware` | Arduino Nano sketch (`Nano_IOT.ino`) — not in the workplan's layout table verbatim, kept as its own dir since it's frozen device source, not prose documentation. See decision log. |

## Reference documents

| Artifact | Path | Status |
|---|---|---|
| Edge Implementation Work Plan (this plan) | `docs/BusductTherMo_Edge_Implementation_WorkPlan.md` (+ original `.docx`) | present |
| Edge Cloud Readiness Workplan (phase-level plan this one maps to; referenced in §1, §4 Slice 8, needed for the final acceptance checklist) | — | **missing** |
| Edge node config spec | `docs/busduct_edge_config.yaml` | present |
| Modbus/joint schema (R1–R13) | `config/schemas/busduct_modbus_joint_config.schema.json` | present |
| Alarms schema (A1–A10) | `config/schemas/busduct_alarms_config.schema.json` | present |
| Existing Node-RED flow | `flows/flows_BBT.json` | present |
| Arduino Nano firmware | `firmware/Nano_IOT.ino` | present |

The **Edge Cloud Readiness Workplan** is referenced repeatedly by the
Implementation Work Plan (it's the higher-level phase/acceptance-criteria
document Slice 8's "Done when" checks against) but hasn't been provided
to this repo yet. Ask for it before treating Slice 8 as fully spec'd.

## Config domains

Three independently-versioned domains, validated as separate atomic
units (R11/R12 govern `cfg/modbus`/`cfg/joints`; A6 governs `cfg/alarms`):

- **`cfg/modbus` + `cfg/joints`** — wiring/commissioning reality: buses,
  slaves, register maps, joint↔slave↔channel↔zone mapping. Remote
  changes gated to maintenance mode only (R12).
- **`cfg/alarms`** — named threshold `profiles` (object keyed by profile
  name; `default` is mandatory, can't be deleted/renamed — A4), each
  with `deltaT`/`ror`/`persistence` thresholds (ordering A1/A2),
  `clear_hysteresis_pct`/`clear_persistence_min`, plus panel-wide
  `sensor_fault` and `notifications` (email/SMS/cloud alarm publish).
  Field names match the existing Node-RED Config Manager for a direct
  migration. No maintenance-mode gate — thresholds aren't wiring
  reality.
- **Edge node config** (`busduct_edge_config.yaml` itself) — identity
  (immutable after provisioning), MQTT/topics, publish policy, buffer,
  local retention. Single `config_version`, not per-domain.

The Nano job compiler (Slice 3) only touches `cfg/modbus`/`cfg/joints` —
it must not need the alarms schema.

## Nano job protocol (from `firmware/Nano_IOT.ino`)

The Nano job compiler must emit JSON the firmware already parses. Do not
change this wire format without updating the firmware in lockstep:

- Serial command is a single JSON object, terminated by `}` (the
  firmware buffers raw bytes until it sees the closing brace — keep
  payloads under `BUFFER_SIZE`, currently 12288 bytes, and do not embed
  a literal `}` inside string/number fields).
- `read`: array where `read[0]` is the packet count, followed by
  `[slaveID, startAddr, length]` tuples.
- `write`: array where `write[0]` is the packet count, followed by
  `[slaveID, startAddr, [data...]]` tuples.
- `transfer`: array where `transfer[0]` is the packet count, followed by
  `[sourceSlaveID, sourceStartAddr, length, destinationSlaveID,
  destinationStartAddr]` tuples (register-to-register copy between two
  slaves, no intermediate storage on the Pi).
- `comm`: `[pollingMicroseconds, baudRate, timeoutMs]` — required every
  time (the firmware re-inits `Serial1` and the Modbus timeout from it
  on every job update).
- Firmware emits one JSON line per processed packet on Serial:
  `{"t":"r"|"w"|"x", ...}` with `"st":"ok"|"err"` (`"err_read"`/
  `"err_write"` for transfers). The Cloud Gateway / Node-RED side needs
  to parse this framing, not assume a single batched response.

## Working agreements

- Test with Node.js locally before considering a slice done; the test
  script must also run on the Pi.
- Debugging on the actual Pi deployment (e.g. via SSH) is in scope once a
  phase is deployed — inspect logs, don't just guess from code.
- Architecture decisions, schema changes, and TOGAF-level review happen in
  the companion project chat, not here. This repo executes against the
  agreed design; if an implementation detail seems to require a design
  decision, flag it instead of deciding unilaterally. Each slice ends
  with a review of diffs and test results in that chat.
