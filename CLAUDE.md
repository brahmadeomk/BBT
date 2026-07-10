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

The following design artifacts are the source of truth for intent and
should be dropped into this repo (see paths below) before implementation
work starts on the phase that needs them:

| Artifact | Expected path | Used by |
|---|---|---|
| `busduct_edge_config.yaml` | `config/busduct_edge_config.yaml` | Config validator |
| Modbus/joint JSON schema (R1–R13) | `schemas/modbus_joint.schema.json` | Config validator |
| Workplan (docx or markdown extract) | `docs/workplan.md` | All phases |
| `flows_BBT.json` (existing Node-RED flow) | `flows/flows_BBT.json` | Nano job compiler |
| Nano config-compiler sketch | `docs/nano_compiler_sketch.md` | Nano job compiler |

If any of these are missing when you start a phase, ask for them rather
than inventing the schema/config shape from scratch — the design intent
lives in those documents, not in this file.

## Working agreements

- Test with Node.js locally before considering a slice done.
- Debugging on the actual Pi deployment (e.g. via SSH) is in scope once a
  phase is deployed — inspect logs, don't just guess from code.
- Architecture decisions, schema changes, and TOGAF-level review happen in
  the companion chat/project space, not here. This repo executes against
  the agreed design; if an implementation detail seems to require a design
  decision, flag it instead of deciding unilaterally.
