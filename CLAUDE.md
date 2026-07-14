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
  slice until the current one meets it. Slice 1, Slice 2 (config
  service), Slice 3 (Nano job compiler + resend wiring), and Slice 4
  (internal bus link-out taps) are **done** — all live-verified on the
  real Pi, HMI/historian/email behavior confirmed unchanged. Slice 5
  (Cloud Gateway: batcher, alarm publisher, outbox, heartbeat) is next.

- **Cloud-agnostic rule**: no AWS SDK (or any single-cloud SDK) may be
  imported outside `/src/adapters/aws`. Everything else — config
  service, Nano job compiler, cloud-gateway batcher/outbox/heartbeat —
  talks through the transport interface only. Enforce this with a lint
  rule or grep check in the test script (per the workplan's Working
  Agreement), not just by convention.

- **Edge validation rules R1–R14** (`cfg/modbus` + `cfg/joints`, in
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
| `/src/config-service` | Config store, validators (R1–R14, A1–A10), version manager, audit writer, Node-RED handlers, Nano job compiler |
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
| Modbus/joint schema (R1–R14) | `config/schemas/busduct_modbus_joint_config.schema.json` | present |
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
  changes gated to maintenance mode only (R12). Ambient sensor for
  delta-T resolves per joint through a 3-level override chain -
  `joints[].ambient_sensor`, else `zones[].ambient_sensor` for that
  joint's zone, else `modbus.ambient_sensor` (panel-wide default) - R9
  requires every joint to resolve one when alarms use deltaT, R14
  checks any override present is a valid slave/channel. Added so a
  busduct run through both air-conditioned and open-air zones can use a
  different ambient reference per zone (or per joint, for an exception
  within a zone) instead of one ambient for the whole panel.
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

## Nano job resend wiring (Slice 3, live-verified)

`compileNanoJob` (`src/config-service/nano-compiler.js`) turns the
applied `cfg/modbus+joints` doc into `{read, comm}`. The actual serial
write to the Nano lives on the **`modbusMaster_V2`** tab (`serial out`
node, `/dev/ttyACM0` @ 115200 baud — matches `Serial.begin(115200)` in
`firmware/Nano_IOT.ino`). That tab is legacy per the workplan, but it's
the live path to the real hardware, so the new resend logic was added
*alongside* it rather than rewriting its internals:

- **`Send Nano Job`** (new function node, `modbusMaster_V2` tab): calls
  `buildNanoJobMessage(store)` (`src/config-service/node-red/nano-resend-handler.js`),
  sets `msg.payload` to the compiled job, and feeds into the *same*
  `json` node the legacy read-job path already uses before the serial
  write — so the final-mile plumbing to the Nano is unchanged.
- **Three triggers**, wired via a `link in`/`link out` pair (the
  trigger sources live on a different tab than `Send Nano Job`):
  1. **Boot**: new inject node (`once`, 5s delay) on `modbusMaster_V2`,
     wired directly to `Send Nano Job`.
  2. **After RECOVERY CONTROLLER's USB power-cycle**: the existing
     `exec` node's return-code output (fires once `uhubctl ... off &&
     sleep 3 && uhubctl ... on` completes) now also feeds a new 3s
     `delay` node ("Wait for Nano Reboot" — the Nano needs time to
     finish `setup()` after power is restored), then a `link out` to
     `Send Nano Job`.
  3. **After a config apply**: `JointMasterBackEndNode` now has 2
     outputs instead of 1. Its thin wrapper returns
     `[outMsg, resendNeeded ? {payload:'apply'} : null]` — `resendNeeded`
     comes from `handleJointMasterMessage`'s return value. Output 2
     feeds a `link out` to the same `Send Nano Job` trigger.
  Recovery events themselves are already reported as SYSTEM alarms by
  the existing `RECOVERY CONTROLLER` node (`SYSTEM|MODULE|RESET_N`,
  `INFO` level, to Alarm Manager) — nothing new was needed there.

**`resendNeeded` is content-aware, not "any successful apply."**
Fixed after a live bug report: joint-mapping edits (assigning a sensor
to a joint/zone) were triggering a resend even though `compileNanoJob`
only ever reads `modbus.slaves`/`modbus.buses` — never `joints[]` — and
`applyJoints()` always carries `modbus` through unchanged for a
joint-only edit. A resend isn't a harmless no-op: the firmware re-inits
`Serial1` and the Modbus timeout on *every* job update, so an
unnecessary resend briefly disrupts live polling. `applyJoints()` now
sets `resendNeeded: !nanoJobsEqual(currentModbusJoints, newDoc)`
(`nanoJobsEqual`, `src/config-service/nano-compiler.js`, compiles both
documents and compares the result) — only a change to `modbus.slaves`/
`modbus.buses` actually triggers a resend.

`test/flows-integrity.test.js` checks every `wires`/`links` reference
in `flows_BBT.json` resolves to a real node id and that `link in`/`link
out` pairs are mutually consistent — a cheap regression guard against
hand-editing mistakes in this 537KB file, not a substitute for actually
running it.

**Tested and working on the real Pi** — Slice 3 is done.

## Modbus Settings dashboard (schema-backed, replaces legacy commissioning)

**Design decision (user, 2026-07-14):** the schema-backed path is
authoritative for Modbus commissioning. The legacy "Parameter – Modbus
Configuration" dashboard (`ui_template` `51c4bed3d56ec39f`) and "Comm
Parameters" dashboard (`ui_template` `9f459a1e.89fae8`) were a second,
complete, **unvalidated** (no R1-R14) job-building pipeline feeding the
same serial-out node as `Send Nano Job`, with no connection to
`cfg/modbus` in `ConfigStore` — "not aligned to our goal." They are now
**deprecated: do not commission slaves or change comm settings through
them.** They're left wired for now (their `SetVal` globals feed the
whole sensor-decode pipeline) and should be removed/disconnected in a
follow-up once the new table is live-verified.

The replacement, on the **Joint Config** dashboard tab (`ui_group`
"Modbus Settings", nodes `7f3a1c9e2b5d4a01`–`08`):

- **`ModbusSettingsUI`** (`ui_template`, same client-side rules as the
  joint/zone tables: sends its full `{slaves, bus}` state on *every*
  action — the data-loss-bug lesson) → **`ModbusSettingsBackEndNode`**
  (thin wrapper, 3 outputs) →
  `src/config-service/node-red/modbus-settings-handler.js`.
- Bus form (single RTU bus — the firmware has one RS-485 port and
  `compileNanoJob` enforces it) + slaves table (name/label, unit
  address, model, channels, base addr, words, scale, poll interval).
  `slave_id` is carried invisibly so joint mappings survive edits; new
  rows get the lowest unused `slNN` at apply. `function_code` is always
  3 (firmware only implements holding-register reads).
- `apply` validates through `validateModbusJoints` + `applyIfValid`
  (R1-R14 for real), with friendly pre-checks: duplicate unit address,
  deleting a slave still mapped to a joint or used as an ambient
  reference (panel/zone/joint level) is rejected by name.
- Output 2 → `link out` → the same `Resend Nano Job (in)` trigger as
  the joint table; `resendNeeded` is content-aware via `nanoJobsEqual`
  (a label-only edit doesn't resend; a bus/slave change does).
- **Legacy bridge**: on successful apply, the wrapper calls
  `writeLegacyModbusGlobals(global, legacy)` to rewrite everything the
  legacy sensor-decode pipeline (~40 function nodes on `modbusMaster_V2`
  + alert/SMS nodes) still reads: `SlaveIDList`, `slaveLength`,
  `parameterName{i}`/`parameterID{i}`/`sID{i}`/`sregisterAddress{i}`/
  `sdataBits{i}`, and the comm globals (`port`/`baudRate`/`parity`/
  `stopBits`/`Polling`/`Timeout`). `paraRaw` is flow-scoped on
  `modbusMaster_V2`, so output 3 ships it there via a `link out`/`link
  in` pair to a tiny `Sync Legacy ParaRaw` function node — so even if a
  legacy trigger still fires, it sends the same job content the
  compiler would. `parameterID` (legacy decode-type selector, no schema
  equivalent) is carried over per `unit_address`; new slaves default to
  the panel's most common existing type.
- Schema addition (user-authorized): optional `slaves[].label`
  (display name, legacy `parameterName`). The migration tool now
  populates it; on panels migrated before this field existed, the
  handler recovers labels from the live `SlaveIDList` at load and
  persists them on the first apply.

**Needs live verification on the Pi** (new `ui_template` + restart for
the library change) before the legacy dashboards are removed.

## Node-RED integration

`flows/flows_BBT.json`'s two config-editing function nodes now call the
config service instead of touching raw global context directly:

- **`BusbarTherm Config Manager`** (alarms domain) → `src/config-service/node-red/config-manager-handler.js`
- **`JointMasterBackEndNode`** (modbus/joints domain) → `src/config-service/node-red/joint-master-handler.js`

Both function node bodies are now one-liners requiring
`global.get('busductConfigService')` (see
`src/config-service/node-red/index.js`), per the thin-function-node
rule above. **This requires a `functionGlobalContext` entry in the
Pi's Node-RED `settings.js`** — see
`src/config-service/node-red/settings.js.example` for the exact
snippet; function nodes can't `require()` a local (non-npm) repo path
without it. **Full step-by-step Pi setup: `docs/pi-deployment.md`.**

**Deployment target: Node-RED 4.x on Raspberry Pi, Node.js 18+** (this
repo's own `package.json` targets the same — nothing here is
version-specific to Node-RED 4 vs earlier, and there are no native
dependencies to worry about on ARM). One real operational gotcha this
setup does have: `functionGlobalContext` entries are `require()`'d once
when `settings.js` loads at Node-RED **startup** — a plain "Deploy" in
the editor re-runs the flows but does **not** re-require this library.
After pulling a change to anything under `src/config-service/`,
**restart the Node-RED service** (not just Deploy) before testing.

`add`/`add_below`/`edit`/`delete`/`save` (single-row draft edits) keep
operating on the legacy draft shape in `global` context exactly as
before — those are UI-side bookkeeping on an intentionally-incomplete
array mid-edit, which can't be schema-validated. Only `apply` changed:
it transforms the completed draft into the new schema shape (looking
up each legacy `slaveID` against the *currently applied*
`cfg/modbus+joints` document's `modbus.slaves[]` by `unit_address` —
not re-deriving `slave_id` from scratch, since `slave_id` must stay
stable across edits) and pushes it through `validateModbusJoints` +
`ConfigStore.applyIfValid`. If a joint references a `slaveID` that
hasn't been provisioned into the applied `cfg/modbus` yet, `apply`
rejects with a clear error — this refactor doesn't add a way to
commission new slaves from the dashboard; that's still a separate,
untouched flow.

**Live-verified on the Pi**: dashboard save/apply/restore/load paths
for both the joint table and the alarm config table all confirmed
working (Slice 2's own "Done when": *"UI save/apply paths work
unchanged"* — met). Two real bugs were caught and fixed along the way
(dropped `msg` properties breaking dashboard routing;
`add`/`edit`/`delete` silently suppressing their table-refresh output)
— see the decision log. 123 unit tests plus this live pass; **Slice 2
is done.**

**Client-side data-loss bug (found after Slice 2, fixed):**
`JointMasterUI`/`ZoneMasterUI` (the `ui_template` nodes behind both
tables) only sent their current `joints`/`zones` array on SAVE and
APPLY — EDIT/ADD/ADD_BELOW/DELETE didn't. If a user typed into one row
without saving it first, then clicked EDIT/ADD/DELETE on *any other*
row, the server responded from its own last-persisted copy (missing
the unsaved edit), and the template's `$watch` unconditionally
overwrote the client's local state with that stale response — silently
discarding the in-progress edit. Fixed by sending the current array on
every action, not just SAVE/APPLY. This is pure client-side Angular JS
inside a `ui_template` node — nothing in this repo's test suite
exercises it directly, so **needs a live re-test on the Pi** like any
other flow change.

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

## Internal bus (Slice 4)

`ProcessLogic` (KPI stream, 3 outputs) and `Alarm Manager` (alarm
events, 4 outputs) — both on the `BusbarTherMo` tab — now have a `link
out` tap on every output, purely additive (new node appended to each
output's existing wire list; the two function nodes' code is
byte-identical to before). These taps have no consumer yet (`links: []`
on each) — Slice 5's Cloud Gateway batcher/alarm publisher are meant to
add matching `link in` nodes. **Full message shapes for every output:
`docs/internal-message-contracts.md`.**

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
