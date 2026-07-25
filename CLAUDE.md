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
| BMS register map (customer-facing, append-only) | `docs/bms-register-map.md` | present |
| BMS integration deployment/runbook | `docs/bms-integration.md` | present |
| Existing Node-RED flow | `flows/flows_BBT.json` | present |
| Arduino Nano firmware | `firmware/Nano_IOT.ino` | present |
| Edge device user manual (operator/technician HMI guide) | `docs/edge-user-manual.md` | present |

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
  joint/zone tables: sends its full `{slaves, bus}` state on *every*
  action — the data-loss-bug lesson) → **`ModbusSettingsBackEndNode`**
  (thin wrapper, 3 outputs) →
  `src/config-service/node-red/modbus-settings-handler.js`.
- Bus form (single RTU bus — the firmware has one RS-485 port and
  `compileNanoJob` enforces it) + a slaves table with **one row per
  channel** (user requirement 2026-07-14: one slave unit can carry
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

**Hang fix (2026-07-22, firmware rev):** the Nano stopped transmitting
after some hours, repeatably. Root causes, all fixed internally with
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
watchdog already triggers that resend. **Flashed to the real Nano
(2026-07-22) — confirmed transmitting; a 24 h soak is in progress to
confirm the hang is gone.**

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

## Scale hardening (Slice 10 — in progress)

For the 100-joint + 10-ambient target. Built so far:
- **Ambient outlier rejection + fallback** (`src/config-service/ambient-resolver.js`,
  exposed as `busductConfigService.resolveAmbient`): plausibility band
  (-20..80 C) then configured -> zone median -> panel median. Wired into
  ProcessLogic's ΔT block (configured-and-plausible path unchanged;
  fallback only when the ambient is out-of-band/missing; ambient output
  gains a `source`). **Alarm-relevant (ΔT) — needs a live check.**
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
  optional). The flow still wires only bus1 — adding the second physical
  pipeline (2nd serial pair, per-bus Send Nano Job, bus-tagged response
  tap, per-bus recovery) is a **documented runbook** (§B) pending a
  physical second Nano to wire/test.

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
- **Not yet done**: the **BMS Integration flow tab** (thin nodes: server
  @boot, KPI/alarm/blacklist taps, refresh tick, ACK output — wired like
  the Cloud Gateway tab; runbook in `docs/bms-integration.md`) and the
  **reference-gateway live validation** (workplan §11 "Done when": a stock
  gateway reads Tier 1 as BACnet with no custom mapping; a frozen Pi is
  detectable via the heartbeat; a BMS-originated ACK lands in the audit
  trail). Both need the Modbus→BACnet gateway hardware.

## Device blacklisting (Slice 9 — all steps built, live pass pending)

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

**Blacklist live-verified on the Pi (2026-07-24):** disconnecting a
device blacklists it (after the tap was fixed to read the PARSED Nano
stream, and the tracker moved to a module singleton) and raises its
SYSTEM alarm. Still to live-verify: restore path (alarm clear + no
spurious RoR) and held-alarm-while-dark. Deploy = git pull → restart
Node-RED → re-import flow.

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
  (`{lwt:true, thing_name}` on the telemetry topic, QoS 1 — the yaml
  defines no status topic; flagged as a cloud-side design question),
  and **self-managed reconnect** with full-jitter exponential backoff
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
