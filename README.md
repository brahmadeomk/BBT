# BBT — Busduct Cloud/Edge Monitoring

Cloud-to-edge monitoring system for busduct joint temperature ("BusbarTherMo")
and Modbus sensor data, with an edge tier (Raspberry Pi running Node-RED,
talking over serial to an Arduino Nano Modbus RTU master) and a cloud
gateway tier above it.

See `CLAUDE.md` for the standing implementation instructions, phase
order, and the mandatory design rules (cloud-agnostic adapter boundary,
edge validation rules R1–R13).

## Repo layout

- `config/` — edge config (e.g. `busduct_edge_config.yaml`)
- `schemas/` — Modbus/joint config JSON schema (validation rules R1–R13)
- `docs/` — workplan and design reference docs
- `flows/` — Node-RED flow export (`flows_BBT.json`, 13 tabs incl.
  `modbusMaster_V2`, `BusbarTherMo`, `Alert system`, `Dashboard`)
- `firmware/` — Arduino Nano sketch (`Nano_IOT.ino`) that consumes the
  read/write/transfer job JSON produced by the Nano job compiler and
  drives the RS-485 Modbus RTU bus

Drop the remaining design artifacts (`busduct_edge_config.yaml`, the
schema, the workplan) from the companion chat/project space into the
paths above before starting the phase that depends on them.
