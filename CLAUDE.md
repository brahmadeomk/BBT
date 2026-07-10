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

- **Edge validation rules R1–R13** live in the JSON schema file for
  Modbus/joint config (see `schemas/`) and are mandatory. Any config
  validator or compiler change must keep all R1–R13 rules enforced and
  covered by tests. Do not relax or bypass a rule without explicit
  instruction.

## Reference documents

| Artifact | Path | Status | Used by |
|---|---|---|---|
| `busduct_edge_config.yaml` | `config/busduct_edge_config.yaml` | missing | Config validator |
| Modbus/joint JSON schema (R1–R13) | `schemas/modbus_joint.schema.json` | missing | Config validator |
| Workplan (docx or markdown extract) | `docs/workplan.md` | missing | All phases |
| Existing Node-RED flow | `flows/flows_BBT.json` | present | Nano job compiler, Cloud Gateway |
| Arduino Nano firmware | `firmware/Nano_IOT.ino` | present | Nano job compiler (target device) |

If a "missing" artifact is needed when you start a phase, ask for it
rather than inventing the schema/config shape from scratch — the design
intent lives in those documents, not in this file.

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
