# BBT — Busduct Cloud/Edge Monitoring

Cloud-to-edge monitoring system for busduct joint temperature
("BusductTherMo") and Modbus sensor data: an Arduino Nano 33 IoT Modbus
RTU master, a Raspberry Pi running Node-RED at the edge, and a cloud
gateway tier above it.

See `CLAUDE.md` for standing implementation rules (cloud-agnostic
adapter boundary, mandatory validation rules) and
`docs/BusductTherMo_Edge_Implementation_WorkPlan.md` for the full slice
plan — that workplan is the source of truth for what gets built when.

## Repo layout

- `docs/` — workplan (`.md` + original `.docx`), edge node config spec
  (`busduct_edge_config.yaml`), decision log
- `config/schemas/` — the JSON Schemas: `busduct_modbus_joint_config.schema.json`
  (`cfg/modbus` + `cfg/joints`, rules R1–R14) and
  `busduct_alarms_config.schema.json` (`cfg/alarms`, rules A1–A10)
- `config/examples/` — reference config instances per domain, migration
  snapshots (empty until Slice 2)
- `src/config-service/` — config store, validator, version manager,
  audit writer, Nano job compiler (empty until Slice 2+)
- `src/cloud-gateway/` — batcher, alarm publisher, heartbeat, outbox,
  transport interface (empty until Slice 5+)
- `src/adapters/aws/` — AWS-specific code, the only place an AWS SDK may
  be imported (empty until Slice 6+)
- `flows/` — Node-RED flow export (`flows_BBT.json`, 13 tabs incl.
  `modbusMaster_V2`, `BusbarTherMo`, `Alert system`, `Dashboard`)
- `firmware/` — Arduino Nano sketch (`Nano_IOT.ino`) that consumes the
  read/write/transfer job JSON produced by the Nano job compiler and
  drives the RS-485 Modbus RTU bus
- `test/`, `tools/` — unit tests and migration/commissioning scripts
  (empty until Slice 2+)

Still missing: the Edge Cloud Readiness Workplan (the higher-level
phase/acceptance-criteria doc this implementation plan maps to — needed
for Slice 8's final checklist). See `CLAUDE.md` for details.
