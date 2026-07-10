# BBT — Busduct Cloud/Edge Monitoring

Cloud-to-edge monitoring system for busduct joint temperature ("BusbarTherMo")
and Modbus sensor data, with an edge tier (Raspberry Pi running Node-RED,
talking over serial to an Arduino Nano Modbus RTU master) and a cloud
gateway tier above it.

See `CLAUDE.md` for the standing implementation instructions, phase
order, and the mandatory design rules (cloud-agnostic adapter boundary,
edge validation rules R1–R13).

## Repo layout

- `config/busduct_edge_config.yaml` — edge node config spec: identity,
  MQTT/AWS IoT connection, topics, publish policy, store-and-forward
  buffer, remote-config validation rules, local retention
- `schemas/modbus_joint.schema.json` — `cfg/modbus` + `cfg/joints` JSON
  Schema (buses, slaves, register maps, joint/zone mapping) with the
  mandatory cross-field edge validation rules R1–R13
- `schemas/alarms.schema.json` — `cfg/alarms` threshold profiles
  (deltaT/ror/persistence), clear hysteresis, sensor-fault handling, and
  email/SMS/cloud notification routing, with the mandatory cross-field
  edge validation rules A1–A10
- `docs/` — workplan and design reference docs (still to add)
- `flows/` — Node-RED flow export (`flows_BBT.json`, 13 tabs incl.
  `modbusMaster_V2`, `BusbarTherMo`, `Alert system`, `Dashboard`)
- `firmware/` — Arduino Nano sketch (`Nano_IOT.ino`) that consumes the
  read/write/transfer job JSON produced by the Nano job compiler and
  drives the RS-485 Modbus RTU bus

Still missing: the workplan. See the table in `CLAUDE.md` for what each
phase depends on.
