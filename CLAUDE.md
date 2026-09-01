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

- **Work in the slice order the workplan defines.** As of 2026-07-24
  that order is: Slice 8a (security) → 9 (blacklisting) → 10 (scale
  hardening) → 11 (BMS integration) → **8b (portability drill, pilot,
  rollout) last**. Slice numbers are stable identifiers, NOT execution
  order — see Addendum A of the workplan. Existing references to
  "Slice 8" in source comments mean the portability drill (8b).
  Each slice has a "Done when" acceptance line — don't start the next
  slice until the current one meets it. Slice 1, Slice 2 (config
  service), Slice 3 (Nano job compiler + resend wiring), and Slice 4
  (internal bus link-out taps) are **done** — all live-verified on the
  real Pi, HMI/historian/email behavior confirmed unchanged. The
  schema-backed Modbus Settings dashboard (multi-channel, R15) and the
  legacy commissioning removal are also **live-verified**. Slice 5
  (Cloud Gateway) is wired into a "Cloud Gateway" flow tab and
  confirmed flowing live on the loopback (debug counts healthy).
  **User decision (2026-07-15): Slice 5's standalone loopback soak is
  merged into Slice 6's soak** — one combined 24h soak on the real
  transport covers both slices' "Done when" (aggregates vs historian,
  alarm parity, real link pull 1h/24h, router reboot, outbox
  recovery). Slice 6 (AWS adapter + Fleet Provisioning) code is built
  and unit-tested; it needs real AWS-side inputs (ATS endpoint, claim
  certs, provisioning template — see docs/aws/README.md) before the
  panel can connect and the combined soak can run. **Update: live
  connect achieved 2026-07-17; combined 24h soak PASSED 2026-07-18 —
  Slices 1–6 are all done. Slice 7 (remote config channel) is
  **live-verified (2026-07-20)** — end-to-end push from AWS working:
  telemetry-interval knob, alarm thresholds (A10 live re-evaluation),
  R12 maintenance gate, acks + audit all confirmed on the real panel.
  **Slices 1–7 are done.** Slice 8 has been split and re-sequenced
  (workplan Addendum A): **Slice 8a (security hardening) —
  live-verified 2026-07-24 (all five gate PINs + kiosk working on the
  Pi)** — the flow's five hardcoded plaintext
  gate PINs (`system123`/`alarm123`/`AdminPro`/`AdminLite`/`Password@21`)
  are removed and now read from the Node-RED environment (fail closed
  when unset); scoped `uhubctl`-only sudoers, `.gitignore` for
  creds/keys, and editor `adminAuth` template shipped. Full runbook:
  `docs/security-hardening.md`. Then Slice 9 (device blacklisting — full design in
  `docs/blacklist-recovery-spec.md`), Slice 10 (scale hardening for
  100 joints + 10 ambient), Slice 11 (BMS Modbus TCP integration), and
  finally Slice 8b (portability drill, pilot, rollout) so the pilot runs
  against the shipping configuration. The Edge Cloud Readiness Workplan
  is now present in `docs/`; its §6 checklist is Slice 8b's exit gate.**

- **Cloud-agnostic rule**: no AWS SDK (or any single-cloud SDK) may be
  imported outside `/src/adapters/aws`. Everything else — config
  service, Nano job compiler, cloud-gateway batcher/outbox/heartbeat —
  talks through the transport interface only. Enforce this with a lint
  rule or grep check in the test script (per the workplan's Working
  Agreement), not just by convention.

