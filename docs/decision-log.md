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

- **2026-07-10** — Slice 2 validators (`src/config-service/validate-modbus-joints.js`,
  `validate-alarms.js`) implement R1–R12 and A1–A7/A9 as document-level
  checks (schema + cross-field, with optional context for the
  cross-domain/workflow ones: R9/A5 need the other domain's doc, R11/A6
  need the currently-applied version, R12 needs source+maintenance-mode).
  Three rules are deliberately **not** enforced there:
  - **R13 / A8** (write audit trail, publish applied version, keep
    last-known-good snapshot on any accepted change) are apply-time
    workflow requirements, not document validation — they belong to the
    config store (`src/config-service/store.js`, Slice 2 in progress).
  - **A10** (live re-evaluation of active alarms after a threshold
    change, no mass-clear) is alarm-engine runtime behavior, not
    something a config document validator can check — it's Slice 7
    territory per the workplan.
  - R10 (bus scan-time capacity) and A9 (hysteresis sanity) use
    formulas/bounds that are reasonable but not handed down verbatim by
    the schema author — see the comments in the two validator files if
    those numbers ever need revisiting.

- **2026-07-10** — `src/config-service/store.js` stores **two** domain
  files, not three: `modbus_joints.json` (covering both `cfg/modbus`
  and `cfg/joints` together) and `alarms.json`. The workplan's §3 table
  says "one JSON file per domain (modbus, joints, alarms)", but the
  schema we were actually given
  (`busduct_modbus_joint_config.schema.json`) requires `modbus` and
  `joints` as top-level keys of a single document with one atomic push
  covering both — there's no schema for a standalone `cfg/modbus`-only
  or `cfg/joints`-only file. Followed the schema over the prose. Each
  domain file gets a `.lkg.json` last-known-good snapshot next to it.
  Checked the existing `BusbarTherm Config Manager` function node in
  `flows_BBT.json` (id `ebbf810a01b0f9a6`) for the current audit-trail
  shape before building the new one: `{ts, action, user, oldConfig,
  newConfig}` in a capped array under global context key
  `audit_busbartherm`. The new `ConfigStore` audit writer keeps those
  field names (plus additive `domain`/`result`/`errors` fields) and
  writes them as an append-only `audit_trail.jsonl`, one line per
  domain-apply attempt (accepted or rejected), rather than a capped
  in-memory array — Node-RED global context isn't durable across a
  restart unless separately configured to persist, and the workplan
  requires the trail to survive.
