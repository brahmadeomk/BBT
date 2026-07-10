# Decision Log

Chronological record of implementation-level decisions made in this repo
(as opposed to architecture/design decisions, which are made in the
companion project chat and recorded in the workplan/design docs there).

- **2026-07-10** — Repo structure realigned to the layout in
  `BusductTherMo_Edge_Implementation_WorkPlan.md` §3 (`/config/schemas`,
  `/config/examples`, `/src/config-service`, `/src/cloud-gateway`,
  `/src/adapters/aws`, `/flows`, `/test`, `/tools`, `/docs`). Schema
  files renamed to match the workplan's naming
  (`busduct_modbus_joint_config.schema.json`,
  `busduct_alarms_config.schema.json`). Kept `firmware/Nano_IOT.ino` as
  its own top-level directory rather than under `/docs` — it's the
  actual frozen sketch source (the wire-protocol contract), not prose
  documentation, even though the workplan's reference-artifact table
  groups it with the docs.