- **Edge validation rules R1–R16** (`cfg/modbus` + `cfg/joints`, in
  `config/schemas/busduct_modbus_joint_config.schema.json`; R16 = RS-485
  bus loading, added 2026-07-24 for the 110-device target) and **A1–A10**
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
| `/src/config-service` | Config store, validators (R1–R16, A1–A10), version manager, audit writer, Node-RED handlers, Nano job compiler |
| `/src/cloud-gateway` | Batcher, alarm publisher, heartbeat, outbox, transport interface (empty — Slice 5+) |
| `/src/adapters/aws` | AWS-specific: endpoint config, Fleet Provisioning, Basic Ingest mapping (empty — Slice 6+) |
| `/flows` | Node-RED flow exports — `flows_BBT.json` is the current production flow |
| `/test` | Unit tests, soak/network-pull scripts, portability drill config (empty — Slice 2+) |
| `/tools` | Migration script, commissioning helper (empty — Slice 2/6) |
| `/src/historian` | Local InfluxDB historian: KPI→point transform + Node-RED exposure (not in the workplan's layout table; a local service per the Readiness Workplan) |
| `/src/integration` | Slice 11 BMS integration: register-map builder, rollup/worst-joint latch, holding-register image, ACK decode, Modbus TCP slave adapter (injected server factory), BmsService orchestration + Node-RED exposure |
| `/firmware` | Arduino Nano sketch (`Nano_IOT.ino`) — not in the workplan's layout table verbatim, kept as its own dir since it's frozen device source, not prose documentation. See decision log. |

## Reference documents

| Artifact | Path | Status |
|---|---|---|
| Edge Implementation Work Plan (this plan) | `docs/BusductTherMo_Edge_Implementation_WorkPlan.md` (+ original `.docx`) | present |
| Edge Cloud Readiness Workplan (phase-level plan this one maps to; §6 is Slice 8's exit checklist) | `docs/BusductTherMo_Edge_Cloud_Readiness_Workplan.docx` (+ extracted `.md`) | present (2026-07-21) |
| Edge node config spec | `docs/busduct_edge_config.yaml` | present |
| Modbus/joint schema (R1–R16) | `config/schemas/busduct_modbus_joint_config.schema.json` | present |
| Alarms schema (A1–A10) | `config/schemas/busduct_alarms_config.schema.json` | present |
| Integration schema (I1–I5, Slice 11) | `config/schemas/busduct_integration_config.schema.json` | present |
| **Device → cloud wire contract (versioned; the cloud team's spec)** | `docs/aws/README.md` **Part G** + `src/cloud-gateway/message-types.js` | present (2026-08-27, `v1`) |
| Internal (on-panel) message shapes — NOT the wire contract | `docs/internal-message-contracts.md` | present |
| BMS register map (customer-facing, append-only) | `docs/bms-register-map.md` | present |
| BMS integration deployment/runbook | `docs/bms-integration.md` | present |
| BACnet gateway integration (Moxa MGate 5217I-1200-T) | `docs/bms-mgate5217-integration.md` | present (2026-08-19) |
| Existing Node-RED flow | `flows/flows_BBT.json` | present |
| Arduino Nano firmware | `firmware/Nano_IOT.ino` | present |
| Licence management (remote + typed key, expiry gating) | `docs/licence-management-proposal.md` | **PROPOSAL, not built** (2026-09-01) |
| Channel recovery in the decode path (incl. why `temp_scale` is report-only) | `docs/channel-decode-proposal.md` | steps 1-2 **built**, fan-out proposed (2026-09-01) |
| Edge device user manual (operator/technician HMI guide) | `docs/edge-user-manual.md` | present |
| Nano 33 IoT field-replacement runbook | `docs/nano-replacement.md` | present |

The **Edge Cloud Readiness Workplan** (now present) is the higher-level
phase/acceptance document. Its §6 Exit Checklist is Slice 8's acceptance
bar. Mapping to what's built: its Phases 0-5 correspond to our Slices
1-7 (all done); it added **two items our slices did not cover** — (1)
**certificate rotation** (Phase 1) — **now built** (see below), and (2)
**OTA update readiness** (Phase 6: A/B dual-bank update, signed
packages, generic job message on the cmd channel, auto-rollback) —
still to build. Its §6 checklist also requires a 7-day
(not just 24h) network-pull autonomy test, the portability drill
against a non-AWS broker, and a 3-4 week pilot parallel run. OTA (Phase
6) is a substantial new build whose A/B scheme depends on the Pi's
OS/boot layout — take it to the design chat before implementing.

## Config domains

Four independently-versioned domains, validated as separate atomic
units (R11/R12 govern `cfg/modbus`/`cfg/joints`; A6 governs `cfg/alarms`;
I4 governs `cfg/integration`). The fourth, **`cfg/integration`** (Slice 11
BMS), is described in its own section below; the three original domains:

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
node, `/dev/busduct-bus1` @ 115200 baud — a udev symlink to the bus1 Nano
(`deploy/udev`), matching `Serial.begin(115200)` in
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
`cfg/modbus` in `ConfigStore` — "not aligned to our goal."

**Removed (user-directed, 2026-07-14, ahead of live verification):**
both dashboards and their exclusive chains — 32 nodes: the
commissioning UI + `modbusSlave.txt` read/write/boot-restore chains
(both copies: `modbusMaster_V2` and the config tab), the
`commParameters.txt` chain, their `SetVal` global-writers, the 'Read'
link-out, and the emptied "Communication Parameters" `ui_group` +
"Communication Settings" `ui_tab`. **Kept**: the Read/Transfer
`ui_dropdown` + "SLAVE Active" template (their group survives on the
"Slave Config" dashboard tab), and the legacy read/write/transfer job
builders with their serial-silence watchdog trigger — that's the live
polling recovery path; it now sends content identical to the compiler
because the new table's bridge keeps `paraRaw`/comm globals in sync.
Legacy globals are no longer boot-restored from txt files: they live
in the Pi's persistent (localfilesystem) context store and are
rewritten on every Modbus Settings apply. Because the old screens no
longer exist as a fallback, the new table **must** be verified first
thing after this deploys.

The replacement, on the **Joint Config** dashboard tab (`ui_group`
"Modbus Settings", nodes `7f3a1c9e2b5d4a01`–`08`):

- **`ModbusSettingsUI`** (`ui_template`, same client-side rules as the
  joint/zone tables: sends its full `{slaves, buses}` state on *every*
  action — the data-loss-bug lesson) → **`ModbusSettingsBackEndNode`**
  (thin wrapper, 3 outputs) →
  `src/config-service/node-red/modbus-settings-handler.js`.
- **RS-485 Buses table** (one row per segment; each segment is its own
  Nano on its own serial port — see the Slice 10 multi-bus entry below,
  2026-08-08. Was a single fixed bus form until then) + a slaves table
  with **one row per channel** (user requirement 2026-07-14: one slave unit can carry
  several temperature channels, so the unit address may repeat across
  rows; each channel has its own base address). At apply, rows are
  grouped by unit address into one schema slave: `channels` = row
  count, per-channel addresses/names stored in
  `registers.channel_addrs`/`channel_labels` (multi-channel; new
  optional schema fields governed by **R15** — length == channels,
  addresses unique/non-overlapping, min == `temp_base_addr`);
  single-channel slaves keep the plain migrated shape. Slave-level
  fields (model, words, scale, **poll interval**) repeat on every row
  but must match across a unit's rows — the firmware reads all of a
  slave's channels in ONE Modbus transaction (`compileNanoJob` emits
  one min..max span read per unit, via the shared `readSpan` helper
  the R10 timing math also uses), so there is exactly one poll
  interval per slave, not per channel; a mismatch is a friendly apply
  error. `slave_id` is carried invisibly so joint mappings survive
  edits; new units get the lowest unused `slNN` at apply.
  `function_code` is always 3 (firmware only implements
  holding-register reads). A `+CH` row button pre-fills the next
  channel row for the same unit.
- `apply` validates through `validateModbusJoints` + `applyIfValid`
  (R1-R16 for real), with friendly pre-checks: channel numbers within
  a unit must be 1..N with no gaps/repeats, base addresses within a
  unit unique and non-overlapping, and deleting a slave *or a channel*
  still mapped to a joint or used as an ambient reference
  (panel/zone/joint level) is rejected by name.
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

**Live-verified on the Pi (2026-07-14)** — table load/apply confirmed
working, including the multi-channel row model; the legacy dashboards
were then removed (see decision log for the exact 32-node deletion and
what was deliberately kept).

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
rejects with a clear error — commissioning slaves happens in the
Modbus Settings dashboard (above), not here.

**Alarms carry the joint's NAME as well as its id (2026-08-31).** The alarm
object had `joint_id`, `zone_id` **and** `zone_name` — zone had both halves,
joint only the key. The operator names every joint in the Joint Config table (a
mandatory column, schema `joints[].label`, *"Riser bend, above ACB-8"*) and
ProcessLogic already carried it as `d.joint_name`; the Alarm Manager just never
copied it, so the Active Alarms column headed **"Location"** rendered `J02`.
`joint_name` is now derived once and defaulted in `raiseAlarm` (same place
`zone_name` is), reaches both HMI tables as `{{a.joint_name || a.joint_id}}`
with the id kept as a tooltip, the history CSV as a `Location` column, all three
e-mail bodies via `jointLabel()`, and the cloud alarm message as a top-level
field beside `joint_id`. It is **null when unnamed and absent on panel/device
SYSTEM alarms** — never echoed from the id, since a fabricated name would be
indistinguishable from a real one, and the same `joint_name || joint_id`
fallback covers alarms already in persisted context. An added optional field, so
the wire contract stays `v: 1`.

**Joint-scoped alarm descriptions lead with the joint id (user request
2026-08-31):** `J02: ΔT 29.48 ≥ 25`, `J02: RoR 3.10 ≥ 2`, `J02: Sensor
communication failure`, via `describeJoint()` in the Alarm Manager. The
description is the one field that travels everywhere intact — e-mail subjects
and bodies, the CSV export, the alarm history, the cloud snapshot — and several
of those show it with no joint column beside it. **Nothing keys on this string**
(dedupe is by `instanceId`, historian matching by `instanceId` + `raisedTs`;
description is only ever displayed), so changing it is safe. The **id**, not the
name: short, stable, and it matches the `instanceId` in the e-mail subject,
while the name is already carried in `joint_name` and shown in the Location
column. Panel- and device-scoped alarms (`COMM_FAILURE`, `BLACKLIST`,
`PI|POWER`) are deliberately **not** prefixed — they belong to no joint, and the
blacklist alarm already names its device and affected joints.

**Joint ID format widened to 6 characters (user request 2026-08-31):**
`joints[].joint_id` was `^J[0-9]{2,3}$` — a literal `J` plus 2-3 digits, so
4 characters maximum. Sites name joints to their own convention (riser/floor
coding), not `J01..J999`. Now **`^[A-Za-z0-9][A-Za-z0-9_]{1,5}$`**: 2-6
characters of letters, digits and underscore, not starting with underscore.
Every previously legal id still validates, so the installed base is unaffected.
Two characters are deliberately excluded: **`|`**, because the alarm
instanceId is `PROCESS|{joint}|{type}|{level}` and a pipe would make that key
ambiguous to split; and **`-`**, because the MGate BACnet `description` field
forbids it (manual v1.4 p61) — `R1-J12` would reach the BMS as `R1 J12`, a
different string from the one on the HMI. Nothing derives an index or ordering
from a joint_id, so the shape itself is otherwise free. Checked against the
downstream consumers at 6 chars: MGate `cmdName`/`bacnetDescription` peak at 26
of 39/40, and keyed telemetry grows ~300 B per interval at 100 joints against a
4800 B budget that already chunks.

**Joint channel mapping (user requirement 2026-07-14):** the joint
table has a `Ch` column — each joint maps one dedicated channel of a
slave (`joints[].channel`; drafts predating the column default to 1).
Two joints may share a slave on *different* channels; the same
(slave, channel) pair repeating across joints is rejected by a
friendly pre-check naming the conflicting joint (and by R7 for real),
and selecting a channel the commissioned slave doesn't have is
rejected by a pre-check naming the slave's channel count (and by R6).

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

**⚠️ ROOT CAUSE CORRECTED (2026-07-29): the hang was a Raspberry Pi
POWER-SUPPLY problem, not firmware.** The Pi's power LED was blinking
randomly (the classic under-voltage indicator); supplying adequate power
fixed it. The team re-tested **both** the reduced-memory build *and* the
**original unmodified sketch** — **both ran fine** once power was sound,
so the RAM-exhaustion theory below was wrong. Keep this in mind before
attributing any future "device stops transmitting" to firmware: **check
Pi power first** (`vcgencmd get_throttled`, power LED). **User decision (2026-07-29): KEEP the
new firmware.** The changes below stay as deliberate defensive hardening
(the watchdog in particular buys automatic recovery from any wedge,
whatever its cause — including a brown-out), but **none of them is the
fix** and they must not be cited as one. `firmware/Nano_IOT.ino`'s header
carries the same warning so a future reader doesn't re-derive the wrong
story from the code. Note the panel already samples the under-voltage flags in
`src/cloud-gateway/pi-health.js` (`vcgencmd get_throttled` →
`low_voltage.now` / `throttled_now` / `*_since_boot`) — but only inside
the **cloud heartbeat**, with no local HMI/alarm surface, which is why
this took so long to spot. **Now surfaced locally (2026-07-29):**
`src/cloud-gateway/power-health.js` (`derivePowerAlarm`/`summarizePower`,
exposed on the existing `busductCloudGateway` global — no settings.js
change) drives a **`SYSTEM|PI|POWER`** alarm from a 30 s "Pi Power Health"
node on the Device Health tab: raises immediately (CRITICAL for
under-voltage, WARNING for throttling-only), clears after 3 consecutive
good samples so a marginal supply can't flap it, and writes
`global.busduct_power_health` for a colour-coded banner on the Device
Health dashboard. The banner keeps showing *"under-voltage since boot"*
after recovery — the forensic bit that catches an intermittent brown-out.

**Original (superseded) diagnosis, 2026-07-22 firmware rev:** the Nano
stopped transmitting
after some hours, repeatably. Suspected causes, all changed internally with
**no wire-format change** (Node-RED side untouched): (1) RAM exhaustion
— the per-loop response builder used a 12 KB `StaticJsonBuffer` on the
stack every `loop()` next to the 12 KB static `inputBuffer` on a 32 KB
SAMD21 → stack/heap collision → hard fault; now a 4 KB
`RESPONSE_BUFFER_SIZE` (it only ever holds one packet result). (2)
USB-CDC back-pressure — `Serial.print`/`flush` block when the Pi stops
reading; writes now guarded by `if (Serial)`, blocking `flush()` calls
removed. (3) No recovery — added an Adafruit SleepyDog **watchdog**
(16 s window, fed at top of `loop()` and per Modbus packet). (4) Boot
wedge — `while(!Serial)` **removed entirely** (early output is guarded
by `if (Serial)`; live testing 2026-07-24 showed bounding the wait to
2 s was not effective, so the sketch no longer waits for the host at
all). (5) `comm` validated
before `Serial1.begin` (a bad comm used to set baud 0 and kill Modbus);
`delayMicroseconds` >16383 µs routed through `delay()`. **New build
dependency: Adafruit SleepyDog library.** After a watchdog reset the
Nano waits for the Pi to resend the job — the Pi's serial-silence
watchdog already triggers that resend. Flashed to the real Nano
(2026-07-22) and confirmed transmitting — but, per the correction above,
**the hang was resolved by fixing the Pi's power supply, not by these
changes.**

## Internal bus (Slice 4)

`ProcessLogic` (KPI stream, 3 outputs) and `Alarm Manager` (alarm
events, 4 outputs) — both on the `BusbarTherMo` tab — now have a `link
out` tap on every output, purely additive (new node appended to each
output's existing wire list). The Slice 4 wiring left both function
nodes' code byte-identical; the **only** later logic edit is the RoR
fix below. **Full message shapes for every output:
`docs/internal-message-contracts.md`.**

**RoR fix (2026-07-22, user-approved):** RoR was coming through as `0`
for every joint. Root cause in `ProcessLogic`: a `if (dtSec < 2) { ror
= 0; }` "startup stability" guard zeroed RoR (and froze `emaTemp`) on
every sample whose interval was under 2 s — and this panel polls
~0.5 s, so it fired permanently. Removed the guard: the EMA update is
already time-weighted by `alpha = dtSec/tauSec`, and the first sample
is naturally 0 because `emaTemp` initialises to `sensorVal`, so no
sub-2 s special case is needed. **Behaviour change: RoR now tracks real
trends and RoR-based (A2) alarms can fire** — previously they never
could. **Live-verified on the Pi (2026-07-24): RoR tracks real trends,
no spurious A2 alarms on stable joints.**

## Scale hardening (Slice 10)

For the 100-joint + 10-ambient target. **The ambient chain is
live-verified on the Pi (2026-07-28)** after four fix passes (see the
decision log): disconnecting the ambient yields `ambient:null`/
`deltaT:null` with **no false ΔT alarm**, reconnecting **clears** the ΔT
alarms promptly (no 20-minute EMA decay), and the blacklist alarm names
the commissioned device with its real ambient impact. Positional
telemetry stays OFF (no cloud consumer yet); **two-segment RS-485 is now
wired end to end**, alarms included, against a real second Nano
(**fully live-verified 2026-08-12** — per-segment COMM alarms, isolated
blacklisting, the ΔT/RoR ladder on both segments, per-bus resend, and
per-bus USB recovery cycling only its own hub port while the other
segment kept polling). Built:
- **Ambient outlier rejection + fallback** (`src/config-service/ambient-resolver.js`,
  exposed as `busductConfigService.resolveAmbient`): a reading is usable
  only if **in-band (-20..80 C) AND fresh (age ≤ `maxAgeSec`, default 60 s)
  AND status OK**, then configured -> zone median -> panel median -> none.
  Wired into ProcessLogic's ΔT block (configured-and-usable path unchanged;
  fallback only when the ambient is out-of-band/**stale**/**faulted**/missing;
  ambient output gains a `source`). **Live-fixed 2026-07-28:** the first
  cut only checked the band, so an unplugged ambient that read a *plausible*
  `0 °C` (age 166 s, comm-failed) was accepted as `source:"configured"` and
  ΔT = joint − 0 ≈ 31 raised false WATCH/WARNING alarms. Fix: readings now
  carry `{val, age_sec, status}`; the ambient cache no longer overwrites the
  last-good value on a faulted read and tracks `lastGoodTsMs`; a stale/faulted
  ambient is rejected → fall back (or `none` → **ΔT simply isn't computed**
  rather than fabricated against 0). **Live-fixed again 2026-07-28 (2nd
  pass):** the disconnected transmitter kept answering Modbus with a
  FRESH, in-band, status-OK `0.0 °C` for ~20 min (register 0x0000) before
  the bus comm-failed — so band/age/status all passed. Added a **zero
  sentinel**: a reading within `DEFAULT_ZERO_EPS` (0.05) of 0 is treated as
  no-data (0 °C isn't physical for a switchgear ambient). Configurable via
  `zeroEps` (set `null` + raise `band.min` for a genuinely sub-zero site —
  flagged for the design chat). On a single-ambient panel, unplugging the
  ambient now yields `source:"none"` and no ΔT alarm.
- **Ambient RECOVERY / ΔT EMA re-init (live-fixed 2026-07-28, 3rd pass):**
  reconnecting the ambient did not clear the stale ΔT alarms. ProcessLogic
  had no `else` for the unusable-ambient case, so `deltaTEmaState` stayed
  frozen at its poisoned value (~32) and, on recovery, **decayed** toward the
  true ΔT (~3.7) with tau = `timeWindowMin` (20 min) — the alarm looked stuck
  for 20+ min. Two fixes: (1) ProcessLogic now marks the joint's baseline
  `{ambInvalid:true}` while no usable ambient exists and **drops it on the
  first usable sample**, so ΔT re-inits from the real reading (same idea as
  the Slice 9 blacklist-restore reset); (2) `emaResetJoints` now also includes
  joints that merely **reference** the restored slave as their ambient
  (`jointsUsingAmbientSlave` + `ambientSlaveForJoint`, R14 joint→zone→panel
  chain) — a dedicated ambient slave carries no joints, so a restore used to
  reset nothing. **Recovering a panel stuck from before this fix:** set
  `global.busduct_ema_reset = {J01:true, J02:true, ...}` once (inject node);
  ProcessLogic drops those baselines on the next sample.
- **100+ device commissioning fixes:** `slave_id` generation now handles
  3 digits (`sl100+`; carried-id regex `^sl[0-9]{2,3}$`, `nextFreeId` cap
  128) and **R16 bus-loading warnings** now surface on the Modbus
  Settings apply toast (`store.applyIfValid` returns `warnings`).

- **Positional-array telemetry (edge built, OFF by default):** `Batcher`
  `positional` mode emits a compact column-oriented payload (dt_min/max/
  avg, ror_max, t_max, amb_avg as index-aligned arrays) + a
  self-versioning **manifest** (index→joint_id, QoS 1, republished only
  on change), with index-range chunking as a safety net. Whole 100-joint
  panel in ~one message. Enabled via `publish.telemetry.encoding:
  'positional'` in the edge config; **default keyed** stays live until
  the cloud pipeline is built to consume it (cloud is deferred to after
  the edge workplan). Format contract: `docs/slice10-design-proposals.md` §A.

- **Two-segment RS-485 — cloud-agnostic core built (`docs/slice10-design-proposals.md` §B):**
  `compileNanoJob(doc, {busId})` compiles one job per bus (filters slaves
  by `bus_id`, emits that bus's own comm), errors `specify {busId}` on a
  multi-bus doc without one; `nanoJobsEqual(a,b,busId)` and
  `buildNanoJobMessage(store,{busId})` are bus-aware;
  `unitToSlaveId(doc,addr,busId)` + `processReadResult` (reads
  `ctx.busId ?? payload.bus_id`) resolve a response within its bus (unit
  addresses are unique per-bus, one tracker keys by global `slave_id`).
  **Single-bus panels are byte-for-byte unchanged** (every new arg
  optional).
- **Second segment WIRED in the flow (2026-08-10, second Nano connected):**
  `modbusMaster_V2` now carries a bus2 `serial-port` config
  (`/dev/busduct-bus2` @115200), `bus2 Nano in` → **`Tag Bus2`** (stamps
  `msg.bus_id` as a TOP-LEVEL property — payload is still a raw string at
  the serial edge, and the `json` node rewrites only `payload`, so the tag
  survives to the blacklist tap, which now reads it as `ctx.busId`) → the
  **same shared** decode/UI/Data-Out chain (safe because addresses are
  unique panel-wide), a second `Send Nano Job (bus2)` → `json` →
  `serial out`, and **its own 30 s serial-silence watchdog** (a shared one
  would let bus2 traffic keep a dead bus1 looking alive) which recovers by
  resending bus2's own compiled job rather than the bus1-only legacy
  `paraRaw` builder. `test/two-segment-flow-wiring.test.js` pins all of
  this — the flow is hand-imported JSON and a half-wired segment fails
  silently.
- **Alarm generation for bus2 (2026-08-10)** — the wiring above carries
  bus2's *data*; raising an *alarm* about bus2 needed a further layer.
  ΔT/RoR needed nothing (ProcessLogic is keyed by unit address, unique
  panel-wide). The rest could not be shared: bus2 got **its own COMM
  watchdog** and stopped feeding bus1's — the transport wiring had routed
  bus2 into bus1's `Data Out`, so either Nano being alive satisfied the
  single watchdog and *neither* segment's total failure could alarm. The
  **Alarm Manager** now derives the COMM key from `msg.payload.busId`
  (`SYSTEM|BUS2|COMM_FAILURE`; absent or `bus1` keeps the original key
  byte-identical). **Per-bus blacklist resend** via `resendBusIds` from
  `_finalize`, so a bus2 failure can't glitch bus1 (the firmware re-inits
  its Modbus timeout on every job update). **Per-bus USB recovery**: the
  RECOVERY CONTROLLER is thin over `src/config-service/bus-recovery.js`
  (`planRecovery` — pure, timing-injected, independent ladders per
  segment); bus2's hub port comes from **`BUSDUCT_UHUBCTL_BUS2`** in
  `/etc/busduct/nodered.env` (site wiring, not code) and is
  pattern-validated before it reaches the root shell — unset means bus2
  alarms normally but is never cycled. Guarded by
  `test/flows-bus2-alarms.test.js`.
- **Two fixes from the first panel drill (2026-08-10)** — (1) the bus2
  silence watchdog was a `trigger`, which fires ONCE and then needs an
  input to re-arm, and its input is the frame stream that has gone quiet;
  a Nano that missed that single resend stayed dark forever. Now a
  liveness stamp + 15 s check that keeps retrying. (2) the Diag **Status**
  column froze: `global.Status[addr]` is written only when a frame is
  decoded and nothing expired it, so a device that stopped being polled
  kept reading "Connected" and a dead segment rendered all-green. Writes
  are stamped; entries older than 60 s read **"No Data"**.
- **Commissioning UI for the second bus (2026-08-08)** — the schema
  allowed two buses but there was no way to *enter* one (user report).
  The Modbus Settings dashboard now has an **RS-485 Buses table**
  (ADD BUS / DEL, one row per segment with its own port/baud/parity/
  timeout/retries/inter-frame) and a **Bus column on every slave channel
  row**. Apply guards: no two buses on one serial port ("each RS-485
  segment needs its own Nano on its own port"), no deleting a bus that
  still carries sensors (named), no slave on an undefined bus, all
  channels of one unit on one bus. **Unit addresses must be unique across
  ALL buses** — deliberately stricter than Modbus, because the surviving
  legacy decode pipeline keys `sensorData[<unit_address>]` by address
  alone; making ~40 legacy nodes bus-aware would be a large change to the
  live data path. **Resend is per-bus** (`resendBusIds` → one
  `{payload:'apply', busId}` per *changed* segment), and each `Send Nano Job`
  names its segment as a **literal** (`const MY_BUS = 'bus1'|'bus2'`) and
  drops a resend aimed elsewhere; on a single-bus panel that id is a
  preference, not a filter, so renaming the sole bus can't stop polling.
  **Not an env var**: function nodes have no per-node environment
  (`env.get()` resolves from the group, then the tab) and both nodes share
  one tab, so an env var could never differ between them.
  The **legacy bridge stays bus1-only** (`comm` + `paraRaw` describe bus1,
  the only port the legacy job builders write to) while `SlaveIDList`/
  `parameterName{i}` keep every channel on every bus so the decode side
  can handle either Nano's response.

## BMS integration (Slice 11 — core built, flow wiring + live pending)

Modbus TCP slave on the Pi + off-the-shelf Modbus→BACnet gateway (agreed
approach — certified stack, no BOM commitment; native BACnet is a later
product investment the point model carries into unchanged). A **peer
adapter** of the cloud gateway: fed from the same internal link-node bus,
computed locally, works with the internet down. Full deployment/runbook:
`docs/bms-integration.md`; customer-facing register map:
`docs/bms-register-map.md` (versioned, **append-only** — rule on page 1).

- **Fourth config domain `cfg/integration`** (schema
  `busduct_integration_config.schema.json`, validator
  `validate-integration.js`, rules **I1–I5**: I2 privileged-port warning,
  I3 tier≥2 needs zones, I4 append-only point_map_version + domain-version
  monotonicity, I5 register-map capacity). Same store/validate/audit path
  as the other three; registered in `store.js` (`DOMAIN_FILES`/
  `DOMAIN_VERSION_KEYS`) and `node-red/index.js` `createStore`.
- **Pure, unit-tested core (`src/integration/`)**: `register-map.js` —
  deterministic layout from cfg/joints + cfg/integration, **fixed block
  bases/strides** so adding a joint/zone never renumbers a point
  (append-only by construction); Tier 1 summary (~12 pts @ base 0) +
  control/ACK (base 16) + optional severity bitmap (base 32) + Tier 2
  per-zone (base 100, stride 8) + Tier 3 per-joint (base 500, stride 8).
  `rollup.js` — `WorstJointLatch` (first-raised holds, reassign only on
  clear) + per-level instance counts + panel/zone maxima (LIVE joints
  only). `holding-registers.js` — signed-int16 ×10 image, NO_DATA
  (−32768) sentinel for dark joints, heartbeat wrap. `ack.js` — decode a
  BMS write to the ACK register (1 = ACK all active; 1000+i = ACK joint
  i). `modbus-tcp-slave.js` — adapter with an **injected serverFactory**
  (same DI pattern as the cloud transport / cert reconnect), so the socket
  library is swappable and unit-testable. `bms-service.js` — orchestration
  singleton (ingest KPIs/alarms/blacklist → refresh → image → slave; ACK →
  alarm ACK path).
- **`busductIntegration`** Node-RED entry (`src/integration/node-red/`):
  `getBmsService` (process-wide singleton — holds latch/heartbeat/socket,
  must NOT go through serialised context), `handleIntegrationMessage`
  (config apply → reconfigure). Production Modbus server is the pure-JS
  **`jsmodbus`** (optionalDependency, **lazily required** in
  `jsmodbus-server-factory.js` — the only file importing it; the
  cloud-agnostic grep stays green). Without it installed, the service
  computes images but binds no socket.
- **BMS Integration flow tab — BUILT (2026-07-29)**, nodes
  `b115ac57e0f100xx`: "BMS server @boot" (builds the singleton with the
  production `jsmodbusServerFactory`, wires the ACK bridge **once per
  process** — the singleton survives a Deploy, so an unguarded `onAck`
  would stack handlers and ACK each alarm N times), `link in` taps off
  the existing Slice 4 `KPI Stream - Joint` and `Alarm Events - Active`
  link-outs, and a 5 s "BMS Refresh" tick that ingests
  `busduct_blacklist_state`, recomputes the image and bumps the
  heartbeat. A BMS write to the ACK register is expanded into one
  `{action:'ACK', instanceId, user:'BMS'}` per matching active alarm —
  the same shape the HMI's table sends, so it takes the identical path
  into the audit trail. Verified end-to-end against the real 21-slave
  migrated config with a fake server factory: 20 live joints, 658
  registers, Tier-1 `panel_max_temp` 615 (61.5 °C ×10), and the ACK
  bridge emitting correctly.
- **Live-verified on the Pi (2026-08-03)** — Modbus TCP working end to end
  after the jsmodbus factory rewrite (see the decision log: the first
  factory was written against an assumed API and reset every connection).
  `tools/bms-read.js` reads the whole Tier-1 block over a real socket
  (`panel_max_temp 319 -> 31.9 °C`, `live_joint_count 2`), the **heartbeat
  advances** (and correctly reported FROZEN before the tick had started),
  and a **BMS-originated ACK lands in the alarm history** with its Ack
  timestamp. **Three of the four §11 "Done when" criteria are met.**
- **MGate 5217 CSV generator (2026-08-26)** — `tools/mgate-csv.js` (logic in
  `src/integration/mgate-csv.js`) builds the gateway's Modbus-configuration
  CSV from the panel's applied config via the same `buildRegisterMap` the
  TCP server answers from, so the two cannot drift. One register = one
  command = one BACnet object (`Read quantity` is 1 or 2), so Tier 3 is
  600–1200 rows. The manual's import-time limits are encoded as tests
  (object-type/function-code legality — **`Analog Value` is write-only**,
  reads use `Analog Input`/`Multi-state Input`/`Integer Value`; instance
  uniqueness per type; `cmdIndex` order + 1200 cap; 40/39-char fields;
  forbidden charset; `devSequence` ≤ 32). **Two-gateway splits go by ZONE**
  (`--zones=`) not joint index — a straddling zone would emit its Tier-2
  rollup on both gateways. Prefer `--template=<gateway export>`; the CSV
  format is versioned. Doc: `docs/bms-mgate5217-integration.md` §5c.
- **Not yet done**: the
  **reference-gateway live validation** (workplan §11 "Done when": a stock
  gateway reads Tier 1 as BACnet with no custom mapping; a frozen Pi is
  detectable via the heartbeat; a BMS-originated ACK lands in the audit
  trail). Both need the Modbus→BACnet gateway hardware — as does the first
  real import of a generated CSV.

## Device blacklisting (Slice 9 — done, live-verified 2026-07-28)

Full design: `docs/blacklist-recovery-spec.md`. Removes a dead/marginal
slave from the scan so one bad device can't tax the other 109.

- **Firmware (step 1):** `Nano_IOT.ino` re-inits `Serial1`/timeout only
  when baud/timeout actually change (not every job), so a blacklist/
  probe resend (same comm, different read set) doesn't glitch the bus.
- **`src/config-service/blacklist-tracker.js` (steps 2-3):** pure
  `BlacklistTracker` — blacklist after 3 consecutive failures, probe on
  backoff 30s→5m, restore after 3 consecutive good probe reads
  (hysteresis, no flap). active/blacklisted/probing states.
- **Compiler (step 4):** `compileNanoJob(doc, {excludeSlaveIds})` +
  `buildNanoJobMessage(store, {excludeSlaveIds})` omit blacklisted
  slaves; comm unchanged. `Send Nano Job` reads
  `global.busduct_blacklist_exclude`.
- **`src/config-service/node-red/blacklist-handler.js` (steps 5,7):**
  pure orchestration exposed at `busductConfigService.blacklist` —
  `processReadResult`/`processTick` drive the tracker from Nano `{t:'r'}`
  results, decide resend (exclude-set change), emit blacklist alarm
  commands, and derive joint **LIVE/STALE/OFFLINE** (STALE = held alarm
  on a non-measurable joint, carries `last_valid_ts`).
- **Alarm Manager:** new blacklist section raises/clears one ACK-able
  `SYSTEM|<slave>|BLACKLIST` alarm (mirrors the COMM watchdog); the
  `CONFIG_REMOVED` sweep now skips `category:"SYSTEM"` alarms (so a
  blacklist/COMM alarm isn't auto-cleared — also fixes a latent COMM
  bug). `buildOutputs` mirrors active alarms to
  `global.busbartherm.activeAlarms` for joint-state derivation.
- **Flow:** new **Device Health** tab (nodes `d9b1ac57e0f100xx`) — taps
  the Nano response stream (via the "Data Out" link), runs the Blacklist
  Engine (+10s probe tick), resends the trimmed job, injects blacklist
  alarms into the Alarm Manager, and writes `global.busduct_blacklist_state`
  for the HMI. Hold-don't-clear is satisfied by the existing "no data +
  still-configured" behaviour (blacklisted joints stay in config).
- **HMI view:** a **Device Health** dashboard tab
  (`ui_template` `d9b1ac57e0f10022`, fed by a 5 s refresh) renders
  `summarizeBlacklist(global.busduct_blacklist_state)` — a live table of
  blacklisted/probing slaves with recovery countdown + affected joints,
  and the STALE/OFFLINE joint lists. Each blacklisted slave also shows in
  **Active Alarms** as its `SYSTEM…DEVICE_BLACKLIST` alarm.

- **Freeze/reset on restore (step 6, built after RoR live-verified):**
  freeze is automatic (a blacklisted joint gets no samples, so its EMA +
  persistence timers don't advance). On restore the handler flags the
  joints in `global.busduct_ema_reset`; ProcessLogic drops that joint's
  `emaState`/`deltaTEmaState` on the next sample so it re-inits
  (`emaTemp=sensorVal`, RoR=0) — **AC4: no spurious RoR after a blackout**.
  The Alarm Manager's blacklist-clear also resets `PROCESS|<joint>|*`
  persistence timers so a re-appearing condition re-proves from zero.

**Config-change alarm sweep (2026-08-31, from a live report).** After editing
the joint configuration, alarms raised against the *old* setup stayed in Active
Alarms. The Alarm Manager has always had a "CLEANUP DELETED SENSORS" sweep, but
it had two gaps: it compared against **`global.joint_master_zone_A`** — the
legacy DRAFT the dashboard edits, which can disagree with what is actually
running — and it **skipped every SYSTEM alarm**, so a `SYSTEM|<slave>|BLACKLIST`
alarm for a *deleted* device could never clear (a deleted device is never
polled, so the tracker never emits `restored`). `sweepDecommissionedAlarms`
(`src/alarms/config-sweep.js`, on `busductConfigService.alarmSweep`) replaces
it: source of truth is the **applied** `cfg/modbus+joints` doc, PROCESS alarms
clear when their `joint_id` is gone, device-scoped SYSTEM alarms clear when
their `slave_id` is gone, and **panel-scoped** SYSTEM alarms
(`MODULE`/`BUS1`/`BUS2`/`PI`) are never swept — "not in the config" is
meaningless for those. **The scope segment of a SYSTEM key is not one
namespace**: `SYSTEM|<slave>|BLACKLIST` carries a slave_id, but the per-sensor
fault alarms are keyed `SYSTEM|<joint_id>|COMMUNICATION`/`|SENSOR_FAULT`. The
first cut checked only the slave list and so cleared those the instant they were
raised — on a panel with a disconnected sensor that produced a raise/auto-clear
pair, and a pair of e-mails, every 5 minutes (the blacklist tracker's max probe
backoff). The scope is now matched against **both** id spaces; an unrecognised
scope is still swept, so a deleted device's blacklist alarm still clears.
Critically it **refuses to act on absent information**:
no readable doc, or an empty `joints[]`, sweeps nothing. The old `|| []`
fallback meant a missing global made every joint look deleted and would have
auto-cleared every PROCESS alarm on the panel at once. The call sits in a
`try/catch` on the live alarm path and defaults to sweeping nothing, so it can
never break alarming; `test/flows-integrity.test.js` pins both properties. **Live-verified on the Pi (2026-08-31)**: three stale alarms auto-cleared together, shown in Cleared Alarm History as "(Auto-cleared)". Note one of them (`J1_2143124`, 10 chars) could never have passed the 6-char schema pattern — because **ProcessLogic raises alarms from the legacy DRAFT global**, not the applied doc. Alarms are therefore raised from the draft but swept against the applied config; that asymmetry is correct for cleanup but means a saved-not-applied joint can raise an alarm the sweep then clears. **Repointed 2026-09-01 (user decision):** ProcessLogic now reads `global.busduct_applied_joints`, published every 10 s from the applied doc by "Publish Applied Joints" (Device Health tab, `c0nf1gd21ft0000x`) via `buildProcessLogicJoints` (`src/config-service/process-logic-joints.js`, on `busductConfigService.processLogicJoints`). Raise and sweep now share one source of truth. **Polling, not apply-hooks** — local joint apply, local Modbus apply, a remote push and a hand-edited file must all converge, and a poll cannot miss one; ProcessLogic itself never touches the store (it runs on every reading). **Fail-safe: the draft remains a fallback** when the global is empty (boot, or library not loaded) — a fire-safety monitor must not stop watching joints because a global is unpopulated. The change also makes the **R14 ambient chain** (joint → zone → panel) actually take effect, which the draft's flat `ambientSlaveID` never honoured. **Channel disambiguation is NOT fixed and cannot be here**: the Nano frame is `{t:'r', id:<unit address>, ...}` with no channel, so rows stay keyed by unit address; where two joints share one, the lowest channel wins (matching the old `find()`) and a warning is surfaced. New **"Configuration Status" banner** on the Joint Config tab (`c0nf1gd21ft00010/11`) names joints saved-but-not-applied — the behaviour change is that those are no longer monitored, so it must announce itself.

**Stale-alarm reconciliation (2026-08-31, from a live report).** The panel
showed a CRITICAL `Slave 101 (AmbientT) blacklisted` alarm while the same
device read 31.39 °C and showed **Connected/Active** on the Diagnostics and
BMS views. Not a false blacklist — a **stuck alarm**. The two halves have
different lifetimes: the tracker is an in-memory singleton (empty after every
Node-RED **restart**), while the alarm lives in the Alarm Manager's
localfilesystem-backed context and **survives** one. The alarm clears only on a
tracker `restored` event, so a device blacklisted *before* a restart never gets
one and its alarm stays active forever. `reconcileBlacklistAlarms(activeAlarms,
tracker, doc)` (blacklist-handler.js) emits a clear for any
`SYSTEM|<slave>|BLACKLIST` alarm whose slave the tracker considers `active`;
a slave it considers `blacklisted` or `probing` is left alone. Wired as
"Reconcile Blacklist Alarms" on the Device Health tab
(`d9b1ac57e0f10051`–`53`), a **one-shot boot inject at 20 s** — late enough
that polling has resumed and a genuinely dead device has already re-failed its
3 reads, so its alarm survives correctly. Deliberately NOT on the 10 s tick:
that would race the raise path. Any deploy that restarts Node-RED while a
blacklist alarm is active would otherwise leave it stuck.

**Stale EXCLUDE set after a restart (2026-08-31, second live report).** Two
sensors read `No Data` with frozen values while the tracker called every device
`active` and the HMI said *"all responding"*. Same lifetime mismatch as the
stuck alarm above, but the more dangerous half:
`global.busduct_blacklist_exclude` — what `Send Nano Job` subtracts from the
compiled read job — is written to the **default** context store
(localfilesystem, **survives a restart**), while the tracker does not. The
Blacklist Engine rewrites that global only when `resendNeeded` is true, and
after a restart `_finalize` computes
`prevExcludeKey === undefined ? excludeSlaveIds.length > 0 : …` = **false** on a
fresh tracker, so a stale list is never corrected. The failure is silent *and* a
deadlock: an excluded slave is never polled, so it produces neither an `ok` nor
an `err` for the tracker to count — it can never be re-blacklisted or restored.
The stuck-alarm fix above made it *less* visible, since the tracker calls the
slave active and the alarm gets cleared. `reconcileExcludeSet(persistedExclude,
tracker, doc)` keeps only slaves the tracker actually has `blacklisted`
(**`probing` is deliberately not excluded** — probing means "back in the scan on
backoff", and excluding it would stop the very reads that let it recover), and
returns the buses to resend so a healthy panel is a no-op rather than an
unnecessary job update. Wired as "Repair Blacklist Exclude"
(`d9b1ac57e0f10054`–`55`), a boot inject at **10 s — before** the 20 s alarm
reconcile, so the scan is repaired first and a genuinely dead device has
re-failed its 3 reads by the time alarms are reconciled.

**Blacklist live-verified on the Pi (2026-07-24):** disconnecting a
device blacklists it (after the tap was fixed to read the PARSED Nano
stream, and the tracker moved to a module singleton) and raises its
SYSTEM alarm. **Restore path + alarm wording live-verified 2026-07-28**
— reconnecting clears the blacklist alarm (seen in Cleared Alarm
History), and the raise text now names the commissioned device
(`Slave 101 (AMBIENT_101)`, not `sl21`) and states the real impact
(`ambient reference for joint(s) J01, J02 - ΔT unavailable`) instead of
the misleading `(none mapped) not measurable`. **Slice 9 is done.**
Deploy = git pull → restart Node-RED → re-import flow.

## Cloud Gateway tab (Slice 5, wired — soak pending)

New "Cloud Gateway" flow tab (nodes `8a1b2c3d4e5f6a10`–`22`) consumes
three of the Slice 4 taps: KPI joint (`18f56266a8967320`), alarms
active (`f0f308d026bba2a9`), alarms cleared (`f4b8cd205f84810e`). The
ambient/unassigned KPI streams and historian/email alarm taps stay
unconsumed (batcher reads each joint's ambient from inside the joint
message; historian/email stay local-only). Thin function nodes call
`src/cloud-gateway/node-red/` (exposed as **`busductCloudGateway`** in
`functionGlobalContext` — settings.js.example updated; same
restart-not-Deploy rule applies):

- `getGateway()` builds a **process-wide singleton** (batch
  accumulators and the alarm publisher's RAISE dedupe must survive
  across messages): `Outbox` at `/var/busduct/outbox` (dir must exist,
  see pi-deployment §2) draining 5 msg/s into a `LoopbackTransport`
  capped at 500 recorded publishes (no MQTT until Slice 6 swaps in the
  AWS adapter behind the same transport interface), `Batcher` +
  `AlarmPublisher` + `Heartbeat` on topics resolved from the edge
  config templates with placeholder identity `c0000/s0000/p0000`
  (Slice 6 provisioning supplies the real one). Heartbeat publishes on
  the telemetry topic — the yaml defines no separate heartbeat topic.
- Telemetry flush: inject every **600s** → `flushTelemetry(gw, 10)` —
  the `10` (interval_min, stamped into payloads) must be kept in sync
  with the inject period by hand. Heartbeat: hourly inject (+once at
  boot +30s) sends fw version (`global.fwVersion`, 'unknown' until
  something sets it) and applied config versions from the ConfigStore.
- Debug nodes on both show flush/outbox/publish counts in the sidebar
  — that's the live bench-verification surface until Slice 6.

Slice 5's "Done when" (24h bench soak vs historian + link-pull drill)
is merged into Slice 6's combined soak (user decision, 2026-07-15) —
the soak scripts under `/test` are still to be written.

## AWS adapter & provisioning (Slice 6, built — awaiting AWS account)

All under `src/adapters/aws/` (the only place allowed to be
AWS-specific), built on **mqtt.js** — pure JS, no AWS SDK anywhere
(the cloud-agnostic grep stays trivially green), no native aws-crt
build on ARM, and because it's plain MQTT+TLS it doubles as the
Slice 8 portability-drill transport (point `mqtt.endpoint` at
Mosquitto):

- **`edge-config.js`**: loads/validates the per-panel
  `/etc/busduct/edge-config.yaml` (spec: `docs/busduct_edge_config.yaml`,
  overridable via `BUSDUCT_EDGE_CONFIG`), resolves topics from the
  identity block; `use_basic_ingest: true` rewrites only the telemetry
  *publish* topic to the `$aws/rules/btTelemetry/...` form.
- **`aws-iot-transport.js`**: implements the transport interface
  (publish/subscribe/isConnected/onConnectionChange) — TLS 1.2 mutual
  auth on 8883, thing name = client ID, keep-alive 300s, LWT
  (`{type:'lwt', thing_name}` on the **status** topic, QoS 1 — see the
  message-contract section below), and **self-managed reconnect** with full-jitter exponential backoff
  2→300s (mqtt.js built-in reconnect disabled; subscriptions replayed
  on every reconnect). `publish` rejects while disconnected — that's
  what makes the outbox hold-and-drain behave correctly.
- **`provisioning.js` + `tools/provision-panel.js`**: Fleet
  Provisioning by claim over plain MQTT topics
  (`$aws/certificates/create/json` → `$aws/provisioning-templates/{t}/provision/json`),
  writing the operational cert/key to the config's paths (key 0600).
  The CLI refuses to run on an already-provisioned panel without
  `--force`. Cloud-side deliverables: `docs/aws/iot-policy-panel.template.json`
  (per-device policy locking each panel to its own namespace via thing
  attributes), `docs/aws/provisioning-template.json`, `docs/aws/README.md`
  (admin runbook + per-panel commissioning steps).
- **Transport selection is automatic**: `getGateway()` (no args) calls
  `createGatewayFromEdgeConfig()` — if the edge config loads and the
  cert/key/CA files exist, it builds the AWS transport and connects;
  otherwise it falls back to the loopback with a `reason` string
  (surfaced via `getGatewayInfo()` and the flush status's
  `transport_mode`/`connected` fields). A provisioning problem never
  takes down local monitoring. This composition root is the ONE place
  that may require from `src/adapters/aws` — gateway logic still sees
  only the transport interface.

**Live connect achieved (2026-07-17)**: the real panel provisioned via
Fleet Provisioning (after two live fixes: `bt-panel` thing type — AWS
caps untyped things at 3 attributes — and a SUBACK race in the
provisioning request/response flow) and now publishes to AWS IoT Core:
`transport_mode: "aws"`, `connected: true`, telemetry flowing every
10 min.

**Soak tooling** (`BUSDUCT_SOAK_LOG=<dir>` in Node-RED's environment,
else fully inert): `src/cloud-gateway/soak-recorder.js` captures raw
KPI/alarm taps, flush statuses, accepted publishes (with drain time),
and connection transitions as JSON-lines; `tools/soak-verify.js`
(logic in `src/cloud-gateway/soak-verify.js` — the CLI lives in
/tools because `node --test` executes everything under /test)
recomputes every interval's aggregates from the raw samples, checks
alarm RAISE/CLEAR parity in order, and reports offline windows +
hold-and-drain times. See docs/aws/README.md §C5 for the procedure.

**Combined 24h soak: PASS (2026-07-18, user-verified via
tools/soak-verify.js)** — Slice 5's and Slice 6's "Done when" are both
met. **Slices 1–6 are done.** Heartbeats now carry a `system` block
(`src/cloud-gateway/pi-health.js`: cpu_temp_c, mac_id, ram_free_mb,
ram_available_mb, low_voltage incl. Pi under-voltage/throttling flags
from `vcgencmd get_throttled`; all fields null off-Pi, probe failures
never break the heartbeat).

**Uplink + Pi health extended (user request 2026-09-01).** The `system` block
now also carries **`disk[]`** (`df -P -k`; the highest-value addition — the SD
card holds the InfluxDB historian *and* the cloud outbox, and a full disk breaks
both silently), **`uptime_sec`** (a value that decreases between heartbeats is a
reboot — the brown-out signature), **`load`** with `cpus`, **`ram_total_mb`**,
**`clock_synced`** (`timedatectl`; edge_utc timestamps depend on it),
**`process_rss_mb`** (Node-RED's own RSS, the only slow-leak signal), and full
**uplink identity**: Wi-Fi `ssid`/`bssid`/`freq_mhz`/`band`/`tx_bitrate_mbps`
from one `iw dev <if> link` call (fallback `iwgetid -r` + `/proc/net/wireless`,
since wireless-tools is absent by default on Bookworm), and cellular
`operator`/`access_tech`/`registration`/`modem_state` from `mmcli -m any -K`
(fallback: the human output). Cellular still sends only **one** AT command
(`+CSQ`) on `BUSDUCT_MODEM_AT_PORT` — each exchange on a modem carrying a live
data session is a risk; **CSQ 99 = "unknown"** and is now rejected rather than
decoded as +85 dBm. Extra filesystems via `BUSDUCT_HEALTH_DISK_PATHS`
(colon-separated). Every probe nulls **only its own field**, and all spawns use
`stdio: ['ignore','pipe','ignore']` — `timedatectl` on a non-systemd box
otherwise writes to Node-RED's log every hour. `wifi.ssid`/`bssid` name the
customer's network and are published: deliberate (remote diagnosis of a marginal
link needs the AP identity) but site information. Rejected as not earning their
place: CPU frequency (throttle flags cover the actionable part), SD-wear counters
(not portable), per-core temps (a Pi has one thermal zone), throughput counters
(needs cross-sample state; the outbox backlog already answers it).

**Also on the HMI: a "Panel & Uplink" tile** (`ui_group` `d9b1ac57e0f10060` +
tile `…61`, on the **Diagnostics** dashboard tab beside BMS Registers — moved
there 2026-09-01 because the Device Health dashboard tab is not one operators
navigate to; it is fed from the Device Health *flow* tab either way). The heartbeat carries the same data but
*hourly and only when the link is up* — exactly wrong for a technician standing
at the panel wondering why the uplink is marginal. `summarizeSystemHealth`
(pure, on `busductCloudGateway`) renders SSID/operator as the headline with a
colour-coded good/fair/poor band (Wi-Fi ≥ −67/−75 dBm, cellular ≥ 50/25 %),
plus CPU, RAM, disk, uptime, load, and a warning list (disk ≥ 85/92 %, clock
unsynced, CPU ≥ 70 °C, load > cores, poor signal). **No extra collection cost**:
the existing 30 s "Pi Power Health" node already calls `collectPiHealth()`, so it
just summarises the snapshot it has — a second collector would have re-spawned
`df`/`iw`/`mmcli`/`timedatectl` every 30 s for the same numbers.

## Device → cloud message contract (2026-08-27)

**Every published message carries a `type` field as its first
property.** The authoritative list is
**`src/cloud-gateway/message-types.js`**, required by every publisher so
the code cannot drift from the docs: `telemetry`, `manifest`,
`heartbeat`, `alarm`, `device_health`, `config_ack`, `cert_ack`, `lwt`.
Full table with
topics, QoS and payload examples: **docs/aws/README.md Part G**.

Why it exists: four shapes shared the telemetry topic (interval
aggregate, heartbeat, positional manifest, LWT) and only the manifest
said what it was, so a consumer had to discriminate by sniffing field
presence — decodes today, mis-routes silently the first time anyone adds
a field. Caught in design review as CR-OPEN-3 and fixed **before cloud
development started**, so there is no deployed consumer to migrate.

- `type` values are a wire contract: **append-only**, like the BMS
  register map. A new message shape gets a new value, never a reused one
  with an extra flag.
- Telemetry carries `encoding: 'keyed' | 'positional'` — both are
  `type:'telemetry'` on purpose, so a consumer needn't know how the panel
  is configured. Keyed is the default and the only one live.
- **The LWT moved to its own `status/{c}/{s}/{p}` topic**, never
  Basic-Ingest rewritten. On the telemetry topic it was wrong twice: a
  disconnect is not a measurement, and under Basic Ingest that topic is an
  IoT Rule ingress, so the LWT arrived as a malformed telemetry record and
  could not be subscribed to at all.
- **Every message also carries `v`** (contract version, currently **1**).
  `type` = shape, `v` = revision. It earns its keep because **OTA isn't
  built** (Readiness Phase 6), so panels are updated by visiting them and
  a fleet runs mixed firmware for months — the cloud *will* parse two
  revisions at once. Rules: bump **only** on a breaking change (rename,
  removal, changed meaning/unit/type); an added optional field never
  bumps; **one global number**, since consumers route on `type` first;
  an unknown `v` must fail loudly, never be guessed.
- **Deployment ordering**: push the policy granting publish on the status
  topic *before* this code reaches a panel — AWS IoT authorises the will
  topic when establishing the connection. **But the panel no longer goes
  dark if you forget**: after 3 failed attempts, dials **alternate**
  with/without the will (`_willFor`, `aws-iot-transport.js`). If the will
  topic is unauthorised only the no-will dials connect, so telemetry and
  alarms keep flowing; if the cause is anything else both kinds fail
  equally and a with-will dial connects once it clears — which is why this
  alternates rather than latching (a transient outage must not strip the
  LWT permanently). A suppressed LWT is reported on **every flush**
  (`lwt:` in the flush status), because such a panel looks entirely
  healthy otherwise.
- **Field names are frozen** (CR-OPEN-5): `dt_min dt_max dt_avg ror_max
  t_max amb_avg`, **identical in both encodings**. Keyed used to emit
  `ambient` where positional emitted `amb_avg` for the same number, and
  `slice10-design-proposals.md` §A showed a third name (`t_avg`) for a
  field the code computes as a maximum. Every wire field now names its
  statistic; the internal KPI input keeps `ambient: {slaveID, val,
  age_sec}` (an object — reusing that name for a bare number on the wire
  was the drift).
- **`device_health` publishes the panel's self-diagnosis** (EC-2) —
  blacklisted devices, joint LIVE/STALE/OFFLINE, **per-segment bus
  liveness**, Pi supply. All of it was computed for the HMI's Device
  Health tab and went no further, so a fleet view could see what the
  panel measured but not whether it could still measure. Alarms don't
  close that gap: they're transitions, so a consumer that starts late or
  restarts can't know the CURRENT blacklist without replaying history.
  **Live-verified on the Pi (2026-08-31)**: the "Publish Device Health" node
  reports `4/4 live | bus1:ok bus2:ok | unchanged` — both segments seen, and
  the second tick correctly publishing nothing, so on-change detection is not
  degrading into publish-every-tick. Still unverified: AWS-side receipt of the
  message, and the LWT on the status topic (needs the policy pushed first).
  Pure builder `src/cloud-gateway/device-health.js`; published **on
  change + hourly resync** (the resync is for late subscribers, which
  QoS 1 does nothing for); flow node "Publish Device Health"
  (`8a1b2c3d4e5f6a36`–`38`, 60 s tick — the publisher decides whether to
  send, so the tick is cheap). Per-bus liveness is recorded on the
  blacklist tracker (`tracker.busSeen`, stamped in `processReadResult`
  from `busForSlave`) because the flow's silence watchdogs keep their
  stamp in **flow** context on `modbusMaster_V2`, unreadable from the
  Cloud Gateway tab. **`last_frame_age_sec`/`next_probe_in_sec` are
  excluded from change detection** — they move continuously, and
  including them silently turned "on change" into "every tick".
- `test/cloud-gateway/message-discriminator.test.js` pins the contract: a
  publish path that forgets its `type`, or an encoding whose field names
  drift, fails there rather than in a customer's IoT Rule.
  `soak-verify.js` now reads `type` too, with the old sniffing kept only
  as a fallback so pre-2026-08-27 soak logs stay verifiable.

## Remote config channel (Slice 7, built — live verification pending)

Implemented over the **cmd topics** (`cmd/{c}/{s}/{p}/config` +
`/config/ack`), NOT the AWS shadow — plain MQTT works on any broker
(Slice 8 portability drill) and keeps gateway logic cloud-agnostic;
shadow support would be an AWS-adapter add-on if the design chat ever
wants it. Envelope/examples: docs/aws/README.md Part E.

- `src/config-service/node-red/remote-config-handler.js`
  (`processRemoteConfig` — pure, fully unit-tested): routes `alarms`
  (A-rules, freely tunable), `modbus_joints` (source:'remote' → R12
  rejects outside maintenance mode; the `maintenanceMode` global is a
  deliberately local-only switch), and `edge` (first knob:
  `telemetry_interval_min`, 1–1440, persisted via
  `src/cloud-gateway/runtime-settings.js` in the outbox dir). Acks
  echo `request_id` and carry `applied_versions` or `errors` with real
  rule ids; acks ride the outbox **alarm** class (QoS 1, survives link
  drops, ordered).
- Accepted remote modbus change converges exactly like a local apply:
  `deriveLegacyBridge` rewrites the decode-pipeline globals, dashboard
  drafts are rebuilt (`buildLegacyDrafts` reverse-maps schema →
  legacy shapes incl. effective-ambient flattening), paraRaw ships to
  modbusMaster_V2, and the Nano resend fires content-aware
  (nanoJobsEqual). Accepted alarms change writes
  `busbartherm_system_config` — the global the live Alarm Manager
  evaluates each sample against, which is A10's live re-evaluation
  (normal raise/clear paths, no mass-clear).
- **Telemetry flushing is now due-based**: the Cloud Gateway tab's
  inject ticks every 60s calling `flushIfDue` (emits nothing
  off-cycle); the interval lives in persisted runtime settings
  (default 10 min) and changes take effect within a minute — no flow
  edit needed to retune. `flushTelemetry`'s fixed-interval form
  remains for tests.
- `setupRemoteConfig` (src/cloud-gateway/node-red/remote-config.js)
  is the subscription glue: works over any transport with
  subscribe(), so the whole channel is bench-testable on the loopback
  (publishing into the loopback = a simulated cloud push — that's how
  the end-to-end tests run). Subscriptions replay on AWS reconnects.
- **Also fixed here (regression from Slice 2)**: local threshold
  saves stopped writing `busbartherm_system_config`, so the running
  Alarm Manager kept evaluating OLD thresholds after a dashboard
  save. The handler now returns `runtimeConfig` and both the local
  wrapper and the remote drain write the global (store "default", to
  match how the Alarm Manager reads it). `appendLegacyAudit` likewise
  writes the audit globals to store "default" - the store both audit
  viewers read - so remote/local audit entries actually appear.

**Not yet done**: Slice 7's "Done when" live pass (push valid+invalid
configs from the real AWS console, confirm acks/audit/no
alarm-state corruption), and the cloud-side data pipeline (IoT Rule →
Timestream/S3 — a design-chat decision).

## Certificate rotation (Readiness Phase 1, built — live pending)

The device accepts a **new operational certificate** pushed over a
dedicated cmd channel and switches atomically with rollback (Readiness
§ line 56). Three layers:

- **`src/cloud-gateway/cert-rotation.js`** (`CertRotator`) — pure,
  cloud-agnostic fs mechanics + commit/rollback: validate PEM (no fs
  change if junk) → snapshot + `.bak` backup → atomic write (tmp+rename,
  key `0600`) → injected `reconnectAndVerify()` → commit on success,
  else restore snapshot and reconnect on the old cert. A `_busy` guard
  serializes rotations. Fully unit-tested with an in-memory fs.
- **`AwsIotTransport.reloadCredentials({verifyTimeoutSec})`** — re-reads
  cert/key/ca from the same paths and force-redials, resolving `true`
  once the broker accepts the new cert or `false` on timeout. The
  `_redial()` + "stale client's close no-ops" guard (`this.client !==
  client`) make the swap clean. This is the only AWS-side piece; the
  rotator sees only the injected callback (cloud-agnostic rule intact).
- **Channel wiring** (`src/cloud-gateway/node-red/cert-rotation.js`):
  dedicated `cmd/{c}/{s}/{p}/cert` topic (ack on `.../cert/ack`, outbox
  alarm class), same receipt/apply split as remote config —
  `setupCertRotation` (subscribe → `_certRotationInbox`, only enabled on
  a transport that can reload creds), `drainCertRotation` (async tick,
  applies in message context so the `CERT_ROTATION` audit lands). Flow:
  Cloud Gateway tab nodes `8a1b2c3d4e5f6a30`–`35` (setup @boot + 5s
  drain tick). Topics resolved in `edge-config.js` (`cmd_cert`/
  `cmd_cert_ack`, defaults when absent). Policy template grants the new
  topic; runbook + envelope: **docs/aws/README.md Part F**.

**OFF by default (learned live 2026-07-22):** subscribing to
`cmd/.../cert` before the device's AWS IoT policy grants it makes AWS
IoT Core drop the whole connection (unauthorized subscribe =
disconnect) → `connected:false`, telemetry down. So `setupCertRotation`
now no-ops unless `BUSDUCT_CERT_ROTATION=1` is set in Node-RED's env.
Enable order: (1) push the updated `iot-policy-panel.template.json` as a
new active policy version in AWS, then (2) set the flag + restart.
Recovery if it broke a connection: unset the flag (or apply the policy).

**Not yet done**: live pass — push a real replacement cert from AWS,
confirm atomic switch + ack, then push a bad cert and confirm rollback
keeps the panel online.

## Local historian (InfluxDB 1.x)

Local, cloud-independent trend store (Readiness Workplan "Local
services / Historian"). The panel already runs InfluxDB 1.x (legacy
`Mecha` db); this uses the same engine in a dedicated **`busduct`**
database. New **Historian** flow tab taps the ProcessLogic joint +
ambient KPI streams (`18f56266a8967320` / `89020f3e770fb86a`) → thin
`Historian Points` node → `src/historian/influx-points.js`
(`toInfluxPoints`, exposed as **`busductHistorian`**) → an
`influxdb batch` node writing measurement `bt_kpi` (tags
sensor_id/zone_id/slave_id/kind; fields temp_c + KPIs). Non-OK
readings are skipped so trend aggregates stay clean.

Retention/downsampling is native InfluxDB (`tools/influx-setup.influxql`):
`raw` 7d (highest granularity) + `rollup_1h` 90d (daily/weekly) +
`rollup_1d` ~5y (monthly/yearly), fed by two continuous queries. Full
setup + read queries + flash-wear notes: **docs/historian.md**.

**Visualisation — both read layers built:** (1) an in-HMI **Trends**
dashboard tab (Historian flow tab nodes `9c1d2e3f4a5b7000`–`0b`):
Sensor + Range dropdowns drive an on-demand `influxdb in` query into a
`ui_chart`; the sensor list auto-populates from `SHOW TAG VALUES`
(boot + hourly), and each range picks the matching retention tier. Pure
logic in `src/historian/trend-query.js` (`buildTrendQuery`,
`resultsToChart`, `sensorOptionsFromTagValues` — all on the
`busductHistorian` global), thin function nodes. (2) **Grafana**
provisioning-as-code under `tools/grafana/` (datasource + dashboard
provider YAMLs + `busduct-historian.json`, a `sensor_id` variable and
one panel per retention tier). See docs/historian.md "Visualisation".

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
