# BBT — Busduct Cloud/Edge Monitoring

This repo implements the cloud-to-edge monitoring system for busduct joint
temperature (and related Modbus sensor) monitoring, running on a Raspberry
Pi at the edge with a cloud gateway tier above it. The architecture and
schema were designed in a companion chat/project space (TOGAF-anchored
design docs); this repo is where that design gets built, tested, and
deployed.

## Standing instructions

- **Implement per the workplan phases**, in vertical slices, in this order:
  1. Config validator + Node-RED ("Nano") job compiler — this touches
     existing edge behavior, so it needs the most care and the most tests.
  2. Cloud Gateway tab/flow.
  3. Provisioning.

  Do not jump ahead to a later phase before the current slice is working
  and tested.

- **Cloud-agnostic rule**: no AWS SDK (or any single-cloud SDK) may be used
  outside the cloud adapter module. Business logic, validation, and the
  Nano job compiler must not import cloud-provider SDKs directly — they
  call through the adapter interface only.

- **Edge validation rules R1–R13** (modbus/joints, `schemas/modbus_joint.schema.json`)
  and **A1–A10** (alarms, `schemas/alarms.schema.json`) are mandatory. Any
  config validator or compiler change must keep all of them enforced and
  covered by tests. Do not relax or bypass a rule without explicit
  instruction.

## Reference documents

| Artifact | Path | Status | Used by |
|---|---|---|---|
| Edge node config spec | `config/busduct_edge_config.yaml` | present | Edge boot config, MQTT/publish policy, config validator |
| Modbus/joint JSON schema (R1–R13) | `schemas/modbus_joint.schema.json` | present | Config validator |
| Alarm thresholds schema (`cfg/alarms`) | `schemas/alarms.schema.json` | present | Config validator, alarm engine |
| Workplan (docx or markdown extract) | `docs/workplan.md` | missing | All phases |
| Existing Node-RED flow | `flows/flows_BBT.json` | present | Nano job compiler, Cloud Gateway |
| Arduino Nano firmware | `firmware/Nano_IOT.ino` | present | Nano job compiler (target device) |

If a "missing" artifact is needed when you start a phase, ask for it
rather than inventing the schema/config shape from scratch — the design
intent lives in those documents, not in this file.

### Config domains (from the schema + edge config spec)

There are (at least) three independently-versioned config domains, and
the validator must treat them as separate atomic units per R11/R12:

- **`cfg/modbus` + `cfg/joints`** — wiring/commissioning reality:
  buses, slaves, register maps, joint↔slave↔channel↔zone mapping.
  Defined in `schemas/modbus_joint.schema.json`; versioned via
  `config_domain_versions.{modbus,joints}`; remote changes gated to
  maintenance mode only (R12).
- **`cfg/alarms`** — named threshold `profiles` (object keyed by profile
  name; `default` is mandatory and can't be deleted/renamed — A4), each
  with `deltaT`/`ror`/`persistence` thresholds (ordering rules A1/A2),
  `clear_hysteresis_pct`/`clear_persistence_min` for raise/clear chatter
  control, plus panel-wide `sensor_fault` (comm timeout, sensor-error
  cutoff) and `notifications` (email/SMS/cloud alarm publish routing).
  Field names deliberately match the existing Node-RED Config Manager
  (`deltaT`/`ror`/`persistence`) for a direct migration. Defined in
  `schemas/alarms.schema.json`; versioned via `config_domain_versions.alarms`
  (monotonicity is rule A6); no maintenance-mode gate — thresholds aren't
  wiring reality, unlike `cfg/modbus`/`cfg/joints` (R12).
- **Edge node config** (`busduct_edge_config.yaml` itself) — identity
  (immutable after provisioning), MQTT/topics, publish policy, buffer,
  local retention. Single `config_version`, not per-domain.

The Nano job compiler only touches `cfg/modbus`/`cfg/joints` (it turns
slave/register definitions into the firmware's `read`/`write`/`transfer`
job JSON below) — it must not need the alarms schema.

### Nano job protocol (from `firmware/Nano_IOT.ino`)

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

- Test with Node.js locally before considering a slice done.
- Debugging on the actual Pi deployment (e.g. via SSH) is in scope once a
  phase is deployed — inspect logs, don't just guess from code.
- Architecture decisions, schema changes, and TOGAF-level review happen in
  the companion chat/project space, not here. This repo executes against
  the agreed design; if an implementation detail seems to require a design
  decision, flag it instead of deciding unilaterally.
