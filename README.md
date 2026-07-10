# BBT — Busduct Cloud/Edge Monitoring

Cloud-to-edge monitoring system for busduct joint temperature and Modbus
sensor data, with an edge tier (Raspberry Pi, Node-RED) and a cloud
gateway tier above it.

See `CLAUDE.md` for the standing implementation instructions, phase
order, and the mandatory design rules (cloud-agnostic adapter boundary,
edge validation rules R1–R13).

## Repo layout

- `config/` — edge config (e.g. `busduct_edge_config.yaml`)
- `schemas/` — Modbus/joint config JSON schema (validation rules R1–R13)
- `docs/` — workplan and design reference docs
- `flows/` — Node-RED flow exports (e.g. `flows_BBT.json`)

Drop the design artifacts from the companion chat/project space into the
paths above before starting the phase that depends on them.
