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

- **2026-07-10** — Extended `busduct_modbus_joint_config.schema.json`
  (not just the validator) with a schema/architecture change: **ambient
  sensor override chain**. Confirmed with the user that this is a real
  physical requirement, not a legacy artifact to migrate away from — a
  busduct run passes through both air-conditioned and open-air zones,
  so a single panel-wide `modbus.ambient_sensor` can't represent it. The
  legacy `JointMasterBackEndNode` handled this with a per-joint
  `ambientSlaveID` on every joint; instead of reproducing that (one
  field to keep in sync per joint), added an optional `ambient_sensor`
  to `zones[]` (so every joint in a zone inherits it) with an optional
  `ambient_sensor` override on individual `joints[]` for the rare
  exception within a zone (e.g. a joint right next to a vent). Both use
  a new shared `definitions/ambient_sensor_ref`. Resolution order:
  joint override → zone override → `modbus.ambient_sensor` (panel
  default). R9's wording changed from "ambient_sensor must be
  configured" to "every joint must resolve one through the chain"; R7's
  collision check now covers ambient claims at all three levels, not
  just the panel one; added **R14** (new) for referential integrity of
  any ambient override present, independent of whether alarms/R9 apply.
  **This changes a file the design chat ratified — flag it there** so
  the companion project's copy of the schema stays in sync with this
  repo's.

- **2026-07-10** — Corrected the R10 worst-case-scan-time formula in
  `validate-modbus-joints.js` after validating against a real exported
  production panel (`context.zip`, 21 slaves on one RTU bus at 9600
  baud, 1s timeout, 2 retries, `Polling`/inter-frame ~10ms). The
  original formula summed `timeout * retries` into *every* slave's
  worst case, i.e. assumed all slaves time out on every scan cycle —
  that real, working, deployed config would have failed R10 at any
  sane poll interval (~42.6s worst-case for a 30s interval). Changed to
  sum the normal (successful-response) frame time for every slave, plus
  **one** `timeout * retries` straggler allowance for the whole bus
  (at most one non-responding slave per cycle) — still pessimistic
  enough to be a meaningful check, but no longer rejects reality. Added
  the real 21-slave config as a regression fixture in
  `validate-modbus-joints.test.js` so this can't silently regress.

- **2026-07-10** — Built `tools/migrate-legacy-config.js` against the
  real exported legacy Node-RED context (`SlaveIDList`,
  `joint_master_zone_A`, `zone_master`, `busbartherm_system_config`,
  flat bus-timing globals). Findings from the real data, beyond the
  R10 fix above:
  - **Legacy hardware is one Modbus slave = one channel** (each
    `SlaveIDList` entry has exactly one register, `dataBits: 1`) —
    confirms `channels: 1` per migrated slave is a fact, not a
    guess. One slave (`slaveID 101`, `"AmbientT"`) is a dedicated
    ambient probe referenced by every joint's `ambientSlaveID` today
    (no zone actually differs yet in production — the AC/open-air
    split this repo now supports is provisioned for, not yet used).
  - **Function code is always 3** (holding registers) in the migrated
    output — confirmed from the firmware, not assumed; see the
    Nano job protocol section in `CLAUDE.md` for the related
    schema/firmware gap (`function_code: 4` is unimplementable as-is).
  - **Real persistence data violated A2**: legacy
    `{watchMin:1, warningMin:1, criticalMin:5}` means CRITICAL alarms
    took *longer* to raise than WATCH/WARNING. Confirmed with the user
    and replaced with `{watchMin:5, warningMin:2, criticalMin:1}` via
    `migrateLegacyConfig`'s `persistenceOverride` option — the tool
    never silently invents this fix; it's opt-in and logged as a
    warning either way.
  - **Real data contained personal information** (`MobileNo`,
    `EmailID`, `Esettings.RecipDetails` — real names/phones/emails).
    None of it went into any fixture, migrated output, or commit. The
    migration tool omits `alarms.notifications` entirely and warns
    that recipients must be configured directly on the live system,
    not via a version-controlled file. `IP_Address`/`Mac`/`LocalMac`/
    `project_config` were also excluded — they belong to the edge node
    config identity domain, out of scope here, and weren't needed.
  - Model name, per-slave `poll_interval_s`, `temp_scale`, and bus
    `retries` have no legacy equivalent and are placeholder/default
    values flagged in the tool's `warnings` output — real values (part
    number, scan interval, sensor datasheet scaling) need commissioning
    review before this config is applied to the actual panel.
  - Output committed to `config/examples/migrated_modbus_joints.json`
    and `migrated_alarms.json` — both pass `validateModbusJoints`/
    `validateAlarms` with zero errors.

- **2026-07-10** — Refactored `BusbarTherm Config Manager` and
  `JointMasterBackEndNode` in `flows_BBT.json` to call the config
  service (`src/config-service/node-red/{config-manager-handler,
  joint-master-handler}.js`) instead of raw global context, completing
  Slice 2's last item. Extracted the ambient-chain-resolution algorithm
  out of `tools/migrate-legacy-config.js` into a shared
  `src/config-service/ambient-resolution.js` since the live
  `JointMasterBackEndNode` replacement needs the exact same logic on
  every `apply`, not just at one-time migration.
  - Kept `add`/`add_below`/`edit`/`delete`/`save` operating on the
    legacy draft shape in `global` context, unchanged — those are
    UI-side bookkeeping on an intentionally-incomplete array mid-edit
    (empty `joint_id`, `editing: true`), which the new schema can't
    validate anyway. Only `apply` was replaced.
  - `apply` looks up each legacy `slaveID` against the **currently
    applied** `cfg/modbus+joints` document's `modbus.slaves[]` (by
    `unit_address`), not a fresh sequential re-assignment like the
    one-time migration tool uses — `slave_id` must stay stable across
    edits (that's the whole reason the schema separates `slave_id`
    from `unit_address`). If a slave isn't provisioned there yet,
    `apply` rejects with a clear error rather than inventing a mapping;
    slave/register commissioning is a separate, untouched flow, out of
    this refactor's scope.
  - `config_domain_versions.modbus` and `.joints` both bump on every
    `apply`, even one that only changed joints — R11 requires both to
    be strictly greater on every push of the combined document, since
    they're delivered atomically together (see the earlier
    two-files-not-three entry above).
  - Function nodes are now one-line `require()`s via
    `global.get('busductConfigService')`, requiring a
    `functionGlobalContext` entry in the Pi's Node-RED `settings.js` —
    documented in `src/config-service/node-red/settings.js.example`.
  - **Tested with 120 unit tests (mocking Node-RED's `msg`/`global`
    shape) but not yet run inside an actual Node-RED instance.** Do
    that once Node-RED is available, per the checklist in `CLAUDE.md`'s
    "Node-RED integration" section, before marking Slice 2 fully done.

- **2026-07-10** — First live Node-RED test found 2 real bugs in the
  refactor above (both from restructuring control flow instead of
  mirroring the legacy nodes' exactly):
  1. **Both handlers constructed a brand-new `msg` object
     (`{ payload: {...} }`) instead of preserving the incoming `msg`'s
     other properties** (`topic`, `req`/`res`, `socketid`, `_msgid`).
     The legacy nodes' fallthrough/load path does `msg.payload = ...;
     return msg;` - mutating and returning the *same* object, so
     Node-RED's dashboard routing metadata survived. Reported as "Joint
     configuration table not showing old data" and "Busbar alarm config
     table blank" - the load path's reply likely wasn't reaching the
     right dashboard widget without that metadata. Fixed with a
     `withPayload(msg, payload)` helper (`{...msg, payload}`) used on
     every return path in both handlers.
  2. **`joint-master-handler.js` suppressed output (`msg: null`) for
     `add`/`add_below`/`edit`/`delete`**, on the assumption those were
     silent draft mutations. They're not: the legacy node's `if` blocks
     for those actions don't return early at all - they fall through to
     the same final `msg.payload = {joints, zones}; return msg;` as a
     plain load, so the dashboard table repaints immediately after
     every draft edit. Reported as "add joint pressed, no record
     added" - the row *was* being added to the draft, but the message
     carrying it back to the table was being thrown away. Fixed by
     removing the early returns for those four actions and letting them
     fall through like the original, persisting the mutated array via
     `draft` (explicit `global.set`, replacing the original's reliance
     on Node-RED's default context store returning the same object
     reference on every `global.get`).

  Rewrote both handlers' tests to assert on the corrected behavior (add/
  edit/delete now expected to produce table-refreshing output) and added
  an explicit msg-property-preservation test to each handler so this
  class of bug can't regress silently. 123 tests total.

- **2026-07-10** — Confirmed deployment target: Node-RED 4.x on
  Raspberry Pi. Did a proactive compatibility pass rather than react to
  a specific error - found nothing actually incompatible: no native
  dependencies (`ajv`/`ajv-formats` are pure JS, fine on ARM), no
  ESM/CommonJS conflict (`package.json` has no `"type"` field, defaults
  to CommonJS, matching how `settings.js`/function nodes `require()`
  things), and Node.js 18+ (this repo's own `engines.node`) is already
  Node-RED 4's own minimum, so if Node-RED 4 runs at all, this repo
  runs too. `functionGlobalContext` (used for `busductConfigService`)
  is unchanged behavior across Node-RED versions - not something NR4's
  newer per-function-node "external modules" Setup tab replaces, since
  that feature is for npm-installed packages, not local repo paths.
  Documented one real, concrete operational gotcha this setup does
  have, surfaced by the back-and-forth fixing bugs in the previous
  entry: `functionGlobalContext` entries are `require()`'d once at
  Node-RED **startup** (when `settings.js` loads), so a plain "Deploy"
  in the editor does not pick up library changes - the Node-RED service
  needs an actual restart after `git pull`ing anything under
  `src/config-service/`. Added this to `settings.js.example` and
  `CLAUDE.md`'s Node-RED integration section.

- **2026-07-10** — **Slice 2 confirmed done.** Live-verified on the
  actual Node-RED 4 / Pi deployment after the settings.js wiring +
  restart: joint configuration table loads existing data, "Add Joint"
  adds a row immediately, alarm configuration table loads current
  thresholds - all three symptoms reported after the first live test
  are resolved. Moving to Slice 3 (Nano job compiler).

- **2026-07-10** — Traced the actual physical serial path to the Nano
  in `flows_BBT.json` before writing the compiler, rather than guessing
  from the reference table alone: the real connection is a `serial out`
  node (`32001d89f98174c3`) on the **`modbusMaster_V2`** tab, using the
  serial-port config `/dev/ttyACM0` @ 115200 baud - which matches
  `Serial.begin(115200)` in `firmware/Nano_IOT.ino` exactly. The
  `/dev/ttyUSB2` serial-out node I'd assumed might be it is actually a
  cellular modem (AT command traffic on the "SIM Debug" tab) -
  unrelated. This confirms the workplan's own note ("modbusMaster_V2 is
  legacy") describes a tab that's still the **live, active** path to
  the physical hardware today, not a dead one - Slice 3/4 are meant to
  eventually retire it, but haven't yet.

  Added `src/config-service/nano-compiler.js` (`compileNanoJob`):
  cfg/modbus+joints → `{read, comm}` job JSON. Only emits `read`+`comm`
  (this panel's joints are read-only sensors; `write`/`transfer` aren't
  needed for normal polling). One read tuple per slave spanning all its
  channels in one Modbus transaction, matching the legacy
  `modbusMaster_V2` tab's own `paraRaw` min/max-register-span
  construction. Verified against the real 21-slave production data
  (`config/examples/migrated_modbus_joints.json`) as a concrete
  regression test: the compiler's output matches the real legacy
  globals exactly (`Polling: 10000`us → `comm[0]`, `baudRate: 9600`,
  `Timeout: 1000`ms, every slave's `[unit_address, 3, 1]` tuple from
  `registerAddress: 3, dataBits: 1`) - satisfies the workplan's own
  Slice 3 "Done when: compiler output matches the current
  hand-configured job JSON for the reference panel."

  R10 (bus capacity) isn't re-implemented here - `compileNanoJob` calls
  `validateModbusJoints` and refuses to compile an invalid document, so
  R10 is enforced by construction (a document that violates it was
  never accepted by `ConfigStore.applyIfValid` in the first place).
  Also refuses (with a clear error, not a silent guess) a document with
  more than one bus or a non-RTU bus - the firmware has exactly one
  RS-485 port, so there's no way to know which bus is physically wired
  to the Nano if more than one is configured.

  **Not yet done**: wiring resend triggers (boot / after RECOVERY
  CONTROLLER USB power-cycle / after a config apply) into the actual
  flow, and reporting recovery events as SYSTEM alarms. That means
  splicing new logic into the live `modbusMaster_V2` tab that directly
  controls real-time communication with deployed hardware - higher risk
  than anything touched so far in this repo. Flagging for explicit
  direction before touching it.

- **2026-07-10** — Drafted the resend wiring (user chose "draft it, I
  review before deploying" over pausing). Added *alongside* the legacy
  `modbusMaster_V2` internals rather than rewriting them, to minimize
  risk to the working path: a new `Send Nano Job` function node feeds
  into the *same* `json` node the legacy read-job path already uses
  before the serial write, so the final-mile plumbing to the Nano is
  untouched. Three triggers (boot, after RECOVERY CONTROLLER's USB
  power-cycle + a 3s settle delay, after a successful
  `JointMasterBackEndNode` apply via a new 2nd output) reach it through
  a `link in`/`link out` pair, since the trigger sources live on a
  different tab. Recovery-event alarm reporting needed no new code -
  the existing `RECOVERY CONTROLLER` node already emits a
  `SYSTEM|MODULE|RESET_N` alarm.

  `resendNeeded` added to `handleJointMasterMessage`'s return value
  (true only after a successful apply) rather than deciding this in the
  Node-RED function node itself, keeping the decision in the
  unit-tested library per the thin-function-node rule.

  Added `test/flows-integrity.test.js`: checks every `wires`/`links`
  reference in `flows_BBT.json` resolves to a real node id and that
  `link in`/`link out` pairs are mutually consistent. Cheap regression
  guard for hand-editing this 537KB file (which is how these changes
  were made - a targeted Python script, verified to change only the
  intended ~6 new nodes and 2 modified ones, not reformat the rest).

  **Full details, and the pre-deploy test checklist, are in
  `CLAUDE.md`'s "Nano job resend wiring" section - this has NOT been
  run against real hardware or a live Node-RED instance yet.**

- **2026-07-10** — **Slice 3 confirmed done** (compiler + resend
  wiring both tested and working on the real Pi). Moving to Slice 4
  (internal bus refactor): link-out taps at ProcessLogic/Alarm
  Manager outputs, no logic changes, document the message contracts.

- **2026-07-10** — Slice 4: read `ProcessLogic` (node
  `39dad91df0c15744`, 3 outputs) and `Alarm Manager` (node
  `de6fcc55794afd9e`, 4 outputs) function source directly rather than
  guess at "the KPI stream" / "the alarm events" the workplan's
  parenthetical shorthand implies. Given the ambiguity over which
  specific output(s) counted as "the" stream, and that tapping every
  output is a strict superset with zero added risk (a `link out` with
  an empty `links` array is inert - Node-RED just drops the message,
  no side effects), added a tap to **all 7 outputs** rather than guess
  which subset Slice 5 will actually need: `ProcessLogic` → joint /
  ambient / unassigned; `Alarm Manager` → active / cleared / historian
  / email. Verified byte-identical function bodies before/after (both
  nodes' `func` fields untouched - only new nodes appended to the
  existing `wires` arrays). Documented every output's exact message
  shape in `docs/internal-message-contracts.md`, sourced from the
  actual code (e.g. `buildOutputs`'s change-detection semantics, the
  `INJECT_EVENT` "EVENT" status shape RECOVERY CONTROLLER uses), not
  inferred. No consumer wired yet (`links: []` on every new tap) -
  Slice 5's Cloud Gateway is expected to add matching `link in` nodes.

- **2026-07-10** — **Slice 4 confirmed done.** Deployed, new link-out
  taps visible in the editor, HMI/historian/email behavior confirmed
  unchanged. Moving to Slice 5 (Cloud Gateway: batcher, alarm
  publisher, outbox, heartbeat).

- **2026-07-10** — Slice 5 core modules added under `src/cloud-gateway/`
  (see individual commits for full detail): `transport.js`
  (cloud-agnostic interface + `LoopbackTransport`), `outbox.js`
  (disk-backed alarm/telemetry priority queue matching
  `busduct_edge_config.yaml`'s buffer section exactly, tested against
  a simulated 24h-link-loss-then-recovery scenario), `batcher.js`
  (KPI aggregation into batched telemetry, with a byte-budget chunking
  safety valve instead of silently dropping joints), `alarm-publisher.js`
  (RAISE/CLEAR on state transitions only, QoS 1), `heartbeat.js`
  (hourly liveness ping). 179 tests total across the four modules.

- **2026-07-10** — Resolved the value/threshold/persistence_min gap
  flagged when `alarm-publisher.js` was built: at the user's direction,
  extended `Alarm Manager` (node `de6fcc55794afd9e`) to emit these as
  structured fields **alongside** the existing `description` string,
  not replacing it. This is a real (if small) logic change to a live
  function node, unlike Slice 4's purely-additive taps - handled with
  the same care: `d.ror`/`L.th`/`L.p` (and the DELTA_T equivalents)
  were already in scope via closure at the exact point each `PROCESS`
  alarm object is built (`evaluateAlarm`'s `build()` callbacks), so
  the change is three added object keys per alarm type, nothing else
  touched. Verified via `difflib` against the pre-change function body
  that only those 6 lines (3 keys × 2 alarm types) differ, and that
  the patched source still parses (`node --check`). `clearAlarm`
  already spreads `...a` when building the cleared copy, so these
  fields carry through to CLEARED alarms automatically - no separate
  change needed there. `alarm-publisher.js` now promotes them to the
  top level of the published event when present (still absent, not
  fabricated, for SYSTEM alarms that don't evaluate a numeric
  threshold). Updated `docs/internal-message-contracts.md` and the
  publisher's tests to match.

- **2026-07-10** — Added `absolute_temp_c` (the raw sensor reading,
  `d.val`) to the same two `PROCESS` alarm `build()` callbacks in
  `Alarm Manager`, at the user's direction - distinct from `value`
  (which is the rate-of-rise number for `ROR` alarms or the delta-T
  number for `DELTA_T` alarms, not the absolute temperature). Same
  pattern as the previous entry: `d.val` was already in scope via
  closure, one added key per alarm type, verified by diff that nothing
  else changed. `alarm-publisher.js` promotes it the same way as the
  other structured fields (present for PROCESS alarms, absent for
  SYSTEM). Updated docs and tests.

- **2026-07-10** — Live "Apply Config" on the real Pi surfaced the
  expected consequence of a gap already known: the migration tool only
  produces files in the repo (`config/examples/migrated_*.json`) - it
  never touches the live `ConfigStore` at `/var/busduct/cfg`, so
  `joint-master-handler.js`'s "No cfg/modbus applied yet" check
  (correctly) fired on a panel that had never had anything applied.
  Added `tools/apply-migrated-config.js`: a one-time bootstrap that
  applies the already-migrated files to the live store, refusing to
  run again once something's been applied (so it can't clobber real
  dashboard edits made afterward). Documented as a new step 3 in
  `docs/pi-deployment.md`, before the settings.js wiring step.

- **2026-07-10** — Fixed a real bug in the bootstrap tool itself,
  caught on the first real run: the guard was all-or-nothing (refused
  to touch *either* domain if *either* already had something applied).
  On the real panel, `alarms` already had a config applied (most likely
  a "Restore Defaults" click on the alarm screen before the bootstrap
  tool was ever run) while `modbus_joints` didn't - so the tool refused
  to bootstrap `modbus_joints` too, even though that was the one that
  actually still needed it. Rewrote to check and apply each domain
  independently - `modbus_joints` and `alarms` are separate
  `ConfigStore` domains with no reason to be coupled here. Added a test
  reproducing the exact reported scenario (alarms pre-applied, verify
  `modbus_joints` still bootstraps) plus the mirror case. 184 tests
  total.

- **2026-07-10** — Found and fixed a real client-side data-loss bug in
  `JointMasterUI` (the `ui_template` node backing the joint config
  dashboard, `flows_BBT.json` node `d58c3f80174c66df`), reported as
  "submitted config showed old data instead of what was in the live
  table." Read the actual Angular template rather than guess: the
  EDIT/ADD/ADD_BELOW/DELETE buttons' `send()` calls didn't include the
  current `joints` array (only SAVE and APPLY CONFIG did) - so if a
  user typed into one row without clicking SAVE first, then clicked
  EDIT/ADD/DELETE on any other row, the server processed that action
  against its own last-persisted copy (missing the unsaved edit),
  and the template's `scope.$watch("msg", ...)` unconditionally
  overwrites the client's local state with whatever the server just
  returned - silently discarding the in-progress edit before the user
  ever got to click APPLY. Confirmed this is deterministic, not a race
  with some other periodic trigger: `JointMasterBackEndNode` is the
  *only* node feeding `JointMasterUI`.

  Fix: every button now sends `joints: msg.payload.joints` (or
  `scope.msg.payload.joints` in the plain-JS `confirmDelete` handler),
  matching what SAVE/APPLY already did - the client's current state is
  now always the source of truth sent to the server, never silently
  replaced by a stale server-side fallback. Verified by diff that only
  those 4 `ng-click`/`send()` call sites changed - no other markup, CSS,
  or script logic touched.

  Found (not yet reported, but identical mechanism) the same bug in
  `ZoneMasterUI` (node `bb73f897eaeabb2f`) - EDIT/ADD/DELETE there also
  didn't send `zones`. Fixed the same way, same verification. 184 tests
  still passing (this is pure client-side JS inside two `ui_template`
  nodes - nothing in this repo's Node.js test suite exercises Angular
  template code directly, so this needs a live re-test on the Pi, same
  as any other flow change).

- **2026-07-14** — Fixed a real design flaw reported from the live
  panel: "joint mapping is only to assign sensor to actual field
  location... modbus polling should be affected only if modbus
  configuration table [changes]," yet every joint-only edit was
  triggering a Nano resend. Root cause: `applyJoints()` in
  `joint-master-handler.js` set `resendNeeded: true` unconditionally
  after *any* successful apply, but `compileNanoJob` only ever reads
  `doc.modbus.slaves`/`doc.modbus.buses` - never `joints[]` - and
  `applyJoints()` always spreads `modbus` through unchanged for a
  joint/zone-only edit. So the compiled job is provably identical
  before/after such an edit, yet was being resent anyway. This isn't
  just a wasted resend: `firmware/Nano_IOT.ino` re-inits `Serial1` and
  the Modbus timeout on *every* job update, so each needless resend was
  a real (if brief) live-polling disruption caused by an edit that
  should have been polling-invisible.

  Fix: added `nanoJobsEqual(docA, docB)` to `nano-compiler.js` (compiles
  both documents and compares the resulting job by value; a compile
  error on either side is conservatively treated as "changed").
  `applyJoints()` now sets `resendNeeded: !nanoJobsEqual(currentModbusJoints, newDoc)`
  instead of hardcoding `true`. Updated the existing test that asserted
  `resendNeeded === true` for a joints/ambient-only apply (now correctly
  `false`) and added a dedicated regression test naming the reported
  bug directly (re-mapping a joint to a different slave/zone/ambient
  probe - still `modbus.slaves`/`buses`-invariant - must not flag a
  resend), plus direct unit tests for `nanoJobsEqual` itself (equal when
  only joints/zones differ; not-equal when a slave's `unit_address` or a
  bus comm parameter changes; not-equal on a compile error). 189 tests
  passing.

- **2026-07-14** — Investigated the user's follow-up question ("check
  modbus setting table linkages with nano jobs") - whether the legacy
  Modbus commissioning dashboard has any relationship to the new
  `cfg/modbus.slaves` document the Nano job compiler reads. It does
  not, and this is a real, currently-unaddressed gap, not just a naming
  coincidence:

  The panel has a legacy "Parameter – Modbus Configuration" dashboard
  (`ui_template` node `51c4bed3d56ec39f`) whose APPLY button sends
  `{RecipDetails, NoOfRecip, Dropdown}` to `Data Filter` →
  `SetVal` (`67efb06527f2e7a0`), which sets `SlaveIDList` and a family
  of `global` vars (`sID<i>`, `sregisterAddress<i>`, ...) and derives
  `flow.paraRaw` (per-slave register spans) directly from the submitted
  rows. A second legacy dashboard, "Comm Parameters"
  (`ui_template` node `9f459a1e.89fae8`), writes bus settings
  (port/baud/parity/stopBits/Polling/Timeout) to a flat file
  (`/home/pi/Desktop/commParameters.txt`), which a second `SetVal`
  (`41d97a02.dc0964`) reads back into `global` vars on file write. Three
  more function nodes (`fd729d0af6e67cac`, `9f8ca9579d2932de`,
  `7130fe6f4f01d9b0`), triggered by their own inject/rbe/trigger/link-in
  nodes, assemble `{read,comm}`/`{write,comm}`/`{transfer,comm}` jobs
  straight from those `paraRaw`/`global` values and feed them into the
  *same* `json` nodes (`49aad217cfab3178`/`6dc874787132a275`) that lead
  to the real serial-out node (`32001d89f98174c3`, `/dev/ttyACM0`) - the
  identical final-mile path Slice 3's "Send Nano Job" also uses.

  None of this legacy path touches `ConfigStore` or the
  `cfg/modbus`+`cfg/joints` schema in any way - it is a complete,
  independent, unvalidated (no R1-R14) pipeline for the same physical
  job, built years before this refactor and never wired to it. That
  means: (1) committing a slave via the legacy "Parameter – Modbus
  Configuration" table does **not** update `cfg/modbus.slaves`, so a
  boot/USB-recovery/joint-apply resend from the new path will overwrite
  the Nano with whatever's in `cfg/modbus.slaves` - which may be stale
  relative to whatever was most recently commissioned live via the
  legacy table; and (2) conversely, nothing keeps the legacy path from
  firing (its inject/rbe/trigger nodes are independent of the new
  resend triggers) and silently overwriting a job the new path just
  sent, with data that was never validated against R1-R14 at all.

  This is an architecture-level gap, not a bug introduced by this
  refactor, and per the working agreement ("architecture decisions...
  happen in the companion project chat, not here... flag it instead of
  deciding unilaterally") it has not been fixed here. Flagged to the
  user directly rather than silently bridged or one of the two paths
  disabled.

- **2026-07-14** — User decision on the gap above: build a **new
  schema-backed Modbus Settings dashboard** and make it authoritative;
  the legacy "Parameter – Modbus Configuration"/"Comm Parameters" pair
  is "not aligned to our goal" and is deprecated (left wired for now,
  to be removed after the new table is live-verified). Implementation:

  - `src/config-service/node-red/modbus-settings-handler.js` — mirrors
    the joint-master-handler editing model (add/edit/delete/save are
    draft bookkeeping; only `apply` builds a full cfg/modbus+joints doc
    and pushes it through `validateModbusJoints` + `applyIfValid`).
    Friendly pre-checks: per-row bounds matching the schema, duplicate
    unit address, and refusing to delete a slave still mapped to a
    joint or used as an ambient reference (panel/zone/joint level),
    naming the offender. `slave_id` stays stable across edits (rows
    carry it invisibly); new rows get the lowest unused `slNN` at
    apply. `function_code` is pinned to 3 — the firmware only
    implements holding-register reads. `resendNeeded` uses
    `nanoJobsEqual`, so a label-only edit doesn't disturb polling but a
    real bus/slave change resends.
  - **Legacy bridge** (`deriveLegacyBridge`/`writeLegacyModbusGlobals`):
    investigation showed ~40 function nodes (the whole sensor-decode
    pipeline on modbusMaster_V2, plus alert/SMS nodes) read the legacy
    globals that only the legacy table's SetVal used to write
    (`SlaveIDList`, `slaveLength`, `parameterName{i}`, `parameterID{i}`,
    `sID{i}`, `sregisterAddress{i}`, `sdataBits{i}`, and the comm
    globals). A successful apply now rewrites all of them from the
    just-applied document, and ships `paraRaw` (flow-scoped on
    modbusMaster_V2) via a link pair to a new `Sync Legacy ParaRaw`
    function node — so even a stray legacy trigger now sends the same
    job content the compiler would. `parameterID` (decode-type
    selector, no schema equivalent) is carried over per unit_address
    from the current SlaveIDList; new slaves default to the panel's
    most common existing type ('6' on the real panel — every slave
    uses one type).
  - **Schema change (user-authorized: "You can change it")**: optional
    `slaves[].label` (maxLength 48), the display name the legacy
    `parameterName` provided — it's load-bearing across dashboards and
    alerts and had no schema home (the migration had dropped it with a
    warning). The migration tool now populates it; the committed
    migrated example was backfilled with the real panel's names
    (Sensor1..20/AmbientT, already public in the test fixture); and
    for already-migrated stores the handler recovers labels from the
    live SlaveIDList at load and persists them on first apply.
  - Flow additions (`7f3a1c9e2b5d4a01`–`08`): ui_group "Modbus
    Settings" on the Joint Config tab, `ModbusSettingsUI` (sends full
    `{slaves, bus}` on every action — the JointMasterUI data-loss-bug
    lesson applied from day one), `ModbusSettingsBackEndNode` (thin,
    3 outputs: UI / resend link / paraRaw link), boot inject, and the
    link nodes. The resend output feeds the *same* `Resend Nano Job
    (in)` used by the joint table. Verified only the 8 new nodes plus
    one `links` append changed in flows_BBT.json.

  210 tests passing (20 new handler tests + 1 migration label test).
  Needs live verification on the Pi (library change → full Node-RED
  restart, then re-import the flow).

- **2026-07-14** — Multi-channel slave support (user requirement:
  "one slave unit is having multiple channel so unit Id can repeat
  across records. Base address will be unique for each channel...
  In joint configuration table, there should be provision to select
  slave channel... same slave id and channel can not repeat across
  joints"):

  - **Modbus Settings table is now one row per channel.** A
    multi-channel unit repeats its unit address across rows, each row
    with its own channel number and base address. At apply the rows
    group into ONE schema slave (`channels` = row count) — R4's
    unique-unit-address rule is *not* relaxed, because the schema
    still has one slave entry per unit; the per-row freedom lives in
    the UI/handler layer. New `+CH` row button pre-fills the next
    channel for a unit.
  - **Schema additions (user-directed)**: optional
    `registers.channel_addrs` (per-channel start addresses, for
    modules whose channels aren't consecutive words from
    `temp_base_addr`) and `registers.channel_labels` (per-channel
    display names). New **R15** governs them: length must equal
    `channels`, addresses unique and spaced >= `temp_word_count` (no
    overlapping reads), min must equal `temp_base_addr`. Six new
    R15 tests (1 passing shape, 5 failing shapes).
  - **One read span per unit, one poll per unit**: new shared
    `readSpan(slave)` helper (exported from the validator, used by
    both the R10 timing math and `compileNanoJob`, so they can never
    disagree) computes the contiguous block to read: consecutive
    layout = channels x word_count from base; sparse layout = min..max
    channel address + word_count — the same min/max span the legacy
    SetVal computed into paraRaw. Because all of a unit's channels are
    read in one Modbus transaction, the poll interval is a property of
    the UNIT, not the channel: the table keeps the Poll column on
    every row for visibility, but rows of the same unit must match
    (model/words/scale likewise) — a mismatch is a friendly apply
    error, never a silent pick.
  - **Joint table channel mapping**: new `Ch` column in
    `JointMasterUI`; `joints[].channel` now comes from the row
    (drafts predating the column default to 1). The old blanket
    "Duplicate Slave ID" pre-check became "same (slave, channel) pair
    may not repeat" — two joints CAN now share a multi-channel slave
    on different channels, which the old check wrongly forbade. New
    friendly pre-check (R6's counterpart) rejects selecting a channel
    the commissioned slave doesn't have, naming its channel count.
    Deleting/shrinking a unit in Modbus Settings while a joint still
    maps one of its channels is rejected by name (channel-aware
    version of the existing referential pre-check).
  - **Legacy bridge is per-channel**: one `SlaveIDList` entry per
    channel row (parameterName = channel label, registerAddress = that
    channel's address, dataBits = word count) — exactly the shape the
    legacy per-parameter table produced — and `paraRaw` grouped per
    unit as [unit, min, span]. `parameterID` carry-over now matches by
    (unit address, register address) first, then unit address, then
    the panel's most common type.

  226 tests passing. The single-channel real panel's documents are
  byte-identical under the new code (no `channel_addrs` emitted for
  1-channel slaves), so nanoJobsEqual sees no change on migration.
  Needs the same live verification pass as the parent feature.

- **2026-07-14** — Removed the deprecated legacy Modbus commissioning
  subsystem from `flows_BBT.json` (user-directed: "delete unused flows
  and function, ui template"; the follow-up CLAUDE.md had planned
  after live verification, pulled forward on the user's instruction).
  32 nodes deleted, boundary-verified so nothing kept lost an input or
  output it needed:

  - The "Parameter – Modbus Configuration" (`modbus slaves`)
    ui_template and its whole chain on modbusMaster_V2: boot/refresh
    injects, `modbusSlave.txt` file reader/writer, `Data Filter`,
    `SetVal` (the legacy SlaveIDList/paraRaw/indexed-globals writer),
    `Para2DropUpdated`, debugs, and the 'Read' link-out (its id
    cleaned out of the kept link-in `4580cb246b849844`).
  - The duplicate `modbusSlave.txt` boot-restore chain on the config
    tab (inject → file in → json → Data Filter → SetVal → debugs).
  - The "Comm Parameters" ui_template chain on Advanced Settings:
    inject, `commParameters.txt` reader/writer, settings obj, json,
    `SetVal` (comm globals writer), debug — plus its now-empty
    "Communication Parameters" ui_group and the "Communication
    Settings" ui_tab.

  **Deliberately kept:** the Read/Transfer `ui_dropdown` and "SLAVE
  Active" ui_template (their "Modbus Settings" legacy ui_group on the
  "Slave Config" dashboard tab survives with just those two); the
  legacy read/write/transfer job builders (`9f8ca9579d2932de`,
  `fd729d0af6e67cac`, `7130fe6f4f01d9b0`) and their triggers — the
  serial-silence watchdog (`trigger` 30s fed by `serial in`) that
  re-kicks the Nano through `9f8ca9579d2932de` is a live polling
  recovery mechanism, not dead code, and the write/transfer paths may
  still serve calibration screens. Those builders now emit content
  identical to the compiler's because the new table's bridge keeps
  `flow.paraRaw` and the comm globals in sync on every apply.

  Consequence of deleting the boot-restore chains: the legacy globals
  (SlaveIDList, slaveLength, parameterName{i}, ..., port/baudRate/...)
  are no longer re-seeded from the Desktop txt files at startup. They
  persist in the Pi's localfilesystem context store (the same store
  context.zip was exported from) and are rewritten on every Modbus
  Settings apply - and the txt files would have gone stale anyway once
  the new table became the only writer, making the old boot-restore a
  stale-data overwrite hazard rather than a safety net. The old
  screens no longer exist as a fallback, so the new table must be
  verified first thing after this deploys. 226 tests passing
  (flows-integrity confirms every remaining wire/link resolves).

- **2026-07-14** — User confirmed live on the Pi: the schema-backed
  Modbus Settings table (multi-channel row model) and the joint
  table's channel column work, with the legacy commissioning screens
  removed ("It's working"). Marked live-verified in CLAUDE.md.

- **2026-07-14** — Slice 5 Node-RED wiring: new "Cloud Gateway" flow
  tab consuming the Slice 4 taps, completing the loop the taps were
  built for. Design decisions:

  - Consumes exactly three taps: KPI joint, alarms active, alarms
    cleared. The ambient/unassigned KPI streams are NOT consumed - the
    batcher reads each joint's ambient from inside the joint message
    (`kpi.ambient.val`), so a separate ambient subscription would
    double-count; unassigned sensors aren't part of the telemetry
    contract. Historian/email alarm taps stay local-only.
  - `src/cloud-gateway/node-red/` (gateway-handler.js + index.js):
    thin handlers (`ingestKpiTap`/`ingestAlarmActiveTap`/
    `ingestAlarmClearedTap`/`flushTelemetry`/`sendHeartbeat`) plus a
    `getGateway()` singleton - the batcher's interval accumulators and
    the alarm publisher's RAISE dedupe set are process state that must
    survive across messages, so function nodes share one instance via
    `functionGlobalContext.busductCloudGateway` (settings.js.example
    updated; the restart-not-Deploy rule applies to this library too).
  - Transport is the loopback until Slice 6 (workplan: "no MQTT yet").
    Added a `maxPublished` cap to `LoopbackTransport` (500 in the
    gateway) - its publish record was unbounded, which is fine for
    tests but a slow memory leak on a weeks-long Pi deployment.
  - Outbox persists at `/var/busduct/outbox` (pi-deployment §2 now
    creates it alongside /var/busduct/cfg) and drains 5 msg/s.
  - Telemetry flush: 600s inject calling `flushTelemetry(gw, 10)` -
    interval_min matches busduct_edge_config.yaml
    publish.telemetry.interval_min; the inject period and the `10`
    argument must be kept in sync by hand (documented in the function
    node). Heartbeat: hourly (+30s-after-boot) with
    `global.fwVersion || 'unknown'` and the ConfigStore's applied
    versions. Topics resolve from the yaml templates with placeholder
    identity c0000/s0000/p0000 until Slice 6 provisioning; heartbeat
    shares the telemetry topic (the yaml defines no heartbeat topic).
  - Debug nodes ("gateway telemetry"/"gateway heartbeat") surface
    flush chunk counts, outbox counts/bytes, and the loopback publish
    total in the sidebar - the bench verification surface until MQTT.

  234 tests passing (8 new). Slice 5's "Done when" (24h bench soak,
  link-pull drill) remains open - soak scripts under /test are the
  next Slice 5 work item once the bench is available.

- **2026-07-15** — User confirmed the Cloud Gateway loopback path
  flowing live on the Pi (debug snapshot: flushed_chunks 1, outbox
  telemetry 1 draining, published_total 2 = boot heartbeat + prior
  flush - all healthy). **Sequencing decision (user)**: Slice 5's
  standalone loopback soak is NOT run separately; it merges into
  Slice 6's soak - one combined 24h soak on the real AWS transport
  covering both slices' "Done when" (aggregates vs historian, alarm
  parity, real 1h/24h link pulls, router reboot, outbox recovery).
  Rationale: Slice 6's own acceptance already repeats most of the
  loopback soak on a strictly more realistic transport, and the
  loopback gateway running live on the panel accumulates the same
  evidence passively. Recorded as an explicit deviation from the
  workplan's slice-gating rule.

- **2026-07-15** — Slice 6 built: AWS IoT adapter + Fleet Provisioning,
  all under src/adapters/aws (the only AWS-permitted directory).
  Design decisions:

  - **mqtt.js, not the AWS IoT Device SDK**: pure JS (no native
    aws-crt build on ARM), no AWS SDK import anywhere so the
    cloud-agnostic grep stays trivially green, and - because AWS IoT
    is plain MQTT over TLS 1.2 mutual auth on 8883 - the same
    transport doubles as the Slice 8 portability-drill transport
    (point mqtt.endpoint at Mosquitto, everything works). Fleet
    Provisioning is also just MQTT topics, so provisioning needs no
    SDK either. Dependencies added: mqtt@5, js-yaml@4 (edge config).
  - **aws-iot-transport.js**: transport-interface implementation with
    self-managed reconnect - mqtt.js's fixed reconnectPeriod is
    disabled in favor of full-jitter exponential backoff
    (random(0, min(300, 2*2^attempt))s per the edge config spec; AWS
    throttles thundering-herd reconnects). Subscriptions replay on
    every reconnect (clean session). publish() rejects while
    disconnected, which is exactly what the outbox's
    stop-on-first-failure drain expects. LWT = {lwt:true, thing_name}
    QoS 1 on the telemetry topic - the yaml defines no status topic;
    flagged as a cloud-side design question for the companion chat
    (heartbeat/2-missed stays the primary offline detector).
  - **provisioning.js + tools/provision-panel.js**: claim-cert
    connect, $aws/certificates/create/json ->
    $aws/provisioning-templates/{t}/provision/json, operational key
    written 0600; CLI refuses re-provisioning without --force. The
    provisioning timeout timer is deliberately NOT unref'd - it keeps
    the short-lived commissioning process alive until AWS answers (an
    unref'd timer let the process exit with the promise pending,
    caught by the timeout unit test).
  - **Automatic transport selection**: getGateway() ->
    createGatewayFromEdgeConfig(): edge config + all three cert files
    present -> AWS transport, else loopback with a human-readable
    reason surfaced in the flush status (transport_mode/connected
    fields added; published_total only exists in loopback mode). A
    provisioning problem degrades to bench mode, never takes down
    local monitoring. This composition root is the one sanctioned
    require() of src/adapters/aws from outside it - gateway logic
    still sees only the transport interface, and the require is lazy
    so unprovisioned panels never load mqtt.
  - Cloud-side deliverables (workplan Slice 6): per-device IoT policy
    template locking each panel to its own namespace via thing
    attributes (client id must equal thing name), provisioning
    template deriving bt-{customer}-{site}-{panel} thing names, and
    docs/aws/README.md with the one-time admin setup + per-panel
    commissioning runbook.

  253 tests passing (19 new: transport dial options/LWT, connection
  state, publish/subscribe semantics, jittered backoff + resubscribe
  after reconnect, close() semantics, provisioning happy/rejected/
  timeout paths, credential file modes, edge-config parsing incl.
  basic-ingest rewrite, loopback fallback reasons). Remaining for
  Slice 6 "Done when": real AWS account inputs (ATS endpoint, claim
  certs, registered template), first live connect, then the combined
  24h soak.

- **2026-07-16** — First live Fleet Provisioning run (real AWS
  account, real claim cert - the connection itself worked) surfaced
  two fixes:
  - **AWS rejects >3 attributes on an untyped thing** ("To use more
    than 3 attributes, a thing must have a type specified") - our
    template stamps 4 (customer/site/panel/serial). Chose a thing
    type over dropping hw_serial: `bt-panel` thing type added to the
    template (ThingTypeName) and as runbook step A4, keeping the
    serial in the registry for commissioning audits. Existing
    registrations upgrade via create-provisioning-template-version
    --set-as-default (documented in A5).
  - **Intermittent "no response within 30000ms" timeouts** (some runs
    timed out where later identical runs got a real response): the
    provisioning flow published its request immediately after calling
    subscribe(), before the broker SUBACKed the response
    subscriptions - a classic MQTT request/response race, invisible
    on the loopback (synchronous) and only manifest against the real
    broker. Added AwsIotTransport.subscribeAsync (resolves on SUBACK)
    and provisionOverMqtt now awaits BOTH response subscriptions
    before publishing each request. Regression tests: SUBACK-ordering
    asserted via an event-sequenced fake transport; subscribeAsync
    accept/reject paths.

- **2026-07-17** — **Milestone: first live panel on AWS IoT Core.**
  After the thing-type + SUBACK fixes, provisioning completed and the
  gateway came up with transport_mode "aws", connected true -
  telemetry flowing every 10 min (user's debug screenshots, 15:48 and
  15:58 flushes, outbox draining). Slice 6's "reference panel
  publishes batched telemetry and alarms to AWS IoT Core" is met; the
  resilience half (router reboot, 24h link pull, outbox recovery)
  awaits the combined soak. Advised the user that the MQTT test
  client is a live window only, and to add a CloudWatch Logs IoT rule
  for retained inspection until the real cloud data pipeline
  (Timestream/S3/dashboard - a design-chat decision) exists.

- **2026-07-17** — Combined 24h soak tooling (recorder + verifier),
  so the soak acceptance is a mechanical check, not eyeballing:

  - `src/cloud-gateway/soak-recorder.js`, enabled only when
    BUSDUCT_SOAK_LOG=<dir> is in Node-RED's environment (inert
    otherwise; recorder write errors are swallowed - evidence
    collection must never take down the gateway). Records JSON-lines:
    kpi.jsonl (every joint sample entering the batcher), alarm-taps
    .jsonl, flush-status.jsonl, published.jsonl (messages actually
    accepted by the transport, stamped with drain time), connection
    .jsonl. Wired in createGateway via a transport decorator +
    optional-chained calls in the tap handlers.
  - `src/cloud-gateway/soak-verify.js` + `tools/soak-verify.js`:
    recomputes every published interval's per-joint aggregates from
    the raw samples (window = between consecutive batch timestamps;
    250ms boundary slack for millisecond ties) and diffs against what
    was published; replays the alarm taps through the publisher's
    dedupe rules and requires the published RAISE/CLEAR sequence to
    match in order (trailing still-queued alarms tolerated via the
    last flush status's outbox count - reordering/loss never);
    reports offline windows and per-message hold times
    (published_at - edge timestamp) proving hold-and-drain.
  - **"Aggregates vs historian" is checked against the KPI tap
    recording**, which is the same ProcessLogic stream the historian
    consumes - ground truth captured at the source, with manual
    historian spot-checks remaining a human step in the runbook.
  - The CLI lives in /tools, not /test (where the workplan's prose
    puts soak scripts), because `node --test` executes everything
    under /test - a runnable CLI there would fail the suite. The
    verification logic is a library under src with its unit tests in
    /test (7 new: recorder wiring end-to-end incl. inertness, clean
    recording passes, tampered aggregate flagged, reordered alarms
    flagged, trailing queued alarm tolerated, link-pull hold times).

  263 tests passing. Runbook gained §C5 (systemd env override, run
  with drills, verify command, what PASS proves).

- **2026-07-18** — **Combined 24h soak: PASS** (user ran
  tools/soak-verify.js on the panel's recording - telemetry
  aggregates, alarm parity, and hold-and-drain all verified). Slice
  5's and Slice 6's "Done when" are both met; Slices 1-6 done.

- **2026-07-18** — Heartbeat enriched with a `system` block (user
  requirement): `src/cloud-gateway/pi-health.js` collects cpu_temp_c
  (sysfs thermal zone), mac_id (eth0, wlan0 fallback), ram_free_mb +
  ram_available_mb (/proc/meminfo - both requested; available is the
  actionable one, free alone under-reports due to page cache), and
  low_voltage from `vcgencmd get_throttled` (now/since_boot for both
  under-voltage and throttling, plus the raw hex for cloud-side
  decoding of the remaining bits). Collected once per heartbeat in
  the sendHeartbeat handler - no flow change, no new dependencies.
  Every probe degrades to null off-Pi and never throws: a health
  probe must not break the liveness message that carries it. The
  low-voltage state rides the heartbeat rather than raising a local
  SYSTEM alarm through Alarm Manager - cloud-side alerting can act on
  it; wiring it into the local alarm chain is a separate decision if
  wanted.

- **2026-07-18** — Sequencing decision (recommended, user asked):
  the "set telemetry interval from cloud" requirement is NOT built as
  a pre-Slice-7 one-off - the interval lives in the edge config's
  publish.telemetry section, which the spec marks updatable via the
  remote config channel that Slice 7 builds. It becomes Slice 7's
  first delivered knob instead of a throwaway side channel.

- **2026-07-18** — Heartbeat `system` block extended with the active
  uplink (user requirement): `network.interface`/`type` from the
  default route (/proc/net/route), classified wifi/ethernet/cellular.
  Wi-Fi adds signal_dbm + link_quality from /proc/net/wireless; a
  cellular uplink (SIM7600G shows up as usb0/wwan0/ppp0) adds signal
  via ModemManager's percent when installed, and - only when
  BUSDUCT_MODEM_AT_PORT is set (typically /dev/ttyUSB2, the SIM7600's
  spare AT port, safe during a data session) - AT+CSQ directly for
  rssi_dbm (-113 + 2*csq). All null-degrading, same rule as the rest
  of the health probe.

- **2026-07-18** — **Fixed: ACK button on Active Alarms did nothing.**
  Root cause (legacy gap, predates the refactor): the Active Alarms UI
  sends {action:"ACK", instanceId} into Alarm Manager, but the
  function only handled CLEAR_HISTORY/BOOT_REFRESH/INJECT_EVENT - no
  ACK branch existed, so the message fell through to the
  sensor-processing path and was ignored. Added the branch: sets
  status ACTIVE_ACK + ackTs/ackBy on the active alarm (and its
  historian entry), persists both, and emits through buildOutputs so
  the UI repaints and the taps fire. isActive() treats ACTIVE_ACK as
  still-active (startsWith("ACTIVE")), so persistence/clear logic is
  unaffected. Completing the chain, AlarmPublisher now emits an ACK
  event (qos 1, timestamp = ackTs) when a known alarm transitions
  ACTIVE_NACK -> ACTIVE_ACK - fulfilling publish.alarm mode "RAISE,
  CLEAR, ACK only" from the edge config, which had been RAISE/CLEAR
  only. The soak verifier's parity replay mirrors the same rule.

- **2026-07-18** — **Fixed: audit screens blank after settings changes**
  (regression from the Slice 2 refactor): the Audit Log Viewer reads
  global `joint_config_audit_log` ({timestamp, user, action, details};
  actions APPLY_CONFIG/SAVE_ROW/DELETE_ROW) and the alarms audit
  viewer reads `audit_busbartherm` ({ts, user, action, oldConfig,
  newConfig}) - both were written by the legacy backend nodes that the
  refactor replaced; the new handlers wrote only the durable
  audit_trail.jsonl in the ConfigStore. Handlers now also return a
  viewer-shaped `audit` entry (joint save/delete/apply incl. rejected
  applies; modbus-settings save/apply; alarms save/restore incl.
  rejections) and the thin wrappers append it via the new
  legacy-audit.js helper (capped at 200 entries - display only, the
  jsonl file remains the complete record).
  handleConfigManagerMessage's return shape changed to {msg, audit} -
  its wrapper function node updated accordingly. 4 flow nodes changed,
  all func-only, diff-verified. 279 tests passing (11 new).

- **2026-07-19** — Merged the user's on-Pi flow pruning into the repo
  artifact (user deleted unrelated legacy flows directly in the live
  editor, then supplied the export for reconciliation - the repo copy
  is the deployable artifact, so divergence had to be closed before
  Slice 7 adds more flow changes). Verified before adopting:

  - Their export is based on the repo's LATEST version - every recent
    marker present (Alarm Manager ACK branch, audit-bridge wrappers,
    Modbus Settings, Cloud Gateway tab); zero added nodes; the only
    in-both difference is the palette global-config dropping
    node-red-contrib-python3-function (consistent with the deletions;
    the module can be npm-uninstalled from ~/.node-red at leisure).
  - 280 nodes removed: five whole tabs (Temperature, Debugging,
    SIM Debug, CSV Settings, IP Address) plus 82 nodes on
    modbusMaster_V2 - all water-quality-era legacy: pH/pressure/
    current calibration screens with their txt persistence, and the
    entire pre-V2 polling chain (0.5s inject -> GetData/Write job
    builder -> switch -> jsons -> python3-function modbusMaster.py/
    modbusWrite.py). That V1 chain went out as a complete unit.
  - Boundary-verified on the merged result: no dangling wires/links/
    groups; every critical live-path node survives (Nano serial
    in/out, json->serial, Send Nano Job + resend link, read/write job
    builders, serial-silence watchdog, parameterForLoop with all 21
    decode targets, Cloud Gateway link-ins, Sync Legacy ParaRaw,
    Read/Transfer dropdown, SLAVE Active). flows-integrity green.
  - Known cosmetic leftovers, deliberately NOT cleaned in this merge
    (kept the repo byte-identical to what the Pi runs, so no re-import
    is needed): 10 now-empty ui_groups (calibration/CSV/CPU TEMP) that
    render nothing, and 2 pre-existing ui_groups with an empty tab ref
    (Operator Login Form, Group 1) that predate this change. Fold
    their removal into the next deliberate flow change (Slice 7).

  Repo and panel are identical again; 279 tests passing.

- **2026-07-19** — **Slice 7 built: remote config channel** (+ the
  cloud-settable telemetry interval as its first knob, per the user's
  2026-07-18 decision). Design decisions:

  - **cmd topics, not the AWS shadow.** The edge yaml offers both
    (config_channel: shadow|cmd, shadow marked "recommended"); chose
    the cmd channel because it is plain MQTT - it works unchanged on
    Mosquitto for Slice 8's portability drill and keeps every line of
    gateway/config logic cloud-agnostic. Shadow delivery would be an
    AWS-adapter add-on if the design chat wants it later; flag there.
  - `processRemoteConfig` (config-service, pure): envelope
    {request_id, user, domain: alarms|modbus_joints|edge, doc}. Acks
    echo request_id with applied_versions or errors[{rule, message}]
    citing real R/A rule ids; acks are enqueued on the outbox ALARM
    class (QoS 1, ordered, survives link drops). alarms domain is
    freely tunable; modbus_joints carries source:'remote' so R12
    rejects unless the `maintenanceMode` global is true - that switch
    is deliberately local-only (a cloud-settable maintenance mode
    would defeat R12's purpose). edge domain validates
    telemetry_interval_min 1-1440.
  - **Remote modbus applies converge like local ones**: the wrapper
    reuses deriveLegacyBridge (decode globals + paraRaw ship) and new
    buildLegacyDrafts (schema -> legacy dashboard shapes, incl.
    flattening the effective ambient chain back to per-joint
    ambientSlaveID and uppercasing zone ids), clears the
    modbus-settings draft, and fires the content-aware Nano resend.
  - **A10 via the runtime global**: the live Alarm Manager evaluates
    every sample against `busbartherm_system_config`; both the remote
    path and (fix) the local path write it on successful apply. The
    Slice 2 refactor had dropped the local write - dashboard threshold
    saves updated the store but the RUNNING alarm engine kept old
    thresholds (regression found while implementing A10 here; the
    original legacy node wrote the global inline, confirmed from git
    history). Alarm state is never bulk-modified - thresholds change
    and alarms raise/clear through their normal persistence paths.
  - **Telemetry flushing became due-based**: the flow's fixed 600s
    inject is now a 60s tick calling flushIfDue (emits nothing
    off-cycle); the interval lives in RuntimeSettings
    (gateway-settings.json in the outbox dir, atomic writes, bounds
    1-1440, default 10) so a remote change takes effect within a
    minute and survives restarts.
  - `setupRemoteConfig` glue subscribes over the transport interface -
    on the loopback a publish IS a simulated cloud push, which is how
    the end-to-end tests run the whole chain (subscribe -> validate ->
    apply -> side effects -> ack via outbox) without a broker.
    Idempotent (one subscription per gateway); AWS transport replays
    subscriptions on every reconnect.
  - Flow changes: tick swap + Remote Config Setup node (3 outputs:
    status debug, resend link, paraRaw link) + removal of the 10
    empty ui_groups left by the user's pruning (promised cleanup).
    Runbook Part E documents push examples for all three domains.

  294 tests passing (15 new: envelope/A1/R12/R1 rule acks, drafts
  reverse-mapping, edge knob bounds+persistence, end-to-end loopback
  pushes incl. garbage payloads never crashing the subscription).
  Slice 7's "Done when" still needs the live push from the real AWS
  console (valid + invalid, acks observed, audit checked, no
  alarm-state corruption).

- **2026-07-19** — **Live bug fix (first real remote alarms push from
  AWS)**: ack came back "applied", the store (alarms.json) updated, and
  an audit entry appeared, but the running Alarm Manager kept the OLD
  thresholds, and the audit's "before" was always null. Two causes:

  1. **Detached-callback context writes.** Slice 7's setupRemoteConfig
     subscribed with a callback that performed the
     busbartherm_system_config write (and legacy bridge, drafts,
     audits) directly. That callback is captured ONCE at boot and
     fires forever; its `global`/`node` handles go stale after any
     redeploy, so global.set from it silently no-ops even though the
     plain-JS calls beside it (store.applyIfValid, outbox.enqueue)
     succeed - exactly the "applied + stored but not live" split.
     Fixed by splitting receipt from apply: the callback now only
     pushes the raw message onto gateway._remoteConfigInbox; a new 2s
     flow tick ("drain remote config" inject -> "Remote Config Apply"
     function) calls drainRemoteConfig, which does every context write
     in a NORMAL message execution with a fresh `global`. Same
     async-receipt/tick-drain pattern as the outbox. The apply node's
     debug now includes live_thresholds_written for confirmation.
  2. **Audit store + before=null.** appendLegacyAudit wrote the audit
     arrays to the unnamed default store while both viewers read the
     "default" named store; aligned it to "default" (matching the
     original legacy nodes). And the remote alarms path hardcoded
     oldConfig=null - now reads the currently-applied flat profile as
     the audit "before".

  Config apply latency is now up to 2s (the tick period) - negligible
  for config. 294 tests passing; the end-to-end loopback tests updated
  to drive the drain tick and to model that the Pi's unnamed default
  store is the "default" named store.

- **2026-07-20** — **Slice 7 live-verified.** End-to-end remote config
  push from the real AWS console confirmed working on the panel:
  telemetry-interval knob changes the flush cadence, alarm-threshold
  pushes take effect on the running Alarm Manager (A10), the R12
  maintenance gate rejects remote modbus changes unless enabled
  locally, and acks + audit entries land correctly (after the
  2026-07-19 message-context-drain fix). Slice 7's "Done when" is met.
  Slices 1-7 done; Slice 8 (hardening / portability drill / pilot) is
  next, blocked on the missing Edge Cloud Readiness Workplan for its
  acceptance checklist.

- **2026-07-21** — Built the **local InfluxDB historian** (user
  requirement: 7 days full-resolution + daily/weekly/monthly/yearly
  trends for absolute value + derived KPI, all configured sensors).
  Decisions:
  - **InfluxDB 1.x**, not 2.x - the panel ALREADY runs 1.x (found a
    live influxdb config node -> db `Mecha` feeding a legacy raw
    pipeline on modbusMaster_V2). Reused the engine, added a dedicated
    `busduct` database so the legacy store is untouched. 1.x also
    makes the tiered requirement trivial: retention policies +
    continuous queries do the downsampling natively (2.x would need
    Flux tasks).
  - **Retention tiers**: raw 7d (default RP) + rollup_1h 90d + rollup_1d
    1825d, with CQs cq_1h (raw->1h) and cq_1d (1h->1d), all keeping
    tags via GROUP BY time,*. Serves the exact requested views. Durations
    are engineering defaults - flagged for the design chat.
  - **Ingestion from the internal bus**, not a new poll: the Historian
    tab adds link-ins on the existing ProcessLogic joint + ambient
    taps (the ambient tap had no consumer before), so the historian
    sees every sample while the Cloud Gateway independently sees the
    10-min batch. Pure transform in src/historian/influx-points.js
    (measurement bt_kpi; temp_c always, KPIs for joints); non-OK
    sensor_status skipped so rollup means/maxes aren't poisoned;
    "unassigned" stream not historised (not configured sensors).
    Exposed as busductHistorian; the function node is a one-liner.
  - **No new repo dependency**: the DB write uses the node-red-contrib-
    influxdb *batch* node (already in the Pi's palette), and point-
    building is pure JS - so package.json is unchanged and the
    cloud-agnostic check stays trivially green (InfluxDB is a LOCAL
    service, not cloud egress; it does not go through the transport
    interface).
  - **Read/visualisation deferred**: shipped ingestion + retention +
    documented per-granularity read queries; Grafana (recommended) or
    a ui_chart trend screen is a follow-up. Flash-wear mitigation
    (batch writes, optional USB SSD for /var/lib/influxdb) documented
    per the Readiness Workplan risk table.
  New dir /src/historian (added to the layout table). 301 tests
  passing (7 new). Needs live verification on the Pi (create the DB via
  the setup script, restart, confirm bt_kpi points land).

## 2026-07-21 — Historian visualisation + certificate rotation

- **Historian visualisation — both read layers (user: "Build both")**:
  (1) In-HMI **Trends** dashboard tab (Historian flow tab nodes
  `9c1d2e3f4a5b7000`–`0b`): Sensor + Range dropdowns → on-demand
  `influxdb in` query → `ui_chart`. Sensor list auto-populated from
  `SHOW TAG VALUES` (boot + hourly); each range picks the matching
  retention tier (raw / rollup_1h / rollup_1d). Pure logic in
  `src/historian/trend-query.js` (`buildTrendQuery`, `resultsToChart`,
  `sensorOptionsFromTagValues`) on the `busductHistorian` global; thin
  function nodes. No new npm package (reuses node-red-contrib-influxdb's
  query node). (2) **Grafana** as provisioning-as-code under
  `tools/grafana/` (datasource + dashboard-provider YAMLs +
  `busduct-historian.json`; `sensor_id` variable, one panel per tier).
  Rationale: operators stay in the existing HMI for at-a-glance trends;
  Grafana is the richer analysis/export tool for engineering. 13 new
  tests.

- **Certificate rotation (Readiness Phase 1, user: "Certification
  rotation")**: device accepts a new operational cert over a dedicated
  `cmd/{c}/{s}/{p}/cert` channel and switches atomically with automatic
  rollback.
  - **Layering to keep the cloud-agnostic rule intact**: generic
    fs-mechanics + commit/rollback in `src/cloud-gateway/cert-rotation.js`
    (`CertRotator`, plain fs, injected `reconnectAndVerify`); the only
    AWS-side piece is `AwsIotTransport.reloadCredentials()` (re-read the
    same paths, force-redial, resolve true/false on connect/timeout).
    The rotator never imports the transport — it gets a callback. So it
    also works against the Slice 8 Mosquitto/EMQX drill unchanged.
  - **All-or-nothing**: validate PEM (no fs change on junk) → back up
    (`.bak`) → atomic write (tmp+rename, key `0600`) → verify connect →
    commit, else restore old material and reconnect on it. A failed
    (expired/mis-issued) cert can never strand the panel offline.
  - **Dedicated channel, not folded into the config domain**: rotation
    is rarer, connection-affecting and higher-privilege; separate
    receipt/apply split (setup subscribes → inbox; async 5s drain tick
    applies in message context so the `CERT_ROTATION` audit lands),
    mirroring the Slice 7 detached-callback lesson.
  - **Transport hardening**: added a "stale client's late close no-ops"
    guard (`this.client !== client`) so a redial (backoff OR rotation)
    can't have an old client's close event disturb the live connection.
  - Cloud-side: policy template grants the new topic (no new thing
    attributes); runbook + envelope in docs/aws/README.md Part F. 334
    tests passing (20 new). Live AWS pass still pending.

## 2026-07-22 — Nano 33 IoT firmware hang fix

> **⚠️ SUPERSEDED — see the 2026-07-29 correction at the end of this log.
> The real root cause was Raspberry Pi UNDER-VOLTAGE, not firmware.** The
> team later re-tested both the reduced-memory build and the **original
> unmodified sketch**; both ran fine once the Pi was given adequate power.
> Everything below is a plausible-but-unconfirmed diagnosis that was
> reached by code inspection alone, without ever measuring the failure.
> The changes were kept as hardening, but none of them fixed the hang.

- **Symptom (user):** the Nano stops transmitting after some hours,
  behaviour repeats. Classic memory/back-pressure signature, not a
  logic bug.
- **Root causes found in firmware/Nano_IOT.ino:**
  1. **RAM exhaustion (leading cause)** — `processModbusPackets()` built
     its response in a `StaticJsonBuffer<12288>` **on the stack, every
     `loop()`**, on top of the 12 KB static `inputBuffer`, on a 32 KB
     SAMD21. ~24 KB committed before heap/ModbusMaster/USB → stack/heap
     collision → hard fault after hours (fragmentation/timing dependent,
     hence "some hours" + repeatable). The response builder only ever
     holds ONE packet result, so it was oversized by ~10 KB.
  2. **USB-CDC back-pressure** — `Serial.print`/`flush` block when the
     Pi stops draining the port → the poll loop wedges inside a write.
  3. **No watchdog** — any wedge was permanent until a power cycle.
  4. **`while(!Serial);`** blocked boot forever if the host didn't
     reopen the port after a reset.
- **Fix (all internal; Pi<->Nano wire format UNCHANGED, Node-RED side
  untouched):**
  - per-loop builder → `RESPONSE_BUFFER_SIZE` (4 KB) instead of 12 KB;
  - `emitJson()` helper guards every response write with `if (Serial)`;
    removed the blocking `Serial.flush()` calls;
  - Adafruit SleepyDog **watchdog** (16 s window) enabled in setup, fed
    at the top of `loop()` and once per Modbus packet so legitimate long
    multi-slave poll cycles don't trip it;
  - `while(!Serial)` bounded to 2 s;
  - **robustness:** `comm` validated (baud/timeout sane) before
    `Serial1.begin` — a malformed comm used to set baud 0 and silently
    kill Modbus; `delayMicroseconds` >16383 µs routed through `delay()`.
- **New build dependency:** Adafruit SleepyDog library.
- **Recovery after a watchdog reset:** the Nano loses its job and waits
  for a resend; the Pi's existing serial-silence watchdog already
  detects the silence and resends the Nano job (also on boot / USB
  power-cycle / config apply), so the chain self-heals.
- **Not yet verified:** needs flashing + a multi-hour (ideally >24 h)
  soak on real hardware to confirm the hang is gone. ArduinoJson v5 was
  kept; migrating to v6/v7 `JsonDocument` for right-sized allocations is
  a larger follow-up for the design chat.

## 2026-07-22 — RoR permanently zero (ProcessLogic guard)

- **Symptom (user):** rate-of-rise (RoR) came through as 0 for every
  joint; the historian faithfully recorded the 0s.
- **Root cause:** not the historian — `ProcessLogic` (the KPI/alarm
  engine, node 39dad91df0c15744) emitted `ror: 0`. It had:
  `if (dtSec < 2) { ror = 0; } else { emaTemp += ...; ror = ...; }`.
  `dtSec` is the inter-sample interval clamped to [0.5, 300]; this panel
  polls ~0.5 s, so `dtSec < 2` was always true → RoR forced to 0 AND the
  EMA temperature never updated (frozen at the first reading, which also
  explained emaTemp sitting at 31.67 while val moved).
- **Intent vs effect:** the guard was a "startup stability fix" meant to
  suppress a wild RoR on the first sample, but it keyed off the sample
  interval instead of "is this the first sample", so fast polling made
  it permanent.
- **Fix (user-approved, applied to ProcessLogic):** removed the sub-2 s
  guard. The EMA step is already time-weighted by
  `alpha = dtSec/tauSec` (a 0.5 s sample takes a tiny correct step), and
  the first sample is naturally 0 because `emaTemp` initialises to
  `sensorVal` — so no special case is needed. Formula unchanged:
  `emaTemp += alpha*(sensorVal-emaTemp); ror = (sensorVal-emaTemp)/tauSec*3600`.
- **Behaviour change flagged:** RoR now tracks real trends, and
  **RoR-based (A2) alarms — which could never fire while RoR was pinned
  at 0 — become active.** This is the first logic edit to ProcessLogic
  since Slice 4 (previously byte-identical). Per the standing rule this
  touches the alarm engine, so it was confirmed with the user before
  applying; still to review in the companion design chat and re-verify
  live (RoR non-zero on a rising joint; no spurious A2 alarms on stable
  joints).

## 2026-07-24 — Scale to 100 joints + 10 ambient: bus limits, IDs, timeout

Design chat reviewed the repo at `claude/code-handoff-strategy-y551k2`
(Slices 1–7 complete, 338 tests green) against a new provisioning
target: **100 joint sensors + 10 ambient sensors on one panel.**

**Hardware fact established (corrects an earlier assumption).** The
sensor modules use a **MAX487EA**-class transceiver. This is
**quarter**-unit-load, not 1/8 as previously believed — the ceiling is
**128 transceivers per RS-485 segment**, not 256 (Analog Devices
MAX487E/MAX1487E datasheet). At 110 slaves + 1 master = 111 unit loads,
the panel sits at **87% of the electrical budget with ~17 spare**. The
part is also slew-rate-limited to 250 kbps, so 19200 baud remains safe.

**Two schema blockers found (both would have failed a real 110-device
commissioning):**

1. `modbus.slaves.maxItems` was **64** — a 110-device config could not
   validate at all. Raised to **128**.
2. `slave_id` pattern was `^sl[0-9]{2}$`, capping IDs at **sl99**. Found
   by writing the R16 test, not by inspection. Widened to
   `^sl[0-9]{2,3}$` (existing 2-digit IDs stay valid; no migration
   needed). `joint_id` already allowed 3 digits, so joints were fine.

**Changes applied in this pass:**

- **New rule R16 — RS-485 bus loading.** Per RTU bus: slaves + 1 (the
  master's own transceiver is a unit load) must not exceed
  `rs485_max_devices`; above 80% of the ceiling the config is still
  accepted but a **warning** is returned. Does not apply to TCP buses.
- **New optional bus field `rs485_max_devices`** (default 128; set 32
  for 1 UL parts, 256 for genuine 1/8 UL) so the ceiling follows the
  hardware rather than being hardcoded.
- **`validateModbusJoints` now returns `warnings` alongside `errors`.**
  First non-blocking diagnostic in the validator; callers that only read
  `valid`/`errors` are unaffected.
- **Nano firmware default `TimeOut` 5000 ms → 300 ms.** A healthy
  response at 9600–19200 baud returns in ~30–40 ms. At 5 s × retries,
  a handful of dead sensors on a 110-device bus dominates the entire
  scan cycle. `MODBUS_TIMEOUT_MAX` (15 s, watchdog-bounded) is unchanged
  as a ceiling for remotely-pushed values.
- 6 new tests (`test/config-service/r16-bus-loading.test.js`).
  Suite: **345 pass / 0 fail**; cloud-agnostic check still clean.

**Recommendation recorded, not yet implemented: split into two RS-485
segments.** ~55 devices per segment gives 43% loading, halves worst-case
scan time, and halves the blast radius of a single faulty transceiver —
the failure mode already seen at J28 (20 July), where one degraded
transceiver dragged down neighbours J29/J30. `buses.maxItems` is 4, so
the schema already supports this; it is a wiring and commissioning
decision.

### Open items for the next slices (not done here)

- **Device blacklisting** — after N consecutive failures, skip a slave
  for M cycles and raise a SYSTEM alarm. Nothing in `src/` or firmware
  does this today. Highest-value remaining fix at 110 devices; the
  300 ms timeout limits the damage but does not remove it.
- **Positional-array telemetry payload.** The batcher currently emits
  keyed JSON and correctly *splits* into chunks over 4800 bytes — but at
  100 joints that means several messages, hence several AWS 5 KB
  metering blocks per interval. Positional arrays + an index→joint_id
  manifest (sent only on config change) fit the whole panel in one
  message (~2.5 KB).
- **Ambient outlier rejection.** The 3-level ambient chain (R14:
  panel → zone → joint) already models 10 sensors well. What is missing
  is a runtime fallback: with 10 ambients available, a failed or drifting
  sensor should fall back to the zone median, then the panel median,
  rather than silently corrupting ΔT for every joint referencing it.
- **`cfg/integration` domain + Modbus TCP slave (BMS).** Agreed approach:
  Modbus TCP on the Pi + an off-the-shelf Modbus→BACnet gateway first
  (certified stack, no BOM risk); native BACnet/IP on the Pi later once
  panel volume justifies it. Tiered register map (summary / zone /
  joint detail) so customers can buy the smallest gateway point licence;
  heartbeat counter mandatory (Modbus has no liveness concept); register
  map versioned append-only.
- **Re-baseline ProcessLogic.** The RoR fix (22 July) means the Slice 4
  "byte-identical" regression baseline no longer covers the KPI engine,
  and **RoR/A2 alarms are firing for the first time ever** — thresholds
  (15/30/60 °C/hr) have never been validated against live data. Watch
  for false positives and be ready to retune.

## 2026-07-24 (later) — Blacklist recovery design + workplan addendum

The open items recorded earlier were unscoped one-liners. Two of them
had enough design content to lose, so they are now written down:

- **`docs/blacklist-recovery-spec.md`** (new) — the full state model and
  recovery logic for device blacklisting. Key decisions: never
  auto-clear a process alarm because measurement was lost (hold as
  `STALE` with `last_valid_ts`; `OFFLINE` when no alarm was active);
  freeze and **reset** the EMA baseline on restore so a 20-minute
  blackout with an 8 °C change cannot produce a spurious RoR alarm;
  pause and restart persistence timers; probe on backoff
  (30 s → 5 m) with restore only after 3 consecutive good reads
  (hysteresis, aimed squarely at the J28 flapping behaviour). Logic
  lives Pi-side; **prerequisite firmware fix** is to re-init
  `Serial1`/timeout only when `comm` actually changes, otherwise every
  blacklist and probe glitches the bus.

- **Workplan Addendum A** (appended to
  `docs/BusductTherMo_Edge_Implementation_WorkPlan.md`) — adds
  **Slice 9** (blacklisting, highest priority), **Slice 10** (scale
  hardening: positional telemetry payload, ambient outlier fallback,
  two-segment RS-485, full-scale soak) and **Slice 11** (BMS
  integration: `cfg/integration` domain, Modbus TCP slave, tiered
  register map, latched worst-joint rollup, heartbeat counter,
  append-only map versioning). Slices 1–8 unchanged.

Also noted in the addendum: the working agreement's "R1–R13 and A1–A10"
should now read **R1–R16 and A1–A10**.

## 2026-07-24 (later still) — Slice 8 split and re-sequenced to last

**Decision:** defer Slice 8 to the end of the programme, so the pilot
runs against the configuration that will actually ship (110 devices,
blacklisting, positional telemetry, BMS interface) rather than
validating the 19-joint shape.

**One change from the request:** Slice 8 is **split**, not deferred
wholesale.

- **Slice 8a — security hardening stays at its original early
  position.** It removes the hardcoded sudo password
  (`echo Password@21 | sudo -S ...` in the Debugging tab), secures the
  Node-RED editor and cleans credentials out of flow exports. The panel
  is being given a network route outward; holding a known credential
  exposure behind three more build slices is the wrong trade regardless
  of pilot timing.
- **Slice 8b — portability drill, pilot and rollout is now the final
  slice**, assessed against the full-scale configuration.

**Slice numbers are stable identifiers, not execution order.** Slice 8
was deliberately **not** renumbered to 12: ~19 references to "Slice 8"
exist across source comments (`cert-rotation.js`,
`aws-iot-transport.js`), `CLAUDE.md`, `docs/aws/README.md` and this log
— almost all pointing at the portability drill, i.e. 8b. Renumbering
would invalidate them all for no benefit.

**Execution order is now:** 8a → 9 → 10 → 11 → 8b.

**Updated:** workplan Slice 8 section (split), Addendum A sequencing
table, Timeline Summary (now 16 weeks), `CLAUDE.md` standing
instructions and current-status block. `CLAUDE.md`'s test rule also
corrected from "R1–R13" to **R1–R16**.

## 2026-07-24 — Slice 8a security hardening (code)

Audited the flow for the "hardcoded sudo password" the workplan flagged.
Reality differed from the description:

- The USB power-cycle exec node uses **plain `sudo uhubctl`** (no
  embedded password, no `sudo -S`) — it relies on passwordless sudo.
- The actual embedded secrets were **five plaintext dashboard/kiosk
  gate PINs** in function/template node source, committed to git:
  `system123` + `alarm123` (Check Password → system/alarm config),
  `AdminPro` (Parameters tab, two nodes), `AdminLite` (Communication
  Settings tab, two nodes), `Password@21` (Exit Kiosk PIN).
- No plaintext DB/SMTP/MQTT passwords in `flows_BBT.json` — Node-RED
  keeps those in the encrypted `flows_*_cred.json`, which is not tracked.

**Changes:**

- All five PINs removed from the flow; gates now read from the Node-RED
  environment (`BUSDUCT_PW_SYSTEM`/`_ALARM`/`_PARAMETERS`/`_COMMS`,
  `BUSDUCT_KIOSK_PIN`) via `env.get(...)` (function nodes) and
  `${BUSDUCT_KIOSK_PIN}` deploy substitution (kiosk template). Every
  gate **fails closed** when its var is unset — no empty-string bypass.
- `deploy/sudoers.d/busduct-nodered` — NOPASSWD for `uhubctl` only, with
  install + `visudo -c` steps; instruction to drop any `NOPASSWD: ALL`.
- `deploy/nodered.env.example` — env template (real file lives at
  `/etc/busduct/nodered.env`, git-ignored, wired via systemd
  `EnvironmentFile`).
- `.gitignore` — added `flows_*_cred.json`, `settings.js`, `*.pem/.key
  /.crt`, `*.env` (keep `*.env.example`), `/etc/busduct/`, etc.
- `settings.js.example` — `adminAuth` (bcrypt) block + TLS / loopback /
  `credentialSecret` options for securing the editor.
- `docs/security-hardening.md` (new) — full 8a runbook + verification
  checklist; referenced from `docs/pi-deployment.md` §11.

**Noted, not changed:** the dashboard gate PINs are low-strength
client-reachable gates; the real boundary is the editor `adminAuth` +
OS. A hashed/role-based dashboard auth is a possible future improvement,
out of 8a scope.

**Not yet done:** live pass on the Pi — set the env file, install the
sudoers rule, enable `adminAuth`, re-import the flow, and confirm each
gate denies with no PIN / admits with the correct PIN, editor prompts
for login, and `uhubctl` recovery still works.

## 2026-07-24 (later) — Kiosk PIN fix: server-side, not ${} substitution

Live test showed the kiosk exit PIN didn't work after 8a while the other
four gates did. Cause: the kiosk used `scope.correctPass =
"${BUSDUCT_KIOSK_PIN}"` inside the Exit Kiosk `ui_template`, but Node-RED
does **not** substitute `${ENV}` inside dashboard template body content
(it does for typed node properties / `env.get()` in function nodes, which
is why the other gates worked). The browser saw the literal `${...}` and
the guard locked it.

Fix: validate the kiosk PIN server-side like the others. New "Check
Kiosk PIN" function node (`env.get('BUSDUCT_KIOSK_PIN')`) sits between the
kiosk template and the `killall chromium` exec node; the template now
just sends the entered value and shows the server's verdict via a
`$watch('msg')`. Bonus: the PIN never reaches the browser. Env var name
unchanged, so `/etc/busduct/nodered.env` needs no edit — just re-import
the flow. docs/security-hardening.md corrected.

## 2026-07-24 — Slice 9 core: firmware comm-guard + blacklist tracker + compiler exclusion

Built the clean, unit-testable core of device blacklisting (spec:
docs/blacklist-recovery-spec.md). Stopped before the alarm-engine
changes (steps 5–7) for a design-review checkpoint, as they alter alarm
behaviour.

- **Firmware comm-change guard (step 1).** `Nano_IOT.ino` now re-inits
  `Serial1`/`node.setTimeout` **only when baud or timeout actually
  changes**, not on every job update. `Polling` still updates freely (no
  re-init). `setup()` now calls `node.setTimeout(TimeOut)` so the guard
  has a baseline. Without this, every blacklist/probe resend (same comm,
  different read set) would glitch the bus. Prerequisite for practical
  Pi-side blacklisting. (Flash with the other pending firmware changes.)
- **`src/config-service/blacklist-tracker.js` (steps 2–3).** Pure,
  timing-injected `BlacklistTracker`: consumes per-slave ok/err reads,
  blacklists after 3 consecutive failures, probes on backoff
  (30s→1m→2m→5m cap), restores after 3 consecutive good probe reads
  (hysteresis). States active/blacklisted/probing; emits
  blacklisted/probing/restored/probe_failed events; `activeSlaveIds`,
  `blacklistedSlaveIds`, `isMeasurable`, `snapshot`. 8 tests incl. the
  spec's AC1 (blacklist after 3) and AC5 (fail-every-other-probe never
  flaps).
- **Compiler exclusion (step 4).** `compileNanoJob(doc,
  {excludeSlaveIds})` omits blacklisted slaves from the read list; comm
  unchanged (so the firmware guard skips the re-init). Backward
  compatible (default no exclusion), so `nanoJobsEqual` and the existing
  resend path are untouched. R10 capacity math still assesses the full
  configured fleet (validation runs on the document, not the trimmed
  job). 2 tests. 355 tests total.

**Checkpoint — not yet built (steps 5–7, need design review + touch the
alarm engine):** joint LIVE/STALE/OFFLINE states + hold-don't-clear on
non-measurable joints; extend ProcessLogic's `Sensor_Error` freeze to
blacklist with **EMA baseline reset on restore** and persistence
pause/restart; one ACK-able SYSTEM alarm per blacklisted slave
(HMI/cloud/BMS/audit); plus the Node-RED flow wiring that feeds Nano read
results into the tracker and resends the trimmed job. These change alarm
raise/clear behaviour, so confirm with the user (as with the RoR fix)
before editing ProcessLogic/Alarm Manager.

## 2026-07-24 — Slice 9 steps 5 + 7 (joint states, SYSTEM alarm, flow wiring)

User authorised steps 5 and 7 (holding step 6, the EMA freeze/reset,
until the RoR/EMA live check — sensible, since step 6 builds on that
path). Built:

- **`src/config-service/node-red/blacklist-handler.js`** (pure, exposed
  at `busductConfigService.blacklist`): maps Nano `{t:'r',id,st}` results
  to slave_ids, drives the tracker, and returns the exclude set (+ resend
  decision keyed on exclude-set change), blacklist alarm raise/clear
  commands, and per-joint LIVE/STALE/OFFLINE (step 5). 7 tests.
- **Alarm Manager (`de6fcc55794afd9e`):** new DEVICE_BLACKLIST section
  raises/clears one ACK-able `SYSTEM|<slave>|BLACKLIST` alarm, mirroring
  the COMM watchdog. Also guarded the CONFIG_REMOVED sweep with
  `alarm.category !== "SYSTEM"` — without it, a SYSTEM alarm
  (joint_id "SYSTEM") would be auto-cleared on the next KPI pass (latent
  COMM-alarm bug too). `buildOutputs` now mirrors active alarms to
  `global.busbartherm.activeAlarms` so the blacklist engine can tell a
  held (STALE) joint from an OFFLINE one.
- **`buildNanoJobMessage(store, {excludeSlaveIds})`** + `Send Nano Job`
  reads `global.busduct_blacklist_exclude`.
- **Device Health flow tab** (`d9b1ac57e0f100xx`): taps the Nano response
  stream (Data Out link), Blacklist Engine (thin, calls the lib) + a 10s
  probe tick, resends the trimmed job via the existing Resend Nano Job
  link, injects blacklist alarms into the Alarm Manager via a new
  link-in, writes `global.busduct_blacklist_state` for the HMI.

**Design note — hold-don't-clear needs no Alarm Manager surgery:** a
blacklisted slave stops being polled, so ProcessLogic emits no fresh
sample for its joints → the Alarm Manager never re-evaluates them → held
process alarms simply persist, and CONFIG_REMOVED doesn't fire because
the joints remain in config. Step 5 therefore only adds the STALE/OFFLINE
exposure, not a clear-suppression mechanism.

362 tests pass. **Held: step 6** (ProcessLogic EMA/persistence
freeze+reset) pending the RoR live check. Not yet live-verified on the
Pi.

## 2026-07-24 — Live verifications: RoR fix + Slice 8a

- **RoR fix live-verified on the Pi:** RoR now tracks real trends and no
  spurious A2 alarms on stable joints. This clears the key dependency for
  Slice 9 step 6 (the EMA freeze/reset builds on this path).
- **Slice 8a live-verified:** all five env-driven gate PINs work
  (system/alarm/parameters/comms + the server-side kiosk PIN). No
  credentials remain in the flow export.

## 2026-07-24 — Slice 9 step 6 (EMA/persistence freeze + reset on restore)

RoR live-verified, so step 6 unblocked (user go-ahead). Key realisation:
the **freeze is automatic** — a blacklisted slave stops being polled, so
ProcessLogic gets no fresh sample for its joints and their emaState +
the Alarm Manager's persistState simply don't advance. Step 6 is
therefore only the **reset on restore**:

- Handler returns `emaResetJoints` (the restored slave's joints) on a
  restore event; the Blacklist Engine writes them into
  `global.busduct_ema_reset`.
- ProcessLogic, right after loading `emaState`, checks the flag and
  drops that joint's `emaState` + `deltaTEmaState` (and clears the flag)
  so the first fresh reading re-initialises `emaTemp = sensorVal`,
  RoR = 0 — **AC4** (no spurious RoR after a 20-min blackout with an
  8 °C change), building on the validated RoR/EMA path.
- The Alarm Manager's blacklist-clear branch deletes `PROCESS|<joint>|*`
  persistence timers for the restored joints, so any re-appearing
  condition re-proves from zero on fresh data (spec §3.2).

All Slice 9 steps (1-7) now built. 363 tests pass. **Slice 9 code
complete; live pass on the Pi still pending** (blacklist on forced
failure, SYSTEM alarm, scan drop, restore + no spurious RoR, held alarm
not cleared).

## 2026-07-24 — Device Health HMI view for blacklisting

User asked how to view blacklisted slaves. There was no dedicated HMI
panel (only the Active Alarms SYSTEM alarm + the editor node status +
the busduct_blacklist_state global). Added:

- `summarizeBlacklist(state, nowMs)` in blacklist-handler.js (pure,
  3 tests): joins the tracker snapshot + joint states into a display
  summary - blacklisted/probing slaves with recovery countdown and
  affected joints, plus STALE/OFFLINE joint lists and counts.
- **Device Health dashboard tab** (`ui_template` d9b1ac57e0f10022, 5 s
  refresh via a thin function reading the global): live table + "All
  devices live" when clear. Documented in edge-user-manual.md.

366 tests pass.

## 2026-07-24 — Fix: blacklist tracker singleton (context serialisation)

Live error: `TypeError: tracker.tick is not a function` in the Blacklist
Engine. Cause: it stored the BlacklistTracker instance in Node-RED flow
context, but the Pi's context store is localfilesystem-backed, which
JSON-serialises values and strips the class prototype -> read-back is a
plain object with no methods. Same trap the cloud-gateway avoided.

Fix: `getTracker()` process-wide singleton in blacklist-handler.js (held
in the module, loaded once at startup, never serialised). The engine now
calls `bl.getTracker()` and keeps `prevExcludeKey` on the tracker rather
than in the persistent flow store. Test asserts the same live instance
with methods intact. 367 tests.

## 2026-07-24 — Fix: blacklist engine tapped the raw (unparsed) Nano stream

Live: disconnecting a device raised its sensor-fault alarm but the
Blacklist Engine stayed "all live". Cause: the engine tapped the
"Data Out" link, which carries serial-in's RAW STRING output - the JSON
is only parsed later by the `84353552fed87166` json node (serial-in ->
filter '{' -> json -> decode parsers). So the engine saw strings,
`msg.payload.t` was undefined, and every read was ignored.

Fix: re-tapped the engine's "Nano Results (in)" link onto the json
node's OUTPUT (the parsed `{t:'r',id,st}` objects the working decode
pipeline uses), and removed it from Data Out. The firmware emits
`{t:'r',st:'err'}` on every failed read (Nano_IOT.ino), so 3 consecutive
now blacklist as designed. Flow-only change.

## 2026-07-24 — Slice 10 start: ambient outlier rejection + fallback

Blacklist confirmed working live (disconnect -> blacklist + SYSTEM
alarm), so Slice 9's core acceptance is met. Started Slice 10.

- `src/config-service/ambient-resolver.js` (pure, 8 tests, exposed as
  `busductConfigService.resolveAmbient`): resolves a joint's effective
  ambient VALUE with a plausibility band (default -20..80 C) and
  fallback — configured sensor -> zone median -> panel median -> none.
  So one failed/drifting ambient can't poison ΔT for every joint that
  references it.

**Not yet integrated into ProcessLogic** — that changes ΔT (alarm-
relevant), so it's a checkpoint (like the RoR/blacklist engine edits).
Remaining Slice 10 items carry real design decisions (positional
telemetry = a cloud wire-format contract; two-segment RS-485 =
architecture) — to be planned with the design chat before building.

## 2026-07-24 — Slice 10: contained fixes + ambient integration; two items proposed

Implemented the "contained fixes + ambient integration" plan; held the
two design-sensitive items for the design chat.

- **3-digit slave_id (100+ devices):** two real bugs in
  modbus-settings-handler — the carried-id regex was `^sl[0-9]{2}$`
  (a `sl100` would be treated as new and reassigned, breaking joint
  maps) and `nextFreeId` capped at 64. Fixed to `^sl[0-9]{2,3}$` and
  `i <= 128`. `padStart(2)` already yields `sl100` correctly.
- **R16 warnings in the apply UI:** `store.applyIfValid` now returns
  `warnings`; the Modbus Settings handler appends them to the success
  toast (`applied. ⚠ R16: bus at 111/128...`) so an >80%-loaded bus is
  visible without blocking the apply. 2 store tests.
- **Ambient outlier/fallback -> ProcessLogic:** the ΔT block now resolves
  the effective ambient via `busductConfigService.resolveAmbient`
  (configured -> zone median -> panel median, plausibility band
  -20..80 C). The configured-and-plausible path is byte-identical to
  before; fallback only engages when the configured ambient is
  out-of-band or missing. Ambient output carries a `source` field.
  Note: the band catches gross faults; subtle in-band drift is not
  rejected (peer-deviation rejection is a possible future enhancement).

**Proposed, not built (design chat) — `docs/slice10-design-proposals.md`:**
(A) positional-array telemetry payload (cloud wire-format + manifest
contract; the cloud-side parser must change in lockstep), and (B)
two-segment RS-485 (per-bus compile/serial/recovery, bus-tagged
responses). Both need sign-off on their contracts first.

377 tests pass. Ambient ProcessLogic change is alarm-relevant (ΔT) -
needs a live check like RoR did.

## 2026-07-24 — Slice 10: positional telemetry built on the edge (off by default)

User: edge is the current priority; cloud (DB/dashboard) is built after
the edge workplan, and only MQTT topics exist cloud-side today. That
removes the lockstep risk from the positional-telemetry format (no cloud
parser to break), so the edge side is now implemented:

- `Batcher` gains a `positional` mode (constructor flag, **default
  false** so the live keyed format is untouched). It emits a
  column-oriented payload — `dt_min/dt_max/dt_avg/ror_max/t_max/amb_avg`
  as arrays index-aligned to a **manifest** (index→joint_id) — with
  `manifest_version`, `start_index`/`count`, values rounded to 0.01, and
  `null` at an index where a joint had no data. The manifest
  self-versions (append keeps indices stable; a change bumps the version)
  and republishes only when changed (QoS 1). Whole-panel-in-one-message
  is the common case; index-range chunking is the safety net. 5 tests.
- Enabled via `publish.telemetry.encoding: 'positional'` in the edge
  config (`createGatewayFromEdgeConfig` reads it); default keyed.
- The cloud IoT-Rule/DB parser (deferred) will be written to this format
  directly — the contract is docs/slice10-design-proposals.md §A.

Two-segment RS-485 (§B) remains a design-chat item (architecture:
port→bus mapping, bus-tagged responses). 382 tests pass.

- **2026-07-25** — Two-segment RS-485 (§B): the **cloud-agnostic core is
  now built** after the design-chat decisions were settled (keep bus1 as
  the current pipeline, add a parallel bus2, tag responses by the
  serial-in they arrive on, one tracker keyed by global `slave_id`).
  Changes, all back-compatible (single-bus panels byte-for-byte
  unchanged, every new arg optional):
  - `compileNanoJob(doc, {busId})` compiles one job per bus (filters
    `modbus.slaves` by `s.bus_id`, emits that bus's own `comm`). A
    multi-bus doc with no `busId` now errors `specify {busId}` instead of
    the old flat "single bus" rejection — the old guardrail test was
    updated to assert the new message.
  - `nanoJobsEqual(a, b, busId)` compares per bus; `buildNanoJobMessage(store, {busId})`
    threads it through for Send Nano Job.
  - Blacklist handler: `unitToSlaveId(doc, addr, busId)` resolves a
    response within its bus (unit addresses are unique per-bus, not
    globally); `processReadResult` reads the tag from
    `ctx.busId ?? payload.bus_id`.
  The flow still wires only bus1 — the second physical pipeline (2nd
  serial pair on `/dev/ttyACM1`, per-bus Send Nano Job, bus-tagged
  response tap, per-bus recovery controller) is a **documented runbook**
  in §B, pending a physical second Nano to wire and bench-test. 389
  tests pass.

- **2026-07-25** — Slice 11 (BMS integration) **core built + unit-tested**;
  flow tab wiring and reference-gateway live validation are the remaining
  pending items (need the Modbus→BACnet gateway hardware). Implementation
  choices:
  - **Fourth config domain `cfg/integration`** rather than folding BMS
    knobs into an existing domain — it versions independently (its own
    append-only `point_map_version`), audits separately, and can be absent
    (BMS optional). Schema + validator I1–I5 mirror the existing R/A rule
    style; registered in the store's `DOMAIN_FILES`/`DOMAIN_VERSION_KEYS`
    and `createStore`.
  - **Register layout is deterministic with FIXED bases/strides**, not
    packed tightly. Tier 1 @0, control/ACK @16, optional bitmap @32,
    Tier 2 @100 (stride 8), Tier 3 @500 (stride 8). This makes the map
    append-only *by construction* — adding a joint/zone can never move an
    existing point, satisfying the workplan's "never renumber" rule
    mechanically instead of by discipline. Reserved gaps at each block's
    end absorb future appends. I5 rejects a config whose zones/joints would
    overflow the fixed regions.
  - **Modbus TCP server library is INJECTED** (`serverFactory`), same DI
    pattern as the cloud transport interface and the cert rotator's
    reconnect callback. All testable behaviour (serving, ACK decode,
    read-only enforcement, no-data sentinel) is unit-tested with a fake
    factory; the only untestable-here piece — the socket bind — is a thin
    `jsmodbus` factory (`src/integration/node-red/jsmodbus-server-factory.js`,
    the sole importer, **lazily required**). `jsmodbus` chosen over
    `modbus-serial` because it's pure JS (no serialport native build on
    ARM); added as an **optionalDependency** so `npm i` and CI don't depend
    on it (tests use the fake). Cloud-agnostic grep unaffected.
  - **Worst-joint point is latched** (first-raised holds until clear,
    tiebreak by joint_id for determinism) so it doesn't oscillate when two
    joints sit at the same level — the latch is stateful, held in the
    `BmsService` process singleton (never Node-RED context, which would
    serialise away its methods — same lesson as the blacklist tracker and
    cloud gateway).
  - **Heartbeat counter** increments every refresh and wraps 0..32767
    (signed-int16 safe) — Modbus has no liveness concept, so without it a
    frozen Pi presents as healthy steady values. **NO_DATA sentinel**
    −32768 distinguishes a dark/stale joint from a real 0.0.
  - **ACK write point** decodes 1 = ACK all active (summary), 1000+i = ACK
    Tier-3 joint i; routed to the same alarm ACK path as the HMI so
    BMS-originated ACKs hit the audit trail. `setImage` deliberately does
    not stomp the ACK register so a pending write survives a refresh.
  Customer-facing `docs/bms-register-map.md` (append-only rule on page 1) +
  deployment `docs/bms-integration.md` (incl. the flow-wiring runbook).
  444 tests pass; cloud-agnostic check green.

- **2026-07-28** — **Ambient resolver live bug fix (Slice 10).** First live
  test of the ambient outlier/fallback on the real Pi: unplugging the panel's
  only ambient sensor (sl21 / unit 101) raised false ΔT alarms on J02
  (WATCH then WARNING) after a few minutes, and the joint KPI debug showed
  `ambient: { val: 0, age_sec: 166, source: "configured" }`, `deltaT.raw ≈
  31` (= joint temp − 0). Root cause: `resolveAmbient` only checked the
  plausibility band, and a dead sensor reads `0 °C`, which is **inside**
  −20..80 — so it was accepted as the configured ambient, and there was **no
  staleness/status check** (a 166 s-old, comm-failed reading was treated as
  live). Fixes:
  - `resolveAmbient` now treats a reading as usable only if in-band **AND**
    fresh (`age_sec ≤ maxAgeSec`, ProcessLogic passes 60 s) **AND** status
    OK. Readings may be a plain number (legacy/tests, no age/status → old
    behaviour under the default `maxAgeSec: null`) or `{val, age_sec,
    status}`. Return shapes unchanged (existing deep-equal tests still hold).
  - ProcessLogic ambient cache (`39dad91df0c15744`) no longer overwrites the
    last-good `val` on a faulted read (a dead sensor's 0 no longer poisons
    the cache), stores `status`, and tracks `lastGoodTsMs`; `_ambReadings`
    now ships `{val, age_sec (from lastGoodTsMs), status}` and passes
    `maxAgeSec: AMBIENT_MAX_AGE_SEC` (60 s).
  Net behaviour: a stale/faulted configured ambient falls back to zone→panel
  median; when it's the **only** ambient (this panel), the result is
  `source:"none"` and **ΔT is not computed at all** — no fabricated ΔT, no
  false alarm. 7 new resolver tests; full suite 451 pass. Restore path
  (existing ΔT alarms clearing when the ambient reconnects and ΔT reads real)
  still to live-verify.

- **2026-07-28 (2nd pass)** — **Ambient zero-sentinel.** The staleness/status
  fix above wasn't enough: on the real panel the disconnected ambient
  transmitter kept answering Modbus with a **fresh, in-band, status-OK
  `0.0 °C`** for ~20 minutes (register `0x0000`) before the bus finally
  comm-failed — the ΔT alarms (J01/J02) fired well before the
  "AMBIENT_101 sensor communication failure"/blacklist events. So band + age
  + status all passed and ΔT = joint − 0 ≈ 30 kept raising WATCH/WARNING.
  The only discriminator is the value: for a busduct/switchgear panel `0 °C`
  is not a physical ambient, it's the Modbus no-data value. `isUsable` now
  rejects a reading within `DEFAULT_ZERO_EPS` (0.05) of 0. Configurable via
  the new `zeroEps` param (a genuinely sub-zero site sets `zeroEps: null` and
  raises `band.min` above 0 instead — **flagged for the design chat** as a
  panel-environment assumption). ProcessLogic uses the default (0.05), so no
  flow change was needed for this pass — resolver library only. 4 new tests;
  full suite 455 pass.

- **2026-07-28 (3rd pass)** — **Ambient recovery: ΔT EMA re-init.** After the
  zero-sentinel fix, reconnecting the ambient still did not clear the stale ΔT
  alarms (live: ambient healthy again at `val 29.28, age 0.5s,
  source:"configured"`, joint 33.01 -> true ΔT ~3.7, yet the 19:45-20:01 ΔT
  alarms stayed active). Root cause: ProcessLogic's ΔT block had **no `else`**
  for the unusable-ambient case, so `deltaTEmaState[joint]` was left frozen at
  the poisoned value (~32); on recovery the EMA *decayed* toward the truth with
  tau = `timeWindowMin` (20 min), so the alarm sat there for 20+ minutes and
  read as "cannot reset". Fixes:
  - **ProcessLogic** (`39dad91df0c15744`): the unusable-ambient branch now sets
    `deltaTEmaState[joint] = { ambInvalid: true }`, and the usable branch
    **deletes** an `ambInvalid` baseline before the `??=` re-init — so ΔT
    re-initialises from the real reading the moment the ambient recovers
    (identical in spirit to the Slice 9 blacklist-restore EMA reset).
  - **blacklist-handler**: `emaResetJoints` now unions `jointsForSlave` with
    the new `jointsUsingAmbientSlave` (via `ambientSlaveForJoint`, honouring
    the R14 joint -> zone -> panel override chain). A dedicated ambient slave
    (sl21/unit 101 here) carries **no joints**, so restoring it previously
    reset nothing even though every joint referencing it had an invalid ΔT
    baseline. De-duplicated for a slave that both carries and serves a joint.
  Operational note for a panel already stuck from before this fix: the existing
  poisoned baseline has no `ambInvalid` flag, so set
  `global.busduct_ema_reset = {J01:true, J02:true}` once (inject node) to force
  the drop. 6 new tests; full suite 459 pass.

- **2026-07-28 (4th pass)** — **Blacklist alarm identifies the device the way
  the operator commissioned it.** Live report: the alarm read *"Slave **sl21**
  blacklisted after 3 consecutive read failures; joint(s) **(none mapped)** not
  measurable"*, but the device was commissioned as **unit address 101**
  (`AMBIENT_101`) — `sl21` is the internal schema `slave_id`, which no operator
  ever types. Two fixes in `blacklist-handler.js`:
  - `slaveDisplayName(doc, slaveId)` resolves the commissioned identity
    (`unit_address` + optional `label`, e.g. `101 (AMBIENT_101)`), used in every
    raise/clear description; the alarm command also carries `unit_address` as a
    structured field. `slave_id` is still on the command for traceability, just
    not shown as the primary identity.
  - The impact clause now distinguishes the two ways a dead device hurts:
    joints it **carries** (`... not measurable`) vs joints that merely
    **reference** it as their ambient (`ambient reference for joint(s) ... - ΔT
    unavailable`). A dedicated ambient slave carries no joints, so the old text
    said "(none mapped) not measurable" — understating a fault that actually
    disables ΔT for every joint on the panel. Restore now carries a description
    too (`Slave 101 (AMBIENT_101) restored`).
  - `summarizeBlacklist(state, nowMs, { doc })` gained an optional doc so the
    Device Health HMI rows carry `unit_address`/`display`/`ambient_for_joints`;
    without a doc it falls back to the old `slave_id` display (back-compatible).
  Flow: the "Blacklist View" node (`d9b1ac57e0f10024`) now reads the applied
  cfg and passes it in; the Device Health table (`d9b1ac57e0f10022`) shows
  "Device (addr)" and an "Affected" column listing carried + ambient-dependent
  joints. 3 new tests; full suite 462 pass.

- **2026-07-28 (live pass)** — **Ambient chain + blacklist restore verified on
  the real Pi.** User-confirmed across the four fix passes above:
  1. Disconnecting the ambient → `ambient: null`, `deltaT: null` on the joint
     KPI stream (ΔT is not fabricated against a phantom 0) and **no false ΔT
     alarm** is raised.
  2. Reconnecting → the ΔT EMA re-inits from the real reading and the ΔT alarms
     **CLEAR** (observed in Cleared Alarm History at 20:28:36 / 20:29:21),
     instead of decaying for a full tau (~20 min).
  3. The blacklist alarm raises/clears correctly and now reads
     `Slave 101 (AMBIENT_101) ... ambient reference for joint(s) J01, J02 - ΔT
     unavailable`.
  This closes **Slice 9's** remaining live items (restore path + alarm clear)
  and the **Slice 10 ambient-hardening** live check. Still dormant on this
  panel by design: positional telemetry (OFF — no cloud consumer yet) and
  two-segment RS-485 (needs a second physical Nano).

- **2026-07-29** — **Legacy InfluxDB point builder off-by-one (J02 missing).**
  Live report: the legacy `Busbar` InfluxDB write path on `modbusMaster_V2`
  showed J01 and Ambient_101 but never J02. Root cause in the point-builder
  function node (`2978fd45db77d953`): the loop over the legacy per-channel
  globals was `for (var i = 0; i < n - 1; i++)` where `n = slaveLength`. Rows
  are written at indices `0 .. slaveLength-1` (`writeLegacyModbusGlobals`), so
  the bound **always dropped the last commissioned row**. Ambient sensors kept
  appearing because they're emitted by a *separate* `ambientMap` loop after the
  main one — which disguised a systematic "last row is lost" bug as "one
  specific joint is missing". Whether the lost row is a joint or the ambient
  depends purely on `modbus.slaves[]` ordering. Fixed to `i < n` with a
  `sID == null` guard. Reproduced and verified with a simulated 3-row panel
  ordered [unit 1, unit 101, unit 2]: before → `J01, Ambient_101`; after →
  `J01, J02, Ambient_101`.
  Note this is the **legacy** path (measurement `Busbar`, legacy `Mecha` DB),
  independent of the Slice 10 Historian tab (`bt_kpi` in the `busduct` DB,
  fed from the ProcessLogic KPI taps), which never had this bug.
  **Live-verified on the Pi (2026-07-29): J02 now writes.** Historical `Busbar`
  data still has the gap for however long the off-by-one ran — `bt_kpi` is the
  complete series for any back-analysis. **Open question for the design chat:**
  whether the legacy `Busbar` writer should be retired now that the Historian
  tab is the supported path — it is a second, unvalidated data pipeline whose
  only remaining consumer is the legacy dashboard.
  **RESOLVED 2026-07-29 — KEEP it (see the entry at the end of this log): it
  feeds the Grafana-backed "BusbarTherMo — Main Dashboard (Zone Overview)",
  which is a live customer-facing page, not a legacy leftover.**

- **2026-07-29 (2nd)** — **Legacy InfluxDB ambient wrote a fabricated 0.**
  Live report: `Ambient_101` reached the InfluxDB node with `value: 0` while the
  sensor actually read ~29.3. Root cause in the same point-builder
  (`2978fd45db77d953`): the joint branch reads the **commissioned** register
  address (`sensorData[sID][sregisterAddress{i}]`) but the ambient branch
  **hardcoded register 0** (`sensorData[ambientID][0]`). This panel commissions
  every device at register address 3, so the ambient lookup returned
  `undefined`, and `validateValue()` turned that into its default **0** — a
  fabricated reading indistinguishable from a real one, stored as history.
  Fixes: (1) a pre-pass builds `addrBySid` from all legacy rows so the ambient
  uses its real commissioned address; (2) when there is genuinely no reading the
  point is **omitted** rather than written as 0. Same 0-as-no-data trap that
  caused the false ΔT alarms upstream — this was its third appearance today, in
  a different pipeline. Verified by simulation against the real panel shape
  (all devices at register 3): before → `Ambient_101 = 0`; after → `29.34`.
  **Live-verified on the Pi (2026-07-29): the ambient now writes its real
  value.** Reinforces the open question above about retiring the legacy
  `Busbar` writer: it is an unvalidated parallel pipeline that has now produced
  two distinct data-integrity bugs the supported Historian path never had.
  Historical `Busbar` ambient values are 0 for the whole period the hardcoded
  register-0 lookup ran — treat that series as unusable before this date and use
  `bt_kpi` for any back-analysis.

- **2026-07-29** — **CORRECTION: the Nano "hang" was Raspberry Pi
  under-voltage, not firmware.** Supersedes the 2026-07-22 entry above.
  The team found the Pi's **power LED blinking randomly** — the classic
  under-voltage signature — and the problem disappeared once the Pi was given
  an adequate supply. They then re-tested **both** the reduced-memory build
  **and the original unmodified sketch**: **both ran fine**. So the
  RAM-exhaustion / stack-heap-collision diagnosis was wrong, and the "some
  hours, repeatable" timing that seemed to corroborate it was just the supply
  sagging under load.
  - **What we got wrong, methodologically:** the 2026-07-22 root cause was
    derived entirely from **reading the code** — a 12 KB stack buffer next to a
    12 KB static buffer on a 32 KB part is a genuinely suspicious pattern, so it
    was accepted without ever measuring the failure (no free-RAM logging, no
    hard-fault handler, no power rail check). A plausible mechanism was mistaken
    for the confirmed one. **For any future "device stops responding": check the
    power rail FIRST** (`vcgencmd get_throttled`, power LED) before theorising
    about firmware; it is cheaper to rule out and far more common.
  - **What we keep:** the firmware changes stay as defensive hardening — the
    SleepyDog **watchdog** genuinely buys automatic recovery from a wedge of
    *any* cause (including a brown-out), the `comm` validation prevents a bad
    job setting baud 0, and the `if (Serial)` guards are correct regardless.
    But they are **hardening, not the fix**, and the log must not imply
    otherwise. The 4 KB response buffer is retained (proven adequate, and it
    was never harmful) though it is now known to have been unnecessary.
  - **Gap this exposed:** `src/cloud-gateway/pi-health.js` has sampled the
    under-voltage flags since Slice 6 (`vcgencmd get_throttled` →
    `low_voltage.under_voltage_now` / `throttled_now` /
    `throttled_since_boot`), but only inside the **cloud heartbeat** — there is
    no local HMI tile or SYSTEM alarm, so the one signal that would have named
    this in minutes was invisible on the panel. **Open item: raise a local
    SYSTEM alarm + Device Health tile on under-voltage/throttling.** Proposed,
    not yet built (see the note in CLAUDE.md's firmware section).

- **2026-07-29 (3rd)** — **Built: local Pi power/throttling alarm + HMI tile**
  (the open item from the correction above). Turns the signal that would have
  diagnosed the week-long "Nano hang" into something the panel says out loud.
  - `src/cloud-gateway/power-health.js` — pure, state-injected
    `derivePowerAlarm(health, prevState)` + `summarizePower()`. **Raise is
    immediate** (the `now` bits are already momentary; debouncing the raise
    would hide exactly the short brown-outs that wedge a USB device), **clear
    needs 3 consecutive good samples** so a supply hovering at the threshold
    can't flap the alarm, and an escalation WARNING→CRITICAL re-raises.
    Under-voltage = CRITICAL; throttling *without* under-voltage = WARNING
    (that can be thermal). A missing `vcgencmd` yields `ok: null` — **unknown,
    never a fabricated "healthy"** (the same 0-as-no-data discipline adopted
    across the ambient/InfluxDB fixes).
  - Placed in `src/cloud-gateway/` and exported from the **existing**
    `busductCloudGateway` global (alongside `collectPiHealth`, its only input)
    specifically so deployed panels need **no settings.js edit** — only a
    restart + flow re-import.
  - Flow: "power tick (30 s)" + "Pi Power Health" nodes
    (`d9b1ac57e0f10041/42`) on the Device Health tab, feeding the existing
    alarm link pair (renamed "Health Alarm (out)/(in)" — it now carries both
    blacklist and power alarms). Alarm Manager gained a `PI_POWER` section
    mirroring the blacklist one (`SYSTEM|PI|POWER`, ACK-able, emails on
    raise/clear); the `CONFIG_REMOVED` sweep already skips `category:"SYSTEM"`,
    so it won't auto-clear.
  - HMI: colour-coded banner on the Device Health dashboard, which keeps
    reporting *"under-voltage since boot"* after recovery — the forensic bit
    that catches an intermittent fault that has already passed.
  - 12 unit tests + an end-to-end simulation of the flow node (raise → no
    repeat → clear after 3 good). Full suite 474 pass.

- **2026-07-29 (4th)** — **User decision: KEEP the hardened Nano firmware.**
  With the real root cause known (Pi under-voltage), the 2026-07-22 firmware
  revision could have been reverted to the original sketch — both run fine on
  good power. Decision is to **keep the new code**, on the merits rather than
  because it fixed anything: the SleepyDog **watchdog** recovers from a wedge of
  any cause (a brown-out included, so it is *more* valuable now, not less), the
  `comm` validation stops a malformed job setting baud 0, the `if (Serial)`
  guards are correct regardless of host behaviour, and the 4 KB response buffer
  is simply the right size for a one-packet result. No functional change; the
  wire format was never touched.
  `firmware/Nano_IOT.ino`'s header comment was rewritten to lead with the
  correction — a prominent "READ BEFORE BLAMING THIS FILE" block stating that
  the fault was Pi under-voltage, that both builds work on good power, that the
  listed items are hardening rather than the fix, and that a future
  "stops responding" investigation must **check the power rail first**. The
  inline comment at `RESPONSE_BUFFER_SIZE` (previously "the key RAM fix") was
  corrected too. Rationale: the sketch is the artifact an engineer actually
  reads at 2 a.m.; leaving a confident-but-wrong root cause in its header is how
  the same misdiagnosis gets made twice.

- **2026-07-29 (5th)** — **Pi power banner added to the Diagnostics page**
  (user request). The alarm/tile built earlier lives on the Device Health tab,
  but "Live Parameter Data – Modbus" (`ui_template` `db41c2b5077e83fc`, group
  "Modbus Dashboard", tab **Diagnostics**) is the page an engineer already has
  open when something looks wrong — which is exactly when the power state
  matters. The UI-gate function that feeds it (`6e03c48901abfc87`) now attaches
  `msg.payload.power` from the same `global.busduct_power_health` the Device
  Health tile reads, and the template renders a colour-coded banner directly
  under its header (green OK / red FAULT / grey UNKNOWN, with the raw
  `vcgencmd` flags). No new node, no new state, no extra probe — one global,
  two views. The Device Health banner stays as well.

- **2026-07-29 (6th)** — **Blacklist status added to the Diagnostics page**
  (user request, alongside the power banner). Two surfaces on "Live Parameter
  Data – Modbus":
  - **Per-row "Device" column** — Active / **BLACKLISTED** / **PROBING** with the
    retry countdown, keyed by **unit address** so it lines up with the table's
    existing "Slave ID" column (the blacklist state itself is keyed by internal
    `slave_id`, which the operator never sees — the same identity mismatch fixed
    in the alarm text earlier today).
  - **Summary banner** — "all responding" or the blacklisted/probing counts,
    plus each affected device by its commissioned name and its ambient impact
    (`101 (AMBIENT_101): blacklisted — ambient for J01, J02`).
  Implementation note: this UI gate (`6e03c48901abfc87`) runs on **every Modbus
  data message**, so the applied-config read needed for unit_address/label is
  **cached in node context for 30 s** rather than hitting the cfg files at the
  poll rate; the blacklist state itself is a cheap global read and stays live.
  Verified by simulating the gate with sl21/unit 101 blacklisted: the ambient
  row renders `BLACKLISTED (retry 45s)` while the two joint rows stay `Active`.

- **2026-07-29 (live pass)** — **Diagnostics page power + device banners
  verified on the Pi.** "Live Parameter Data – Modbus" now renders
  `Pi Power: OK — power: OK [0x0]` and `Devices: all responding`, with the new
  per-row **Device** column showing Active for units 1, 101 and 2.
  Two things confirmed by the `[0x0]`: the probe is genuinely executing
  `vcgencmd` (a failed probe would render grey UNKNOWN, not green OK), and the
  under-voltage/throttling **since-boot** bits are clear — i.e. the Pi has not
  sagged once since it was re-powered, independently corroborating that the
  power-supply fix (not firmware) resolved the Nano "hang".

- **2026-07-29 (7th)** — **User decision: KEEP the legacy `Busbar` InfluxDB
  writer.** My earlier recommendation was to retire it (two data-integrity bugs
  in one day, both traceable to it being an untested parallel pipeline). That
  recommendation was **wrong about its status**: the `Busbar` measurement feeds
  the Grafana-backed **"BusbarTherMo™ — Main Dashboard (Zone Overview)"** —
  Zone Health Overview + System KPIs (No. of Zones, Max/Avg RoR, Max/Avg ΔT,
  TOTAL/LIVE/OFFLINE counts), embedded in the HMI as the operator's **Home**
  page. It is a live customer-facing surface, not a legacy leftover, so the two
  pipelines are not duplicates: `bt_kpi` (Historian tab) serves the Trends
  screen and long-horizon analysis; `Busbar` serves the main dashboard.
  **Consequence to act on:** because it is load-bearing, the point builder must
  stop being untested. It currently lives entirely inside the Node-RED function
  node `2978fd45db77d953`, which is exactly what CLAUDE.md's standing rule
  forbids ("Node-RED function nodes stay thin — real logic lives in
  unit-testable library modules under `/src`"). **Both** of today's bugs (the
  `i < n - 1` off-by-one and the hardcoded ambient register 0) would have been
  caught by a single unit test of a pure builder. Proposed follow-up: extract it
  to `/src` (e.g. `src/historian/legacy-busbar-points.js`) with tests, leaving a
  thin function node — not yet done, offered to the user.

- **2026-07-29 (8th)** — **Slice 11: BMS Integration flow tab built.** Nodes
  `b115ac57e0f100xx` on a new "BMS Integration" tab, all thin per the standing
  rule (logic stays in `src/integration`):
  - **"BMS server @boot"** builds the singleton with the production
    `jsmodbusServerFactory` and wires the BMS→alarm ACK bridge. The bridge is
    guarded by `svc._ackWired`: `getBmsService` returns a **module** singleton
    that survives a Deploy (settings.js `require()`s the library once at
    startup), so an unguarded `onAck` would stack a new handler on every deploy
    and ACK each alarm N times.
  - **Taps** are `link in` nodes appended to the existing Slice 4 link-outs
    (`KPI Stream - Joint`, `Alarm Events - Active`) — no change to the
    producers, same peer-adapter pattern as the Cloud Gateway tab.
  - **"BMS Refresh" (5 s)** ingests `busduct_blacklist_state`, recomputes the
    rollup/image and bumps the heartbeat.
  - **ACK expansion**: a BMS write to the ACK register becomes one
    `{action:'ACK', instanceId, user:'BMS'}` per matching active alarm — the
    exact shape the HMI's Active Alarms table sends, so a BMS-originated ACK
    takes the identical path and lands in the audit trail attributed to the BMS
    (workplan §11 "Done when", third bullet).
  - `jsmodbusServerFactory` is now re-exported from
    `src/integration/node-red/index.js` so the function node needn't
    `require()` a path (function nodes can't); `jsmodbus` is still required
    lazily inside the factory, so the import never hard-depends on the optional
    package.
  Verified end-to-end by driving the actual node source against a real
  ConfigStore + the migrated 21-slave production config with a fake server
  factory: 20 live joints, 658 registers, Tier-1 `panel_max_temp` = 615
  (61.5 °C ×10), `panel_max_deltaT` = 282, level 2, and the ACK bridge emitting
  the correct message. Remaining for Slice 11: the reference-gateway live
  validation (needs the Modbus→BACnet hardware). 474 tests pass.

- **2026-07-29 (9th)** — **`tools/apply-integration-config.js` added.** Gap in
  my own delivery: the Slice 11 runbook said "apply a `cfg/integration`
  document" but there was **no way to do it** — the domain has no dashboard
  screen (unlike cfg/alarms and cfg/modbus+joints) and `processRemoteConfig`
  routes only `alarms` / `modbus_joints` / `edge`, so the BMS service could
  never leave its "no cfg/integration applied" state on a real panel.
  A CLI is the right shape here: this is commissioning-time configuration set
  once when the BMS is wired, not day-to-day tuning — the same role
  `apply-migrated-config.js` plays for the bootstrap domains. Design points:
  - **Domain version is auto-bumped** past whatever is applied. I4 monotonicity
    is a correctness rule for the *system*, not a puzzle to hand to the
    commissioning engineer.
  - **Flag-only runs edit the applied doc in place** rather than silently
    reverting to the shipped example — otherwise `--port=1600` would quietly
    discard an earlier `--tier` choice.
  - **`point_map_version` can only rise.** A file carrying a stale value gets
    raised back with a warning, never regressing a map a gateway is already
    configured against (the append-only rule, enforced instead of trusted).
  - Refuses to run before the panel is commissioned, pointing at
    `apply-migrated-config.js`.
  9 tests (incl. the regression guard and the reject path). 483 pass.
  **Still not routed through the remote config channel** — a fleet-wide push
  would need `processRemoteConfig` to learn the `integration` domain; not done,
  and worth a design-chat decision since cfg/integration is arguably
  wiring-reality (R12-like maintenance gating) rather than a free-to-tune knob.

- **2026-07-29 (10th)** — **BMS register dump (`describe-image.js`) + HMI view.**
  "What is the Modbus TCP server actually sending?" cannot be answered from a
  raw register array: the ×10 scaling and the −32768 NO_DATA sentinel are
  exactly the things a human misreads (−32768 looks like −3276.8 °C). Commissioning
  a gateway means proving "address 8 really is panel_max_temp = 61.5 °C", so the
  dump renders address → block → point → raw → **engineering value**, names the
  enumerations (`2 (WARNING)`, `0 (OK)`, `2 (OFFLINE)`), explains the
  `worst_joint_index` sentinels (`-1 (none)` / `-2 (set, Tier 3 not exposed)`),
  and always lists the writable ACK register (which `buildImage` deliberately
  never writes, so it would otherwise look absent).
  - **`BmsService.snapshot()`** added for the view: recomputes the image
    **without** advancing the heartbeat or writing to the slave. A diagnostic
    read must not perturb the liveness signal a BMS depends on.
  - **Bug caught while building it:** `snapshot()` initially passed the live
    `this.latch` to `computeRollup`, which **mutates** it — so opening a
    read-only view could reassign the latched worst joint a gateway is reading.
    Fixed with `WorstJointLatch.clone()`; three tests now assert snapshot
    changes neither heartbeat, served registers, nor the latch.
  - Flow: "registers view (5s)" + "BMS Registers View" on the BMS tab feeding a
    collapsible **BMS Registers** group on the Device Health dashboard tab.
    Deliberately *not* cached in Node-RED context — a 658-entry image written to
    the localfilesystem context store every 5 s would be needless flash wear.
  Verified against the real migrated config: 154 rows, Tier-1 `panel_max_temp`
  615 → `61.5 °C`, zone z2 and joint J01 blocks correct. 497 tests pass.

- **2026-07-29 (11th)** — **BMS register table + status moved to the Diagnostics
  page** (user request: keep the diagnostics in one place, next to the Pi power
  and device banners). Two surfaces:
  - The **BMS Registers** ui_group was re-pointed from the Device Health tab to
    the **Diagnostics** tab (order 2, **collapsed** by default — 154 rows would
    otherwise bury the Live Parameter Data table). It keeps its own 5 s tick and
    `snapshot()` call, so it is independent of the Modbus message rate.
  - A compact **BMS status banner** was added to the Modbus page alongside the
    power/devices banners: serving vs image-only, port, tier, register count,
    heartbeat. Deliberately **O(1)** — it reads `svc.heartbeat`/`svc.map` only
    and never calls `describeImage()`, because that gate runs on **every Modbus
    data message** (~2/s) and walking 154 rows at that rate would be pure waste.
    The expensive dump stays on its own tick.
  This is the same split used for the blacklist data: cheap status in the
  per-message gate, expensive detail on a timer.

- **2026-07-29 (live)** — **cfg/integration applied on the Pi; BMS banner live.**
  `tools/apply-integration-config.js` worked end to end on the real panel and
  the Diagnostics page now shows the BMS status banner. That confirms the whole
  chain up to the socket: the CLI applied + audited the fourth config domain,
  `getBmsService` built the singleton from the applied doc, the register map
  generated from the live cfg/joints, and the 5 s refresh is bumping the
  heartbeat. **Not yet confirmed:** that a Modbus master can actually READ the
  socket — the banner reports the service's own view. `serving on port N` means
  a listener was bound (jsmodbus present); `image only` means the registers are
  computed but nothing is listening. Next check is a `modpoll`/`pymodbus` read
  from another host, then the reference gateway (workplan §11 "Done when").

- **2026-08-03** — **jsmodbus server factory was wrong; rewritten against the
  real API and now covered by a REAL SOCKET test.** Live bench read from the Pi
  itself (`tools/bms-read.js`) failed with **ECONNRESET** — the TCP connect
  succeeded, then the server tore the socket down. Root cause: the factory was
  written against an **assumed** jsmodbus API and shipped without ever opening a
  socket. jsmodbus's `ModbusServer` serves reads **itself out of a `holding`
  Buffer** (`ReadHoldingRegistersResponseBody.fromRequest(body, server.holding)`);
  the per-request handlers the first version registered
  (`client.on('readHoldingRegisters', …)`) only fire when that buffer is
  ABSENT. So the handler never ran, the request threw inside the library, and
  the connection was reset. Everything upstream was fine — config, map,
  heartbeat, the earlier fake-factory tests all passed, because the fake
  implemented the interface I had imagined rather than the one jsmodbus has.
  - **Rewrite:** the factory now owns a `holding` Buffer sized to the map, and
    `ModbusTcpSlave` mirrors its authoritative register array into it on every
    `setImage`/`setMap`/`start` (new `registers()`/`size()`/`_syncServer()`).
    Writes come back via `postWriteSingleRegister`/`postWriteMultipleRegisters`
    and are routed into `writeRegister`, which still enforces read-only
    addresses — and because jsmodbus has *already* mutated its buffer by then, a
    rejected write triggers a re-sync so a gateway can't leave a stray value
    visible until the next refresh. `netServer.on('error')` is handled so a bind
    failure (EADDRINUSE/EACCES) can't take Node-RED down.
  - **New `test/integration/jsmodbus-server-factory.test.js`** binds a real
    ephemeral port and drives a real Modbus client: read round trip, signed→
    unsigned on the wire, ACK write reaching the handler, read-only write
    reverted, and out-of-range behaviour. It **skips** when the optional
    dependency is absent so CI stays green without it.
  - **Verified jsmodbus behaviour worth documenting:** it applies **no bounds
    check on reads** — an out-of-range read returns an **empty response**, not
    exception 0x02 (the socket survives). Recorded in
    `docs/bms-register-map.md` so gateway integrators size their poll blocks to
    the map instead of probing.
  - **Lesson (the same one as the Nano firmware misdiagnosis):** a fake that
    implements an interface I invented proves only that my code is
    self-consistent. Anything crossing a real boundary — a socket, a device, a
    power rail — needs one genuine end-to-end test before it ships. 502 tests.

- **2026-08-03 (live)** — **Modbus TCP verified over a real socket on the Pi.**
  After the factory rewrite, `tools/bms-read.js` on the panel returns the whole
  Tier-1 block and the heartbeat advances (6 → 7, *"OK, the panel is alive"*),
  where the previous build died with ECONNRESET. Live values on the 2-joint
  bench panel: `system_health 0 (OK)`, `highest_alarm_level 0 (none)`,
  `worst_joint_index -1 (none)`, `panel_max_temp 319 → 31.9 °C`,
  `panel_max_ror 14 → 1.4 °C/hr`, `live_joint_count 2`, map extent 514 (tier 3,
  2 joints → 500 + 2×8 = 516, last written 513). This clears **two of Slice 11's
  three "Done when" criteria**: a plain Modbus master reads the map with no
  custom mapping, and a frozen panel is detectable via the heartbeat (the first
  run, taken before the refresh tick had fired, correctly reported
  **FROZEN** — the check works in both directions). Remaining: a BMS-originated
  ACK in the audit trail (testable now with `--ack=1`), and the reference
  Modbus→BACnet gateway.

- **2026-08-03 (live, ACK)** — **BMS-originated ACK verified on the Pi.** A
  Modbus write to the ACK register (`tools/bms-read.js --ack=1`) acknowledged
  the active alarms: the Cleared Alarm History rows show **Ack timestamps ~2 s
  after raise** (18:55:34 raised → 18:55:36 acked → 18:56:12 cleared), i.e. the
  write travelled Modbus → `decodeAck` → the expanded per-alarm
  `{action:'ACK', instanceId, user:'BMS'}` → the same Alarm Manager path the
  HMI's table uses. That is Slice 11's third "Done when" criterion.
  Same screen also confirms the 2026-07-29 alarm-wording fix in production:
  *"Slave 101 (AmbientT) blacklisted after 3 consecutive read failures; ambient
  reference for joint(s) J01, J02 - ΔT unavailable"* — commissioned identity and
  real impact, not `sl21`/`(none mapped)`.
  **Slice 11 now has 3 of 4 acceptance criteria met**; only the reference
  Modbus→BACnet gateway remains, and it needs the hardware.

- **2026-08-03** — **`tools/bms-read.js` gains a STANDALONE mode** so it runs
  from a second Pi / an engineer's laptop, not only on the panel. As shipped it
  exited early if `/var/busduct/cfg` held no applied config — it needed the
  panel's own cfg to build the register map, so on any other machine it died
  before opening the socket even though `--host` was supported.
  The fix leans on a property the map already guarantees: **Tier 1 and the
  control block are at FIXED addresses** (the append-only contract — their
  layout is a constant in `register-map.js`, not derived from config), so the
  summary block decodes with no panel config at all. Absent a config the tool
  synthesises a tier-1 map, says so, and defaults port 1502/unit 1; Tier 2/3
  addresses still read but print as `(raw)` rows because only their **labels**
  (zone/joint ids) need `cfg/joints`. Copying the panel's two cfg files and
  passing `--root=` restores full labelling.
  Verified against a real server on the migrated 21-slave config: standalone
  decoded all 12 Tier-1 points (`panel_max_temp 615 → 61.5 °C`,
  `live_joint_count 20`) with the heartbeat advancing 1 → 4, and a Tier-3 read
  printed raw standalone but fully labelled (`[J01] temp 61.5 °C`) with a config
  copy. 502 tests pass.

- **2026-08-03** — **COMM watchdog alarm could never clear (live: stuck 85 min
  with Modbus running).** `SYSTEM|MODULE|COMM_FAILURE` raised at 15:58 and was
  still ACTIVE at 17:23 despite healthy communication. Root cause in the
  **trigger node** `9c6f2b1a18f8c113` (BusbarTherMo tab), which implements the
  60 s silence watchdog: its `op2` correctly sends `{"commTimeout":true}` after
  the timeout, but its **`op1` — what it emits when a message arrives and the
  trigger leaves idle, i.e. when data RESUMES — was an empty string**
  (`op1type:"str"`, `op1:""`). The Alarm Manager clears this alarm only on
  `msg.payload.commTimeout === false`, so nothing ever told it comms were back:
  the alarm was raise-only and stuck until a Node-RED restart. The clear branch
  itself was correct all along and simply never fired.
  - **Fix 1:** trigger `op1` = `{"commTimeout":false}` (`op1type:"json"`). The
    trigger's state machine gives exactly the right semantics: idle → first
    message sends op1 (**clear**), further messages extend the 60 s timer
    (`extend:true`), timeout sends op2 (**raise**) and returns to idle — so the
    next message after an outage clears the alarm. Node renamed to
    "COMM watchdog (60s silence -> alarm, data resume -> clear)" since an
    unnamed trigger gave no hint it was the watchdog.
  - **Fix 2 (robustness):** the `commTimeout === false` branch did **not
    return** — it fell through into the process-alarm evaluation with a payload
    carrying no sensor reading. It now returns `buildOutputs` whether or not an
    alarm was present.
  Verified by driving the real Alarm Manager source: raise → hold → clear on
  resume (with a cleared-alarm message emitted) → idempotent on repeat. 502
  tests pass.

## 2026-08-08 — Multi-bus commissioning UI (Slice 10 §B): defining the second RS-485 segment

**User report:** *"Although we have created two 485 buses but in modbus settings
and comm settings there is no option to define other bus."* Correct — the
schema has allowed up to 4 buses since Slice 2 and the `/src` core has been
bus-aware since 2026-07-25, but the Modbus Settings dashboard still rendered a
single fixed bus form. There was no path from "the code supports it" to "the
commissioning engineer can enter it."

**Wiring decision (user, this session): two Nanos, one per segment.** The
firmware drives exactly one RS-485 port (`Serial1`), so a second segment is a
second Nano on its own serial port with its own baud/timeout and its own
compiled job. That is what the UI now models.

### Built
- **RS-485 Buses table** replaces the single bus form: one row per segment
  (port/baud/parity/stop bits/timeout/retries/inter-frame), with ADD BUS and a
  per-row DEL. Bus ids are *allocated* (`bus1`, `bus2`, …), never typed — a
  typo'd id would orphan every slave pointing at it.
- **Bus column on every slave channel row** (a dropdown over the defined
  buses), carried through load → draft → apply → the applied document.
- Handler state is now `{slaves, buses}`; `bus` (= `buses[0]`) is still echoed
  so a pre-multi-bus client, a persisted single-bus draft, and the existing
  tests all keep working. `normaliseBuses` folds a legacy `{bus}` into the
  array as `bus1`.
- **Apply guards** (friendly, before the validator): two buses may not share a
  serial port ("each RS-485 segment needs its own Nano on its own port"); a bus
  can't be deleted while sensors sit on it (named, up to 3); a slave may not
  reference an undefined bus; all channels of one physical unit must be on one
  bus.
- **Resend is per bus.** `applyModbusSettings` returns `resendBusIds` —
  `buses.filter(b => !nanoJobsEqual(current, newDoc, b.bus_id))` — and the
  function node emits one `{payload:'apply', busId}` message per *changed*
  segment. This matters because the firmware re-inits its Modbus timeout on
  every job update: a bus2-only edit must not briefly disrupt bus1's live
  polling. (Same reasoning as the content-aware `resendNeeded` fix from Slice 3,
  extended along the bus axis.)
- **`Send Nano Job` is segment-scoped**: it reads `env BUSDUCT_BUS_ID`
  (default `bus1`), ignores a resend addressed to another segment, and passes
  its own id to `buildNanoJobMessage`. Cloning the node for bus2 is now an env
  var, not a code edit.

### The one deliberately-strict rule: unit addresses unique panel-wide
Modbus only requires a unit address to be unique *within a bus*, and
`compileNanoJob`/`unitToSlaveId` are already per-bus. The dashboard is
nonetheless stricter: **the same unit address may not appear on two buses**,
rejected by name at apply.

Reason: the surviving legacy decode pipeline (~40 function nodes on
`modbusMaster_V2`, plus the alert/SMS nodes) stores every reading in
`sensorData[<unit_address>][…]`, keyed by the address alone with no notion of a
segment. Two segments both using unit 5 would silently overwrite each other —
the worst possible failure mode, a plausible wrong number rather than an error.
Making that pipeline bus-aware is a large, risky change to the live data path
for no operational gain: 247 addresses across ~110 devices means the constraint
costs nothing. Recorded here so a future reader doesn't "fix" the rule as
over-restrictive without also fixing the decode side.

The same reasoning sets the **legacy bridge scope**: `comm` globals and
`paraRaw` (the legacy read-job builder's input, used by the serial-silence
recovery path) now cover **bus1 only** — asking bus1's Nano for an address that
lives on the other segment would just time out — while `SlaveIDList` /
`parameterName{i}` keep every channel on every bus, because the decode side has
to handle a response from either Nano. That asymmetry is only safe *because*
addresses are unique panel-wide.

### Also fixed
`buildNanoJobMessage(store, {busId})` now treats `busId` as a **preference on a
single-bus panel**: with exactly one bus there is exactly one Nano, so the sole
bus compiles even if the applied document names it something other than the
`bus1` the flow carries by default. Otherwise renaming the only bus would have
silently stopped the panel polling — a config edit with no error and no data.

### Status
13 new unit tests (36 in the Modbus Settings suite, 515 repo-wide, all green)
plus `flows-integrity`. **Not yet live** — the dashboard change needs the usual
Pi re-test (git pull → restart Node-RED → re-import flow), and the second
physical pipeline (2nd serial pair, cloned Send Nano Job with
`BUSDUCT_BUS_ID=bus2`, bus-tagged response tap, per-bus recovery) remains the
runbook in `docs/slice10-design-proposals.md` §B, pending a second Nano.

## 2026-08-08 — Fix: Modbus Settings action buttons clipped after the Bus column landed

**User report:** *"Delete button not appearing in action column of slave channel
table. Also table's action column is partially visible on HMI page."*

Both symptoms, one cause. The slave table went from 10 to 11 columns when the
Bus dropdown was added, but it was still `table-layout:fixed; width:100%` with
no per-column widths — so every column, Actions included, was squeezed
proportionally. Two compounding details turned "narrow" into "invisible":

1. `.mbs-table td { overflow:hidden }` (there to ellipsize long labels) also
   clipped the button row, so DEL simply vanished rather than wrapping.
2. `.mbs-slaves td:last-child { display:flex }` — a `display:flex` on a `<td>`
   takes the cell **out of the table's column-sizing algorithm**, so it could
   not claim a width of its own even once widths were specified.

**Fix:** explicit `<colgroup>` widths on both tables, a `min-width` equal to
their sum so a narrow screen scrolls the panel (`.mbs-panel` is already
`overflow-x:auto`) instead of crushing the columns, the button row moved into a
flex `<div>` *inside* a normal table cell, and slightly tighter button padding
(12px→11px font, 6px→5px padding).

**Verified by rendering, not by reading.** The template was extracted, its
`ng-repeat`/`ng-if` expanded into static rows (including one mid-edit row so the
SAVE variant is exercised), and screenshotted in headless Chromium at the
dashboard's real widths. At 900px the reproduction showed exactly the reported
clipping — EDIT plus a half-visible SAVE, no +CH or DEL — and the fixed version
shows all three buttons on every row in both variants. At 720px the panel
scrolls with columns intact. The group is 23 dashboard units (~1236px), so the
default HMI has room to spare. Preview harness is throwaway (scratchpad); it is
worth rebuilding for any future `ui_template` layout change, since nothing in
the repo's test suite exercises client-side Angular markup.

## 2026-08-08 — Fix: Modbus Settings widget blank + ADD BUS dead; Zone table DELETE clipped

**User report (live on the Pi):** *"Now add bus button not working. Existing
configuration not visible. Zone configuration action column delete button not
visible."*

### 1 & 2 — blank table and dead ADD BUS: one regression, one latent fragility

**The regression.** When the multi-bus table landed, the per-button
`ng-click="send({payload:{action:'add', slaves:msg.payload.slaves, ...}})"`
inline expressions were refactored into a single `scope.act(action, index)`
helper (so every action would ship the full `{slaves, buses}` state). That moved
the property access **from an Angular expression into real JavaScript**, and the
two are not equivalent:

- Angular expressions are *forgiving*: `msg.payload.slaves` on an undefined
  `msg` quietly evaluates to `undefined`.
- Real JS **throws** `TypeError` on the same access, and an exception inside an
  `ng-click` handler means the click does nothing at all.

So on a widget that had not yet received a message, every button was dead —
including ADD BUS. It also destroyed the accidental recovery path the old markup
had: previously a blank table could be repopulated just by clicking any button,
because the server ignored the undefined state and answered from the applied
config.

**The fragility it exposed.** This widget's only load trigger is an inject with
`once: true, onceDelay: 0.5`. Re-deploying while the dashboard is open
re-creates the `ui_template` with an empty scope; if it registers after that
one-shot inject has already fired, nothing is ever replayed and the table stays
blank forever. That was survivable only because of the forgiving-expression
accident above.

**Fix (both layers):**
- `scope.act` reads `(scope.msg && scope.msg.payload) || {}` — never throws,
  and an action from an empty widget still reaches the server, which answers
  from the draft/applied config.
- The widget **requests its own load on init** (`send({payload:{}})` after
  700 ms, skipped if a message already arrived), so it no longer depends on
  winning a race with a deploy-time inject.
- An explicit **RELOAD** button plus a "No configuration loaded yet" hint when
  the bus list is empty — a blank table should say which failure it is rather
  than looking like an empty config.

**Lesson worth keeping:** refactoring an inline Angular expression into a JS
function silently changes its null-safety semantics. Any `ui_template` handler
that touches `scope.msg` must assume `scope.msg` is undefined.

### 3 — Zone Configuration DELETE clipped

`ZoneMasterUI` still carried the original minimal stylesheet: `width:100%`, no
`table-layout`, no column widths, and no `overflow-x` on the panel. The two
`width:100%` inputs took the space and the Actions column was squeezed until
DELETE (a longer word than the DEL used elsewhere) was cut off by the dashboard
card. `JointMasterUI` had already been given an explicit 220px Actions column
and `overflow-x:auto`; this table had simply never had the same treatment.
Fixed the same way: `table-layout:fixed`, explicit 170/220/170 column widths, a
`min-width` so a narrow screen scrolls the panel instead of crushing columns,
and `white-space:nowrap` on the actions cell.

**Verified by rendering** both templates together in headless Chromium at the
dashboard's real width (the scratchpad harness from the previous entry, extended
to expand `ng-if` into both the EDIT and SAVE row variants). All buttons on both
tables are fully visible.

## 2026-08-08 — Blank Modbus Settings persisted: the running flow was never re-imported

**User:** *"Still not working"* — with a terminal photo showing
`git pull` → `Updating 7a9f2aa..be03917`, `2 files changed` including
`flows/flows_BBT.json`, then `sudo systemctl restart nodered`, then a second
pull reporting *Already up to date*.

**Diagnosis from the dashboard photo, not from the description:** the page had
the multi-bus headers and the ADD BUS button, but **no RELOAD button** — and
RELOAD only exists in `be03917`, the commit they had just pulled. So the running
flow was an earlier import. `git pull` updates the repo working copy; Node-RED
runs from its own `~/.node-red/flows_<hostname>.json`, so pulling a flow change
and restarting does nothing visible until the file is re-imported in the editor.
The two halves update by different mechanisms and both are needed:

| changed | updates via |
|---|---|
| `src/**` | pull + **restart** (functionGlobalContext is `require()`d once at startup) |
| `flows/flows_BBT.json` | **re-import** in the editor + Deploy |

`docs/pi-deployment.md` said "re-import ... if it changed too" as a trailing
aside; that was too easy to skip past. Rewritten as a hard rule with the reason,
the `git show --stat HEAD` check, the table above, and the tell-tale symptom
(*some* of a change visible but not all — new headers present, new button
absent) that identifies this exact mistake.

### Two hardening changes so this is never a guessing game again

1. **`tools/modbus-settings-selftest.js`** — runs the exact handler the
   dashboard calls, against the panel's real applied config, and prints either
   the rows it would hand the table ("the server side is HEALTHY → this is a
   delivery problem, re-import the flow") or the specific store failure
   (unreadable root vs never-applied config). This separates the two
   indistinguishable causes of a blank table without a second Pi trip.
2. **`ModbusSettingsBackEndNode` no longer fails silently.** It now guards
   `global.get('busductConfigService')` being absent (the classic
   restart-vs-Deploy mistake) and wraps the handler in try/catch, reporting via
   `node.error` *and* returning an `{error}` payload the widget alerts. An
   exception used to produce no output message at all — indistinguishable, in
   the browser, from an empty configuration.

**Note on my own diagnosis:** I had attributed the blank table to the
`scope.act` null-safety regression plus the once-inject race. Those were real
bugs and are fixed, but they were not what the user was still looking at — that
was simply un-imported code. Worth remembering that "still not working" after a
fix is pushed most often means the fix is not running yet, and the cheapest
first check is whether the artifact on the device matches the commit.

## 2026-08-08 — Live-verified: multi-bus Modbus Settings dashboard loads on the Pi

User confirms the Modbus Settings page is working after re-importing
`flows/flows_BBT.json`. This closes the three live reports from today: the
clipped action buttons, the blank table / dead ADD BUS, and the clipped Zone
Configuration DELETE. Root causes and fixes are in the three preceding entries.

**What this pass covers:** the table loads the applied configuration and renders
both the RS-485 Buses and Slave Channels tables with all their action buttons.

**What it does NOT yet cover** — still to live-verify on the panel:
- Actually commissioning a second segment end to end: ADD BUS → set its port and
  baud → move a sensor's Bus column to it → APPLY, and confirm the apply guards
  fire (duplicate serial port, duplicate unit address across buses, deleting a
  bus that still carries sensors).
- Per-bus resend: confirm a bus2-only edit does not disturb bus1's live polling.
- The second physical pipeline is still unbuilt in the flow (runbook in
  `docs/slice10-design-proposals.md` §B) and needs a second Nano, so a bus2
  entered today is commissioned but not polled.

## 2026-08-08 — AWS-side impact review of the multi-bus change (one real gap found and fixed)

**User question:** does the multi-bus settings work affect anything on the AWS
side? Audited rather than answered from memory.

**No schema or cloud change.** `git diff fa9ec47..HEAD -- config/schemas
src/cloud-gateway src/adapters docs/aws` was empty before this entry. The
modbus/joints JSON Schema has allowed `buses` (array, maxItems 4) and
`slaves[].bus_id` since Slice 2 — the dashboard was the only thing that could
not express a second segment. So:

- **Telemetry payloads unchanged** — the batcher aggregates per joint; a joint
  carries no bus identity and the compact positional encoding is index-by-joint
  too.
- **Alarm payloads unchanged** — instance ids are `PROCESS|<joint>|…` /
  `SYSTEM|<slave>|…`, neither of which encodes a bus.
- **Heartbeat unchanged** — it reports applied config *versions*, not content.
- **Topics, IoT policy, Basic Ingest mapping, provisioning template
  unchanged**, so no policy version to push and nothing to reconfigure in the
  console.
- **Cert rotation channel untouched.**
- Cloud-agnostic rule intact: no adapter file was involved.

**The one real gap — remote resend was not bus-aware.**
`processRemoteConfig` computed `resendNeeded: !nanoJobsEqual(before, doc)` with
no `busId`. On a *multi-bus* document `compileNanoJob` errors with
`specify {busId}`, `nanoJobsEqual` returns false, and `!false` is true — so
**every** accepted remote modbus push, including a label-only one, would have
resent the Nano job on the (single, bus1) pipeline. That discards exactly the
content-aware behaviour the Slice 3 fix introduced, and a resend is not free:
the firmware re-inits `Serial1`/the Modbus timeout on every job update, briefly
disrupting live polling. Single-bus panels were unaffected (a one-bus doc
compiles fine with no `busId`), which is why nothing showed up in the live
tests.

Fixed to mirror the local apply: `resendBusIds` = the buses whose compiled job
actually changed, and the drain emits one `{payload:'remote-apply', busId}` per
changed segment. Covered by a new test that seeds a two-segment panel remotely,
changes only bus2's timeout (expects `['bus2']`), then makes a label-only change
(expects `[]` — the case that was silently broken). The existing end-to-end
loopback test was updated to the new per-bus message shape.

**Also verified, no change needed:** the remote drain already clears
`modbus_settings_draft`, so after a cloud push the Modbus Settings dashboard
reloads from the applied document and shows the new segment rather than a stale
draft.

`docs/aws/README.md` Part E now documents the multi-bus case for whoever pushes
config from the console: same envelope and acks, per-segment resend, and the
panel-wide unit-address uniqueness rule that a cloud push is also held to.

## 2026-08-08 — Panel acceptance drill for the multi-bus guards

To test the multi-bus apply guards on the real panel without a second Nano and
without risking the live configuration, added **`tools/multibus-guard-drill.js`**
plus a manual UI checklist in `docs/slice10-design-proposals.md` §B.

The script reads the panel's applied `cfg/modbus+joints` **read-only**, rebuilds
it in a temp directory, and exercises every guard there. Safe to run on a panel
that is monitoring. Design points worth keeping:

- **It prints each rejection against the panel's real slave names**, not a
  fixture's. A guard is only worth having if a commissioning engineer can act on
  its wording; "Bus bus2 still carries 1 sensor(s) (AMBIENT_101)" is checkable
  in a way that a green tick is not.
- **A rejected apply must not bump the config version** — asserted, not assumed.
  A guard that rejects but has already written is worse than no guard.
- **It adapts to what the panel already has.** The first cut hardcoded `bus2`
  and reported a false FAIL against a store that was already two-segment (it had
  created `bus3`). Fixed to capture the id `add_bus` actually allocated and use
  it throughout. Caught only because the dry run was pointed at a mutated store
  — worth remembering that a self-test which assumes the starting state is
  itself a source of false failures.

The UI half stays manual and is written out as a table, because the script
drives the handler directly and therefore says nothing about whether the
dashboard sends the right thing — the `scope.act` regression earlier today was
exactly that class of bug and no handler-level test could have caught it.

**Safety note recorded in the doc:** only the "apply an empty bus2" step commits;
every guard step ends in rejection, so the panel keeps polling. Moving a live
sensor onto bus2 is called out as the thing NOT to do on a production panel —
with no second Nano that sensor is commissioned but unpolled, its joint goes
dark and blacklists, and moving the *ambient* unit costs every joint its ΔT. The
guards block the common form (repeated unit address) but not a genuinely unused
address, so this is a documented human caution rather than an enforced rule.

## 2026-08-08 — Multi-bus apply guards LIVE-VERIFIED on the panel (+ a config/reality mismatch found)

`node tools/multibus-guard-drill.js` on the real Pi: **ALL GUARDS PASS
(8 passed, 0 failed)**, against a read-only copy of the live
`cfg/modbus+joints`. Every guard rejected with an intelligible message naming
the panel's own devices, no rejection bumped the config version, and the
per-bus resend behaved (`label-only -> []`, `bus3-only change -> ["bus3"]`).
The guard half of the multi-bus commissioning work is done.

### Finding: bus1's configured serial port does not match the live wiring

The drill's header reported the live panel as:

```
Panel: 3 unit(s), 2 joint(s), buses: bus1@/dev/ttyUSB0, bus2@/dev/ttyACM1
```

Two things worth recording:

1. **3 units / 2 joints is correct** for this bench panel (J01, J02 + the
   ambient at unit 101) — it matches the live BMS read of `live_joint_count 2`
   on 2026-08-03. The 21-slave figure quoted elsewhere is the *migrated* config
   used for fixture-based verification, not what is applied here.

2. **`bus1.port` is `/dev/ttyUSB0`, but the flow's `serial-port` config node —
   the one the live `serial in`/`serial out` pair actually uses — is
   `/dev/ttyACM0` @115200.** So the applied configuration describes a port the
   panel does not use.

   **Impact today: none functionally.** Nothing opens a serial device from
   `cfg/modbus`; the path lives in the Node-RED `serial-port` config node.
   `bus.port` is used for R8 validation (present/non-empty for an RTU bus), the
   apply-time "two buses on one port" guard, the audit line, and the legacy
   `port` global. All of those are satisfied by *any* non-empty string, which is
   exactly why a wrong value has gone unnoticed.

   **Impact when the second Nano arrives: real.** The whole two-segment scheme
   keys a segment to its port — §B step 2 says "point the new serial pair at the
   bus2 port", and the duplicate-port guard is only meaningful if the values
   describe reality. A panel where bus1 claims `/dev/ttyUSB0` while its Nano is
   on `/dev/ttyACM0` would let someone commission bus2 on `/dev/ttyACM0` with no
   complaint from the guard — pointing the second Nano's pipeline at the first
   Nano's port.

   Left for the user to correct in the dashboard (edit bus1's Port to
   `/dev/ttyACM0` and APPLY — a port-only change compiles the same Nano job, so
   `nanoJobsEqual` reports no change and it will **not** resend or disturb
   polling). Flagged rather than auto-fixed: only the person at the panel can
   confirm which device node the Nano actually enumerates as.

Also noted while checking: a second `serial-port` config node (`/dev/ttyUSB2`
@115200) exists in the flow with no `serial in`/`serial out` referencing it —
dead configuration, harmless, worth removing on the next flow tidy-up.

### Still outstanding
The dashboard half of the acceptance drill (clicking ADD BUS / duplicate port /
DEL through the UI) — the drill exercises the handler directly and cannot tell
whether the widget sends the right thing. The applied config already containing
`bus2@/dev/ttyACM1` suggests ADD BUS + APPLY has been through the UI at least
once, but that was not observed here.

**Confirmed at the panel (2026-08-08):** `ls /dev/ttyACM*` returns only
`/dev/ttyACM0`. So there is exactly one Nano, on the port the flow's
`serial-port` config node already uses, and `bus1.port = /dev/ttyUSB0` in the
applied config is simply wrong — it should read `/dev/ttyACM0`. The `bus2`
entry left in the applied config points at `/dev/ttyACM1`, which does not
exist; harmless while it carries no sensors (its resend is addressed to `bus2`
and the sole `Send Nano Job`, env `BUSDUCT_BUS_ID` = `bus1`, drops it), but it
should be deleted until a second Nano is physically present, on the same
principle as the port fix: the configuration must describe reality, because
that is the only thing the duplicate-port guard has to work with.

## 2026-08-08 — UI guard steps pass live; bus DEL affordance changed from hidden to disabled

**User:** bus1's port corrected to `/dev/ttyACM0`, **all UI guard steps passed**.
Plus an observation: *"Del button is not visible when only one bus is
configured. When bus 2 is added del button is visible for both rows."*

That behaviour was intentional — the bus DEL button carried
`ng-if="buses.length > 1"`. **The defect was in my acceptance checklist**, which
listed "press DEL on bus1 while it is the only bus → expect *The panel needs at
least one RS-485 bus*" as a step. That step is impossible to perform: the UI
removes the button precisely so the attempt can't be made. Checklist corrected.

**Changed anyway: hidden → disabled.** The person who knows this system best
reported the disappearance as a suspected defect, which is the whole argument.
A control that vanishes teaches nothing and looks broken; a greyed-out button
with a tooltip (*"The panel needs at least one RS-485 bus"*) explains the rule
at the moment it's relevant. `ng-if` became `ng-disabled` plus a conditional
`title`, with a `.mbs-btn[disabled]` style, and `confirmDeleteBus` returns early
on a single bus so no confirm dialog can appear even if the disabled state were
somehow bypassed.

**The server-side guard is unchanged and stays.** This is affordance, not
enforcement — the remote-config path and any scripted client never see the
button, and `tools/multibus-guard-drill.js` covers the rule ("delete the last
remaining bus"). Verified by rendering the single-bus state in headless
Chromium: DEL present and greyed, visibly distinct from the slave row's live
red DEL.

**Status: the multi-bus commissioning UI is now live-verified end to end** —
guards via the drill (8/8 on the panel), the dashboard by click-through, and
bus1's port now matches the one Nano on `/dev/ttyACM0`. What remains for
two-segment operation is purely physical: a second Nano and the flow wiring in
§B's runbook.

## 2026-08-10 — Second Nano connected: bus2 pipeline wired in modbusMaster_V2

The second Nano is physically on the edge, so §B's flow-wiring runbook was
implemented. Ten new nodes on `modbusMaster_V2`, plus two edits to existing
nodes.

### What was built
- `serial-port` config `/dev/ttyACM1` @115200, framing copied exactly from
  bus1's config node.
- `bus2 Nano in` → **`Tag Bus2`** → the **same shared** decode / UI / Data-Out
  chain bus1 uses. Sharing rather than duplicating ~40 decode nodes is the whole
  payoff of forcing unit addresses unique panel-wide (2026-08-08 entry): one
  chain can serve both Nanos because `sensorData` is keyed by address.
- A second `Send Nano Job (bus2)` → `json` → `serial out`, fed by the shared
  `Resend Nano Job (in)` link and the boot inject alongside bus1's.
- **A separate 30 s serial-silence watchdog per segment**, recovering via each
  segment's own compiled job.

### Three things the implementation had to get right that the runbook had wrong

1. **The bus id cannot be an env var.** The runbook said to clone `Send Nano Job`
   and set `BUSDUCT_BUS_ID=bus2` "in the clone's env tab". Function nodes have
   **no per-node environment** in Node-RED — `env.get()` resolves from the
   enclosing *group*, then the *tab*, then process env — and both nodes sit on
   the same tab, so the value could never differ between them. Following the
   runbook literally would have given both segments the identity `bus1` and sent
   bus2's Nano bus1's read list: a silent, plausible-looking failure. Each node
   now carries `const MY_BUS = '…'` as a literal, and the new wiring test
   rejects reintroducing the env lookup.

2. **The tag must be a top-level `msg` property, not `msg.payload.bus_id`.** The
   runbook said `processReadResult` reads `payload.bus_id`, which it does — but
   the only place that *knows* which wire a frame arrived on is the serial edge,
   where the payload is still a raw string, so `msg.payload.bus_id = …` is
   impossible there. Tagging after the `json` node instead would have meant
   duplicating the json node and its four-way fan-out for bus2. Resolved by
   stamping `msg.bus_id` at the edge (the `json` node rewrites only `payload`,
   leaving other msg properties intact) and having the **Blacklist Engine** pass
   it through as `ctx.busId` — a one-line change to an existing node.

3. **The watchdog had to be duplicated, not shared.** bus1's serial-in feeds a
   30 s `trigger` with `extend: true`. Wiring bus2's frames into the same
   trigger would have let bus2 traffic keep a *dead* bus1 looking alive — the
   exact failure the watchdog exists to catch. bus2 got its own, and it resends
   bus2's compiled job rather than the legacy `paraRaw` read-job builder, which
   is bus1-only by design.

### `test/two-segment-flow-wiring.test.js` (6 tests)
The flow is hand-edited JSON, hand-imported into Node-RED, and a half-wired
segment does not fail loudly — it just stops polling half the panel. The suite
pins the properties that make two Nanos safe side by side: one `Send Nano Job`
per segment naming its bus as a literal (and *not* from env), each dropping
another segment's resend, every resend source reaching both, distinct serial
ports, bus2 tagged before the shared chain with the engine consuming the tag,
and separate watchdogs.

522 tests pass. (`node_modules` had been wiped by a container recycle — restored
with `npm install`; note `npm ci` is shadowed here by the package's own `ci`
script.)

### Still outstanding
1. Commission bus2's sensors (Modbus Settings → set each sensor's Bus column).
   Until then bus2's Nano is polled with an empty read list.
2. The Device Health blacklist resend is untagged, so it reaches both segments —
   harmless (each recompiles its own job) but it briefly re-inits the other
   segment's Modbus timeout. Should carry the `busId` of the slave that changed.
3. The RECOVERY CONTROLLER's `uhubctl` USB power-cycle is still one port. bus2
   needs its own, so a wedged bus2 Nano is power-cycled without dropping bus1 —
   panel-side, the port numbers have to be read off the hardware.

**Not yet live-verified.** Needs re-import + Deploy, then the bench check from
§B: pull bus2's link and confirm only bus2 slaves go OFFLINE/blacklisted while
bus1 keeps polling, then restore and confirm bus2 recovers on its own.

## 2026-08-10 — Alarm generation for bus2, and two findings from the first drill

**User:** *"We have connected second nano for bus2 and tested as per flow
wiring run through and getting data. Can do complete wiring alarm generation
for bus2"* — the transport landed in the previous entry; this closes the
alarm half, including its outstanding items 2 and 3.

Data arriving is not the same as a monitored segment. Most of what decides an
alarm was per-panel state that looks correct right up until a whole segment
dies.

**ΔT/RoR needed nothing**, and that is the payoff from the shared-chain
decision: ProcessLogic is keyed by unit address, unique panel-wide, so bus2's
joints were already getting KPIs and process alarms the moment its frames
reached the shared `Data Out`.

**The COMM watchdog was actively broken by sharing.** `Tag Bus2` fed bus2's
raw frames into bus1's `Data Out`, which is what feeds *the* COMM watchdog.
That watchdog is satisfied while **either** Nano is talking — so a live bus2
masked a dead bus1 and vice versa, and after the transport commit *neither*
segment's total failure could raise a COMM alarm at all. The previous entry's
own test asserted "separate watchdogs" for the serial-silence trigger and was
right to; the COMM watchdog is a second, different shared watchdog that the
same reasoning applies to. bus2 now has its own, emitting
`{commTimeout, busId:'bus2'}`, and the Alarm Manager derives the key from it.
bus1's key stays byte-identical (`SYSTEM|MODULE|COMM_FAILURE`) so its history
and ACK state are continuous.

**Per-bus blacklist resend and per-bus USB recovery** were items 2 and 3 on
the previous entry's outstanding list, and are now done. Making recovery
per-bus turned one state machine into a loop over segments with independent
retry ladders — real logic, so it moved to `src/config-service/bus-recovery.js`
(`planRecovery`, pure and timing-injected) and the function node became
wiring. bus2's hub port comes from `BUSDUCT_UHUBCTL_BUS2` rather than being
guessed: it is site wiring. It reaches a root shell by string concatenation
(that is how Node-RED's `addpay` works), so it is pattern-validated first — a
typo in an env file must not become a command.

### Two findings from the first panel drill

**"When bus was disconnected its sensor status in debug was showing
connected."** `global.Status[addr]` is written *only* when a frame for that
device is decoded, and nothing expired it. A device that stops being polled at
all — blacklisted, or its whole segment down — keeps showing its last good
value forever, so a dead segment renders as an all-green panel. Writes are now
stamped and entries older than 60 s read **"No Data"**, styled as a fault. 60 s
is comfortably longer than any configured poll interval, so a live device never
flickers.

Worth stating what this does *not* explain: this panel's transmitters can keep
answering Modbus with a fresh, in-band, status-OK `0.0 °C` for **~20 minutes**
after being disconnected (found 2026-07-28, and the reason the ambient resolver
has a zero sentinel). If that is what happened, the status was *correct* and
nothing would blacklist for 20 minutes either. The Data column tells them
apart: near-zero values mean the Nano really was reporting OK.

**"After connecting bus connection could not resume."** The silence watchdog
was a `trigger` node. A trigger fires once and then needs an input message to
re-arm — and its input is the very frame stream that has gone quiet. bus2 got
exactly one resend attempt; if the Nano missed it (still booting its USB CDC,
or re-enumerated) it was never handed a job again. Replaced with a liveness
stamp plus a periodic check that retries every 30 s for as long as the segment
is silent. Not confirmed as the cause — the other strong candidate is USB
re-enumeration handing the Nano a different `ttyACM*`, which needs `dmesg` to
settle — but it is a defect on its own terms.

### On the duplicate implementation

This branch originally carried its own complete bus2 transport pipeline, built
before the previous entry's commit existed on the default branch. Merging both
would have put two `serial in` nodes on `/dev/ttyACM1` fighting for the port.
Rebased onto the default branch and the duplicate transport dropped: the
shipping wiring is the one already deployed and drilled on the panel, and this
change is now purely the alarm layer on top of it. The two test files split the
same way — `two-segment-flow-wiring.test.js` owns transport,
`flows-bus2-alarms.test.js` owns alarms. 545 tests pass.

## 2026-08-10 — Alarm layer deployed to the panel; no regression

**User:** *"It worked on pi. Checked alarms and dashboard no abnormalities found."*

This is the regression baseline, and it is worth separating from the drill.
The alarm layer edits three things that are shared with bus1 and would fail
loudly if they were wrong: the **Alarm Manager** (COMM key derivation), the
**RECOVERY CONTROLLER** (rewritten thin over `planRecovery`), and the legacy
**decode sink** feeding `global.Status`. A mistake in any of them shows up
within a minute as spurious alarms, a dead recovery ladder, or a Diag table
reading "No Data" for healthy devices. None appeared, which is the evidence
that:

- bus1's COMM alarm key is genuinely unchanged (no new/duplicate SYSTEM alarm).
- The 60 s status-staleness threshold is comfortably longer than this panel's
  real poll interval — a live device does not flicker to "No Data".
- `planRecovery` loaded from `functionGlobalContext` (a missing library would
  have posted `node.error` on the first 5 s tick).

**Getting there took a git detour worth recording.** The Pi was checked out on
the *default* branch but its content was the old base plus two commits pulled
from this branch before it was rebased — so `git pull` reported divergent
branches and refused. It had never received the transport commit, so the
duplicate-pipeline hazard never reached the panel. Resolved by
`reset --hard origin/<default>` then `checkout -B` onto the PR branch, and
`git config pull.ff only` so a deploy checkout fails loudly instead of
silently creating merge commits. The force-push that caused it was mine.

**Still outstanding: the fault-injection drill.** Nothing here exercises a
failure — the per-segment COMM alarm, per-bus blacklist resend and per-bus USB
recovery are all still unproven on real hardware. Steps in
`docs/slice10-design-proposals.md` §B.

## 2026-08-11 — Two-segment alarm generation LIVE-VERIFIED on the panel

Panel config at the time of the drill: bus1 (`/dev/ttyACM0`) carries Sensor1
(addr 1), Sensor2 (addr 2) and AmbientT (addr 101); bus2 (`/dev/ttyACM1`)
carries Sensor3 (3), Sensor4 (4) and Sensor5 (5). Joints J01/J02 sit on bus1,
**J03/J04 on bus2**, all referencing ambient 101 — which is on the *other*
segment, so the drill also exercises a cross-segment ambient reference.
Sensor5 carries no joint. Both buses 9600 8N2, 1000 ms timeout, 10 ms
inter-frame.

**The headline result — per-segment COMM alarms are real.** Cleared Alarm
History carries both of these as distinct entries:

- *"No data received from **the bus2** communication module for 60 seconds"*
  (raised 14:44:25, cleared 14:44:59; and again 12:26:19 → 12:33:53, that one
  with an operator ACK at 12:28:41)
- *"No data received from communication module for 60 seconds"* — bus1's
  original text, byte-identical

Two segments alarming and clearing independently, with bus1's wording and key
unchanged, is exactly what this change existed to produce. Before it, one
watchdog served both Nanos and neither segment's total failure could raise
anything.

**bus2 devices blacklist with the right impact text, and the segments are
isolated.** Slaves 3, 4 and 5 — all bus2 — blacklisted after 3 consecutive
read failures and later restored. The descriptions distinguish the two ways a
device hurts: *"joint(s) J03 not measurable"* and *"joint(s) J04 not
measurable"* against *"Slave 5 (Sensor5) … no joints affected"*. Slaves 1, 2
and 101 (bus1) did not blacklist during those events.

**ΔT and RoR alarms fire for a bus2 joint.** J04 is slave 4 on bus2, and it
produced the full RoR ladder — WATCH `RoR 71.30 ≥ 15`, WARNING `78.77 ≥ 30`,
CRITICAL `86.54 ≥ 60` — all raised and cleared. J03 (also bus2) raised a
PROCESS `Sensor communication failure`. This is the requirement the whole
change was for: a joint on the second segment is monitored exactly like one on
the first, and it needed no bus-aware logic in ProcessLogic because joints are
keyed by unit address.

**Confirmed with the user: the sensors were being heated deliberately** to
exercise the process alarms. That upgrades what this evidence proves. The
ΔT and RoR ladders were *provoked*, not drifted into, and both ran their full
range in order and then cleared:

- **RoR (A2)** on J04 (bus2) and J01 (bus1): WATCH ≥15 → WARNING ≥30 →
  CRITICAL ≥60, each raised at the right threshold and each cleared.
- **ΔT (A1)** on J02 (bus1): WATCH ≥15 → WARNING ≥25 → CRITICAL ≥35, cleared.

Two things follow. First, **both segments produced process alarms in the same
test** — J01/J02 on bus1 and J04 on bus2 — so the shared ProcessLogic really
is segment-agnostic in practice, not just in principle. Second, this is the
first deliberate end-to-end exercise of the **RoR ladder** since the
`dtSec < 2` guard was removed on 2026-07-22. That fix made A2 alarms possible
for the first time (they could never fire before it); this drill is the
evidence that the whole ladder — raise at each level, then clear through the
hysteresis/persistence path — actually works on real hardware.

**A note on the poll interval and the new status staleness.** The Modbus
Settings table shows `Poll s = 30` per slave, which looks alarmingly close to
the 60 s staleness threshold added for the Diag Status column. It is not:
`poll_interval_s` feeds R10's capacity math, while the Nano's actual cadence
comes from `comm[0]` = `inter_frame_ms × 1000` (10 ms here), so a live device
refreshes sub-second and has ~3 orders of magnitude of margin. Consistent with
no spurious "No Data" being reported.

### Still not covered by this drill
- **Per-bus USB recovery** — needs `BUSDUCT_UHUBCTL_BUS2` set; unset, bus2
  alarms correctly but is never power-cycled.
- **Per-bus resend on a bus2-only config edit** — visible only in the debug
  sidebar (`bus2 job out` fires, bus1's stays quiet), not in alarm history.

## 2026-08-12 — Per-bus resend verified; `uhubctl` scoping is the real constraint

**Two results from the panel.**

**Per-bus resend on a config edit — VERIFIED.** After a bus2-only change, only
the bus2 debug fired, carrying
`{"read":[3,[3,3,1],[4,3,1],[5,3,1]],"comm":[10000,9600,1000]}` — three packets
for slaves 3, 4 and 5, which is exactly bus2's slave set, at base address 3,
with bus2's own comm triple. No bus1 slave appears and bus1's job path stayed
silent. That is `compileNanoJob(doc, {busId:'bus2'})` filtering correctly
against the real applied config, and it closes the last outstanding wiring
item from the drill.

**`uhubctl` restarts the entire USB hub** (user, at the panel). This is not a
regression from this change — it is what the command has always done.
`uhubctl -l 1-1` with **no `-p`** switches every port on that hub, and bus1's
exec node has never passed `-p`. With one Nano that was correct. With two
Nanos on one hub it means recovering either segment power-cycles the other,
which defeats the point of making recovery per-bus.

**What changed here.** The hub target is now a spec, `LOCATION` or
`LOCATION:PORT` (`1-1`, `1-1:3`, `1-1.4:2,3`), parsed and validated into
`uhubctl` arguments (`-l 1-1 -p 3`) by `planRecovery`. `bus1`'s location is now
declared to the controller as well — not to build its command, which stays
hardcoded in its proven exec node, but so the planner can *notice* the
collision.

**On a shared hub it warns and still cycles**, deliberately. Refusing would
leave the dead segment dead, which is worse; the other segment reboots and its
silence watchdog hands its job back. So the operator gets
*"bus2 recovery will also power-cycle bus1 — they share hub 1-1"* once per
episode, with the fix (`:PORT`) named in the message.

**Open question for the panel, not decidable here.** Whether this Pi can
switch ports individually at all. Many models gang every USB port onto one
switch, in which case per-segment power recovery is physically impossible and
the choice is between a wide cycle (both segments blip, both recover) and no
cycle at all. `sudo uhubctl` lists the hub locations, their ports, and which
support power switching — that output decides it. Until then the wide form is
the default and the warning makes its cost visible.

## 2026-08-12 — Per-port USB power switching IS supported; both Nanos on one hub

`sudo uhubctl` on the panel:

```
Current status for hub 1-1 [2109:3431 USB2.0 Hub, USB 2.10, 4 ports, ppps]
  Port 1: 0103 power enable connect [2341:8057 Arduino NANO 33 IoT 3430A7EC50304D48502E3120FF181119]
  Port 2: 0103 power enable connect [2341:8057 Arduino NANO 33 IoT 47B60EAA50304D48502E3120FF0E2E32]
  Port 3: 0100 power
  Port 4: 0100 power
```

This answers the question left open in the previous entry. **`ppps` = per-port
power switching**, so this panel *can* cut power to one port without touching
the others — per-segment USB recovery is physically possible here, and the
`LOCATION:PORT` scoping added in the previous entry is exactly what it needs.
The two Nanos sit on **ports 1 and 2 of hub `1-1`**, which is also why the
unscoped `uhubctl -l 1-1` restarted both: it was switching all four ports.

Note the Nanos are on an **external VIA Labs 2109:3431 hub**, itself on port 1
of the Pi's internal hub `1`. That is what provides per-port switching — the
Pi's own root ports (hub `2`, the USB 3 controller) show all four ports
permanently powered, which is the ganged behaviour that would have made this
impossible. The external hub is load-bearing for recovery, not just for port
count.

**Consequence for identity: tie the segment to the hub PORT, not the device
name.** Both `/dev/ttyACM*` enumeration order and the `uhubctl -p` target are
per-port facts, and they must not drift apart — if `bus1` is the Nano on port 1
for polling but port 2 for recovery, a COMM failure power-cycles the wrong
segment. A `udev` rule keyed on `KERNELS=="1-1.1"` / `"1-1.2"` giving stable
`/dev/busduct-bus1` / `bus2` symlinks makes both facts derive from the same
physical port, and survives replacing a dead Nano (plug the new one into the
same port, change nothing). Pending the current port↔ttyACM mapping before
assigning, so the drill's existing bus↔sensor commissioning is not silently
swapped.

## 2026-08-12 — The hub-port ↔ segment mapping is CROSSED

`ls -l /dev/serial/by-id/` against the `uhubctl` listing from the previous
entry resolves the mapping, and it is not the intuitive one:

| hub 1-1 port | Nano serial | device | segment |
|---|---|---|---|
| **1** | `3430A7EC…181119` | `ttyACM1` | **bus2** |
| **2** | `47B60EAA…0E2E32` | `ttyACM0` | **bus1** |

Worth stating plainly because the obvious guess is wrong: **port 1 is bus2**.
Had `BUSDUCT_UHUBCTL_BUS1=1-1:1` been set by assumption, every bus1 COMM
recovery would have power-cycled bus2's Nano — taking down a healthy segment
while leaving the failed one dead, and the symptom (the *other* bus dropping
whenever one fails) would have looked like a wiring fault rather than a config
error. This is exactly why the values were not guessed.

Correct values: `BUSDUCT_UHUBCTL_BUS1=1-1:2`, `BUSDUCT_UHUBCTL_BUS2=1-1:1`.

The `ls` timestamps make the enumeration hazard concrete too: `ttyACM1` was
created at 14:44 and `ttyACM0` at 14:47 — the higher-numbered device appeared
*first*. The names are probe-order artifacts, not port facts, so they can swap
across a reboot and hand each segment the other's read list.

**`deploy/udev/99-busduct-nano.rules` fixes both problems at once**, keying on
the hub port rather than the board serial:

```
KERNEL=="ttyACM*", KERNELS=="1-1.2", SYMLINK+="busduct-bus1"
KERNEL=="ttyACM*", KERNELS=="1-1.1", SYMLINK+="busduct-bus2"
```

Port-based rather than serial-based is the deliberate choice. Two facts about
a segment must never disagree — which device Node-RED opens to poll it, and
which port recovery cycles — and keying both to the same socket makes that true
by construction. A serial-based rule would let them drift the moment a board is
moved between ports. It also makes replacing a dead Nano a pure hardware swap.

**Not yet applied to the flow, deliberately.** Pointing the `serial-port`
config nodes at `/dev/busduct-bus*` before the rule is installed leaves the
panel dark — a Node-RED serial node just retries a missing device forever, with
no fallback. So this is a two-step deploy: install the rule, confirm both
symlinks exist, and only then switch the flow over.

## 2026-08-12 — udev rule live; the flow now opens the stable symlinks

Installed on the panel and verified:

```
/dev/busduct-bus1 -> ttyACM0     (Nano 47B60EAA…, hub 1-1 port 2)
/dev/busduct-bus2 -> ttyACM1     (Nano 3430A7EC…, hub 1-1 port 1)
```

Both symlinks resolve to the segments they should, so step 2 is done: the
flow's two `serial-port` config nodes now open `/dev/busduct-bus1` and
`/dev/busduct-bus2` instead of `/dev/ttyACM0`/`ttyACM1`. Node ids are
unchanged, so every wire and both wiring test suites are untouched.

`test/flows-bus2-alarms.test.js` gains a guard against reverting to `ttyACM*`.
That would reintroduce two failures at once, and the second is the subtle one:
the probe-order hazard (the names can swap across a reboot and hand each
segment the other's read list), **and** the drift between polling identity and
recovery target. The symlinks and `BUSDUCT_UHUBCTL_*` are keyed to the same hub
port, so as long as both are used, a COMM failure cannot cycle the wrong Nano.
Go back to `ttyACM*` and that guarantee is gone silently — the panel keeps
working right up until a recovery fires on the wrong segment.

**Deployment ordering matters and is now load-bearing.** The udev rule must be
installed before this flow is imported, or Node-RED retries a missing device
forever with no fallback and the panel goes dark. Recorded in the rules file's
own header and in the deployment doc.

### State of the two-segment work
Everything in the drill is now verified on the panel except the USB-recovery
leg, which needs `BUSDUCT_UHUBCTL_BUS1=1-1:2` / `BUSDUCT_UHUBCTL_BUS2=1-1:1`
in `/etc/busduct/nodered.env` and a Node-RED restart. Note those values are
crossed relative to the intuitive guess.

## 2026-08-12 — Per-bus USB recovery verified; the two-segment drill is COMPLETE

The last outstanding leg, run on the panel with
`BUSDUCT_UHUBCTL_BUS1=1-1:2` / `BUSDUCT_UHUBCTL_BUS2=1-1:1` set. bus2's Nano
was pulled:

```
14:13:52  bus2 data stops
14:14:52  SYSTEM|BUS2|COMM_FAILURE raised            <- 60s watchdog
14:15:14  "bus2 silent (82s), resending its job"     <- retry
14:15:44  "bus2 silent (112s)"                          every
14:16:14  "bus2 silent (142s)"                          30s
14:16:24  USB reset attempt 1 on bus2                <- 92s after COMM (>= 90s)
14:16:44  "bus2 silent (172s)"
14:17:24  USB reset attempt 2 on bus2                <- exactly 60s later
14:17:44  bus2 COMM alarm CLEARED                    <- segment recovered
```

Every constant in `planRecovery` shows up in the timestamps: the 90 s hold
before the first cycle (92 s elapsed), the 60 s cooldown (exactly 60 s between
attempts), and the per-segment `RESET_n` events reading *"USB reset attempt N
**on bus2**"*.

**The decisive detail is what did NOT happen.** Active Alarms showed exactly
one alarm throughout, and the history carries no bus1 COMM alarm and no bus1
reset events. bus1 polled continuously while bus2's Nano was power-cycled
twice. That is the proof that:

- **`-p` port scoping works** — only hub port 1 was switched, not all four. The
  earlier whole-hub behaviour would have dropped bus1 at 14:16:24.
- **The crossed mapping was right.** Had `bus2` been pointed at port 2, this
  drill would have power-cycled *bus1's* Nano — bus1 would have raised its own
  COMM alarm and bus2 would never have recovered. The absence of that is the
  strongest confirmation available that `bus2 = 1-1:1` is correct.

**The retrying watchdog earned its keep, visibly.** The resend at 14:16:44 came
20 s after USB reset attempt 1, i.e. while the Nano was still booting its USB
CDC — exactly the window in which the old one-shot `trigger` would have burned
its single attempt and stranded the segment forever. Because it keeps retrying,
the missed resend cost nothing and the next attempt landed.

### Slice 10 two-segment RS-485: done
Transport, alarm generation, blacklisting, per-bus resend, per-segment COMM
alarms and per-bus USB recovery are all live-verified on the panel, plus the
process-alarm ladder on both segments (heat test, 2026-08-11) and stable
per-port device naming. Nothing in §B's drill is outstanding.

## 2026-08-12 — ADD BUS pre-fills the stable symlink, not a ttyACM name

Follow-through from the udev change. The Modbus Settings **ADD BUS** button
pre-filled `/dev/ttyACM${buses.length}`, which now contradicts the shipping
convention: a third segment would be suggested `/dev/ttyACM2` while the two
existing ones read `/dev/busduct-bus1`/`bus2`. It now pre-fills
`/dev/busduct-bus${n}`, matching the bus id it just allocated.

It is only a starting point in an editable field, but the default is what gets
accepted unthinkingly, and accepting a ttyACM name reintroduces both problems
the udev rule solved — probe-order swapping, and the drift between polling
identity and the `BUSDUCT_UHUBCTL_*` recovery target. Pinned by a test, since
this is now a convention rather than an arbitrary default.

Also corrected two stale port references in `CLAUDE.md` (the Nano resend path
and the bus2 wiring bullet) and the `ADD BUS` row of §B's UI acceptance table.

**The panel's own applied config is a separate, operator-side change** — bus
ports live in the ConfigStore on the Pi, not in this repo. Changing them is
safe and non-disruptive: `port` is not part of the compiled Nano job (`comm` is
`[inter_frame_us, baud, timeout_ms]`), so `nanoJobsEqual` sees no difference
and **no resend is issued** — neither segment's polling is interrupted.

## 2026-08-12 — Nano field replacement is a hardware-only operation

**User:** *"If I put different iot33 nano hardware will it work or I need to do
more settings after implemented above changes"*

Worth answering in the repo because it is the payoff from the port-based udev
decision, and because the answer has one sharp edge.

**No configuration changes.** Verified by grep: the two board serial numbers
appear in `deploy/udev/99-busduct-nano.rules` **only as comments**; the rules
themselves match on `KERNEL=="ttyACM*"` plus `KERNELS=="1-1.N"` — the hub port.
So the symlink follows the port, the `BUSDUCT_UHUBCTL_*` target is already the
same port, and the flow and `cfg/modbus` both reference the symlink. Nothing
downstream knows or cares which board is fitted.

The Nano also carries no per-board state: it is a Modbus master that receives
its whole job from the Pi on every update, so a blank board needs no address,
no baud, no slave list. The silence watchdog hands it the job within 30 s.

**The sharp edge is the hub port.** Fit it to a different port and both facts
break together — that segment is not polled, *and* a COMM failure would
power-cycle the other segment's Nano. This is the same coupling that made
port-based keying the right choice, seen from the other side.

**What is actually required is flashing**, and that had no runbook. Written up
as `docs/nano-replacement.md`, including the two things that bite: Node-RED
holds the serial port open and must be stopped before an upload, and
`arduino-cli` requires the sketch folder to be named for the sketch, which
`firmware/` is not — so the `.ino` has to be copied to a `Nano_IOT/` directory
first. Also records the three library dependencies (ArduinoJson, ModbusMaster,
Adafruit SleepyDog) and what a forgotten flash looks like from the HMI.
## 2026-08-10 — Alarm email: real subject lines, and every queued mail actually sent

**User question:** does the alarm mail carry the device id and device description
in its subject? **Answer: no** — and checking turned up a second, worse bug in
the same three lines.

### What the subject was
The Alarm Manager was already building a per-alarm subject
(`🚨 Active Alarm: PROCESS|J01|DELTA_T|CRITICAL`) at ten `emails.push` sites.
The `Email` function node then threw it away:

```js
msg.topic = global.get("project_config").project_name + " Alerts";   // the real subject
msg.payload = data[0].body;
```

So every alarm mail this panel has ever sent — raise, clear, comm failure,
blacklist, Pi power — arrived as **"BusbarTherm Alerts"**. Device identity
existed only in the body, and mail clients threaded the panel's entire alarm
history into one conversation.

### The second bug: `data[0]`
`buildOutputs` emits `{ payload: emails }` where `emails` is an **array**. The
mailer read only `emails[0]`, so when more than one email was queued in a tick
the rest were **silently discarded** — no error, no log. This is not a rare
path: one joint over both its ΔT and RoR thresholds queues several mails from a
single message, and it is exactly the moment mail matters.

### Built
- **`src/alarms/email-subject.js`** (pure, unit-tested) — `buildAlarmSubject` /
  `toMailMessage`. Subject reads *panel → severity → device → what happened*:
  `BusductTherMo S0001 | P0001 | CRITICAL | J01 - ΔT 30.40 ≥ 25`. Deliberate choices:
  a cleared alarm says **CLEARED**, not its old severity (a "CRITICAL" clear
  notification reads as a fresh alarm); the machine `instanceId` is parsed for
  device/level but never shown; description is collapsed to one line and the
  subject capped.
- **Site and panel identity in the subject** (user's choice — several sites,
  each with several panels, report into one mailbox during the pilot; site
  precedes panel because a reader narrows by location first, and the format is
  the user's: `<project> <site> | <panel> | <LEVEL> | <device> - <what>`). A
  missing id is dropped rather than left as an empty ` |  | ` segment, so an
  unprovisioned panel still reads cleanly. Sourced from
  `getGatewayInfo().identity`, which
  now carries the edge config's identity block. Taken from the gateway
  deliberately: that is the composition root, the one place allowed to require
  from `src/adapters/aws`, so the mailer never reaches into the adapter and the
  cloud-agnostic rule stays intact. Null on an unprovisioned panel → the subject
  simply omits it.
- **Ten `meta: {...}` stamps** on the Alarm Manager's `emails.push` sites —
  purely additive, no branch or existing field touched.
- **The Email node now sends one message per queued email.** If the library is
  missing it still delivers every mail, with the old constant subject, and calls
  `node.error` — an alarm mail must never be lost because functionGlobalContext
  was not reloaded.
- Exposed on the **existing** `busductConfigService` global, so no settings.js
  change on deployed panels.

### Tests
`test/alarms/email-subject.test.js` (9) plus
`test/alarms/alarm-email-endtoend.test.js` (4), which loads the **real** Alarm
Manager source out of `flows_BBT.json`, runs a joint over both thresholds
through it, and asserts what a mailbox would receive. Both halves passed their
own review for years while this bug sat between them — only running them
together shows it. 535 tests pass.

### Consequence the user must decide on: mail volume
The Alarm Manager raises a **separate alarm instance per threshold level** — a
`forEach` over CRITICAL/WARNING/WATCH with no break — so ΔT 30 against
thresholds 10/20/25 raises three alarms, and a joint over both ΔT and RoR
raises six. That is pre-existing, visible today as multiple rows in Active
Alarms. But it was **masked in email** by the `data[0]` bug: the panel sent one
mail regardless. Fixing the drop means that joint now sends six mails instead of
one.

Not silently changed either way: dropping mail is not an acceptable way to rate
limit. Flagged for the user, with the obvious follow-up being to mail only the
**highest active level per (joint, alarm_type)** and let the lower instances
live in the HMI table. That changes notification semantics, so it is their call.

## 2026-08-10 — Documentation audit against the scale-up targets

Swept every doc for claims that were true of a 3-device bench panel but false
at the 100 joint + 10 ambient target, two RS-485 segments, and a multi-panel
fleet. Six were stale; all fixed.

| Doc | Was | Now |
|---|---|---|
| `edge-user-manual.md` §6.1 | *"The firmware has one RS-485 port, so there is exactly one bus"* | RS-485 Buses table, Bus column, ADD/DEL behaviour; new **§6.5 "Splitting a large panel across two RS-485 segments"**; §6.3 gains the multi-bus apply guards and the R16 warning; maintenance mode renumbered §6.6 |
| `historian.md` | *"~10–20 points/s for this panel … a few hundred MB"* — a bench-panel figure | a **formula** plus a device-count × scan-interval table, and instructions to measure real on-disk size rather than estimate it |
| `bms-register-map.md` | block bases only, no capacities | per-block capacity column, the measured Tier-3 `extent` at 100 joints, poll-block guidance, and the note that I5 enforces these |
| `blacklist-recovery-spec.md` | *"design agreed, not yet implemented"* | BUILT and live-verified 2026-07-28 |

### The finding worth more than the doc edits: USB port assignment is not stable

`/dev/ttyACM0` and `/dev/ttyACM1` are handed out in **USB enumeration order**,
not by which Nano is which. A reboot, a re-plug, or the RECOVERY CONTROLLER's
own `uhubctl` power-cycle can swap them. Nothing errors: each Nano simply
receives the *other* segment's read list, every address times out, and both
segments look dead — indistinguishable from two failed buses.

This did not exist as a risk while the panel had one Nano, and it is not
mentioned anywhere in the repo. `pi-deployment.md` §5b now gives the udev rule
that pins each Nano to a stable `/dev/busduct-bus1|2` symlink by serial number,
and says to use those names in **both** the Modbus Settings bus rows and the
flow's `serial-port` config nodes. The failure it prevents is a panel that
polls correctly until its first reboot.

### Checked and found already correct
- `busduct_edge_config.yaml` — telemetry is `batch_aggregate`, one message per
  panel per interval, so it does not scale with joint count; the 200 MB outbox
  and 5 msg/s drain are independent of device count.
- `aws/README.md` — Part E already covers multi-bus remote config (added
  2026-08-08).
- `security-hardening.md` — no scale dimension.
- The two workplans — deliberately plan documents, not status documents;
  per-slice status lives in `CLAUDE.md`. Left alone.

Capacity figures in `bms-register-map.md` were **verified against the code**,
not asserted: 51 zones is rejected and 50 accepted, the bitmap covers 128
joints, and a 100-joint Tier-3 panel reports `extent` 1298 (my first draft said
1299 — off by one, corrected to the measured value).

## 2026-08-10 — Wi-Fi selection from the touchscreen (Settings → Wi-Fi Network)

**User question:** can the site Wi-Fi be selected and its password entered from
the existing settings screen? Yes — and the panel having a **built-in 10"
touchscreen** removed the objection that would otherwise have blocked it.

### Why the touchscreen changes the risk
My first answer flagged lockout as the blocker: change Wi-Fi from a dashboard
you are viewing *over that Wi-Fi* and a typo strands the panel, recoverable only
by physical access. But the kiosk browser loads the dashboard from
**localhost** — so switching networks cannot disconnect the local HMI. The
technician standing at the panel keeps control throughout. The risk survives
only for a *remote* viewer, who is not the person commissioning. Rollback
dropped from must-have to belt-and-braces (it is implemented anyway).

Confirmed with the user that an **OS on-screen keyboard is already installed**,
so a plain password field behaves like the existing PIN gates. Had there been
none, that — not the networking — would have been the real blocker: a WPA
passphrase is up to 63 mixed-case characters, against `system123` typed rarely.
(There is no virtual keyboard anywhere in the flow; I checked.)

### The security shape, which is the substance of this change
Slice 8a deliberately narrowed sudo to `uhubctl` alone. This widens it, so the
shape matters:

- **A wrapper (`deploy/bin/busduct-wifi`), not `NOPASSWD: /usr/bin/nmcli`.**
  Granting nmcli wholesale is effectively granting root — it can edit any
  connection profile and run dispatcher scripts on connection events. The
  wrapper exposes `scan`, `status`, `connect <ssid>` and nothing else.
- **The passphrase never enters an argument vector.** `/proc/<pid>/cmdline` is
  world-readable, so the obvious `nmcli device wifi connect X password Y` leaks
  the site's Wi-Fi password to every local user for the life of the process.
  The helper reads it from **stdin** and writes it into a `0600` root-owned
  NetworkManager keyfile. `src/network/wifi.js` writes it to the child's stdin;
  a test asserts it is absent from argv and is the one to keep through any
  refactor.
- **It reaches nothing else.** Not the config store, not the audit trail, not a
  global or the context store (which serialises to disk), not a debug node, not
  the cloud. The backend node deliberately logs no `msg.payload`.
- **A failed join self-reverts** inside the helper: the new profile is deleted
  and the previous wireless connection brought back up, so a mistyped password
  cannot strand a panel even in the remote-viewer case.

### Worth keeping from the implementation
`nmcli -t` escapes a literal `:` inside a field as `\:`. Splitting the terse
output naively on `:` makes an SSID like `Plant:B` shift every later column — it
would have reported that network's signal as `"B"` and mis-parsed everything
after it. `splitTerse` honours the escaping; there is a test for exactly that
SSID.

### Remaining exposure, stated rather than papered over
The screen sits behind the same low-strength dashboard PIN gates as the other
config screens, which §1 of the security doc already says are not the security
boundary. Anyone who can reach the dashboard can change the panel's network. On
a panel whose HMI is the local touchscreen that is acceptable; where the
dashboard is reachable beyond the panel, the editor `adminAuth` and
network-level controls are what actually protect it. Recorded in
`docs/security-hardening.md` §2b rather than left implicit.

13 new unit tests, 556 total. **Not yet live** — needs the helper installed
(§2b), a restart, and a flow re-import.

## 2026-08-19 — Rebuilt two days of work onto `claude/new-session-g3ddvm`

**What happened:** `claude/code-handoff-strategy-y551k2` and
`claude/new-session-g3ddvm` **diverged** at `7d5f070` ("Wire the second RS-485
segment into modbusMaster_V2", 10 Aug). g3ddvm continued 10–12 Aug with 11
commits and was deployed and drilled on the panel; y551k2 continued 18–19 Aug
with 6 commits, built on the pre-fork base with no visibility of the other
branch. The Pi tracks g3ddvm, so g3ddvm is the trunk and this work was rebuilt
on top of it.

### Two problems had been solved twice, and theirs is better

| Problem | g3ddvm | y551k2 (dropped) |
|---|---|---|
| Per-bus blacklist resend | `_finalize` derives the changed slaves from the **symmetric difference of the previous and current exclude sets** — precise, and independent of whether `events` is populated. `busForSlave` falls back to the *sole bus's id*, not a hardcoded `'bus1'`. | derived from `events`; used `[]` to mean "untagged/all" |
| Per-segment USB recovery | `src/config-service/bus-recovery.js` (`planRecovery`, pure + timing-injected), separate COMM keys and escalation ladders per bus, a real `deploy/udev/99-busduct-nano.rules`, hub-spec parsing with collision detection | logic inside the RECOVERY CONTROLLER function node + a `busduct_usb_ports` global |

Both of mine were dropped wholesale. Two points from theirs worth carrying
forward as project knowledge:

- **udev keyed on the hub PORT, not the board's serial number.** Both facts a
  segment depends on — which device Node-RED opens, and which port the recovery
  cycles — then derive from the same physical socket by construction. A
  serial-keyed rule lets them drift: move a board and the symlink follows it
  while the `uhubctl` target does not. It also survives replacing a dead Nano.
  My §5b had proposed the serial-keyed version; it was the worse answer.
- **They found a real bug in my 7d5f070 bus2 wiring**: bus2's frames were routed
  into bus1's `Data Out`, which feeds *the* COMM watchdog — so the watchdog was
  satisfied while **either** Nano was talking. A live bus2 masked a dead bus1
  and vice versa, and neither segment's total failure could raise a COMM alarm.
  Fixed there with a separate `Data Out 2 (bus2)` chain and its own watchdog.

### What was re-applied
Only what was genuinely unique: the alarm-email subject work, the Wi-Fi screen,
and the parts of the scale-up doc sweep g3ddvm had not already covered better
(`bms-register-map`, `historian`, `blacklist-recovery-spec`, `edge-user-manual`).
The flow changes were re-applied **programmatically against g3ddvm's flow** —
the same scripted patches, not a merge: a textual merge of a 537 KB single-line
JSON file is worthless, and a test merge conflicted in 7 files including the
flow, `blacklist-handler.js` and its test.

### The process failure worth not repeating
Nothing surfaced the other branch until it was asked about directly — `git
fetch` only listed it once prompted. Two days of work went onto a stale base,
and two features were built twice. **Fetch and compare against every remote
branch before starting a session's work**, not after. The old y551k2 head is
tagged `pre-rebuild-y551k2` (`f2eec04`) if anything needs recovering.

581 tests pass on the rebuilt branch.

## 2026-08-19 — Wi-Fi screen moved to the Slave Config tab

**User:** put the Wi-Fi setting on the communication settings page. **There is
no such page** — the "Communication Settings" tab and the "Comm Parameters"
screen were both deleted in the 2026-07-14 legacy commissioning cleanup. Its PIN
gate (`AdminLite` / `BUSDUCT_PW_COMMS`) still exists in the env file and now
guards nothing, which is worth tidying separately.

Compounding the confusion, **two different groups are named "Modbus Settings"**:
the one on *Slave Config* holds only the leftover Read/Transfer dropdown and
SLAVE Active display, while the real commissioning table (RS-485 buses + slave
channels) is the group of the same name on *Joint Config*. Offered the user the
choice; they picked **Slave Config**, next to the leftover comms controls.

Moved the `ui_group` (tab + order) rather than rebuilding anything — the
template, backend node and boot inject are untouched, so this is purely where it
renders.

**One real consequence of the move:** the group went from 12 units wide to 23 to
match the group above it, and the form is `flex`, so the password field
stretched to about 1000 px. Wider is *worse* for a finger, not better — a
password box the width of the screen is harder to aim at and looks broken.
Capped `.nw-row`, `.nw-hint` and `.nw-status` at 760 px so the controls stay a
comfortable size while the group still fills the page. Verified by rendering at
the real 1236 px group width, not by assuming.

## 2026-08-19 — BACnet gateway selected: Moxa MGate 5217I-1200-T

Customer requires BACnet/IP at **full Tier 3**, using MGate 5217I-1200-T
gateways — two where a panel carries more than ~200 sensors. Process written up
in `docs/bms-mgate5217-integration.md`.

**The OEM manual could not be read**: `moxa.com` and every mirror tried are
blocked by this environment's egress proxy. Rather than reconstruct the MGate's
configuration screens from memory — which is how a commissioning day gets
burned — the document separates what was *verified* from what must be
*cross-checked against the manual*, and describes the gateway's menus
generically while giving the exact values to enter.

### Verified by running the code, not recalled

- **Two Modbus TCP clients can poll one panel simultaneously.** Bound the real
  server and ran two clients against different register ranges concurrently;
  both served repeatedly, no resets. So two gateways on one Pi need no change on
  our side.
- **Point budget at Tier 3** computed from `register-map.js`: Tier 1 = 12,
  ACK = 1, Tier 2 = 7/zone, Tier 3 = **6/joint**. 100 joints = 669 points;
  200 joints = 1269; 250 = 1625. The 1200-point model therefore needs a second
  gateway from ~200 joints.

### The finding worth money

**`absolute_temp` (Tier-3 offset +5) is a documented duplicate of `temp` (+2)** —
it exists only for gateways wanting a separate point. Dropping it saves one point
per joint, and **at 200 joints that is 1069 vs 1269 — the difference between one
gateway and two.** The crossover moves from ~200 joints to ~215. Worth asking the
BMS integrator before the second unit is ordered.

### Design points recorded for the split
The ACK register is the only writable point and must be mapped on **exactly one**
gateway, or two BACnet objects write the same register. Tier 1 goes on gateway A
only — **except the heartbeat, which goes on both**, since Modbus has no liveness
of its own and each BACnet device needs to prove it independently. Joint index
*i* sits at `500 + i×8`, so the boundary is exact and movable.

### Manual received the same day — three open questions answered, one correction

The user supplied **MGate 5217 Series User Manual v1.4**, so §5 is now written
from the OEM document with page references rather than described generically.

**The correction that mattered:** the first draft said to poll in blocks of ≤125
registers. Wrong. `Read quantity` accepts **only 1 or 2** (p19) — one Modbus
command reads one register and produces one BACnet object. At Tier 3 that means
**hundreds of commands per gateway**, which is why the CSV import (Chapter 7) is
the only sane path and why the web UI is not. Anyone following the original §5
would have discovered this after hand-entering the first few rows.

Answered:
- **What counts toward 600/1200?** Objects/commands, definitively: the CSV's
  `cmdIndex` runs **1 to 1200** (p57). The conservative budget in §1 was right.
  It also means the gateway split must be decided *before* the sheet is
  generated — the CSV cannot express more points than the model licenses.
- **Can the gateway scale?** Yes — `Data scaling (multiplication)`, −1000…1000
  (p20). Set `0.1` on the ×10 points, so the BMS reads 61.5 directly.
- **BACnet `Reliability` for the sentinel?** No per-command field exists, so it
  stays a documented convention. And scaling interacts with it: with ×0.1
  applied the sentinel arrives as **−3276.8**, not −32768. That is the number to
  give the BMS, and §6 keeps testing it as a pre-handover step.

Two further findings worth carrying into commissioning: Moxa advise **COV
subscriptions under 300** (p21), so at 600–1200 points the BMS must not
COV-subscribe everything — subscribe the summary and alarm levels, poll the
per-joint temperatures. And the manual is explicit that requests are sent **in
turns**, so the real scan interval depends on queue depth (p26): with ~700
commands the achievable update rate is set by the queue, not by `Poll interval`.
That is a second, independent reason to split across two gateways.

Still open, and only measurable on hardware: the actual scan time at ~700
commands, and whether the customer's BMS supports the BACnet `Description`
property (if not, the joint↔object index table is the only naming reference).

## 2026-08-19 — BACnet virtual devices: one device per zone instead of one flat list

**User asked whether the virtual device feature had been tried. It had not** — I
mentioned it once in the first draft, dismissed it in a sentence ("we are one
Modbus device, so this is not needed"), and the rewrite from the manual dropped
it entirely. That dismissal was wrong, and worth recording as a lesson: I treated
"we are one Modbus device" as a fixed fact about the panel when it is actually a
*choice* about how the gateway is configured.

### How it works (manual p57)
The BACnet device instance is **six digits**: `1 | 02 | 404` — serial port
(**always 1 in Modbus TCP mode**), then `devSequence` (1–32 for TCP, set per
Modbus device in the CSV), then the gateway's own 3-digit base instance. So
**each Modbus device becomes its own BACnet device**.

### Verified: our server answers on ANY unit id
Modbus TCP treats the unit id as a serial-gateway artefact, and our jsmodbus
server does not filter on it — tested across unit ids 1, 2, 5, 8, 32, 247, all
served identically. Therefore the panel can be presented as **up to 32 Modbus
devices at the same IP:1502, differing only by unit id**, with **no change to our
code or config**. It is purely gateway-side grouping.

That turns one BACnet device with 600–1200 flat objects into e.g. `Panel
Summary` + one device per zone (`101404`, `102404`, …). Beyond readability: a
zone going dark shows as a whole BACnet device failing rather than scattered
objects going stale, and the ACK object sitting alone on `Panel Summary` makes it
self-evidently panel-wide.

### The dependency this creates, and why it is now pinned
The grouping works *because* our server ignores the unit id. That is normal
Modbus TCP behaviour, but it is now load-bearing for a customer-facing
integration, so `test/integration/jsmodbus-server-factory.test.js` asserts it
across several unit ids. Swapping to a server library that filters on unit id
would otherwise break the BMS grouping silently — every one of our own tools
(`bms-read.js`, the dashboard card) would keep working, because they all use
unit id 1.

Constraints recorded in §5b: the point budget is unchanged (virtual devices
regroup the same commands, `cmdIndex` still caps at 1200), `devSequence` caps at
32 so one device per *joint* is not possible, and two gateways need **different
base instances** so instance numbers cannot collide.

## 2026-08-26 — MGate CSV generator: derived from the live config, and split by zone

`tools/mgate-csv.js` + `src/integration/mgate-csv.js` generate the gateway's
Modbus-configuration CSV from the panel's own applied config, via the **same
`buildRegisterMap`** the Modbus TCP server answers from. Rationale: the MGate
reads one register per command (`Read quantity` is 1 or 2, manual v1.4 p19), so
a Tier-3 panel is 600–1200 commands — not a hand-entry job, and a hand-built
sheet drifts from the panel the first time a joint is added. Documented in
`docs/bms-mgate5217-integration.md` §5c; 19 unit tests in
`test/integration/mgate-csv.test.js`.

### The tests encode manual constraints, because the firmware checks at IMPORT
Every limit the gateway enforces — object-type/function-code legality (p59),
`bacnetInstance` uniqueness within a type (p60), `cmdIndex` ordering and its
1200 cap (p57), the 40/39-character description and name limits, the forbidden
`- " ' # * , [ ]` characters (p61), `devSequence` ≤ 32 — is checked at *import*,
after the whole sheet exists. A rule broken on row 3 of 700 is found only once
all 700 have been produced, so each is a test here instead.

### Two corrections to my own earlier advice, both from the manual
1. **`Analog Value` is write-only** (p59: legal on functions 5/6/15/16). §3 and
   §5 of the integration doc had recommended it for temperatures. Every
   measurement we expose is FC 3, so scaled points are **`Analog Input`**, levels
   and states **`Multi-state Input`**, counts and the heartbeat **`Integer
   Value`**; only the ACK register is an `Analog Value`. Both sections corrected.
2. **Object type is derived from the map's `scale`, not a hardcoded key list**,
   so a point added to `register-map.js` later gets the right type without
   touching this file. Pinned by a test.

### A design flaw found in my own two-gateway split
§4 originally split by **joint index** (`J001–J100` / `J101–J200`). With the
per-zone virtual-device grouping from the 2026-08-19 entry, a zone whose joints
straddle that boundary has its Tier-2 rollup emitted on **both** gateways — two
BACnet objects reporting one register, each presented as if it were the whole
zone. Worse than omitting the rollup, because the copy on the gateway holding
half the zone's joints looks authoritative. **The split is now by zone**
(`--zones=`), which makes each rollup belong to exactly one gateway by
construction; a test asserts the two gateways' register sets overlap only on
register 0, the heartbeat, which is deliberately on both. `--joints=` survives
only for a panel with no zones configured.

### Template-first, because the CSV format is versioned
The manual documents the `[command_parameters]` columns (p57–61) but its list
omits the `Data scaling` / `Data addition` fields the web console has, and the
format changed at firmware v1.3 (p54). So `--template=<export from the actual
gateway>` emits rows against **that** gateway's header, filling any column the
generator has no opinion about with `*` ("not used"). Without a template it
falls back to the documented order and says so on stderr. The ×10 → `0.1` `Data
scaling` setting is therefore *not* in the generated CSV by default; the
generator always warns about it, since missing it makes every temperature read
ten times high.

### Discovered while seeding a 200-joint test panel
`config/schemas/busduct_modbus_joint_config.schema.json` caps `modbus.slaves` at
**128**. A 200-joint panel therefore cannot use one single-channel unit per
joint — it must use multi-channel units (e.g. 50 × 4-channel), which is how the
hardware is actually built anyway. Recorded here because the cap is easy to hit
in a synthetic test and hard to diagnose from the validation error alone.

## 2026-08-27 — CR-OPEN-3: every device→cloud message now says what it is

Design review raised CR-OPEN-3: four distinct message types share the
telemetry topic — interval aggregate, heartbeat, positional manifest and the
LWT — and only the manifest carried a `type` field. **Verified true against the
code** (`node-red/index.js:81/83/138` all resolve to `cfg.topics.telemetry`;
`AlarmPublisher` alone is on its own topic), and fixed here. Cloud development
has not started, so there is no deployed consumer to migrate — this is the one
moment the contract is free to change.

### One correction to the finding's wording
"The cloud cannot cleanly discriminate them today" overstated it: each shape
*was* separable by field-presence sniffing (`type`→manifest, `lwt`→LWT,
`fwVersion`→heartbeat, `start_index`→positional, else keyed). It decoded; it
just had no uniform discriminator, so a rule had to encode five structural
signatures and would mis-route the first time anyone added a field. The
accurate charge is "fragile and undocumented", not "impossible" — worth
recording because a reviewer reading only the finding might think the pipeline
was broken.

### What the finding missed, which made the case stronger
With `use_basic_ingest: true`, `edge-config.js` rewrites `topics.telemetry`
itself to the `$aws/rules/btTelemetry/...` form, and the LWT read that
**already-rewritten** value. So in the mode a production panel would actually
run, the LWT was published straight into the rule engine: it arrived as a
malformed telemetry record with no timestamp and no joints, and could not be
subscribed to at all (nothing can subscribe to a Basic Ingest topic). The
README's LWT verification drill only ever worked with Basic Ingest off — which
is how the 24h soak ran, so this had never been exercised.

### The fix
- **`src/cloud-gateway/message-types.js`** — one frozen list of `type` values
  (`telemetry`, `manifest`, `heartbeat`, `alarm`, `config_ack`, `cert_ack`,
  `lwt`), required by every publisher so code and docs cannot drift. Values are
  append-only, like the BMS register map.
- `type` is the **first** property of every payload, so a truncated line in a
  log is still identifiable. Pinned by a test.
- **Telemetry keeps ONE type with an `encoding` field** (`keyed` |
  `positional`) rather than two types. A consumer wanting "the interval
  aggregate" should not have to know how the panel was configured, and a panel
  can be switched between encodings without the cloud re-subscribing.
- **The LWT moved to its own `status/{c}/{s}/{p}` topic**, never Basic-Ingest
  rewritten, with a documented default so configs predating the field keep
  working.
- Acks got `type` too. They are on dedicated topics with one shape each, so
  they were never ambiguous — but a contract with an exception is a contract
  people stop trusting.

### Deployment hazard, recorded because it has bitten us before
The device policy must grant publish on the status topic **before** this code
reaches a panel. AWS IoT authorises the will topic as part of establishing the
connection, so an ungranted status topic can refuse the connect outright — the
panel goes fully dark, looking like a certificate problem. This is the same
shape as the cert-rotation lesson (an unauthorized *subscribe* dropping the
whole connection, 2026-07-22), which is why the policy template, the README and
CLAUDE.md all now state the ordering. Unlike cert rotation there is no feature
flag to fall back to: the LWT is not optional, so ordering is the only control.

### Our own soak tool was doing the same sniffing
`soak-verify.js` discriminated on `payload.joints` / `payload.fwVersion` /
`payload.action` — the exact habit the finding objects to, inside our own
verification tool. It now reads `type`, with the old sniffing kept **only** as
a fallback so soak logs recorded before today (including the 2026-07-18
combined-soak evidence) stay verifiable. Note its telemetry check is
deliberately keyed-only: the aggregate comparison reads `payload.joints`, which
a positional payload does not have.

### Left for the requirements doc, not decided here
Whether messages should also carry a **schema version** (`v: 1`). Greenfield is
when that is cheapest to add, but the versioning policy — global or per
message-type, and what a consumer does with an unknown version — is a
cloud-side design decision, not one to make unilaterally in the edge repo.

## 2026-08-27 — CR-OPEN-5 (field-name drift) and EC-2 (publish device health)

Two more items from the same design review. The third, EC-1/M1 (the `type`
discriminator), had already landed in `96a733b` before the review comment
arrived — the reviewer was reading a pre-fix snapshot.

### CR-OPEN-5: the two telemetry encodings named the same number differently

Verified: `batcher.js` emitted `ambient` in keyed mode and `amb_avg` in
positional for the same value (`_cell` mapped `amb_avg` ← `entry.ambient`), and
`slice10-design-proposals.md` §A showed a third name, `t_avg`, for a field the
code has always computed as a maximum (`t_max`). A parser written against
either encoding would be wrong for the other, and the panel can be switched
between them at any time.

**Frozen on `dt_min dt_max dt_avg ror_max t_max amb_avg`, identical in both
encodings.** `amb_avg` wins over `ambient` for two reasons: every other wire
field names its statistic, and the value genuinely is an interval mean — but
more importantly the *internal* KPI field `ambient` is an object
(`{slaveID, val, age_sec}`). Reusing that name for a bare number on the wire is
what let the drift go unnoticed. `_cell` no longer maps names at all, which
removes the place where the encodings could diverge. The doc's `t_avg` was
simply wrong and is corrected, with a note recording it so the next reader does
not "fix" the code to match an old draft.

A test now asserts the two encodings expose the same field set *and* the same
values for the same joint, so they cannot drift apart again.

### EC-2: device health went no further than the HMI

Confirmed: `global.busduct_blacklist_state` (blacklisted/probing devices, joint
LIVE/STALE/OFFLINE) and `global.busduct_power_health` fed only the Device
Health dashboard tab. A fleet view could see what a panel *measured* but not
whether it could still measure — the blind spot exactly where central
monitoring beats standing in front of the panel.

**Alarms do not close this gap**, which is worth stating because it is the
obvious objection. Alarms are *transitions*; a consumer that starts late, drops
a message, or restarts cannot know the current set of blacklisted devices
without replaying history. So `device_health` is a complete **state snapshot** —
newest message wins, nothing to replay.

New `src/cloud-gateway/device-health.js` (pure, unit-tested) + a
`DeviceHealthPublisher` on the existing outbox, and a 60 s "Publish Device
Health" node on the Cloud Gateway tab. It computes nothing new — it publishes
what the panel already derived for its own HMI.

**Per-segment bus liveness needed a new source.** The flow's silence watchdogs
keep their last-frame stamp in **flow** context on `modbusMaster_V2`, which the
Cloud Gateway tab cannot read. Rather than plumb flow context across tabs, the
blacklist tracker now records `busSeen[bus_id]` in `processReadResult`, deriving
the segment from `busForSlave(doc, slaveId)` rather than `msg.bus_id` — only
bus2 frames carry that tag, and unit addresses are unique panel-wide, so the
slave resolves the segment exactly for both. Any frame counts, including an
error response: the Nano answered, so the serial link is up even if that device
is not.

`status` is `ok | silent | unknown`, and **`unknown` (never seen) is
deliberately distinct from `silent` (seen, then quiet)** — at boot every segment
is briefly unseen, and reporting that as a fault would alarm the fleet view on
every restart.

### A bug found in my own cadence design, worth recording
The first cut fingerprinted the whole payload minus `timestamp` for change
detection. But `last_frame_age_sec` grows every second and `next_probe_in_sec`
counts down, so **every snapshot compared as changed** and "publish on change"
would have silently degraded into "publish every 60 s" — the exact cost the
cadence exists to avoid, and invisible in production because the messages would
all have looked correct. The fingerprint now excludes both; they stay in the
payload because a human reading one message wants them, but the *state* is
`buses[].status` and `devices[].status`. Documented in README Part G so no
consumer keys alerting on the volatile fields either.

(A test of mine was also wrong here in the opposite direction: it held `busSeen`
fixed while advancing the clock and expected "unchanged". Holding the stamps
still while time moves *is* a bus going silent — a real state change. The
fixture now advances the stamps with the clock, as a live panel does.)

### Cadence choice
On change, plus an **hourly resync**. The resync is not redundancy for QoS 1:
QoS 1 protects delivery to a *connected* subscriber and does nothing for a
consumer that started after the last change. Without it a fleet view brought up
against a calm panel would show nothing until the next fault. On a healthy panel
this is one message an hour carrying an empty `devices` array.

## 2026-08-27 — Two open contract questions, decided

Both were left open for the cloud requirements doc; the user asked for a
decision rather than options.

### 1. Schema version: YES — a single global `v`, integer, currently 1

The deciding fact is not about JSON style, it is about **fleet reality: OTA
update is not built** (Readiness Workplan Phase 6). Panels are updated by
visiting them, so a fleet runs mixed firmware for months and the cloud will
have to parse two revisions of a message *simultaneously* — a certainty, not a
risk. Without a version the only way to tell revisions apart is to sniff which
fields are present, which is precisely the habit the `type` discriminator was
added to end. CR-OPEN-5 (the `ambient` → `amb_avg` rename) is the existing
precedent: with `v` the cloud could have accepted both revisions instead of
guessing.

**Global, not per-message-type.** A consumer routes on `type` first and applies
`v` inside that branch, so a bump caused by a telemetry change is already a
no-op for an alarm consumer. Per-type counters would make every consumer track
seven numbers and still could not express an envelope-wide change.

Rules, written into `message-types.js` next to the constant: bump ONLY on a
breaking change (field renamed/removed, meaning/unit/type changed, a
switched-on value gaining a new meaning); an added optional field never bumps
and consumers must ignore unknown fields; an unknown `v` must fail loudly
rather than be guessed. The "never bump for additive" half matters as much as
the other: bumping for additive changes trains people to ignore the number.

### 2. Status-topic ordering: code-level fallback, not documentation alone

The hazard: AWS IoT authorises the will topic as part of establishing the
connection, so a policy that has not yet granted `status/{c}/{s}/{p}` refuses
the whole CONNECT. Nothing at the MQTT client distinguishes that from any other
connect failure, and the reconnect loop retries forever — so the naive
behaviour is an **unbounded** dark panel that looks like a certificate fault.
Documentation alone leaves that live, and this project has already been bitten
by the same shape once (the cert-rotation subscribe, 2026-07-22).

Rejected: a feature flag like `BUSDUCT_CERT_ROTATION`. That works for an
optional feature you decide about in advance; the LWT is not optional and the
operator would have to already know the answer to set the flag correctly.

**Chosen: alternate.** Past three failed attempts, even-numbered dials carry
the will and odd ones do not (`_willFor`). Whichever succeeds is the truth. If
the will topic is unauthorised, only the no-will dials connect and the panel
comes up with telemetry and alarms flowing, losing only immediate
unclean-disconnect detection (missed heartbeats still catch an offline panel).
If the cause is anything else, both kinds fail equally and a with-will dial
connects once it clears.

**Alternating rather than latching is the point.** Latching on the first
no-will success would mean a panel that merely lost its uplink for a while runs
without an LWT until someone restarts it — trading a loud failure for a silent
one. A test pins exactly that case.

The other half is telling someone. A panel running without its will is online
and looks entirely healthy, so the reason — naming the unauthorised topic, the
fix, and what still works — is repeated on **every telemetry flush**, not just
at boot.

## 2026-08-31 — Stuck blacklist alarm after a restart (reported from the panel)

Live report: a CRITICAL `Slave 101 (AmbientT) blacklisted after 3 consecutive
read failures` alarm was active, while the *same* device showed **Connected**,
**Active** and a live 31.39 °C reading on both the Diagnostics table and the BMS
register view. Two screenshots taken minutes apart, so not a transient.

**Diagnosis: a stuck alarm, not a false blacklist.** The Device column reads
`tracker.snapshot().status`, and it said `active` — so the tracker itself did
NOT think the device was blacklisted. Only the alarm did.

The cause is a lifetime mismatch between the two halves of the feature:

- the blacklist tracker is a **process-wide in-memory singleton**
  (`getTracker`, deliberately not in context because serialisation strips the
  class prototype), so it is **empty after every Node-RED restart**;
- the alarm lives in the Alarm Manager's `context.get("activeAlarms")`, which on
  this Pi is **localfilesystem-backed and survives a restart**.

A blacklist alarm clears *only* on a tracker `restored` event. So if a device is
blacklisted and Node-RED restarts before it recovers, the tracker forgets the
device was ever bad, never emits `restored`, and the CRITICAL alarm stays active
indefinitely while the device is polled normally. Any deployment restart can
trigger it — which is what happened here, right after the message-contract
release was loaded.

**Not caused by that release.** The only blacklist-path change in it was adding
`tracker.recordBusSeen(...)` alongside the existing `recordResult`, which cannot
affect a blacklist decision. The release *exposed* a latent bug by requiring a
restart, and would have done so at any restart since Slice 9.

### Fix
`reconcileBlacklistAlarms(activeAlarms, tracker, doc)` — pure, in
blacklist-handler.js. The tracker is the single source of truth for who is
blacklisted *now*; any active `SYSTEM|<slave>|BLACKLIST` alarm naming a slave
the tracker considers `active` is stale and gets a clear command in the shape
the Alarm Manager already accepts. A slave the tracker considers `blacklisted`
or `probing` is left strictly alone — clearing an alarm that is still true is
the one thing this must never do, and it has its own tests.

Wired as a **one-shot boot inject at 20 s** ("Reconcile Blacklist Alarms",
Device Health tab). The delay is the design: by 20 s polling has resumed and a
genuinely dead device has already failed its 3 reads and been re-blacklisted, so
its alarm is correctly preserved. Running this on the existing 10 s tick was
rejected — it would race the raise path and could clear an alarm microseconds
after it was legitimately raised.

### Alternative considered and rejected
Persisting the tracker snapshot and restoring it at boot. It keeps more state,
but it also means a device repaired while Node-RED was down stays blacklisted
until it probes out — turning a stuck alarm into a stuck *exclusion*, which is
worse. Reconciling in the other direction is self-healing: the panel re-learns
the truth from the bus within ~3 poll cycles.

## 2026-08-31 — device_health live on the panel

First live run of the message-contract release (`d53d7d1`) on the real Pi. The
"Publish Device Health" node reports:

```
4/4 live | bus1:ok bus2:ok | unchanged
```

Three things confirmed by that one line:

- **Both RS-485 segments are seen.** `busSeen` is being stamped from
  `processReadResult` for bus1 and bus2 alike, which is the whole point of
  deriving the segment from `busForSlave(doc, slaveId)` rather than `msg.bus_id`
  — only bus2 frames carry that tag. Per-segment liveness now leaves the panel;
  previously a dead Nano on one segment was invisible from outside.
- **On-change cadence works.** `unchanged` means a second tick ran and correctly
  published nothing. This is the property the volatile-field exclusion in
  `healthFingerprint` exists to protect, and it was the bug found during the
  build (including `last_frame_age_sec` made every snapshot compare as changed,
  turning "on change" into "every 60 s" while every message still looked right).
- **The stuck blacklist alarm is gone**, and the ambient reads normally.

Not yet verified, both needing the AWS side: receipt of `device_health` in the
MQTT test client, and the LWT on `status/{c}/{s}/{p}` — which needs the updated
`iot-policy-panel.template.json` pushed as an active policy version first. Until
then the panel connects without a Last Will and says so in every flush status.

## 2026-08-31 — joint_id widened from 4 to 6 characters

Reported from the panel: the Joint Configuration screen would not accept an id
longer than 4 characters. The input field has no `maxlength` — the rejection was
the schema pattern `^J[0-9]{2,3}$` failing at apply time, which forces a literal
`J` prefix followed by 2-3 digits.

Sites want to name joints to their own convention (riser / floor / feeder
coding), not `J01..J999`. New pattern: **`^[A-Za-z0-9][A-Za-z0-9_]{1,5}$`** —
2 to 6 characters of letters, digits and underscore, not starting with an
underscore.

### Why a general format rather than just more digits
`^J[0-9]{2,5}$` would have delivered 6 characters too, but only as `J00001`. The
request was for room to *name* joints, and a general format is a superset — it
still accepts every `J`-prefixed id. Every currently valid id keeps validating,
so the installed base is untouched; that is pinned by its own test.

### Two characters deliberately excluded
- **`|`** — the alarm instanceId is `PROCESS|{joint}|{type}|{level}`. A pipe
  inside the joint id would make that key ambiguous to split.
- **`-`** — the MGate BACnet `description` field forbids `- " ' # * , [ ]`
  (manual v1.4 p61) and the generator strips them. A joint named `R1-J12` would
  reach the BMS as `R1 J12`: a different string from the one on the HMI and in
  the alarm. Excluding the hyphen keeps the id byte-identical on every surface.
  Flagged to the user in case hyphens are wanted anyway — the trade is a
  cosmetic difference on the BACnet side only.

### Verified against the downstream consumers at 6 characters
Nothing derives an index or sort order from a joint_id (checked), so only string
length mattered. MGate `cmdName` and `bacnetDescription` peak at 26 characters
against limits of 39 and 40. Keyed telemetry grows about 300 bytes per interval
at 100 joints, against a 4800-byte budget that already chunks. Tier-3 registers
are index-based and unaffected.

**Not changed: `zone_id`**, still `^z[0-9]{1,2}$`. The report was specifically
about joint ids; widening zones is a separate call.

## 2026-08-31 — Stale blacklist EXCLUDE set: silent, and a deadlock

Second live report the same day. The Diagnostics table showed Sensor4 and
Sensor5 as **No Data** with their values frozen at 0, while the Device column
(the tracker) called every device **Active** and the header said *"Devices: all
responding"*.

Same lifetime mismatch as the stuck alarm earlier today, but the worse half.
`global.busduct_blacklist_exclude` is what `Send Nano Job` subtracts from the
compiled read job. It is written with `global.set(...)` and **no store
argument**, so it lands in the default store — localfilesystem-backed on the Pi,
therefore **surviving a restart**. The tracker does not survive.

The reason it is never corrected is a specific line in `_finalize`:

```js
const resendNeeded = prevExcludeKey === undefined
  ? excludeSlaveIds.length > 0
  : excludeKey !== prevExcludeKey;
```

After a restart `prevExcludeKey` is `undefined` and a fresh tracker yields an
empty `excludeSlaveIds`, so this is `[].length > 0` = **false**. The Blacklist
Engine writes the global only when `resendNeeded`, so the stale list persists
indefinitely.

### Why it is invisible
A slave that is not in the read job produces neither an `ok` nor an `err`, so
the tracker has nothing to count and reports it `active`; `summarizeBlacklist`
therefore says "all responding". The only outward sign is the device going quiet
— Diagnostics ageing it out to "No Data" after 60 s with its last value frozen.
**And this morning's stuck-alarm fix made it less visible still**: the tracker
calls the slave active, so `reconcileBlacklistAlarms` clears its blacklist alarm
— removing the last thing that pointed at it. That is worth recording plainly:
the alarm fix was right, but it took away a symptom whose cause was still there.

### Why it cannot self-heal
It is a deadlock. Excluded means never polled; never polled means it can never
fail a read, so it can never be re-blacklisted, and it can never return a good
read, so it can never be restored. Nothing inside the blacklist state machine
can break that cycle — only putting the slave back in the scan can.

### Fix
`reconcileExcludeSet(persistedExclude, tracker, doc)` — on boot the tracker is
authoritative: keep only slaves it actually has `blacklisted`, and return the
buses whose read set changed. Notable detail: a **`probing`** slave is
deliberately NOT excluded, because probing means "back in the scan on backoff"
and excluding it would suppress the very reads that let it recover.

Wired as "Repair Blacklist Exclude", a boot inject at **10 s — deliberately
before** the 20 s alarm reconcile. Repairing the scan first means that by the
time alarms are reconciled, a genuinely dead device has already re-failed its 3
reads and been re-blacklisted, so its alarm is correctly preserved. The reverse
order would clear the alarm of a device that had not yet had a chance to fail.

A healthy panel is a no-op: no rewrite, no resend. That matters because the
firmware re-inits its Modbus timeout on every job update, so an unconditional
boot resend would briefly disrupt live polling on every restart.

### Root cause worth fixing separately (not done here)
The real fault is that `busduct_blacklist_exclude` is *derived* state persisted
in a store that outlives the thing it is derived from. Both of today's bugs are
the same shape. A cleaner long-term fix is to stop persisting it at all — write
it to the `memory` store explicitly — so it cannot outlive the tracker. Left for
the design chat: it changes restart behaviour for a genuinely-dead device (it
would be polled once more before being re-blacklisted, which is correct but
worth agreeing).

## 2026-08-31 — Alarms surviving a configuration change

Live report: after changing the joint configuration, alarms raised against the
old setup stayed in Active Alarms. The question asked was whether an alarm can
be removed when its sensor is no longer in the joint configuration — and the
answer is that the panel already tried to do exactly that, via the Alarm
Manager's "CLEANUP DELETED SENSORS" sweep, but the sweep had two gaps.

### Gap 1 — it read the draft, not the applied config
```js
const joints = global.get("joint_master_zone_A") || [];
```
That global is the legacy DRAFT the dashboard edits. It can disagree with the
applied `cfg/modbus+joints` document: mid-edit, after a remote config push, or
on a panel whose draft was never rebuilt. So alarms for genuinely-removed joints
survived, and — the mirror risk — alarms for joints that existed only in a draft
could be cleared.

### Gap 2 — every SYSTEM alarm was skipped
```js
if (alarm.category !== "SYSTEM" && ...)
```
That skip is right for an *unhealthy* device: a blacklisted slave must not clear
its own alarm. But it also means a `SYSTEM|<slave>|BLACKLIST` alarm for a device
**deleted from the configuration** can never clear, and cannot recover on its
own either — a deleted device is never polled, so the tracker never emits
`restored`. Same deadlock shape as the two blacklist bugs found earlier today.

### The distinction that fixes it
"Unhealthy" and "no longer configured" are different questions.
`sweepDecommissionedAlarms(activeAlarms, doc)` answers only the second:

- PROCESS alarm → clear when its `joint_id` is absent from the applied `joints[]`
- device-scoped SYSTEM alarm → clear when its `slave_id` is absent from the
  applied `modbus.slaves[]`
- **panel-scoped** SYSTEM alarms (`MODULE`, `BUS1`, `BUS2`, `PI`) → never swept;
  they belong to no configured device, so "not in the config" is meaningless
- `AMBIENT_*` pseudo-joints → never swept, as before

A device that is still commissioned keeps its alarm however sick it is. That is
the tracker's business, not the sweep's.

### Refusing to act on absent information
The old `|| []` fallback was a latent hazard: a missing or unreadable global made
every joint look deleted, which would have auto-cleared every PROCESS alarm on
the panel in one pass. The new sweep returns nothing when the document cannot be
read, and treats an empty `joints[]` the same way — it is indistinguishable from
"could not read it", and leaving one stale alarm is far better than silently
clearing all of them. Five tests cover that path specifically.

### Safety on the live path
The sweep runs inside the Alarm Manager, which is the panel's alarm engine. The
call is wrapped in `try/catch` and defaults to an empty sweep, so a fault in the
library can never stop alarms being evaluated. `test/flows-integrity.test.js`
asserts both that the cleanup no longer READS the draft global (mentioning it in
a comment is fine) and that the call is inside a try/catch.

## 2026-08-31 — Config sweep live-verified, and where alarms are actually raised from

The sweep ran on the panel. Cleared Alarm History shows three entries cleared
together at 12:24:26 with "(Auto-cleared)": `J05`, `J001` and `J1_2143124`, all
"Sensor communication failure". Two SYSTEM blacklist alarms from 12:12 are in the
same list, cleared by the normal restore path. That is the reported problem
resolved.

### What `J1_2143124` reveals
That joint id is 10 characters. The schema pattern caps `joint_id` at 6, so it
could never have passed `validateModbusJoints` — yet it raised alarms. The reason
is that **ProcessLogic reads the joint list from the legacy DRAFT global**:

```js
const JOINT_MASTER_KEY = "joint_master_zone_A";
const joints = global.get(JOINT_MASTER_KEY) || [];
```

So the panel evaluates and alarms against whatever is in the draft, including
rows that were saved but never applied, and ids that the applied config would
have rejected.

Combined with today's fix this is now asymmetric on purpose: alarms are **raised**
from the draft, but **swept** against the applied document. For cleanup that is
the right way round — anything not genuinely applied gets removed. But it does
mean a joint edited into the draft without applying can raise an alarm that the
sweep then clears, which is churn rather than a fault.

**Not changed here.** Pointing ProcessLogic at the applied document instead would
be the consistent fix, but it alters the live measurement path — which joints are
evaluated at all — and would stop a saved-not-applied joint being monitored,
which some commissioning workflows may currently rely on. That is a design-chat
decision, not a unilateral one. Recorded so the asymmetry is deliberate and
visible rather than discovered again later.

## 2026-08-31 — Regression: the sweep cleared per-sensor comm alarms every probe cycle

Reported from the panel with J02's sensor physically disconnected. The
`SYSTEM|sl02|BLACKLIST` alarm was correct. But Cleared Alarm History also showed
`J02 | Zone1 | CRITICAL | Sensor communication failure (Auto-cleared)` raised and
cleared at 15:05, 15:10, 15:15, 15:20 — every five minutes, which is the
blacklist tracker's maximum probe backoff (30s → 60s → 120s → **300s**). Each
cycle also sent a raise e-mail and a clear e-mail.

**My bug, introduced in `cd82de4`** (the config-change sweep from earlier the
same day). Not a pre-existing condition and not a tracker fault.

### Cause
`sweepDecommissionedAlarms` treated the second segment of a SYSTEM instanceId as
a `slave_id`. That is true for `SYSTEM|<slave>|BLACKLIST`, but the Alarm
Manager's per-sensor fault alarms are keyed off the **joint**:

```js
const key = `SYSTEM|${d.joint_id}|${S.type}`;   // -> SYSTEM|J02|COMMUNICATION
```

Category SYSTEM, joint id in the scope position. `validSlaveIds.has('J02')` is
false, so the sweep declared the alarm decommissioned and cleared it — on the
very tick it was raised. The probe cadence made it periodic: each probe read
restored the sensor briefly enough to re-raise, the next sweep cleared it again.

### Fix
The scope is checked against **both** id spaces: `validSlaveIds.has(scope) ||
validJointIds.has(scope)`. An unrecognised scope is still swept, so gap 2 (a
deleted device whose blacklist alarm can never clear) stays closed — the sweep
acts only when the scope names nothing that exists anywhere in the applied
document.

Four regression tests in `test/alarms/config-sweep.test.js` pin it, including the
exact live combination: `sl01` blacklisted while still-configured `J02` holds its
communication alarm, and neither is swept.

### Why it was not caught
The original tests built SYSTEM alarms only through a `system_()` helper that
always passed a slave id. The helper made the wrong assumption look like the
whole shape of the domain. The instanceId scope is not one namespace — the tests
now exercise both, and a panel-scoped third case (`MODULE`/`PI`/`BUS1`/`BUS2`)
that belongs to neither.

## 2026-08-31 — Alarms carry the joint's name, not just its id

Asked whether the joint name was in the alarm object or the description. It was
in neither. The alarm object carried `joint_id`, `zone_id` **and** `zone_name` —
zone had both halves all along, joint had only the key.

### What was already there and unused
The operator names every joint in the Joint Config table. It is a **mandatory**
column (a blank one fails with "Missing fields"), stored as schema
`joints[].label`, described in the schema as *"Human location, e.g. 'Riser bend,
above ACB-8'"*. ProcessLogic carries it through as `d.joint_name` in the very
message the Alarm Manager reads. The Alarm Manager simply never copied it.

The clearest evidence this was an oversight rather than a decision: the Active
Alarms table's column is headed **"Location"** and binds `{{a.joint_id}}`.
Someone intended the location to be there. So on a panel where a joint is called
"Riser bend, above ACB-8", every alarm surface said `J02` — the HMI, the raise
and clear e-mails (`Joint: J02`), the history CSV, and the cloud alarm message.

### What changed
- **Alarm Manager**: `joint_name` derived once from `d.joint_name` and defaulted
  in `raiseAlarm`, exactly as `zone_name` already was — one place, covering all
  three joint-scoped builders (ΔT, RoR, per-sensor COMMUNICATION/SENSOR_FAULT).
- **E-mails**: a `jointLabel()` helper renders `J02 (Riser bend, above ACB-8)`,
  falling back to the bare id. Used in all three bodies — raise, clear, and the
  config auto-clear.
- **HMI**: both tables render `{{a.joint_name || a.joint_id}}` with the id kept
  as a `title` tooltip, so the key that appears in instanceIds and e-mail
  subjects is still one hover away. History CSV gains a `Location` column.
- **Cloud**: `joint_name` promoted to a top-level field beside `joint_id`, so a
  fleet view need not reach into the `alarm` snapshot.

### Two deliberate non-changes
**Null, not the id, when a joint is unnamed.** Echoing the id would make a
fabricated name indistinguishable from a real one; consumers apply
`joint_name || joint_id` themselves. Old alarms already in the Alarm Manager's
persisted context have no `joint_name` at all, and the same fallback covers them
without a migration.

**The description strings are unchanged.** A description is the *condition*
(`ΔT 29.48 ≥ 25`); identity belongs in its own field, not concatenated into text
that the BMS, the cloud and the CSV would each have to parse back out.

> **Superseded the same day** — see the next entry. Asked to put the joint id in
> the descriptions, and on checking, the second half of my reasoning here was
> simply wrong: I claimed the change would disturb strings that alarm dedupe and
> history matching read. Nothing keys on `description` anywhere.

On the wire this is an **added optional field**, so the contract version stays
`v: 1` — precisely the case Part G's rules say must not bump.

### Guarding it
The path crosses two function nodes, two `ui_template` bodies and a CSV export,
all inside hand-imported flow JSON where a dropped binding fails silently. Six
tests in `test/flows-integrity.test.js` pin each hop, including that the CSV
header and the row array agree on column order — getting those out of step would
shift every later column by one without any error.

## 2026-08-31 — Alarm descriptions lead with the joint id

User request, immediately after the `joint_name` work above: put the joint id in
every alarm description. Joint-scoped descriptions are now prefixed via
`describeJoint()` in the Alarm Manager:

| Alarm | Before | After |
|---|---|---|
| ΔT | `ΔT 29.48 ≥ 25` | `J02: ΔT 29.48 ≥ 25` |
| RoR | `RoR 3.10 ≥ 2` | `J02: RoR 3.10 ≥ 2` |
| Comm fault | `Sensor communication failure` | `J02: Sensor communication failure` |
| Sensor fault | `Sensor value out of valid range` | `J02: Sensor value out of valid range` |

### Correcting my own objection
In the previous entry I argued against this on two grounds. The first — that a
description is the *condition*, and identity belongs in its own field — is a
matter of taste, and the user's case is stronger than mine: `description` is the
one field that travels everywhere **intact**. It is the whole content of an
e-mail subject line, it is a column in the CSV export, and a dashboard built
from the alarm stream may well render it with no joint column beside it. In
those places a bare `ΔT 29.48 ≥ 25` genuinely does not say which joint.

The second ground was **factually wrong** and I should have checked before
saying it: I claimed the change would disturb strings that alarm dedupe and
history matching read. It would not. Dedupe is keyed on `instanceId`
(`emailSent[instanceId]`, `isActive(key)`), historian matching on `instanceId` +
`raisedTs`, the cloud publisher on `instanceId` + status, and the BMS is purely
register-based. `description` is only ever *displayed*. Verified by grep before
making the change.

### Scope of the prefix
The **id**, not the name: it is short, stable, and matches the `instanceId`
already in the e-mail subject, while the name is separately available as
`joint_name` and shown in the Location column. A 48-character location string
would crowd out the reading in a subject line.

Panel- and device-scoped alarms are deliberately **not** prefixed — `SYSTEM: `
would be noise on an alarm that belongs to no joint, and the blacklist alarm
already names its device and its affected joints (`Slave 101 (AmbientT)
blacklisted — ambient reference for joint(s) J01, J02`). `describeJoint` falls
through to the unprefixed text when there is no `joint_id`, so this is
structural rather than a list of exceptions to maintain.

Both contract docs now state explicitly that `description` is prose for display
and never an identifier — parse `joint_id`. That is the property worth pinning:
the risk of putting an id into a display string is a consumer that starts
parsing it back out.

Alarms already active when this deploys keep their old description until they
clear and re-raise; there is nothing to migrate.

**Both changes live-verified on the Pi (2026-08-31).** Cleared Alarm History
shows the two states side by side, which is the clearest possible confirmation:
a 15:53 sensor-fault row reads `Sensor communication failure`, and the 17:00 row
for the same joint reads `J02: Sensor communication failure`. The Joint column
renders the operator's name (`Dc/07/Fl_0/Tx/Line_1`) on both, since `joint_name`
deployed first. The two blacklist rows show `SYSTEM` with unprefixed
descriptions - the panel/device exclusion working. The remaining two surfaces
were confirmed on the panel the same day: the history **Export CSV** carries its
new `Location` column, and the raise e-mail body reads
`Joint: J02 (Dc/07/Fl_0/Tx/Line_1)`. All five surfaces verified - both HMI
tables, the CSV, the e-mails and the description prefix.

One thing that check incidentally settled: the site names joints with slashes
and underscores (`Dc/07/Fl_0/Tx/Line_1`). That is fine for the MGate export,
because Tier 3 commands are labelled from `joint_id`, not the label - only ZONE
names reach `bacnetDescription`, where the 40-character cap and the forbidden
set `- " ' # * , [ ]` apply. `/` is not forbidden. Worth remembering if zones are
ever named to the same convention.

## 2026-08-31 — "outbox alarm: 0" read as "no alarms"

From the panel. The Publish Device Health debug showed, with a device
disconnected and blacklisted:

```
device_health: "unchanged"
counts: { joints_total: 5, joints_live: 4, joints_stale: 0, joints_offline: 1,
          devices_blacklisted: 1, devices_probing: 0 }
buses: array[2]
outbox: { alarm: 0, telemetry: 0 }
```

Reported as "when there is a disconnection alarm the alarm count still shows
zero". Not a fault: `outbox.alarm` is the **queue depth** of the alarm priority
class — messages waiting to be sent. Zero is the healthy reading; it means every
alarm message published has already drained to the cloud. A *rising* number is
the bad case (link down, messages held). The disconnection is reported in the
same message, one block up: `devices_blacklisted: 1`, `joints_offline: 1`,
`joints_live: 4`.

The misreading is entirely reasonable — `alarm: 0` sits four lines below a
`counts` block, so it parses as another count. Renamed to **`outbox_pending`**
in this status only. The flush statuses keep the shorter `outbox` key, which
`soak-verify.js` reads to detect alarms still queued when a recording stopped;
renaming that would break verification of existing soak logs for no gain, and
the flush status has no adjacent `counts` block to be confused with.

**Not changed: device_health does not carry an alarm count.** It is a state
snapshot answering "can the panel still measure?" — alarms are a separate
message type and a separate concern (EC-2: an alarm stream reports transitions,
so a consumer that starts late cannot know the current blacklist from it). The
information the operator wanted is already present as `devices_blacklisted` and
`joints_offline`; adding an alarm tally would duplicate the alarm channel inside
the health channel and give two places to disagree.

## 2026-09-01 — Uplink detail and additional Pi health parameters

User request: report which network the panel is on — SSID and signal for Wi-Fi,
signal and "other relevant fields" for a USB telecom dongle — and review what
other Pi health parameters are worth carrying.

### What already existed
`pi-health.js` (heartbeat `system` block) already classified the default-route
interface as wifi/ethernet/cellular and read a Wi-Fi dBm from
`/proc/net/wireless` and a cellular percent from `mmcli`. What it did **not**
have was the identifying half — no SSID, no BSSID, no band, no operator, no
access technology. Signal strength without SSID cannot answer the question that
actually gets asked remotely: *which* access point is it on, and did it roam?

### Uplink detail added
Wi-Fi comes from a single `iw dev <iface> link` call — SSID, BSSID, frequency,
signal and negotiated bitrate all arrive together, and `iw` ships on Raspberry
Pi OS. `iwgetid -r` plus `/proc/net/wireless` remains the fallback, because
wireless-tools is *not* installed by default on Bookworm and neither source can
be the only one. `link_quality` is still read from `/proc` even when `iw`
succeeds: it is the driver's own 0–70 figure and `iw link` has no equivalent.
Band is derived from frequency rather than guessed.

Cellular uses `mmcli -m any -K`, whose key-value output is stable across
versions, falling back to parsing the human output for older builds. That adds
operator name, access technology, registration state (home/roaming) and modem
state. **Deliberately still only one AT command** (`+CSQ`) on the spare port:
every exchange on a modem carrying a live data session is a small risk, and
everything else worth knowing is already in ModemManager.

One real bug fixed while writing the CSQ path: **CSQ 99 means "not known or not
detectable"**, and the existing formula would have decoded it as +85 dBm — an
impossibly strong signal, which is the worst possible way to be wrong about a
link that is actually dead.

### Pi parameters added, and why each earns its place
| Field | Reason |
|---|---|
| `disk[]` | The highest-value addition. The SD card holds the InfluxDB historian (7d raw + 90d + ~5y rollups) **and** the cloud outbox. A full disk stops trend recording and stops the outbox holding messages through a link outage — the two things that make an offline panel harmless — and *nothing* monitored it. |
| `uptime_sec` | A value that decreases between heartbeats is a reboot. An unexplained reboot is exactly how an intermittent brown-out announces itself; that symptom cost a week of misdiagnosis in 2026-07. |
| `clock_synced` | Timestamps are `edge_utc`; the historian and the cloud both correlate on them. An unsynchronised clock corrupts trends silently and is invisible from every other signal. |
| `load` + `cpus` | Node-RED and InfluxDB share the Pi. Sustained load above the core count is when Modbus polls start slipping — and "load 3.5" is meaningless without the denominator. |
| `ram_total_mb` | Same argument: free/available cannot be read as healthy or desperate across a fleet mixing 1/2/4/8 GB Pis. |
| `process_rss_mb` | Node-RED's own RSS. The only field that catches a slow leak across a multi-week run; `ram_available_mb` looks fine right up until the OOM killer arrives. |

**Considered and rejected:** CPU frequency (the throttle flags already say when
it is being clamped, which is the actionable part); SD-card wear counters (not
readable portably); per-core temperatures (a Pi has one thermal zone); network
throughput counters (needs cross-sample deltas and state, and the outbox backlog
already answers "is the link keeping up").

### Two properties that had to hold
**Every probe nulls only its own field.** They are separate reads of sysfs,
/proc, `vcgencmd`, `df`, `iw` and `mmcli`, and a health snapshot must never
break the heartbeat carrying it. A test asserts that killing `df` and
`timedatectl` leaves `uptime_sec` and `load` intact.

**Probes swallow stderr.** Found on a smoke run: `timedatectl` on a non-systemd
box prints *"System has not been booted with systemd"* to stderr, which would
have landed in Node-RED's log every hour. All eight spawns now use
`stdio: ['ignore','pipe','ignore']`. Every command here is expected to be absent
on some machine, so a noisy probe is worse than useless.

`wifi.ssid`/`bssid` name the customer's own network and are published in the
heartbeat. Deliberate — remote diagnosis of a marginal link needs to know which
AP the panel associated with — but noted in both the module docblock and Part G
as site information deserving the same care as the rest of the telemetry.

Added optional fields throughout, so the wire contract stays `v: 1`.

## 2026-09-01 — "Panel & Uplink" tile on the Device Health dashboard

Follow-up to the health work above. The heartbeat carries uplink identity and Pi
health, but hourly *and only when the link is up* — which is exactly the wrong
availability for the question it answers. A technician standing at the panel
wondering why the uplink is marginal cannot wait an hour, and if the link is
already down the message never leaves at all.

`summarizeSystemHealth()` (pure, in `pi-health.js`, exposed on
`busductCloudGateway`) turns a snapshot into a display object: SSID or operator
as the headline, a colour-coded good/fair/poor band, then CPU / RAM / disk /
uptime / load, then a warning list. Thresholds are named constants with their
reasoning attached — Wi-Fi ≥ −67 good and < −75 poor (below that retries
dominate), cellular ≥ 50 % / 25 %, disk ≥ 85 % warn and ≥ 92 % critical (InfluxDB
compaction needs headroom), CPU ≥ 70 °C (a Pi throttles at 80).

### The design decision that mattered
**No new collector.** The obvious implementation is a new 30 s tick calling
`collectPiHealth()`, but the Device Health tab *already* runs a 30 s "Pi Power
Health" node that calls exactly that. A second one would have re-spawned `df`,
`iw`, `mmcli` and `timedatectl` every 30 seconds to recompute numbers the panel
already had. The existing node now also writes `global.busduct_system_health`
from the snapshot it collected anyway, and the existing 5 s view refresh fans out
to both tiles. A test asserts `collectPiHealth()` still appears exactly once in
that node, because the cheap mistake here is someone later "fixing" the coupling
by adding the second collector back.

The tile is its own `ui_group` rather than more rows in the blacklist table: the
two answer different questions (can the panel still measure? vs is the box that
runs it healthy?) and the blacklist table is already 8 units tall.

`warnings` deliberately does **not** raise alarms. Every condition here is
either already alarmed (`SYSTEM|PI|POWER`) or is a slow-moving housekeeping
matter — a disk filling over weeks, a clock drifting — where an alarm that
cannot be cleared by acknowledging it would train operators to ignore the alarm
list. If disk-full should alarm, that is a threshold decision for the design
chat, not something to slip in behind a dashboard tile.

Renders "not sampled yet" before the first 30 s tick rather than a blank panel,
and an all-null snapshot (off-Pi, or every probe failed) degrades to "No uplink"
with no warnings instead of throwing inside the view.

## 2026-09-01 — SSH deploy key documented, not adopted

Asked how to pull on the Pi over SSH securely. §1a of `docs/pi-deployment.md`
now carries the full procedure: a **read-only deploy key**, one per panel,
`IdentitiesOnly yes`, host keys pinned from `api.github.com/meta` over TLS
rather than accepted at the interactive prompt, a push test to prove read-only
is real, and revocation steps.

**User decision: not deploying it.** The panels keep pulling over HTTPS with a
Personal Access Token.

The section stays as documentation, retitled *"optional, not yet adopted"*, and
`docs/pi-deployment.md` §1 was restored to the HTTPS clone — I had switched that
line to the SSH alias in the same commit, which would have pointed a fresh Pi at
a host alias that does not exist. `docs/security-hardening.md` §4 now records
the PAT as a **known, accepted weakness** rather than describing the deploy key
as current practice: a token in the remote URL is plaintext in `.git/config`,
visible in `git remote -v`, and in shell history. Written that way deliberately
— a hardening document that describes an aspiration as if it were the
configuration is worse than one that names the gap.

Practical mitigation while the PAT stands: scope it to `repo` **read** only, and
rotate it when anyone leaves the team.

## 2026-09-01 — Panel & Uplink tile moved to Diagnostics

Deployed and rendering correctly, but reported as *"not on the HMI connected
pages"* — the Device Health **dashboard** tab is not one the operators navigate
to. Moved beside **BMS Registers** on the **Diagnostics** tab, at the same
width (12) so the two sit side by side, ordered immediately after it.

Only the `ui_group`'s `tab`/`order`/`width` changed. The tile is still fed by
the 5 s "refresh view" → "Blacklist View" chain on the Device Health **flow**
tab — the flow tab and the dashboard tab are unrelated, and nothing about the
wiring or the collection path moved. The regression test now asserts the tile
shares a tab and width with BMS Registers *and* that the feed wire is unchanged,
since the easy mistake when relocating a dashboard group is to leave it visually
in place but detached from its data.

The Device Health dashboard tab keeps the blacklist table. Worth revisiting
whether that one should move too, but it was not what was asked and the blacklist
state is also surfaced in Active Alarms, so it is less stranded than the uplink
tile was.

## 2026-09-01 — Licence management: proposal written, not built

Asked for licence management — a 1-month licence entered remotely from the
cloud or typed on the device, edge screens and BMS data sharing disabled after
expiry, days-remaining shown on the panel.

Written up as `docs/licence-management-proposal.md` and **not implemented**.
This is a new cross-cutting subsystem — cryptography, a new state store, HMI
gating, a BMS register-map addition and a cloud channel domain — which the
working agreement puts in the companion design chat rather than here.

### The one that needs a human decision, not a technical one
The requirement as stated blinds both ways of noticing an overheating joint at
the same moment: the HMI goes dark *and* the BMS stops receiving temperatures.
On a system whose purpose is spotting a hot busduct joint before it becomes a
fire, a licence lapsing on a Friday would then mean nobody sees anything until
Monday. There is also a liability question (disabling a safety-related function
for a commercial reason), a sales one (BMS integrators avoid devices that can
stop answering), and a support one (a silent panel is indistinguishable from a
dead one).

The proposal recommends gating **commercial value** — trends, configuration,
diagnostics, cloud publishing, BMS *values* — while the alarm path, the alarm
relay/e-mail, Active Alarms and a minimal live temperature view keep running at
any licence state. That preserves real commercial leverage without the failure
mode being an unseen joint. Flagged explicitly as a business decision: if the
design chat wants a full blackout, it will be built that way.

### Technical positions taken, for review
- **24-character Crockford base32 key**, 48-bit payload + 72-bit truncated
  Ed25519 signature. Asymmetric deliberately: no verification secret on the
  device, so a stolen panel forges nothing. 20 bits bind the key to the panel's
  `thing_name`, so one key cannot license a site.
- **Monotonic time watermark** against clock tampering, advanced only while
  `clock_synced` is true — the health field added earlier the same day turns out
  to be load-bearing here. Winding the clock back does nothing; winding it
  forward only expires the licence early.
- **BMS keeps answering** on expiry, serving the existing `NO_DATA` sentinel
  plus a new Tier 1 licence-status register (append-only, needs a
  `point_map_version` bump). Closing the socket looks exactly like a dead panel
  and turns every lapse into a fault call.
- **Licence state is not a config domain.** The other domains are
  operator-editable, backed up and restorable, and a restorable licence is an
  unlimited licence.
- **14-day grace** with an escalating banner, rather than a midnight cutoff.

Six open decisions are listed in §9, including one that needs answering before
the first key is ever issued: who holds the signing key, and what the escrow and
rotation story is if it is lost — every issued licence becomes unverifiable, and
the public key is baked into shipped images.

## 2026-09-01 — Panel & Uplink tile live, and its timestamp moved to site time

Live on the Diagnostics tab beside BMS Registers: `Wi-Fi · TLD_SC_5G`,
`-53 dBm · 5GHz · 325 Mbps` on the green band, CPU 55.5 °C, RAM 5.7 of 7.6 GB,
disk 35.1 % used, uptime 1d 1h, load `2.43 / 1.71 / 1.61 (4 cores)`,
"✔ Panel healthy". The load line is the threshold behaving correctly — avg5
(1.71) is compared against the core count, not against an absolute number, so a
1-minute spike of 2.43 on a 4-core Pi raises nothing.

The tile printed `updated 2026-09-01T06:39:14.532Z` — raw UTC, while every other
HMI table renders IST through a `toIST` helper. On an operator screen that turns
"is this current?" into mental arithmetic. Now rendered with the same helper and
the same `Asia/Kolkata` string the alarm tables use, so the whole HMI reads one
clock.

**The helper is per-template, not shared.** `ui_template` scopes are isolated,
so each template that formats a time defines its own copy — that is the existing
pattern in this flow, not something introduced here, and the test asserts the
tile defines one rather than only calling it (a template calling an undefined
`toIST` renders an empty string silently, with no console error to notice).

**Only the rendering changed.** The collector still stamps UTC, as everything on
the wire does (`edge_utc`); a timezone belongs at the display edge and nowhere
else. `summarizeSystemHealth` stays timezone-free and so stays portable — a site
outside IST needs one string changed in one template, not a change to the
library.

## 2026-09-01 — ProcessLogic repointed to the applied configuration

User decision, after the asymmetry surfaced twice on 2026-08-31: alarms are now
raised against the same document they are swept against. ProcessLogic reads
`global.busduct_applied_joints` instead of the legacy `joint_master_zone_A`
draft.

### Why the draft was wrong to raise from
- It is **not schema-validated**. `J1_2143124` — ten characters against a
  six-character pattern — was raising alarms on the live panel.
- A row **saved but never applied** was monitored anyway, silently, with nothing
  telling the operator their edit was not in service.
- Anything raised from the draft but absent from the applied doc was immediately
  swept, producing raise/clear churn.
- It carries a flat per-joint `ambientSlaveID`, so the **R14 override chain**
  (joint → zone → panel) never took effect. Reading the applied document fixes
  that as a side effect — a panel with per-zone ambients now behaves as
  configured.

### Three implementation decisions
**Polling, not apply-hooks.** A 10 s inject reads the store and republishes.
Local joint apply, local Modbus apply, a remote config push and a hand-edited
file all have to converge, and hooking each apply site can miss one — this
cannot. The read is the same one the Device Health tab already does every 5 s,
so the cost is established. **ProcessLogic itself never touches the store**: it
runs on every reading (~0.5 s per device), and a file read per sample would have
been a real regression. It still reads a plain global, just a different one.

**The draft stays as a fail-safe fallback.** If the applied list has not been
published yet — at boot, or if the library failed to load — ProcessLogic uses
the draft rather than monitoring nothing. This is a fire-safety monitor; it must
never stop watching joints because a global is unpopulated. The fallback is
visible on the banner rather than silent.

**Refuses to publish an empty list.** `buildProcessLogicJoints` returns
`joints: null` for an unreadable or empty document and the publisher keeps
whatever was there. Publishing `[]` would have stopped monitoring the whole
panel — the same rule the alarm sweep already follows.

### What this does NOT fix
**Channel disambiguation.** ProcessLogic's input is the raw Nano frame
`{t:'r', id:<unit address>, sa, len, val, st}` — there is no channel in the
stream at all, so a multi-channel slave cannot be split across joints here
whatever the configuration says. Rows stay keyed by unit address, exactly as the
draft was. Where two joints share a unit address the **lowest channel wins**
(matching the old `joints.find()`, so nothing changes silently) and a warning is
surfaced to the operator rather than the reading landing on an arbitrary joint.
Fixing it properly means carrying the channel through the decode path — a
separate change, and one that touches the ~40 legacy nodes keyed by
`sensorData[<unit_address>]`.

### The safeguard
A **"Configuration Status"** banner at the top of the Joint Config tab. The
behaviour change is that a saved-but-not-applied joint is no longer monitored;
before this it was, accidentally. That must announce itself — *"2 joint(s) saved
but NOT APPLIED — these are not being monitored: J07, J08"* — rather than being
discovered when a joint turns out to have been unwatched. It also carries the
channel-collision and uncommissioned-slave warnings.

**Before deploying, check the live panel for draft-only joints.** If any exist,
they are being monitored today and will stop being monitored after this — the
banner will name them, but they should be applied first.

**Live-verified on the Pi (2026-09-01).** The Configuration Status banner reads
*"✓ 5 joint(s) monitored — configuration applied and in sync"*. The count
reconciles against the Modbus Settings table: six commissioned slaves (Sensor1,
AmbientT@101, Sensor2 on bus1; Sensor3-5 on bus2) minus the ambient reference,
which is not a joint. Green also confirms no channel collisions, no joints on
uncommissioned slaves, and — the migration risk flagged before deploying —
nothing saved-but-not-applied, so repointing ProcessLogic stopped monitoring
nothing.

Noted from the same screen, not a fault: the panel's only ambient (unit 101)
sits on **bus1**, while three joints are on **bus2**. Ambient resolution is by
unit address and so is bus-agnostic, but a bus1 Nano failure would leave those
three joints without an ambient reference. The resolver degrades correctly —
`source:"none"`, ΔT simply not computed, no false alarm — but ΔT monitoring on
half the panel is lost. A second ambient on bus2 would remove the dependency and
would also give the zone/panel median fallback something to fall back to; worth
raising at commissioning rather than changing here.

## 2026-09-01 — Channel IS recoverable from the frame, and a live defect found

Asked to explore whether `(slave id, start address, data length)` can identify
the channel and map it to a sensor data object. Written up in
`docs/channel-decode-proposal.md`. **Not built** — it is the live measurement
path.

**Yes, and the frame already carries more than enough.** `compileNanoJob` emits
one contiguous read per slave, so a 4-channel module's four values all arrive in
one frame; the decode path simply discards them. The mapping is not the triple,
though — it is an index into `val` computed from the configuration:
`val[channel_addrs[k-1] - sa]` for the sparse layout, `val[(k-1)*word_count]`
for the consecutive one, both exact inverses of `readSpan`. **R15 turns out to
be precisely the invariant that makes this well-defined** (min == base,
addresses unique and non-overlapping, length == channels), so no schema change
is needed. `sa`/`len` earn their place as a **consistency check** rather than a
key: a mismatch means the Nano is still running a previous job, and the frame
should be discarded rather than decoded against the new configuration.

### The defect
`function 18`, immediately upstream of ProcessLogic, is
`validateValue(msg.payload.val / 100)`. `val` is an **array**. Dividing it
coerces through `toString()`:

- `[2543]/100` → `"2543"/100` → **25.43** — single channel works *by accident*;
- `[2543,2601]/100` → `"2543,2601"/100` → `NaN` → **0**.

Verified by direct evaluation. **A multi-channel slave reads 0 °C**, and
`validateValue` turns the NaN into a plausible zero rather than a fault, so it
would present as a cold joint rather than an error. The panel is unaffected
today — all six commissioned slaves are single-channel — but multi-channel
commissioning has been offered in the Modbus Settings dashboard since
2026-07-14 and the schema allows eight. The first multi-channel module
commissioned would read zero.

Same line, smaller: `/100` is hardcoded while the schema carries per-slave
`registers.temp_scale` (1 / 0.1 / 0.01), so any module that is not
centi-degrees is already mis-scaled.

### Why it is a proposal and not a commit
The fan-out (one frame → one message per channel) changes message shape for
everything downstream, and the weight is the **~40 legacy nodes keyed
`sensorData[<unit_address>]`** feeding Diagnostics, the alert/SMS nodes and the
legacy dashboards. They all need finding and changing together. The proposal
sequences it so steps 1–2 (fix the scaling and array bug; build the decoder
emitting a single channel-1 reading) are byte-identical on this panel and safe
live, while steps 3–4 (fan-out, then the `(slave, channel)` joint key) want a
bench run against real multi-channel hardware — which does not exist here yet.

## 2026-09-01 — Channel decoder built (steps 1-2); fan-out still pending

Panel confirmed to be a **test environment**, with a multi-channel sensor
creatable on request — so the fan-out is no longer blocked on hardware, only on
migrating the legacy `sensorData` readers. Steps 1-2 of the proposal are built
now because they need no hardware and close the 0 °C trap.

`src/config-service/channel-decode.js` (`decodeFrame`, on
`busductConfigService.channelDecode`) decodes a Nano read frame into per-channel
readings: slave looked up by unit address in the applied document, channel
recovered as an index into `val` (`channel_addrs[k-1] - sa`, or
`(k-1)*word_count`), scaled by that slave's own `temp_scale`/`temp_offset`.
`function 18` — now **"Scale Nano Reading"** — is thin over it and still emits a
single channel-1 reading, so behaviour on this all-single-channel panel is
unchanged except that the scale is no longer hardcoded.

### Three things worth recording
**Rounded to milli-degrees.** `raw * scale` is not exact in binary floating
point: `254 * 0.1` is `25.400000000000002`. The old `/100` happened to avoid it
because dividing by an integer is clean. That noise would have travelled into
the historian, the BMS registers (×10 int16) and every alarm description, so the
result is rounded to three decimals — far finer than any sensor here resolves.

**Stale-job detection.** A frame whose `sa`/`len` disagree with the applied
config was produced by a *previous* job — the window between an apply and the
resend landing. It now warns rather than being silently decoded against the new
configuration. This is what the `(id, sa, len)` triple is actually good for; the
channel itself comes from the config, not the triple.

**Fail-safe twice over.** An uncommissioned unit still yields its first value on
the legacy scale rather than being dropped, and the flow node falls back to
`val[0] / 100` if the library fails to load. A monitoring panel must not go
blind because a config has not converged or a `require` failed.

A multi-channel slave now shows *"unit N: 4 channels, only ch1 used"* on the
node status — the other channels are decoded correctly by the library but not
yet delivered anywhere. That stays visible until step 3.

**Test note:** the first flow assertion matched the node's own explanatory
comment rather than its code — the third time that mistake has been made today.
The check now strips comment lines first.

## 2026-09-01 — Honouring `temp_scale` broke the panel; reverted to report-only

Reported minutes after deploying the decoder: **"Sensor value out of valid
range" on every joint**. My regression, and an instructive one.

`tools/migrate-legacy-config.js:60` writes `temp_scale: 0.1`, with its own
warning attached: *"legacy data does not record scaling, verify against the
sensor datasheet"*. The legacy pipeline hardcoded `/100` and never recorded the
divisor, so the migration had to guess — and guessed wrong for this hardware,
which is centi-degrees. A joint at 31 °C (raw 3100) decoded as **310 °C**, past
ProcessLogic's 300 limit, so every joint raised `SENSOR_FAULT` simultaneously.

**Nothing had ever read that field.** The wrong value sat in the applied
configuration from migration onwards, undetected, until the decoder became its
first consumer. The migration tool's warning was correct and had simply never
been acted on.

### Fix
`useConfigScale` is now **off by default**. Readings decode on the legacy `0.01`
exactly as before; a configured scale that disagrees is **reported, not
applied**. The opt-in path is built and tested, so a panel whose Scale column
has been checked against the datasheets can switch it on — but no panel gets
that behaviour by inheriting a guess.

The array-indexing fix, which was the actual find, is unaffected and stays.

### A second bug the fix created
The mismatch warning is true of *every frame from that unit, forever* — about
12 log lines per second on a six-slave panel, into the SD card that the
historian and the outbox share, which we had added disk monitoring for hours
earlier. Throttled to once per unit per five minutes, and pinned by a test that
also asserts the flow never opts into the configured scale.

### The general lesson, recorded because it will recur
**A config field that nothing reads is not "unused" — it is unverified.**
Migrating a value nobody consumes records a guess with the authority of a
measurement. The first consumer of any such field should default to the previous
hardcoded behaviour and report the difference, rather than assume the stored
value is right. Other fields in the same position worth suspecting before
anything starts reading them: `temp_offset`, `temp_word_count`, `function_code`,
and `poll_interval_s`.

**Live-verified on the Pi (2026-09-01).** The SENSOR_FAULT storm cleared on
deploy and no new alarms appeared. "Scale Nano Reading" shows yellow with the
unit address, the correct temperature to two decimals, and `(1 warn)` — the
scale mismatch being reported rather than applied, which is the designed
behaviour, not a residual fault.

**Remaining action, on the panel not in code:** set the **Scale** column to
`0.01` on all six rows in Modbus Settings and Apply. That records what the
hardware actually does instead of the migration's guess; the warning then stops
and the status goes green. Safe on a live panel — `compileNanoJob` builds the
Nano job from `unit_address`, `temp_base_addr` and `readSpan` only, so
`temp_scale` is not in the compiled job and changing it triggers no resend.

## 2026-09-01 — Channel fan-out built (steps 3-4)

Steps 3 and 4 of `docs/channel-decode-proposal.md`: "Scale Nano Reading" now fans
a frame out into one message per channel, `buildProcessLogicJoints` keys rows by
`(unit address, channel)`, and ProcessLogic matches on both. The "lowest channel
wins" compromise and its warning are deleted.

### My blast-radius estimate was wrong, and that is the headline
I said this needed ~40 legacy nodes keyed `sensorData[<unit_address>]` migrated
together. Reading them instead of inferring: **`sensorData` is already keyed per
channel.** The legacy `/100` node writes `sensorData[sID][sAddr]` — unit address,
then *register* address — and readers do `global.get('sensorData[1][3]')`. Since
`channel_addrs` are register addresses, that structure already distinguishes
channels. **None of those 28 nodes needed changing.**

Exactly one path ever lost the channel: `Data Out → json → Scale Nano Reading →
ProcessLogic`, which collapsed a frame into a single coerced number. So the
fan-out is contained to that node and its consumer, and the "nested vs composite
`sensorData` key" question was moot.

The estimate came from a note in CLAUDE.md that was describing a *different*
concern (per-bus address uniqueness), taken at face value rather than checked
against the flow. Measure before quoting.

### A second bug of mine, found the same way
The legacy node handles sign: `ip < 32767 ? ip/100 : ((65535-ip)/100)*-1`. My
decoder did not. Modbus registers arrive as **unsigned** 16-bit words, so a
sub-zero reading comes back near 65535 and decoded as **~+650 °C** — straight
past ProcessLogic's 300 limit, turning a cold ambient into a sensor fault. Now
proper two's-complement (`(w & 0xffff) << 16 >> 16`), which also fixes the
legacy's off-by-one: raw 65136 is −4.00 °C, not −3.99.

### Compatibility
- A message with **no `channel`** is read as channel 1 — messages in flight
  across a deploy, and the library-missing fallback path. Every slave on this
  panel is single-channel, so it is also the correct reading.
- The **channel-1 ambient keeps its original `AMBIENT_<unit>` id**; only
  channels 2+ get `AMBIENT_<unit>_<channel>`. Historian tags and any alarm
  already raised against an existing ambient are untouched.
- A channel the frame did not carry is emitted as `st:'err'`, **not** as `0` —
  a zero would read as a cold joint, which is the failure this whole change
  exists to remove.

### Verified in simulation, not on hardware
End to end with a 3-channel module at **sparse** addresses 100/104/108: compiled
span 9 registers, frame of 9 values, three joints matched to their channels, one
of them sub-zero, no warnings. Sparse deliberately — a consecutive layout would
decode correctly even if the indexing were subtly wrong. **It has never met a
real multi-channel module**, which is the remaining gate.

**Live-verified on the Pi (2026-09-01), single-channel only.** Steps 3-4 deployed
with no abnormalities: readings unchanged, no new alarms, Diagnostics unaffected
(it feeds off the legacy `sensorData` chain, which the fan-out did not touch),
Configuration Status still green at 5 joints, ΔT unbroken across the ambient
key change from `101` to `"101:1"`.

That confirms the change is **transparent on single-channel hardware**, which is
what this panel has. It does **not** confirm the multi-channel path — every slave
here has one channel, so the fan-out emitted exactly one message per frame
throughout and the indexing was never exercised. The multi-channel behaviour
remains verified in simulation only (sparse addresses 100/104/108, three joints,
one sub-zero) and still needs a real module.

Left in place deliberately: the pre-change `latest_ambient_state` entry under the
bare key `101`. It can never be written again and the 60 s freshness check
rejects it permanently, so it is inert; pruning it would have meant a third
change to the live measurement path in one day for tidiness alone.

## 2026-09-01 — Repoint lost the joint name from alarm e-mails

Reported from the panel: the e-mail body read `Joint: J02` again, having shown
`J02 (Dc/07/Fl_0/Tx/Line_1)` before the pull. My regression, from repointing
ProcessLogic at the applied document.

**The joint-table apply never persisted the name.** `joint-master-handler.js`
built each applied joint as `{joint_id, slave_id, channel, zone_id, enabled,
threshold_profile}` — no `label`, despite the schema having the field and the
dashboard making the name a **mandatory** column. So the operator's name existed
only in the legacy draft. Reading the draft, ProcessLogic picked it up; reading
the applied doc, there was nothing to pick up, `buildProcessLogicJoints` fell
back to the joint id, and `jointLabel()` correctly rendered just `J02` because
name and id were equal.

Exactly the same shape as the `temp_scale` break earlier today, inverted: there,
a field nothing read held a wrong value; here, a field nothing wrote held
nothing at all. Both were invisible until something started reading them.

### Fix, in two parts
1. **`applyJoints` now writes `label: j.joint_name`.** The name belongs in the
   applied configuration like everything else the panel runs on.
2. **`buildProcessLogicJoints(doc, { labelFallback })`** recovers the name from
   the draft for documents applied *before* this fix — otherwise the name would
   stay missing until every operator happened to re-apply. A persisted `label`
   always wins; the fallback is a stopgap, not a second source of truth. This is
   the same recovery the Modbus Settings handler already does for slave labels
   on panels migrated before that field existed.

So the e-mails are correct again on the next deploy with no operator action, and
the config self-heals on the next joint-table apply.

**Also visible in the same debug capture, and unrelated:** the SMTP send failed
with `getaddrinfo ENOTFOUND relay.go…`. The alarm pipeline is producing the mail
correctly; the panel cannot resolve the relay hostname. That is DNS or the mail
host setting, not the alarm path.

## 2026-09-01 — Panel & Uplink tile froze on its first snapshot

Reported from the panel: the tile's timestamp only advanced when the browser page
was reloaded. My bug, and not a cosmetic one.

The template did `<div ng-init="s = msg.payload.system">` and then bound `s.*`
throughout. **`ng-init` evaluates once, when the element is created, and never
again** — so `s` held the first snapshot forever. Reloading the page
re-initialises the template, which is exactly the symptom described.

On a HEALTH display that is worse than a cosmetic freeze: the tile would have
kept showing *"✔ Panel healthy"* with a strong Wi-Fi reading long after the link
degraded, the disk filled or the clock lost sync. The one thing it exists to do
is tell a technician the CURRENT state, and it was showing a photograph.

Replaced with `scope.$watch('msg', …)` in the template's script block — the same
pattern the alarm tables already use. The Config Drift Banner was unaffected: it
binds `msg.payload.*` directly, which Angular re-evaluates on every digest.

**Test-writing note, worth recording because it happened four times today:** the
first guard asserted `!/ng-init/` against the template, which failed on the
replacement's own explanatory comment ("MUST be a `$watch`, not `ng-init`"). The
check is now for the ATTRIBUTE `ng-init=`. Matching prose instead of code has
now produced a false failure in the config sweep, the decode node, the joint-name
guard and here — when pinning "X is gone", assert on the syntax, not the word.

## 2026-09-01 — Multi-channel live-verified on the panel

A `LEGACY-4CH` module commissioned at unit address 6, four joints on registers
3/4/5/6, alongside eight single-channel slaves and the ambient at 101. Banner:
*"✓ 9 joint(s) monitored — configuration applied and in sync"*. Diagnostics
showed all four channels distinctly (31.06 / 36.06 / 41.06 / 46.06), and the KPI
stream for channel 2 read:

```jsonc
{ "joint_name": "multich_1", "joint_id": "J07", "zone_name": "Zone1",
  "slaveID": 6, "channel": 2, "val": 36.12, "emaTemp": 36.09, "ror": 0.187,
  "ambient": { "slaveID": "101:1", "val": 31.72, "age_sec": 0, "source": "configured" },
  "deltaT": { "raw": 4.4, "ema": 4.18 }, "sensor_status": "ok" }
```

One message confirming everything at once: the fan-out delivering channel 2 as
its own reading, the `(unit, channel)` joint match, the composite ambient key
`"101:1"` resolving through the R14 chain, ΔT computed per channel, and
`joint_name` persisted by the joint-table apply — so the label fix from earlier
today is confirmed by the same capture.

**What is still NOT proven: the sparse layout.** This module's channels are
*consecutive* from the base address, which is precisely the branch that would
decode correctly even if the `channel_addrs` indexing were wrong. A module with
non-consecutive addresses (e.g. 100/104/108) remains simulation-only. Worth
saying plainly rather than letting a successful 4-channel run read as "the whole
feature is proven".

Checked while reviewing the capture, and fine: `sensor_status` arrives lowercase
`"ok"`, and `influx-points.js` already compares case-insensitively with a comment
explaining exactly this, so the historian is not silently dropping readings.

## 2026-09-01 — Blacklist description now follows the joint mapping

Reported from the panel: slave 6 carries four joints since the multi-channel
commissioning, but its blacklist alarm read *"joint(s) J06 not measurable"*.

**The lookup was never wrong.** `jointsForSlave` already filters, and a fresh
blacklist with four joints mapped produces
*"Slave 6 (Sensor6) blacklisted after 3 consecutive read failures; joint(s) J06,
J07, J08, J09 not measurable"* — verified directly. The history entry was a
**snapshot artifact**: it was raised at 16:54:55 when only J06 was mapped (its
text says "Slave 6" with no "(Sensor6)" label, so the slave row was mid-edit),
and the multiCh_1/2/3 comm alarms first appear at 16:58:54, when J07–J09 were
applied. The description was correct when written and never revisited.

That is still a real gap: commissioning channels onto a device that is *currently*
blacklisted is exactly what a test panel does, and the alarm then understates the
impact permanently.

### Fix
`refreshBlacklistDescriptions` re-derives the impact on every tick for slaves
still `blacklisted`, emitting `action:'update'` only when it changes. The Alarm
Manager rewrites the text in place — same instance, same `raisedTs`, same ACK
state, same history entry, **no e-mail**. A re-raise would have reset the
acknowledgement and mailed everyone again for a device that never changed state.

`probing` slaves are deliberately excluded: probing means the device is back in
the scan and may recover within seconds, and its alarm is about to clear anyway.

### Two details that took a second pass
**Memoise the impact, not the description.** The raise text says "blacklisted
after N consecutive read failures" and the refresh says "blacklisted", so
comparing full strings never matched and every tick would have emitted an
update. Both paths now share one `impactFor()` helper, and the memo keys on its
output.

**Skip a slave raised on the same pass.** The refresh runs inside the same
`_finalize` as the raise, so without a guard every blacklist emitted a raise
immediately followed by an identical update. Caught by an existing test
asserting `alarms.length === 1`.

### Test-fixture note
My first regression test for the restore-then-re-blacklist case never actually
restored the device — the ticks never reached the 30 s probe backoff, so it
stayed blacklisted and the test proved nothing while passing its own premise.
It now asserts `status === 'active'` before re-blacklisting. Same class as the
device-health fixture that held `busSeen` fixed while advancing the clock: a
fixture that does not reach the state under test is worse than no test.

**Live-verified on the Pi (2026-09-01).** Cleared Alarm History shows the
refreshed text — *"Slave 6 blacklisted; joint(s) J06, J07, J08, J09 not
measurable"* — on the alarm that was raised when only J06 was mapped, with the
historian copy rewritten in step. The earlier 16:54:55 entry keeps its original
single-joint text, correctly: that was a different alarm instance.

**Small information loss, noted not fixed:** the update text drops the *"after N
consecutive read failures"* clause the raise carries, because the two prefixes
differ by design. Once an alarm has been updated, the history no longer records
how many failures triggered the blacklist. The count is still in the tracker and
could be carried into the update prefix; left alone for now rather than spending
another deploy cycle on it.

## 2026-09-01 — Sticky column headers on the config and diagnostic tables

Asked from the panel: keep the column titles visible when scrolling. On a table
with a row per joint or channel the titles leave the screen first, which is
exactly when they are needed.

**The pattern already existed here.** Alarm History and the BMS Register table
both do bounded wrapper + `th { position: sticky; top: 0; background: … }`, so
this follows that rather than inventing a second approach. Applied to:

| Table | What was missing |
|---|---|
| JointMasterUI | wrapper + sticky |
| ModbusSettingsUI (slaves) | wrapper + sticky |
| Diagnostics "modbus data" | wrapper + sticky |
| Active Alarms | sticky only — its `.table-wrap` was already bounded at 70vh |

Active Alarms is the interesting one: it had the scrolling wrapper all along but
its `th` rule set only colour and cursor, so it was the one alarm table whose
header did not pin while its sibling's did.

### Two details that decide whether this works at all
**The panel is already a scroll container.** `.bms-panel`/`.mbs-panel` carry
`overflow-x: auto`, and per CSS an `overflow` of `visible` on one axis computes
to `auto` when the other is not `visible` — so the panel scrolls on *both* axes.
A sticky `th` therefore binds to the panel, and if the panel has no bounded
height it never scrolls vertically and the header does nothing. Hence the inner
`*-wrap` div with an explicit `max-height`, which is what the alarm tables were
already doing.

**The background must be opaque.** A sticky header with a transparent
background has the rows scroll visibly through it. And `box-shadow: inset 0 -1px
0` replaces `border-bottom`, because under `border-collapse: collapse` the
collapsed border is painted on the cell edge and does not travel with the sticky
element.

Heights are `min(50vh, 250px)`-style rather than plain `vh`: the config cards are
7-8 units tall (~370-420 px), so a bare `60vh` would exceed the card on a normal
screen and the card, not the wrapper, would end up scrolling — putting us back
where we started. The `vh` half keeps it sane on a short screen.

**Not verified visually from here** — this is CSS and there is no way to render
it in this environment. Structural checks only: div balance, wrapper present and
bounded, sticky present with an opaque background, on all six tables.
**Confirmed working on the device (2026-09-01)**, so the `min(vh, px)` heights
sit correctly inside the 7-8 unit cards and no height tuning was needed.

---

## 2026-09-05 — Field calibration check on J10, and a one-sided plausibility gate

> **STATUS: the code change is HELD, not deployed (user, 2026-09-05).** The
> panel in the screenshot **is not running current code**, so the J09/J19
> readings below cannot be attributed to the current decode path. The gate fix
> is committed and tested because the defect is visible in the source
> independently of any device — but it is **not field-validated**, and the
> reading provenance claims in "The defect the same screenshot showed" are
> weaker than first written. See the correction at the end of this entry.

A Fluke 87V with a thermocouple was put against J10 while the panel showed
**131**; the meter read **132.0 °C**. First independent reference check the
system has had, and the first at a temperature far above the working band.

**What it establishes.** No gross scale error, no sign error, no offset drift,
and the `0.01` decode scale is right at a high reading. That is a real result:
the wrong `temp_scale` of `0.1` this panel carries in its applied config would
have displayed 1310, and the array-coercion bug fixed on 2026-09-01 would have
displayed 0. It also exercises the sign-extension path indirectly — a reading
this far from zero would expose a mis-set word count.

**What it does not establish.** That the sensor is accurate to 1 °C. The
reference is not that good: the 87V's temperature function is roughly ±1 % of
reading plus 1 °C, and a bead-type K probe adds about ±1.1 °C or 0.4 %, so the
reference's own combined uncertainty at 132 °C is on the order of ±2.5–3 °C. The
honest statement is **the two agree to within the reference's uncertainty** —
which is the most a working multimeter can give, and is what was wanted.

Two things were not recorded and should be next time, because they change what
the number means:

- **Where the probe sat.** On the mounting plate beside the sensor element, this
  validates the sensor. On the busduct surface under the magnet, it validates
  the whole mounting chain including the 0.25 mm gap — a far more valuable
  claim, and the transfer function D3 needs.
- **Whether the two readings were simultaneous and settled.** At 131 °C on a
  bench heat source, a minute's drift is several degrees.

### The defect the same screenshot showed

On the same Grafana panel: **J19 read −273** and **J09 read exactly 0**, while
every neighbour read 27–31 °C against a 33.8 °C ambient. Neither is a
temperature. −273 is absolute zero and 0 is register `0x0000` — both are
standard module sentinels for *no sensor attached*.

They were being carried through as measurements. ProcessLogic's gate was

```js
else if (sensorVal > 300) sensor_status = "Sensor_Error";
```

**one-sided.** Nothing rejected an implausibly *low* value, so a dead channel
presented as a healthy **cold** joint: ΔT deeply negative, so no ΔT alarm; the
step down is a falling transient, so no RoR alarm; and the joint is still in the
applied config, so the decommission sweep leaves it alone. Two joints silently
unmonitored, indistinguishable on the dashboard from two cool ones.

**This is the same failure shape as the detachment hazard in the HIRA** (STATUS.md
D2): an unmeasurable joint that reads as a safe one. It arrived by a different
route — a dead channel rather than a fallen sensor — which is the argument for
treating "reads implausibly cool" as a fault class rather than patching each
cause as it appears.

**A detection was also lost on 2026-09-01 without anyone noticing.** An
open-circuit module reporting −27300 centi-degrees decoded UNSIGNED as **+382**,
which tripped `> 300`. Reading it as two's complement is arithmetically correct
— that fix stands — but it moved the value from the caught side of a one-sided
test to the uncaught side. A correct fix to one component silently disabled a
check in another. Worth remembering when a decode changes sign, range or units:
**ask what downstream thresholds were catching the old representation.**

### The fix

The gate is now two-sided, `SENSOR_MIN_C = -40` to `SENSOR_MAX_C = 300`, plus an
explicit non-finite check. −40 °C is the conventional industrial floor and sits
far below any panel this ships into, so it cannot reject a real reading. The
ambient path has had this shape — plausibility band plus a zero sentinel — since
2026-07-28; this brings the joint path level with it. **The upper limit is
untouched**: this completes an existing check rather than retuning an alarm
threshold.

**J09's exact zero is deliberately still accepted.** 0 °C is a real temperature
in an unheated panel, and a blanket rejection would be wrong for a cold site.
The ambient resolver can reject it because an *ambient* of 0 in a switchgear
room is not physical; a joint has no such guarantee. Discriminating a dead
channel from a genuinely cold one needs the sustained-near-ambient/negative-ΔT
rule already queued as **D2**, which is a new alarm rule and therefore a
design-chat decision, not something to slip in under a bounds check.

So J19 will now fault; **J09 will not**, and needs the panel to say whether it is
a dead channel or a fabricated zero — `validateValue(value, defaultValue = 0)`
in the legacy chain defaults missing data to 0, so the value may never have come
from the sensor at all. Check `global.sensorData[<unit>][<reg>]` for J09's
channel: absent means fabricated, present-and-zero means the module is sending
the sentinel.

### Correction (same day): the device is not on current code

The panel in the screenshot is running an **older build**, which invalidates part
of the reasoning above and needs separating from the part that survives.

**What no longer stands.** That J19's −273 is *what the current decode produces*.
That was an inference from a screenshot taken on an unknown code version, stated
as though it exercised the two's-complement path added on 2026-09-01. It did
not. By the same token the claim that the sign fix "moved the value from the
caught side of a one-sided test to the uncaught side" is sound as *reasoning
about the current source*, but this screenshot is not evidence for it.

**What still stands, and does not depend on the device at all.** The gate is
one-sided in the source:

```js
else if (sensorVal > 300) sensor_status = "Sensor_Error";
```

That is readable in `flows_BBT.json` without any panel. An unbounded low side on
a fire-safety monitor is a defect whether or not this screenshot showed it, so
the fix is kept — but **held, not deployed**, pending a look at the same joints
on current code.

**And one conclusion is actually stronger than before, because it is
version-independent.** Both candidate decodes converge on the same raw register:

| Decode | Arithmetic on raw `0x955C` (38236) | Result |
|---|---|---|
| Legacy `sensorData` writer | `((65535 − 38236) / 100) × −1` | **−272.99** |
| Current `channel-decode.js` | `(38236 − 65536) × 0.01` | **−273.00** |

They differ by 0.01 °C — the off-by-one already noted in `channel-decode.js`.
So whichever build produced the display, **the module is genuinely transmitting a
raw value that means −273 °C**, and that is a sentinel, not a measurement. The
practical consequence: **updating the code will not make J19 read sensibly.** It
should still show ≈ −273, changing only in the second decimal. If it changes by
more than that, the decode is not what either path predicts and that is a
separate finding worth chasing.

**What the update *will* change** is whether −273 is *classified* as a fault
rather than displayed as a temperature — which is the whole point of the gate
fix, and the thing to confirm once it is deployed.

**J09's exact 0 remains genuinely ambiguous** and the update does not settle it
either: `validateValue(value, defaultValue = 0)` fabricates a zero for missing
data, so it may never have come from the sensor. The check is unchanged —
inspect `global.sensorData[<unit>][<reg>]` for J09's channel: absent means
fabricated, present-and-zero means the module is sending the sentinel.

**The lesson.** A screenshot dates the *display*, not the *build*. Reading a
field observation as confirmation of current-code behaviour needs the version
established first — and the version was never asked for. The habit that would
have caught it is the one already recorded against the commercial building in
STATUS.md: **record what code a deployment is running before drawing conclusions
from what it shows.** That was written about the other site and not applied to
this one.

---

## 2026-09-07 — HMI latency at 71 devices: measuring instead of guessing

Panel ESBUSBBT06, 71 devices, slow HMI. `ps`/`vmstat` from the panel:

```
%CPU %MEM   RSS COMMAND          procs -----io---- -------cpu-------
 100  4.2 339868 node-red         r  b   bi   bo   us sy id wa
79.5  3.7 299192 chromium         9  0    0  232   53 10 36  1
34.2  1.9 154040 chromium         6  0   50  284   57 12 31  0
14.0 15.5 1247020 influxd         1  0    0   96   55  8 37  0
 6.7  1.3 108440 Xorg             6  0  326  742   51 11 37  1
 5.5  1.0  83648 orca
```

**`wa` ≈ 0 and `b` = 0, so the SD-card theory is dead** — this is CPU in user
space, not I/O. (Worth having checked: Linux load counts uninterruptible disk
wait, so load 5.2 alone could not distinguish the two.)

**node-red is at 100 %, and Node.js is single-threaded — that IS its ceiling.**
One core fully consumed, no headroom, so every HMI message queues. That is a
direct and sufficient explanation of the symptom. Chromium is second at ~125 %
across four processes: a browser rendering the dashboard **on the Pi itself**.
`orca`, a GNOME screen reader, is burning 5.5 % on a kiosk panel for nothing.

### Two guesses, both wrong, before any measurement

Recorded because the pattern is the point, not the answers:

1. **"The Alarm Manager stringifies the whole alarm history on every reading."**
   True, and it looked like an O(history) × O(rate) cost — until the same file
   turned out to cap the history at 100 entries (`splice(0, 50)` at 100). Bounded
   and small.
2. **"The legacy InfluxDB feeder reads every joint and writes on every frame."**
   It does read 11 joints and write per message — but its upstream `delay` node
   is `pauseType: rate`, 1/second, `drop: true`. Throttled since long before this.

Both were plausible readings of the flow graph. Both were false. **Reasoning
about a flow's shape kept producing confident wrong answers**, which is what
prompted building a measurement instead.

### The measurement

`tools/bench-hot-path.js` lifts the four function nodes a frame actually
traverses out of `flows_BBT.json` and runs them against a synthetic panel:

| Devices | Alarm Mgr | ProcessLogic | Blacklist | Scale | **Total/frame** |
|---|---|---|---|---|---|
| 9 | 43.8 | 6.0 | – | – | **56.8 µs** |
| 25 | 41.1 | 7.7 | – | – | **56.8 µs** |
| 71 | 41.2 | 10.5 | – | – | **58.9 µs** |
| 110 | 60.0 | 20.0 | – | – | **92.4 µs** |

**Per-frame cost is roughly flat in device count** — it does not blow up on the
way to 110. And the absolute number is nowhere near a core: at 200 frames/s,
~2 % of one core on this machine, so perhaps 7–11 % on a Pi 4 (3–5× slower for
JS). **The flow's own logic is not what is pegging Node-RED.** The Alarm Manager
is still the largest single node at ~70 % of that total, so it is the right place
to optimise *if* the total ever matters — but today it does not.

That leaves the Node-RED runtime itself: per-message cloning and routing across
~30 nodes per frame, `node.status()` and debug-node traffic to any open editor,
and the dashboard's socket.io fan-out to every connected browser. The
node-red-at-100 % / chromium-at-125 % / 20 k context-switches-per-second triple
is consistent with a Node-RED ↔ browser ping-pong, but that is a hypothesis and
**the next measurement, not a conclusion.**

### A cost of my own, noted

`node.status()` at the end of "Scale Nano Reading" (added 2026-09-01, for the
per-channel readout) runs on **every frame**, and Node-RED publishes every status
change to all connected editor sessions. Not a core's worth, but it is per-frame
work that did not exist before, and it should be throttled to ~1/s regardless of
how this investigation ends.

### The benchmark's own first result was a lie

Its first run reported the Alarm Manager at **0.0 µs** — because ProcessLogic
returns `[null,null,null]` at `if (!cfg?.ror?.timeWindowMin)`, and the synthetic
config had `timeWindowMin` at the top level instead of under `ror`. The node
never ran, and "never ran" measures as free. The harness now counts invocations
and prints `!! NEVER INVOKED (not a measurement)`.

**This is the third time in this project a fixture has silently failed to reach
the state under test** (device-health `busSeen`, blacklist probe backoff, now
this). The guard is cheap and belongs in any harness whose output is a number:
**assert the code ran before believing what it cost.**

### Control panel: 6 sensors / 10 joints, load 1.86

A second panel (Wi-Fi `TLD_SC_5G`, uptime **5d 3h**) with only **6 sensors and 10
joints** reports **load 1.85 / 1.89 / 1.86 on 4 cores**, CPU 60.4 °C, "Panel
healthy". Steady over five days.

Two points, same software family:

| Devices | Load (4 cores) |
|---|---|
| 6 | **1.86** |
| 71 | **5.20** |

Naively that is ~1.9 fixed plus ~0.05 per device, which extrapolates to **~7.4 at
the 110-device target** — comfortably past 4 cores. Treat that as indicative
only: two different machines, possibly different code versions, and the 71-device
panel was additionally running a local Chromium at ~125 % that this one may not
be. It is a reason to measure, not a prediction to design against.

**The more interesting half is the intercept, not the slope.** A panel with six
sensors sitting at load 1.86 for five days means **most of the cost is not the
sensors** — it is the constant stack (Node-RED, InfluxDB, Grafana, X, any local
browser) ticking over. Halving that baseline would buy more headroom at 110 than
optimising anything on the per-frame path, which the benchmark has already shown
costs ~60-90 µs.

This also constrains the earlier frame-rate hypothesis. The Nano loops
continuously through its read list, so **total frames per second is bounded by
bus speed and is roughly independent of how many slaves are on it** — more slaves
means each is polled less often, not that more frames arrive. If that holds, the
6- and 71-device panels see similar message rates, and the load difference must
come from per-message work that scales with panel size (ProcessLogic's O(n) joint
lookup, and dashboard tables carrying 71 rows instead of 10) rather than from
message rate. **Unverified** — the clean way to settle it is the same `ps` and
`vmstat` from this panel, which turns a one-panel snapshot into a controlled
comparison.

### The configured poll interval never reaches the device

`top` on panel **ESBUSBBT04** (the 6-sensor / 10-joint panel):

```
Cpu(s): 25.7 us, 4.7 sy, 0.0 ni, 64.3 id, 4.7 wa
 738 root  20  0 2322220 284516 49864 R  63.6  3.6  4d+5h node-red
 738 root  20  0 2322220 284516 49864 R  79.7  3.6  4d+5h node-red
 738 root  20  0 2323244 284812 49864 R  80.1  3.6  4d+5h node-red
```

**node-red is at 64-80 % of a core on a panel with six sensors**, and its TIME+
of **4d 5h against 5d 3h of uptime** says it has averaged ~82 % of a core
continuously since boot. The 71-device panel showed the same process at 100 %.

**So Node-RED's cost is very nearly independent of device count.** The load
difference between the two panels (1.86 vs 5.2) was mostly the *other* processes
— Chromium at ~125 %, Xorg, orca — not the sensors. The per-device scaling model
from the previous entry was wrong, and the benchmark's "flat in device count"
result was pointing at this the whole time.

#### The mechanism, confirmed in the compiler and the firmware

`compileNanoJob` emits exactly one rate control:

```js
const comm = [Math.round(bus.inter_frame_ms * 1000), bus.baud, bus.timeout_ms];
```

and `Nano_IOT.ino` applies it as `pollingDelay(Polling)` between transactions,
looping its read list continuously. There is **no per-slave scheduling in the
firmware at all.**

Meanwhile the schema carries `slaves[].poll_interval_s` (**default 30 s**), the
Modbus Settings dashboard shows it as a per-slave column, and **R10 validates
it** — "worst-case scan time per bus must fit within the shortest
`poll_interval_s` on that bus". R10 checks the sweep *fits*; nothing then waits
out the remainder of the interval. So the operator sets a poll interval, the
validator confirms it is satisfiable, the dashboard displays it — and the device
never receives it.

At the schema default `inter_frame_ms` of 20 ms (the firmware's own default is
1.7 ms, lower still), with a ~11 ms transaction at 19200 baud:

| Slaves | Sweep | Frames/s | Each slave polled | vs 30 s configured |
|---|---|---|---|---|
| 6 | 0.19 s | ~32 | every 0.19 s | **162× too often** |
| 71 | 2.20 s | ~32 | every 2.20 s | **14× too often** |

**The frame rate is the same either way** — it is bounded by bus speed, not slave
count — which is exactly why both panels load Node-RED equally. Every downstream
consumer (ProcessLogic, Alarm Manager, historian writes, dashboard updates, BMS
image) runs at that rate instead of the intended one.

**This is the third instance of the same class of defect in this project**, after
`temp_scale` (migrated as a guess, never read until it broke the panel) and the
one-sided plausibility gate. A field that is *validated and displayed but never
actuated* is worse than one that is absent: R10 passing gives positive evidence
that the setting is in force.

#### Status: hypothesis, not conclusion

That the over-polling is what consumes the core is **not yet proven** — it is the
only mechanism found that is device-count independent, which is the striking fact
to explain, but three earlier guesses in this investigation were wrong. The test
is cheap and needs no code: **raise `inter_frame_ms` on the RS-485 Buses table and
watch node-red's %CPU.** At 100 ms the frame rate drops ~4× (9/s at 19200 baud);
if node-red's CPU does not fall roughly in proportion, this is not the cause
either.

Safe to raise: the serial-silence watchdogs trigger on *no frames at all*, and
frames keep arriving throughout a sweep, so sweep length does not affect them.
The Diagnostics "No Data" expiry is 60 s per device, so the sweep must stay well
under that — at 71 slaves, `inter_frame_ms` up to ~800 ms would still qualify.
Thermal monitoring of a busduct joint does not need sub-second sampling; the
joint's own time constant is minutes.

**The real fix is a design-chat item**, because it is firmware-level: either the
firmware honours per-slave intervals, or the compiler emits a sweep-level delay
so `poll_interval_s` is actually enforced. Until one of those exists,
`poll_interval_s` should not be presented to the operator as if it does anything.

### Full process list from ESBUSBBT04: no browser, and an SD-card wear problem

```
%CPU %MEM     RSS COMMAND          procs ------io----  -system--  ------cpu-----
82.6  3.5  282416 node-red          r  b   bi    bo     in     cs  us sy id wa
50.0  0.0    6708 sudo              4  0   43   993   6608     28  30  6 59  5
13.9 30.0 2403948 influxd           3  0    0   892  15086  27192  26  9 61  4
 1.8  0.4   32512 systemd-journal   2  1    0  1074  15591  27926  34 11 52  4
 1.6  1.3  107936 Xorg              4  0    0   926  15994  28869  24  7 64  5
 1.4  4.6  375180 grafana           6  0    0   852  13477  24024  24  7 65  4
 0.8  2.6  215900 orca
```

**No Chromium on this panel at all.** That confirms the previous entry's reading:
the 71-device panel's extra ~1.25 cores were a local browser, not its sensors,
and node-red's own cost (82.6 % here, 100 % there) is essentially flat in device
count.

#### The new finding: the historian is writing ~0.9 MB/s, continuously

`bo` holds at **850-1070 blocks/s** — roughly **0.88 MB/s sustained**, which is
**~80 GB/day, ~29 TB/year**, on the SD card, from a panel with **six sensors**.
`bi` is ~0 (reads are cached), `wa` sits at 4-5 %, `b` occasionally 1, and
`jbd2/mmcblk0p2-8` — the ext4 journal thread — appears in the top processes.
`influxd` is holding **2.4 GB RSS, 30 % of RAM**.

Disk *space* is fine (35.8 % used). **Wear is not.** A typical industrial SD card
is rated in the low hundreds of TBW, so ~29 TB/year puts card replacement on a
2-5 year cycle — on a device whose whole purpose is unattended fire-safety
monitoring, where the same card holds the historian, the cloud outbox and the
persistent context store. `docs/historian.md` anticipated flash wear in general;
this is the first time it has been measured, and it is an order of magnitude
worse than "background noise".

#### It is the same root cause, if the poll hypothesis holds

At the configured 30 s poll interval, six sensors should produce **12
readings/minute**. Continuous polling produces **~1,900/min** at 20 ms
inter-frame, or **~17,000/min** at the firmware's 1.7 ms default. Every one of
those becomes a Node-RED message, a `bt_kpi` point, and an InfluxDB write. That
single mis-actuated setting would explain node-red's CPU, influxd's CPU and RSS,
the write rate, and the 15 k interrupts / 27 k context switches per second — all
of it, on a panel doing almost nothing.

#### The measurement that settles it, exactly

The historian already holds the answer; no instrumentation needed:

```
influx -database busduct -execute "SELECT count(temp_c) FROM bt_kpi WHERE time > now() - 1m"
```

Six sensors at the configured 30 s interval = **12**. Anything in the thousands
confirms the over-polling and its factor in one number. Then raise
`inter_frame_ms` on the RS-485 Buses table and re-run both that query and `top`:
CPU and write rate should fall in proportion, and if they do not, the cause is
elsewhere and this entry is wrong.

**Note the retention design does not save us here** — `raw` is 7 d, `rollup_1h`
90 d, `rollup_1d` ~5 y (`tools/influx-setup.influxql`). Retention bounds how much
is *kept*, not how much is *written*; every point is written to the card before
any of it is expired, and the continuous queries then read it all back to
downsample. Over-sampling costs full write amplification regardless of how
briefly the data survives.

### CONFIRMED: 297× over-sampling, measured

```
$ sudo influx -database busduct -execute "SELECT count(temp_c) FROM bt_kpi WHERE time > now() - 1m"
name: bt_kpi
time                count
1788784690592430141 3558
```

**3558 points/minute on a panel with six sensors and ten joints.** At the
configured 30 s poll interval it should be **12**. That is **297×**, and it is a
measurement, not an inference.

Each joint is being sampled every **0.17 s** (a 169 ms sweep), against a 30 s
setting the operator chose, the dashboard displays, and R10 validates. **5.12
million points a day instead of 17.3 thousand.** This is the cause of the ~0.9
MB/s of SD writes, and it is consistent with node-red's 82.6 % on a panel that is
otherwise doing nothing.

The hypothesis in the previous two entries is confirmed on its factual half — the
poll interval is not in force, by a factor of ~300. That the CPU falls when it is
corrected is still to be demonstrated, and remains the acceptance test.

#### Interim mitigation, no code

Raise `inter_frame_ms` on the RS-485 Buses table. It is schema-capped at 500 ms:

| Slaves | ifm=500 ms | Sweep | vs now |
|---|---|---|---|
| 6 | | **3.1 s** | ~18× fewer points |
| 71 | | **36.3 s** | close to the 30 s intent |

Note the asymmetry: because the knob is a *per-packet* delay, the same setting
gives a small panel a fast sweep and a large one a slow sweep. A six-slave panel
cannot reach a 30 s sweep through this knob at all (it would need 5 s per packet,
ten times the schema cap). That asymmetry is itself the argument for fixing it
properly.

#### The proper fix is compiler-only — no firmware reflash

`comm[0]` is simply "microseconds to wait between transactions"; the firmware
stores it in a `long` and has no cap. The 500 ms limit lives only in the JSON
schema, on a field *named* for the RS-485 inter-frame gap — a different concept
that has been overloaded into a rate control. So `compileNanoJob` can compute the
delay needed to hit the configured interval:

```
perPacket = max(inter_frame_ms, (min(poll_interval_s) * 1000 / slaveCount) - txEstimate)
```

keeping the RS-485 minimum gap as a floor and stretching it to meet the poll
interval. Every panel already in the field would be corrected by a config
re-apply, with no visit to the Nano. R10's meaning changes from "check the sweep
fits" to "compute the delay that makes it fit", which is a small edit to logic
that already does the timing arithmetic.

#### But 30 s is probably the wrong target, and this is a design-chat call

Slowing the sample rate is not free, and three existing mechanisms are keyed to
it:

- **Ambient staleness.** `resolveAmbient` rejects a reading older than
  `maxAgeSec` (default **60 s**). At 71 slaves and ifm=500 ms the sweep is 36 s,
  so ambient age approaches 36 s — inside the limit, but a true 30 s *per-slave*
  interval on a large panel would push ages past 60 s and the ambient would start
  being rejected as stale, silently disabling ΔT. **The two settings must be
  chosen together.**
- **Blacklist detection latency.** A device is blacklisted after 3 consecutive
  failures, i.e. 3 sweeps. Today that is ~0.5 s; at a 30 s interval it becomes
  ~90 s before a dead sensor is noticed.
- **RoR** is safe either way — the EMA is time-weighted by `dtSec`, so it adapts
  to whatever the interval is.

So the question is not "how slow can it go" but **what sampling interval a
fire-safety monitor should run at.** ~5-10 s looks like the sweet spot on the
numbers above: ambient stays fresh, a dead sensor is caught in 15-30 s, RoR is
unaffected, and the data rate falls ~35-70× from today. **The current 30 s
default may itself be too slow** once it actually takes effect — which nobody has
had to think about, because it never did.

**Nothing changed in code.** The interim knob is a config edit; the compiler fix
and the choice of interval both belong in the design chat.

### Scan rate or InfluxDB logging? They are coupled, but the CPU can be separated

Asked 2026-09-07: is the cost the 10 ms RS-485 scan or the InfluxDB logging?
(10 ms matches the measurement — a 169 ms sweep over 6 slaves is ~28 ms per
slave, i.e. ~18 ms transaction plus a 10 ms inter-frame gap.)

**They are not independent: the scan rate sets the logging rate.** 59 readings/s
arrive because the bus is scanned that fast, and every one becomes a point. Slow
the scan and both fall together. But the *CPU* can be attributed, and the answer
matters because the two fixes have different costs.

#### What the logging path actually does

`Historian Points` → `write bt_kpi`, and `toInfluxPoints` ends:

```js
return [{ measurement, fields, tags, timestamp }];   // exactly ONE point
```

One message in, one point out, one node message to the `influxdb batch` node.
**Nothing accumulates across messages.** The node's name is misleading — "batch"
means it *accepts* an array, not that it aggregates one. So the panel is doing
**~59 separate HTTP POSTs per second, each carrying a single data point.** That
is the most expensive possible way to write 59 points: line-protocol
serialisation, HTTP client, socket and round-trip per point, all inside
Node-RED's single thread. `Historian Points` also calls `node.status()` with a
`toLocaleTimeString()` on every message, which is a websocket publish and an Intl
format per reading.

#### The test that separates them, 2 minutes and reversible

Disable the **`write bt_kpi`** node and Deploy, then watch `top`:

- node-red falls from ~82 % to ~20-30 % → **the logging path is the cost**, and
  the fix is to batch writes.
- node-red stays near 80 % → **the scan rate is the cost**, driving the whole
  flow (ProcessLogic, Alarm Manager, dashboard, BMS, cloud batcher), and the fix
  is the poll interval.

Nothing else changes: alarms, HMI and BMS all keep working, only trend history
stops recording for the duration.

#### The two fixes buy different things

| Fix | CPU | SD wear | Sample rate | Cost |
|---|---|---|---|---|
| Slow the scan (poll interval) | falls ~18× at `ifm=500`, more with the compiler fix | falls with it | **reduced** — blacklist detection slows to 3 sweeps | alarm responsiveness |
| Batch historian writes (~5 s) | removes the per-point HTTP cost | large: InfluxDB write amplification drops sharply with batch size | **unchanged** | a bounded code change |

They are complementary, not alternatives. Batching keeps full sample rate for
alarms while removing the logging cost; slowing the scan reduces everything
including the work the alarms are computed from.

**Recommendation: both** — and note that **a 10 ms scan is indefensible on its
own terms** regardless of which dominates the CPU. A busduct joint's thermal time
constant is minutes; sampling it ~6 times a second buys no detection capability
that ~5 s sampling does not, and costs a 297× data rate. Even if logging turned
out to be the entire CPU cost, the scan rate should still be fixed.

### RESULT: logging is the wear problem, the scan rate is the CPU problem

`write bt_kpi` disabled, everything else untouched:

| | Before | After | Change |
|---|---|---|---|
| node-red %CPU | 74 | **74** | **none** |
| `bo` blocks/s | 936 | **129** | **−86 %** |
| interrupts/s | 15 037 | 11 772 | −22 % |
| context switches/s | 27 003 | 20 922 | −23 % |
| SD writes | 83 GB/day | **11 GB/day** | −86 % |

The disable demonstrably took effect — `bo` collapsed — so this is a real
measurement and not a no-op.

**Node-RED's CPU did not move at all.** The InfluxDB write path, one HTTP POST
per data point, is *not* what is consuming the core. I expected it to be a large
share and it is essentially none. That is the second wrong prediction in this
investigation and the reason the test was worth running before building the
batching fix I had proposed.

**But the write path is essentially the whole SD-wear problem**: 83 → 11 GB/day.
So the two symptoms have different owners:

| Symptom | Cause | Fix |
|---|---|---|
| Slow HMI (node-red at ~74 % of a core) | message volume through the flow, i.e. **the scan rate** | poll interval |
| SD wear (~29 TB/year) | **historian writes**, which are derived from the scan rate | poll interval, or batching |

**One fix addresses both**, because the logging rate is downstream of the scan
rate: slowing the scan cuts messages *and* points proportionally. Batching would
fix only the wear, and is now demoted to optional.

#### What the number implies, and the next falsifiable step

~74 % of a core against ~35 frames/s is **~21 ms of CPU per frame** — for a chain
of roughly 30 node hops that should cost tens of microseconds each. Node-RED's
own routing does not explain a figure that large, so something per-message is
disproportionately expensive. The candidates are all editor/browser fan-out:
`node.status()` on every frame (Scale Nano Reading), 12 active debug nodes on the
frame path, and dashboard updates — all of which serialise and push over
websocket **to every connected session**, and the panel is being driven over VNC
with browser tabs open on it.

So the next two steps, in order, each with a stated falsification:

1. **Raise `inter_frame_ms` from 10 ms toward 500 ms** (no code). Readings should
   fall ~18×, from 59/s to ~3.2/s. **If node-red's CPU does not fall roughly in
   proportion, the cost is not per-message and the scan rate is not the answer
   either.**
2. If it does not, **close every browser tab pointing at the Pi** — editor and
   dashboard — and re-measure. That isolates the websocket fan-out.

**Re-enable `write bt_kpi` first.** It was not the CPU problem, the panel needs
its trend history, and once the scan is slowed its write volume falls with
everything else.

### Browser fan-out eliminated too — and my explanation for the magnitude is gone

Remote browser sessions closed, `write bt_kpi` still disabled:

| node-red %CPU | |
|---|---|
| baseline | 74.5 |
| InfluxDB writes off | 74.2 |
| **+ all remote browsers closed** | **70.5** |

A ~4-point drop, i.e. nothing. **Editor and dashboard websocket fan-out is not the
cause either.** Context switches actually rose (20.9 k → 27.6 k) and system time
roughly doubled (~7 % → ~13 %), so whatever Node-RED is doing it is not waiting
on browsers.

Two candidates eliminated by direct experiment. What remains is message volume
through the flow — the scan rate.

**But the magnitude is still unexplained, and that should be said plainly.**
~70 % of a core at ~35 frames/s is **~20 ms of CPU per frame**. Nothing measured
so far accounts for that: the four function nodes benchmarked cost ~57 µs
combined, the InfluxDB write is gone, the browsers are gone.

**A limitation of `tools/bench-hot-path.js` is now clear.** Its header warns that
it excludes Node-RED's runtime overhead, but it also silently excludes **every
other function node on the frame path** — the ~28-node legacy decode chain on
`modbusMaster_V2` and the 94-node **Alert system** tab, which `ToProcessFlow`
feeds on every frame. Those were never measured, and "I benchmarked the hot path"
was a broader claim than the tool supports. The benchmark covers four nodes, not
the path.

#### Next: raise the poll interval, which is both the test and the likely fix

If CPU is proportional to message rate, raising `inter_frame_ms` from 10 ms
toward 500 ms cuts readings ~18× and CPU should follow — and it does not matter
which node is expensive, because they all run per message. If CPU does **not**
fall roughly in proportion, there is a fixed cost independent of rate and the
next step is bisection: disable the `ToProcessFlow` link (Alert system, 94 nodes)
and re-measure, then the legacy decode chain.

That ordering is deliberate. Slowing the scan is wanted on its own merits — a
297× over-sample against the configured interval — so it is worth doing before
spending more effort attributing a cost that may be about to disappear.

### Summary of the four configurations — node-red is pinned regardless

| Configuration | node-red %CPU | `bo` blocks/s |
|---|---|---|
| baseline (influx on, browsers on) | 74.5 | 936 |
| influx OFF, browsers on | 74.2 | 129 |
| influx OFF, browsers CLOSED | 70.5 | 129 |
| influx ON again (**fresh node-red**) | 81.9 | 919 |

**Node-RED sits at 70-86 % in every configuration tested.** Disabling the
historian moved it by nothing; closing every browser moved it by 4 points. Only
the disk writes respond, and they track the historian exactly (936 → 129 → 919).

The last run is a **restarted process** — PID 738 → 725, `TIME+` 4d+6h → 83:15,
free memory 0.6 → 4.5 GB and page cache 3.5 → 1.8 GB, so the Pi itself came back
up. **A fresh Node-RED reaches ~82 % immediately**, which rules out a leak,
accumulated context or a degrading state: it is steady-state per-message work
from the first minute. (System-wide figures in that run are less comparable —
influxd will be doing post-boot catch-up — but node-red's own %CPU is.)

Influx costs roughly 8-12 points of CPU and **all** of the disk writes. Browsers
cost ~4. Neither is the story.

**Every candidate except message volume has now been eliminated by experiment.**
The scan rate is the only untested lever, and it is also the one change wanted on
its own merits.

### RESOLVED: `inter_frame_ms` 10 → 500 on ESBUSBBT04

| | Before | After |
|---|---|---|
| readings/min (`bt_kpi`) | 3558 | **304** (11.7× fewer) |
| node-red %CPU | 81.9 | **34.8** (2.35× lower) |
| idle | 54-66 % | **82-84 %** |
| process state | `R` every sample | **`S` in 2 of 3** |

The state column is the qualitative confirmation: Node-RED was *running* on every
sample before and now spends most of its time *sleeping*. That is the difference
the HMI feels.

#### CPU is not purely per-message — there is a fixed floor

CPU fell 2.35× while the message rate fell 11.7×, so fitting
`CPU = FIXED + k × readings/s` to the two points:

- **FIXED ≈ 30 % of a core**, independent of scan rate — the periodic work: BMS
  refresh 5 s, blacklist tick 10 s, applied-joints publish 10 s, power health
  30 s, device health 60 s, telemetry, the dashboard's own updates.
- **k ≈ 0.87 % per reading/s**, i.e. **~8.7 ms of CPU per reading**. The variable
  part collapsed from 51.5 points to 4.4 (**−91 %**).

8.7 ms per reading is still enormous for one message — the four benchmarked
function nodes account for ~57 µs of it. The rest is the unmeasured majority of
the path (legacy decode chain, the 94-node Alert system tab, dashboard, BMS and
cloud taps, and Node-RED's own message cloning). It no longer *matters* at 5
readings/s, but it is the reason the panel was ever in trouble, and it would bite
again at higher device counts.

#### The value does NOT transfer to the 71-device panel — do not copy it across

`inter_frame_ms` is a **per-packet** delay, so the sweep it produces scales with
slave count. With the implied ~36 ms transaction time:

| Slaves | ifm=10 | ifm=50 | ifm=100 | ifm=500 |
|---|---|---|---|---|
| 6 | 0.28 s | 0.5 s | 0.8 s | **3.2 s** |
| 71 | 3.3 s | 6.1 s | 9.6 s | **38 s** |

**500 ms on ESBUSBBT06 would give a 38 s sweep** — past the 30 s the operator
configured, close to the Diagnostics 60 s "No Data" expiry, and pushing ambient
age toward the 60 s `maxAgeSec` beyond which ΔT is silently dropped. ~50-100 ms
is the right region there.

**And note what this implies about that panel's 100 % CPU.** At ifm=10 its sweep
was already 3.3 s, i.e. ~21 readings/s — *lower* than this panel's 59/s — yet its
node-red was higher. So the big panel's cost is mostly the **fixed** term, which
grows with panel size (bigger tables, more joints per lookup, larger dashboard
payloads, 1058 BMS registers), not with message rate. **Slowing its scan will
help less than it did here**, and that panel needs its own measurement rather
than this panel's conclusion.

This is exactly the argument for deriving the delay from `poll_interval_s` in the
compiler instead of hand-setting a per-packet number: the correct value is a
function of slave count, and no operator should have to compute it.

## 2026-09-08 — Sizing 240 sensors on two RS-485 segments

Asked: what `inter_frame_ms` for 240 sensors across two independent buses.

**The number depends on slaves per bus, not sensors** — `compileNanoJob` emits one
read per *slave*, and a multi-channel module returns all its channels in a single
transaction. So the packaging decision comes first. With the measured ~36 ms
transaction and a 30 s sweep target (half the 60 s `maxAgeSec` / Diagnostics
"No Data" limit, leaving margin):

| Packaging | slaves/bus | ifm wanted | usable | sweep | readings/s | R16 loading |
|---|---|---|---|---|---|---|
| 1 channel (240 slaves) | 120 | 215 ms | **215** | 30 s | **8.0** | 121/128 = **95 %** |
| **2 channel (120 slaves)** | 60 | 465 ms | **465** | 30 s | **8.0** | 61/128 = 48 % ✓ |
| 4 channel (60 slaves) | 30 | 960 ms | 500 (capped) | 16 s | 14.8 | 31/128 = 24 % |
| 8 channel (30 slaves) | 15 | 1960 ms | 500 (capped) | **8 s** | **29.6** | 16/128 = 13 % |

**Recommendation: 2-channel modules, 60 slaves per bus, `inter_frame_ms` ≈ 465 ms.**
The only packaging that reaches a 30 s sweep *within* the 500 ms schema cap while
leaving RS-485 headroom.

#### The counter-intuitive part

**Fatter modules make the CPU problem worse, not better.** Intuition says fewer
devices means less work; the opposite holds, because the 500 ms cap binds on a
short read list and the sweep collapses. Eight-channel modules give 30 slaves in
total and a **29.6 readings/s** load — nearly four times the 8.0 of the
two-channel layout — purely because the panel cannot be told to wait longer
between packets. The reading rate is `sensors / sweep`, and sweep is
`slaves_per_bus × (tx + ifm)`; reducing slave count shortens the sweep unless
`ifm` can grow to compensate, and it cannot past 500 ms.

That is the same asymmetry found on ESBUSBBT04 vs ESBUSBBT06, and the strongest
argument yet for **D7**: the delay should be derived from the configured poll
interval, not hand-set as a per-packet number with a cap that means different
things at different panel sizes.

#### But 240 does not fit the schema today

| Cap | Value | 240 sensors |
|---|---|---|
| `joints` maxItems | **200** | **BLOCKS every packaging** |
| `slaves` maxItems | 128 | blocks single-channel (240) |
| `unit_address` 1-247, unique panel-wide | 247 | blocks single-channel once ambients are added (240 + ~10 > 247) |
| `buses` maxItems | 4 | fine |
| R16 `rs485_max_devices` | 128/bus | 121/128 at single-channel — 95 %, warns, no headroom |

**`joints` maxItems 200 is binding in every layout**, so 240 measurement points
needs a schema change whatever the module choice. Single-channel is blocked three
times over and should be discounted regardless.

Downstream, the BMS register map at tier 3 would be `500 + 240 × 8 = 2420`
registers, against the MGate's **1200-command import cap** — so **at least two
gateways, split by zone** (`tools/mgate-csv.js --zones=`), which the existing
two-gateway guidance already covers.

#### The real risk is not `inter_frame_ms`

The fitted model from ESBUSBBT04 is `CPU ≈ 30 % + 8.7 ms × readings/s`. At 8
readings/s the variable term is only ~7 %. **The fixed term is the problem, and
it grows with panel size** — 240-row dashboard tables, ProcessLogic's O(n) joint
lookup, a 2420-register BMS image, blacklist state over 240 devices, the
device-health builder. ESBUSBBT06 showed exactly this: 71 devices at ~21
readings/s pinned Node-RED at 100 %, i.e. mostly fixed cost.

**That term has never been measured above 71 devices, and extrapolating it would
repeat the mistake this whole investigation was about.** Before committing to 240
on one Pi, commission a bench panel at ~120 and measure. If the fixed term is
already dominant there, the answer is not a different `inter_frame_ms` — it is
**two panels**, and that is an architecture decision for the design chat, not a
tuning one.

### ESBUSBBT06 with the local browser closed — the fixed term is confirmed dominant

Fresh capture, **no Chromium at all** (previously ~125 % across four processes):

| | Before | Now |
|---|---|---|
| run queue `r` | 6-9 | **1-2** |
| idle | 31-36 % | **57-68 %** |
| node-red %CPU | 100 | 106 |
| top consumers | node-red, 4× chromium, influxd | node-red, influxd (11 %, 1.72 GB RSS), Xorg, grafana |

**The panel is no longer oversubscribed.** A run queue of 6-9 on 4 cores meant
everything queued; at 1-2 it does not. That came almost entirely from closing the
Pi's own browser — no code, no tuning. The HMI symptom should already be largely
gone, and that needs confirming with the actual buttons rather than inferred from
these numbers.

**node-red is at 106 %** — `ps` sums threads, so this is the main thread saturated
plus GC/libuv threadpool.

#### This panel's cost is ~87 % fixed, against ~30 % on ESBUSBBT04

At `inter_frame_ms` 10 and 71 slaves, the sweep is ~3.3 s → **~21.5 readings/s**,
barely a third of ESBUSBBT04's 59/s. Applying that panel's fitted 8.7 ms/reading
gives a variable term of only ~19 %, leaving **~87 % fixed** — nearly three times
BT04's ~30 %.

| ifm | sweep | readings/s | variable term |
|---|---|---|---|
| **10 (now)** | 3.3 s | 21.5 | ~19 % |
| 50 | 6.1 s | 11.6 | ~10 % |
| **100** | 9.7 s | 7.4 | ~6 % |
| 200 | 16.8 s | 4.2 | ~4 % |

So raising ifm to 100 ms should return **~13 points** of node-red CPU — real, and
worth taking for the SD wear alone, but nothing like the 47 points it bought on
the small panel. **The prediction that the scan fix would help less here is borne
out.** (The split is approximate: per-reading cost is probably also higher here —
O(n) joint lookups over 71 rows, 71-row tables, a 1058-register BMS image — so
some of that "fixed" 87 % is really variable cost with a bigger coefficient.
Either way it is not the scan rate.)

**This panel is now the evidence for the 240-sensor warning.** The term that
grows with panel size, not the message rate, is what puts Node-RED over a core —
which is exactly why 240 sensors on one Pi needs measuring at ~120 before it is
committed to, and why the answer there may be two panels rather than a different
`inter_frame_ms`.

#### Unconfirmed: whether `bt_kpi` is actually disabled here

`bo` averages **~336 blocks/s** across both vmstat runs. On ESBUSBBT04 the
historian gave 936 running and 129 disabled. 336 is neither. The `influx` count
query was not run in this capture, so the historian's state on this panel is not
established — and `influxd` is still at 11 % CPU with 1.72 GB RSS.

### Correction: closing the browser was not a fix — it removed the HMI

Tested on the **on-board HMI**, and the response is largely unchanged after both
the browser closure and `inter_frame_ms` 10 → 250.

**The previous entry's framing was wrong and needs withdrawing.** It read the run
queue falling from 6-9 to 1-2 as "the panel is no longer oversubscribed... that's
your HMI symptom". On this panel **the on-board HMI *is* that Chromium**: it runs
on the Pi's own display. Closing it did not remove a competing workload, it
removed the thing under test. A measurement taken with the browser closed
describes a configuration that never exists in service.

So this panel has **two bottlenecks sharing four cores**, and they were never
separated:

- **server side** — node-red's single JS thread at ~106 %, which serves every
  dashboard websocket message;
- **client side** — Chromium at ~125 % across four processes, rendering a
  node-red-dashboard page with 71-row tables on a Pi.

Either alone could produce a sluggish HMI, and the numbers gathered so far cannot
say which, because every capture had one or the other switched off.

#### The two measurements that separate them

1. **`top` with the on-board HMI running** — the real operating state, and the
   only one worth tuning against. Wanted for both `node-red` and `chromium`,
   now that the scan rate is 6× lower.
2. **The same dashboard from a laptop or tablet on the LAN, with the on-board HMI
   closed.** Snappy there and sluggish on-board ⇒ the client is the limit and the
   levers are dashboard weight, update rate and Chromium's rendering flags — not
   Node-RED at all. Sluggish in both ⇒ it is the server, and the fixed term is
   the target.

Neither has been done. Everything measured so far constrains the *machine*, not
the *path a button press actually takes*.

### FOUND: a 10 Hz timer fanning out over every sensor — the fixed cost

`inject 8233660a43277487` on `modbusMaster_V2` fires **every 100 ms** into
`parameterForLoop`:

```js
var n = global.get('slaveLength')
for (i = 0; i < n; i++) {
    msg.payload = [global.get('parameterTypeName[' + global.get('parameterID'+i) + ']'),
                   flow.get('sensorRawData[' + global.get('sID'+i) + '][' + global.get('sregisterAddress'+i) + ']'), i]
    node.send(msg);
}
```

One output wired to **21 destinations** — the legacy decode-type dispatcher (pH,
4-20 mA, RTD, DHT, CT current, /10, /100, /1000, three Schneider meter types,
BHMS old/new, Tamura, WCS, E-N meter, vibration, NTC, load cell). Node-RED clones
the message once per additional wire, so each `node.send` costs 20 clones.

| Panel | sensors | node executions/s | dynamic-path context gets/s |
|---|---|---|---|
| ESBUSBBT04 | 6 | 1,200 | 240 |
| **ESBUSBBT06** | **71** | **14,910** | **2,840** |
| proposed 240-sensor | 240 | **50,400** | 9,600 |

And the branch that matches does a **full read-modify-write of the entire
`sensorData` object** per message (`global.get('sensorData')` → mutate →
`global.set('sensorData', ...)`), into the *default* context store — which on
this Pi is localfilesystem. At 71 sensors that is ~710 whole-object rewrites per
second.

**This is the fixed term.** It is driven by a timer, not by data, so it is
completely independent of `inter_frame_ms` — which is precisely why the scan-rate
fix that transformed the 6-sensor panel barely moved this one, and why closing
the browser did not help either. It scales linearly with sensor count, which is
why the fixed term measured ~30 % on ESBUSBBT04 and ~87 % on ESBUSBBT06.

It also plausibly explains the residual `bo` ≈ 336 on ESBUSBBT06, a panel with no
`bt_kpi` historian at all: a persisted context store being marked dirty hundreds
of times a second.

**Note node-red at ~106 % is saturated**, so the measurements understate demand —
a single JS thread cannot report the work it wanted to do. True demand on
ESBUSBBT06 may be well above one core.

#### What it is decoding, and why 10 Hz is 200× too fast

This is the generic multi-sensor-type platform the panel was built on;
BusductTherMo uses one of the 21 types. The values it re-decodes only change when
a frame arrives — now every ~20 s per sensor at `inter_frame_ms` 250. Re-running
the whole dispatch 10 times a second against data that changes every 20 seconds
is ~200× oversampling of the decode step.

#### The test, and the fix

Change that inject's repeat from **0.1 s to 2 s** in the editor and Deploy —
20× less work, immediately reversible. Expect node-red to fall from ~106 % toward
~30 % if this is the dominant term.

Low risk, because **the alarm path does not use it.** ΔT/RoR alarms come from
`Scale Nano Reading` → `ProcessLogic` → `Alarm Manager`, which read the fanned-out
channel readings directly, never `global.sensorData`. What slows down is the
legacy Diagnostics table and the legacy alert/SMS nodes, by up to 2 s — on a
measurement that updates every 20 s anyway. It should also *help* the client
side, since fewer dashboard pushes means less Chromium work.

**The proper fix is to drive it from frame arrival rather than a timer**, which
is a code change and should follow once the test confirms the attribution.

#### This changes the 240-sensor answer

At 240 sensors this loop alone is **50,400 node executions/second** before any
frame is processed — several cores' worth on a Pi. The earlier sizing entry
concluded the fixed term was the risk at 240; this is that term, and it is a
**timer that can simply be slowed or made event-driven**. Fixing it may matter
more to the 240 question than any choice of `inter_frame_ms`.

### Fix: route the legacy decode dispatcher instead of fanning out (2026-09-08)

`parameterForLoop` now has **21 outputs**, one per decode branch, and sends each
sensor only to the branch whose type it is.

| | Before | After |
|---|---|---|
| destinations per send | 21 | **1** |
| message clones per send | 20 | **0** |
| node executions/s @ 71 sensors, 10 Hz | 14,910 | **710** |
| node executions/s @ 240 sensors | 50,400 | 2,400 |

Verified by running the rewritten node against a synthetic 71-sensor context:
71 sends, all landing on output 7 (`Value/100`) and nowhere else, and an unknown
type producing zero sends — the same "nothing matched" outcome as before, minus
21 wasted executions.

**Behaviour-preserving.** The branch filters are deliberately *kept*: each still
verifies the type it receives, so a wiring mistake fails closed rather than
mis-decoding. The same messages arrive at the same nodes.

Two things fixed along the way:

- **A latent aliasing bug.** The old loop mutated and re-sent one shared `msg`
  object per iteration. Node-RED clones for additional wires but the first
  recipient holds the original by reference, so the next iteration could rewrite
  a payload already in flight. Never observed; free to fix while rewriting.
- **`TYPE_OUTPUT` is pinned to the wiring** by `test/flows-integrity.test.js`,
  which reads each branch's own `compare` array and asserts it matches the output
  it is wired to. Reordering the wires without the map would route a sensor to
  the wrong decode type — a *mis-scaled reading*, not an error, which is exactly
  the kind of silent fault this repo has been bitten by before.

#### On deleting the unused types

**Not done, deliberately, and the reason is that it cannot be decided from this
repository.** The branch names are matched against `parameterTypeName`, which
`SetVal` populates from **`Parameter.txt` on the Pi** — site data, not source.
Which types a given panel uses depends on that file and on the per-slave
`parameterID{i}` globals. Deleting a type some panel actually uses would stop
that sensor decoding silently, and this is the live measurement path.

**After this change deleting them buys nothing measurable**: an unused branch is
never sent a message, so it costs zero. It is now cosmetic cleanup, worth doing
once against a confirmed list rather than guessed at.

To produce that list, read from the Node-RED context sidebar (or a one-shot
inject): `parameterTypeName` — the array from `Parameter.txt` — and the
`parameterID0..N` globals, which index into it. The set of distinct values is
what the panel actually uses. On a BusductTherMo panel that is expected to be
just `Value/100` (`channel-decode.js` uses the same 0.01 scale), in which case
20 of the 21 branches and their downstream nodes can go.

### Dispatcher fix measured on ESBUSBBT06, and the tick slowed

Deployed, fresh process (`TIME+ 2:09`):

```
%Cpu(s): 34.8 us  60.9 id   node-red 136.4   <- discard: process still initialising
%Cpu(s): 21.4 us  70.4 id   node-red  73.8 S
%Cpu(s): 24.8 us  65.0 id   node-red  61.9 R
```

**node-red ~106 % → ~68 %** (mean of the two settled samples), a **38-point**
drop, and the process is now sometimes in state `S` rather than permanently `R`.
The first sample is discarded deliberately: at 2 minutes of CPU the flow was
still initialising, and `RES` falls 349 MB → 296 MB across the three samples as
GC settles.

**Attribution.** The fan-out was ~38 points of the ~106, so roughly a third. Less
than the executions-per-second ratio (21×) suggested, which is the useful part:
the *sends themselves* were never removed — only the clones and the 20 filters
that returned null. At 71 sensors and 10 Hz the loop still made **710 sends per
second**, each doing a full `global.get('sensorData')` → mutate →
`global.set('sensorData', ...)` of an object with 71 entries.

So the remaining cost is the tick rate itself, and that is now slowed from
**0.1 s to 2 s**:

| inject | sends/s | dynamic-path context gets/s |
|---|---|---|
| 0.1 s (was) | 710 | 2,840 |
| **2 s (now)** | **35.5** | **142** |

Justified by the data cadence, not by taste: at `inter_frame_ms` 250 each sensor
produces a new reading every ~20 s, so a 2 s tick is still 10× faster than
anything changes. What slows is the legacy Diagnostics table and the legacy
alert/SMS nodes, by up to 2 s. **The alarm path is untouched** — ΔT/RoR go
`Scale Nano Reading → ProcessLogic → Alarm Manager` and never read
`global.sensorData`.

A test pins the **floor** at 1 s rather than the exact value, so the tick stays
tunable per panel but cannot silently return to 100 ms.

**Committed separately from the dispatcher fix** so either can be reverted alone
— two changes in one deploy would have made this measurement uninterpretable,
which is the same discipline that made the influx and browser tests worth
anything.

### RESOLVED: node-red 106 % → ~19 % on ESBUSBBT06

```
%Cpu(s): 11.4 us  79.5 id   node-red  9.1 S
%Cpu(s): 16.8 us  76.2 id   node-red 19.8 S
%Cpu(s): 20.6 us  70.5 id   node-red 27.5 R
```

Mean **18.8 %**, corroborated independently by the `TIME+` delta — 0.68 s of CPU
across 4 s of wall clock is 17 %, so the instantaneous samples are not a lucky
window. State is **S, S, R**: mostly sleeping, where it was `R` on every sample
before.

| Step | node-red | Δ |
|---|---|---|
| baseline | 106 % | |
| `inter_frame_ms` 10 → 250 | 106 % | **0** |
| dispatcher routing (21 wires → 1) | 67.8 % | −38 |
| decode tick 0.1 s → 2 s | **18.8 %** | −49 |

**5.6× lower, 87 points recovered**, and the event loop now has ~80 % headroom
instead of none.

#### The two fixes were the same bug in two places

Both are **work driven at a rate unrelated to the rate the data changes**:

- `poll_interval_s` configured at 30 s, actually polling every 0.17 s — **297×**;
- the decode dispatcher re-running at 10 Hz against values that change every
  ~20 s — **~200×**.

That is one failure mode, not two, and it is worth naming because the third
instance will look different again. Neither was visible as a defect: both
"worked", both had passed live verification, and the only symptom was a panel
that felt slow.

#### Why the scan-rate fix did nothing here but everything on ESBUSBBT04

Because the two panels were limited by *different* halves of it. ESBUSBBT04 (6
sensors) had a fast sweep — 0.17 s per joint — so its cost was dominated by the
per-reading path, and slowing the scan took it from 82 % to 35 %. ESBUSBBT06 (71
sensors) already had a 3.3 s sweep, so its readings were only ~21/s; its cost was
the timer-driven dispatcher, which scales with **sensor count** and ignores the
scan rate entirely. Same code, opposite bottlenecks. The earlier entry's
prediction that the scan fix "will help less here" was right for the right
reason.

#### This substantially changes the 240-sensor outlook

The previous sizing entry concluded the fixed term was the binding constraint at
240 and might force two panels. That term was overwhelmingly this dispatcher, and
it is now ~40× smaller: at 240 sensors with a 2 s tick it is 120 sends/s, against
the 710/s that 71 sensors produced at 10 Hz. **The remaining blockers at 240 are
the schema caps** — `joints` maxItems 200 above all — not CPU. A bench
measurement at ~120 is still the right gate before committing, but the answer is
no longer likely to be "two panels".

**Still to confirm: the HMI itself.** Every number here says the server has
headroom; whether the buttons respond is a separate observation, and the client
side (Chromium rendering 71-row tables on the Pi) was never measured
independently.

### "Everything works with parameterForLoop disabled" — why that is not yet evidence

Reported 2026-09-08. It may well be right, but the observation cannot distinguish
working from frozen, and there is a safety consequence if it is wrong.

**`sensorData` has exactly one source.** Every writer is a decode-branch
conversion node (`/100`, `/10`, `/1000`, `pH Logic`, `Map`, `NTC`, …) — all
downstream of `parameterForLoop`. Disable the loop and nothing writes it; the
object simply **stops changing**, holding its last values.

**A frozen `sensorData` is indistinguishable from a live one on screen.** The
numbers are the last real readings, so they look plausible; nothing errors,
nothing alarms, no node goes red. This is the same failure mode as J09 reading
exactly 0, the ambient that answered a fresh in-band 0.0 °C for 20 minutes, and
the stale blacklist exclude set. **In this codebase, "looks fine" has been wrong
about stale data three times.**

#### What still reads it

| Reader | Tab | Enabled |
|---|---|---|
| **`SMS and Email for alerts`** | Alert system | **yes** |
| `Alert counter` | Alert system | yes |
| `2aa9ec351622e3e9`, `fd729d0af6e67cac`, `SetVal` | modbusMaster_V2 | yes |
| legacy influx feeder `22f51bf8…` | modbusMaster_V2 | already disabled |

`SMS and Email for alerts` evaluates **Low Critical / Low / High / High Critical**
against the live value pulled straight out of `sensorData`, and sends **email and
SMS**. Against a frozen value it can never cross a threshold again — so a joint
that overheats *after* the freeze produces no legacy alert, silently and
indefinitely.

#### The part that makes this more than legacy cruft

**The new alarm path has no absolute temperature threshold at all.**
`busduct_alarms_config.schema.json` defines `deltaT` and `ror` thresholds plus
`sensor_fault.sensor_error_above_c` — and that last one is the 300 °C
plausibility bound, not an alarm level. So:

> A joint can sit at a dangerous **absolute** temperature with a small ΔT and a
> flat RoR — a panel-wide ambient rise, or a slow drift that has already
> stabilised — and the Alarm Manager will say nothing.

The legacy `SMS and Email for alerts` node is currently the **only** absolute-
temperature alerting in the system. Deleting its data source without replacing
that function would remove a safety net nobody has noticed is load-bearing.

#### Two checks that settle it, both from the context sidebar

1. **Is the legacy alert path configured?** Read flow `alertLength` on the Alert
   system tab (`6bc810f3.e732e`). **0 ⇒ the node loops zero times and the whole
   legacy chain really is dead code**, safe to delete.
2. **Is `sensorData` actually frozen?** Read `global.sensorData` twice a minute
   apart with the loop disabled. Identical values = frozen, which is what the
   code says must happen; anything else means there is a writer this analysis
   missed and the analysis is wrong.

If (1) returns 0, delete the lot — the tick, `parameterForLoop`, all 21 branches
and their conversion nodes — and **raise the absolute-threshold gap as an A-rule**
rather than losing the capability by accident.

### Deleted: 16 unused decode branches (44 nodes)

User direction 2026-09-08, with the absolute-alarm gap (D8) going to the design
chat separately.

**Deleted** — sensor kinds this product does not measure: pH, 4-20 mA, RTD, DHT,
CT current, Schneider EM6400NG / EM1200 / EM6436, BHMS old, BHMS new, Tamura,
WCS, E-N Meter, Vibration, Negative Vibration, Load cell. With their exclusive
downstream chains that is **44 nodes**; the flow drops from 658 to 614.

**Kept** — anything that could plausibly decode a temperature: `Raw Data`,
`Value/10`, `Value/100`, `Value/1000`, `NTC`. The user named RTD, DHT and CT as
unused; the rest are not temperature at all. NTC and the generic scalers stay
because **which type a panel actually uses comes from `parameterTypeName`,
populated from `Parameter.txt` on the Pi** — it cannot be decided from this
repository, and a temperature decode is the wrong thing to guess wrong about.
Keeping five costs nothing: an unused branch is never sent a message.

**`Raw Data Logic` was correctly retained.** The deletion walked each branch's
downstream closure and removed a node only when *every* one of its feeders was
inside the set. That node is fed by both the deleted DHT branch and the kept Raw
Data branch, so it stayed — the kind of shared node a hand-deletion removes by
accident.

#### The safeguard that makes this recoverable

`sensorData` has exactly one source. If a panel's type turns out to be one of the
deleted sixteen, that sensor simply stops being written — and a frozen
`sensorData` is indistinguishable from a live one: last-known plausible values,
no error, no alarm, while the legacy absolute-threshold e-mail/SMS never fires
again.

So the dispatcher no longer skips an unknown type silently. It collects them,
sets a **red node status** naming them, and warns (throttled to once per five
minutes, since the condition is true every tick once true at all). Verified:

```
all known     -> {"2":5}  status: green  "5/5 dispatched"
deleted types -> {"2":1}  status: red    "NO DECODE BRANCH: Temperature - RTD, CT current"
                          warn: "...sensorData will NOT update for them: ..."
```

**Nothing regressed.** The legacy `SMS and Email for alerts` node is untouched and
still reads `sensorData`, which the kept branches still write — so the only
absolute-temperature alerting in the system keeps working until D8 replaces it
properly. If the red status appears on a panel, restore the branch from git
history rather than guessing.

**Recovery**: `git revert` this commit, or re-import the branch nodes from the
previous flow revision. Nothing else references them.

### Diagnostics table cut over to the new decode path (2026-09-08)

User request: *"link debug window slave data connectivity and data view table to
data coming from Scale Nano Reading output. Other slave attributes can be taken
from Modbus settings table... We want to separate from legacy system."*

**Before**, every field came from the legacy chain: `parameterName{i}` /
`sID{i}` / `sregisterAddress{i}` for attributes, `sensorData[sID][addr]` for the
value, `Status[sID]` + `StatusTs` for connectivity — all written by the decode
branches hanging off `parameterForLoop`. So the operator's diagnostic view was
reporting on a pipeline that no longer decides anything: alarms, the historian,
the BMS image and the cloud all read `Scale Nano Reading`. **Two independent
representations of the same measurement, and the one on screen was the one
nothing else used.**

**After**: values and connectivity from the decoded readings; attributes from the
applied `cfg/modbus` document — the same document Modbus Settings edits,
ProcessLogic matches against and the alarm sweep clears against.

| Piece | Where |
|---|---|
| `recordReading` / `buildSlaveRows` (pure) | `src/diagnostics/slave-table.js`, on `busductConfigService.diagTable` |
| Tap on `Scale Nano Reading` output | `link out` `d1a91e50c0000001` → `link in` `…02` (additive, Slice 4 pattern) |
| Live cache | `Diag Reading Cache` `d1a91e50c0000003` |
| Row builder | `2aa9ec351622e3e9`, rewritten as a thin call |
| Dashboard template | **unchanged** — field names `Name/ID/Add/Data/Status` preserved |

Verified end to end against the real node bodies: two readings in, three rows out
(`Riser A` Connected 31.4, `MULTI ch1` **No Data**, `MULTI ch2` Connected 36.1),
node status *"3 channels, 2 connected"*.

#### Three decisions worth recording

**Rows come from the CONFIG, not from traffic.** A commissioned channel that has
never reported appears as "No Data" — precisely the case an engineer opens this
page to find. Deriving rows from readings would make a dead device *vanish* from
the table rather than show up as dead, which is this project's recurring failure
shape.

**The cache is FLOW context, not a global.** The cache node and the builder share
tab `14fbe87aa2a163e8`, so flow scope reaches both, and flow context is
memory-only. A global would land in the **default** store — localfilesystem on
these panels — putting a write on the SD card for every reading, which is exactly
what the historian investigation was about.

**A stale row keeps its value but loses its status.** `Status` becomes "No Data"
past `staleMs` while `Data` still shows the last reading plus `AgeSec`. An
engineer wants the last value and its age; the status is what says not to trust
it. `staleMs` (60 s default) **must exceed the bus sweep** — ~20 s at
`inter_frame_ms` 250 with 71 slaves — which is why it is a parameter, not a
constant.

#### Not changed

`global.Status` is still written, because **`Alert counter`, `Connection counter`
and `testing` on the Alert system tab still read it**. `StatusTs` now has no
reader — the expiry it existed for lives in the module. Left in place: it costs
nothing and removing it is a separate cleanup.

New fields `Ch`, `Bus`, `SlaveId`, `AgeSec` are in the payload but **not rendered**
— the template was left alone to keep this change to one thing. A channel column
would be worth adding now that a multi-channel module shows several rows with the
same Slave ID.

#### A note on the test that had to change

`flows-bus2-alarms.test.js` pinned the old builder's inline expiry. Rewriting it
exposed the trap again: the new builder's *comment block* names the legacy
globals it replaced, so a naive `doesNotMatch` search hits prose and passes or
fails on documentation. **The updated assertions strip comments first.** That is
the fourth time in this project a check has matched a comment instead of code.

### Correction: the diagnostics cache was writing to the SD card

The first cut of the Diagnostics cutover kept the live reading cache in Node-RED
**flow context**, with a comment asserting flow scope is memory-only. **That is
wrong.** A context store is selected by `contextStorage.default`, and that choice
applies to node, flow **and** global scope alike — on these panels the default
store is **localfilesystem**. So `flow.set('diagReadings', …)` put an SD write on
every reading, and JSON-serialised the object on the way through.

Precisely what the historian investigation was about, introduced two commits
after it. The repo already documented the fact — `blacklist-handler.js:28`,
"the Pi's context store is localfilesystem-backed, which JSON-serialises values
and strips the prototype" — and I asserted the opposite from intuition instead of
checking. **Same class of error as `temp_scale`: a stored value assumed rather
than verified.**

Fixed by holding the cache as a **module singleton** in `slave-table.js`, which
is the pattern this repo already uses for the blacklist tracker and
`getBmsService`. Memory-only by construction, reaches every function node
because `busductConfigService` is required once at startup and shared.

It does not survive a restart, which is correct: after one, no readings have
arrived and every row should read "No Data" until they do. This cannot repeat the
stale-blacklist bug of 2026-08-31, where a *persisted* global disagreed with a
non-persisted tracker — nothing here is persisted, so there are no two lifetimes
to diverge.

Verified by running the real node bodies with a `flow` stub that throws on read
and counts writes: **0 `flow.set` calls** on the reading path, rows still built
correctly.

#### Also seen in the same capture, and NOT yet explained

```
node-red 25.0 S   RES 368436   TIME+ 5:42.47
node-red 28.4 D   RES 392308   TIME+ 5:43.04
node-red 54.5 R   RES 440032   TIME+ 5:44.14
```

RSS climbing ~35 MB per 2 s sample, CPU rising across the three, and one sample
in state **`D`** (uninterruptible sleep — disk). The context-store writes are a
candidate but do not obviously account for 18 MB/s, and **three samples are not a
trend**: RSS routinely climbs between GC cycles, and a deploy re-initialises
every flow. It needs a re-measure at steady state before anything is concluded —
the mistake this whole investigation has been about is reading a snapshot as a
trajectory.

### The RSS climb is not a leak — but the CPU regression was real, and mine

Second capture after the diagnostics cutover:

```
node-red  5.9 S  RES 472376  0:42.51
node-red 54.7 R  RES 520100  0:43.61
node-red 50.5 D  RES 570648  0:44.63
```

**RSS was not leaking, and arithmetic settles it without another measurement.**
The *previous* capture showed the same ~18 MB/s climb on a process with
`TIME+ 5:42` — 5.7 minutes of CPU already accumulated. Sustained, that rate would
have reached **~6 GB** by then; it was at 0.43 GB. So it is not monotonic growth,
it is **V8 heap sawtooth**: a high allocation rate collected at each GC. Worth
noting as an allocation signal, not a leak, and it needed no further sampling —
the earlier sample already contained the refutation.

**The CPU regression was real: ~19 % before the cutover, ~53 % after** (TIME+
delta 2.12 s over 4 s). Cause, and it is the same trap twice in one day:

The row builder cached the applied config with `context.get('diagDoc')` /
`context.set(...)`. **Node context uses `contextStorage.default` exactly as flow
and global do**, and on these panels that is localfilesystem — so a ~100 KB
document was being read back off the SD card and deserialised **every second**,
and written every 30 s. I had just fixed this in the reading cache and then
reproduced it two functions away, because I copied the pattern from the
pre-existing `function 12` without re-applying what I had learned.

Fixed by `appliedDoc()` in `slave-table.js`: module-scope, TTL'd, memory-only.
**`function 12` is fixed the same way** — it ran the identical `blDoc` pattern and
now shares the one cache. Measured against the real node bodies: **10 ticks →
1 store read, 0 context writes** (was 10 reads and 20 writes).

On a read failure the last good document is **kept**, not blanked: the config
changes only on an apply, and an empty table would read as "no devices
commissioned" rather than "could not read the configuration". The node status
shows *"(config stale)"* so the view is not silently trusted.

**The generalisable rule, now stated once in the file and once here:** in this
deployment **"context" means the SD card unless a store is named**. Node, flow and
global scope are all the same store. Module scope is the only free memory, which
is why the blacklist tracker, the BMS service and now both diagnostics caches
live there.

### Confirmed: both symptoms resolved (5-sample steady state)

`top -b -n 5 -d 5`, PID 1949411:

| | Before the fix | Now |
|---|---|---|
| RSS drift | 24.0 MB/s | **0.067 MB/s** across the first 15 s |
| node-red %CPU | ~53 | **23.4** (TIME+ 4.67 s over 20 s — cross-checks the 24.1 % sample mean) |

The last sample steps RSS 34 MB in one interval and then the run ends; that is a
GC growth step, not a resumption of the climb — the four samples before it are
flat to within 1 MB. **The per-second document deserialisation was the whole of
it**, for both the CPU and the allocation rate.

Full arc on ESBUSBBT06:

| Step | node-red |
|---|---|
| baseline | 106 % |
| dispatcher routing (21 wires → 1) | 67.8 % |
| decode tick 0.1 s → 2 s | 18.8 % |
| **diagnostics cutover — my regression** | 53 % |
| applied-doc cache moved to module scope | **23.4 %** |

**4.5× lower than baseline**, with the panel at ~70-77 % idle.

#### What the residual ~4-5 points above 18.8 % is

The row builder runs on a 1 s tick and constructs 71+ row objects each time. That
is the honest cost of the new table, and it is bounded and understood rather than
mysterious.

**There is an easy further saving available, not taken.** `function 12` already
gates the stream on whether anyone has the Diagnostics page open ("UI Active -
Data ON/OFF") — but it sits *downstream* of the builder, so the rows are built
every second whether or not anyone is looking. Moving that gate upstream of the
builder would drop the cost to near zero when the page is closed. Left alone
because 23.4 % on four cores is not a problem, and this session has already shown
what happens when a change goes in without a measurement to justify it.

#### RSS baseline is higher than before and that is expected

~600 MB now against ~300 MB earlier in the session. V8 does not readily return
heap to the OS once its high-water mark rises, and the churn before this fix was
substantial. It is **stable**, which is the property that matters, and a restart
would show the true floor. Worth a glance after the next restart, not worth
chasing now.

### The easy saving, taken: gate the row builder on someone watching

The dashboard template emits `open`/`heartbeat`/`close`, and the gate node has
always used them to stop forwarding data to a page nobody has open — but it sits
**after** the row builder, so 71+ row objects were built every second and thrown
away. The gate now runs first.

Measured against the real node body at 71 slaves, 60 ticks:

| | builds | store reads | time |
|---|---|---|---|
| page closed | 0 | 0 | 0.2 ms |
| page open | 60 | 1 | 3.1 ms |

**92.5 % of the builder's cost disappears when nobody is looking** — which is most
of the time on a panel in service.

**Presence lives in the module, not in either node's context.** Two reasons, both
already learned the hard way in this file: context is the SD-backed store unless
a store is named, and two copies of a lifetime that can disagree is the exact
shape of the stale-blacklist and stale-exclude bugs. The gate node now *records*
into the module and *reads back* from it, so the two nodes cannot drift; its own
context copy survives only as a fallback for the library-not-loaded case.

**Fail-safe direction: unknown presence means inactive.** Being wrong costs a
table that does not refresh until the next heartbeat — visible and
self-correcting. Assuming active would cost exactly the work this exists to
avoid. Nothing safety-related is downstream; alarms do not pass through here.

#### A sentinel collision the test caught

The first cut used `0` for "never seen", so `noteUiEvent('open', 0)` was
indistinguishable from "no page has ever opened". Harmless in production, where
`Date.now()` is never 0 — but it is the same class of ambiguity as a 0 °C reading
meaning "no sensor", which this project *has* been bitten by. Now `null` for
never and a number otherwise. A distinct type costs nothing, and the test that
found it was the one written to check boundary behaviour.

### Correction: that saving was quoted in the wrong unit

Asked, fairly: is gating the row builder the right approach? Re-examining the
number I used to justify it:

| | |
|---|---|
| builder cost per 1 s tick | **0.052 ms** on the dev machine |
| on a Pi (3-5× slower) | **~0.2 ms/tick = 0.02 % of a core** |
| "92.5 % saving" in absolute terms | **~0.02 percentage points** |

**I quoted a ratio where the absolute number was the decision-relevant one.**
92.5 % of almost nothing is almost nothing. The change is harmless and slightly
tidier, but it is not a performance win and should not have been presented as
one.

**And the ~4-5 point "residual" I attributed to the row builder is not
established either.** 18.8 % came from 3 samples over 4 s; 23.4 % from 5 samples
over 20 s, under conditions that differed in at least one way nobody recorded
(whether the Diagnostics page was open). A 4-point difference is inside the noise
of that method. Attributing it to a specific node was the same over-reading this
investigation has repeatedly punished — the discipline held while candidates were
being *eliminated by experiment*, and slipped as soon as the numbers got small.

#### Is the approach right?

**As an architecture, timer-plus-gate is poll-then-discard.** The cleaner design
is demand-driven: the reading cache is already maintained continuously and
cheaply by an event, so the table could be built when the UI asks for it and the
1 s timer removed entirely. That would be the right shape.

**It is not worth doing for 0.02 %.** Every change to this flow has to be
deployed to a live fire-safety panel and re-verified, and this session has
already produced two regressions from changes that looked obviously safe.

**Keep the gate** — it is written, tested, and removes work that had no purpose —
**and stop optimising here.** node-red sits at ~23 % with the panel 70-77 % idle;
there is no CPU problem left to solve. The open question is not a number, it is
whether the **HMI actually responds now**, which is the symptom that started all
of this and has still not been confirmed.

### Leaving the Diagnostics page was slow — client-side, and fixed server-side

Live report 2026-09-08: HMI response much better overall, but switching *away*
from the Diagnostics page took slightly longer. That is Angular teardown, and
counting what it had to destroy per row made the cause obvious:

| Per row | Before | After |
|---|---|---|
| `ng-model` on disabled `<input>` | **4** | 0 |
| `blacklist.byUnit[RawData.ID]` resolutions | **6** | 0 |
| watchers (interpolations + `ng-if` + `ng-class`) | 9 | **9→3 in the device cell** |

At 71 rows that was **284 NgModelControllers** — a full Angular model controller
per cell, with formatters, parsers and a `$render`, built purely to display
read-only text — plus ~640 watchers. Every one is evaluated on each digest and
destroyed when the page closes. At the 240-sensor target it would be ~960
controllers and ~2160 watchers.

Two changes, neither of which alters what the page looks like:

- **The four disabled `<input ng-model>` cells become `<div>`s with the same
  class.** `.bms-input` only sets width, background, colour, border, padding and
  text-align — all of which apply identically to a div; `box-sizing: border-box`
  and `display: block` were added so the 100 % width behaves the same.
- **`annotateDevice()` collapses the device cell server-side** into one
  `Device` string and one `DeviceClass`. The text and class names are
  byte-identical to what the template produced, pinned by unit tests, because a
  performance fix must not quietly change what an operator sees.

This also cuts the *live* cost, not just teardown: six property-chain lookups per
row were being re-evaluated on every digest, and digests run on every update.

#### The fifth comment-versus-code trap, this time in my own check

The post-edit structural check reported `<div` 11 / `</div>` 10 — an unbalanced
tag. It was not: the CSS comment I had just written to explain the change
contains a literal `<div>`, and the naive count read it as an open tag. The
verification now strips CSS and HTML comments first, and asserts the nesting
depth **never goes negative** rather than only that the totals match — totals can
balance while the structure is wrong.

Five times now a check in this project has matched prose instead of code. The
rule is cheap and should simply be habit: **strip comments before asserting on
structure, and assert on nesting rather than counts.**

### The Audit page, same class of problem — and a silent export bug it uncovered

Reported alongside the Diagnostics lag. The two Audit Trail viewers have no
`ng-model`, so that fix did not apply; the cost was different:

| | Joint audit `31e8d84…` | Alarm audit `2966ac3…` |
|---|---|---|
| rows | up to **200** (the `appendLegacyAudit` cap) | up to 200 |
| watchers/row | 5 | 8 |
| `orderBy` in `ng-repeat` | yes | yes |
| `track by` | yes | **no** |

**`orderBy` inside `ng-repeat` re-runs the sort on every digest cycle** — 200
entries re-sorted on any UI interaction anywhere on the dashboard, forever, for
an order that changes only when a config is applied. And the alarm audit had
**no `track by`**, so Angular rebuilt all 200 rows' DOM whenever the payload
array identity changed.

Fixed by sorting in the feeding function nodes (`sortAuditDesc` in
`legacy-audit.js`, the module that already owns these globals) and adding
`track by $index`. Neither page is on a timer — they refresh at boot and on a
config apply — so the remaining cost is render and teardown of 200 rows, which is
inherent to showing 200 rows.

**`sortAuditDesc` returns a copy.** `global.get(key, 'default')` hands back a live
reference to the persisted array; sorting in place would permanently reorder the
audit log — a record whose entire value is that its order can be trusted.

#### The bug this uncovered, which tests did not catch

`sortAuditDesc` was required into `node-red/index.js` but **never added to
`module.exports`**. The viewers call it as `cs.sortAuditDesc(...)` behind a
`cs && cs.sortAuditDesc` guard, so nothing threw — the pages would simply have
rendered **unsorted** audit entries, indefinitely, with no error anywhere.

A graceful fallback turned a missing export into a silent behaviour change. That
is the same shape as every other defect this week: the failure mode is not a
crash, it is a plausible-looking wrong answer.

Guarded generally now, not just for this one symbol:
`test/flows-integrity.test.js` finds every local variable in a flow node assigned
from `global.get('busductConfigService')`, collects every member accessed on it,
and asserts the service actually exports it. **839 tests.**

### Audit viewers capped at 20 rows (user request 2026-09-08)

**Safe because these arrays are not the audit record.** `ConfigStore._appendAudit`
appends every change to **`audit_trail.jsonl`**, uncapped and untrimmed;
`joint_config_audit_log` and `audit_busbartherm` are display caches that exist
only because two `ui_template`s read them. Trimming them deletes nothing — it
shortens what the dashboard renders. That was worth confirming before touching
anything called "audit" on a safety system.

Cap **200 → 20**, applied on both write and read:

- **write** — `appendLegacyAudit` now caps at `VIEWER_CAP`;
- **read** — `viewerRows()` sorts newest-first and slices to the same constant,
  because a panel already holding 200 entries would otherwise keep rendering all
  of them until its next config apply. Read-side trimming deliberately **does not
  write back**: that would put an SD write on every page open, and the stored
  array converges on the next append anyway.

Two benefits beyond render cost, both specific to `audit_busbartherm`: each entry
embeds a **full before/after config snapshot** (`oldConfig`/`newConfig`), and the
array lives in the **localfilesystem** context store — so 200 of them was a
sizeable object rewritten to the SD card on every context flush, for history
nobody scrolls to.

#### A test that had to be edited, and now cannot be again

`joint-master-handler.test.js` asserted `log.length === 200` and `log[199]`, so
changing the cap broke it. It now reads `VIEWER_CAP` from the module and derives
its expectations, because the property under test is **"the oldest are dropped"**,
not any particular number. A test that hardcodes a constant it does not own turns
every deliberate change into a false failure — and the temptation then is to
update the number without re-reading what the test was for.

### "Device: Active" beside "Status: No Data" — fixed (user request 2026-09-08)

A panel showed five rows reading **Device: Active, Status: No Data**, with the
Data column empty. `annotateDevice` said `Active` whenever the blacklist held no
entry for the unit — including for a device that had **never been heard from**.

That is a contradiction on its face. Green "Active" reads as healthy; the
truthful answer was that there is no current reading and the blacklist engine has
not formed a view, because a device that is never polled produces neither an `ok`
nor an `err` and so never accumulates the three failures that would blacklist it.

Now a device is called **Active only when there is a fresh, OK reading**.
Everything else without a blacklist entry — never seen, stale, or erroring — is
**Unknown**, styled muted grey (`#94a3b8`) rather than green: it is an absence of
information, not a fault, and it must not read as reassuring.

| Blacklist entry | Reading | Device |
|---|---|---|
| none | fresh + OK | `Active` |
| none | never seen / stale / error | **`Unknown`** |
| blacklisted | any | `BLACKLISTED [Ns]` |
| probing | any | `PROBING [Ns]` |

The invariant is asserted directly in the tests: **`Active` can never appear
beside a `Status` other than `Connected`.**

This is the same correction as every other one this week — prefer the honest "we
do not know" to the plausible-looking wrong answer. It is worth noting how the
old behaviour arose: the label was written when the only question being asked was
"is this device blacklisted?", and `Active` was a fair answer to *that* question.
It became wrong when the column was placed next to a Status column that could
say "No Data". **A label that is true in isolation can be false in context.**

#### Still open: why the Data column is empty on that panel

Three candidates, not yet distinguished, and they need different fixes:
1. the sensors are genuinely not connected — in which case the table is correct
   and this is the new design working as intended;
2. readings are flowing but the tap into the cache is not reaching it — a defect
   in the 2026-09-08 cutover;
3. the Nano is not polling those slaves at all (commissioned without a job
   resend), which also explains why nothing blacklisted.

The two node statuses that separate them: **"Scale Nano Reading"** shows
`id:channel=value` per frame, and **"Diag Rows"** shows `N channels, M connected`.
Values in the first with `M = 0` in the second is conclusive for (2).

### "Cannot delete a slave still mapped to a joint" while adding a slave (2026-09-08)

Live report: adding a slave in Modbus Settings was refused with *"Cannot delete a
slave still mapped to a joint: J22, J39, … — unmap it in the joint table first"*,
while the Joint Config table on screen was **empty**.

**Both statements were true and neither was useful.** The panel's applied config
carried 12 mapped joints; the Configuration Status banner on the same screen said
so — *"In service but not in the editing table: J22, J39, …"*. But the Modbus
Settings table held only 2 rows.

The mechanism is the design that fixed an earlier bug. The client posts its
**whole** `{slaves, buses}` state on every action (the 2026 data-loss lesson), so
a table that never loaded the applied configuration silently proposes deleting
every slave absent from it. The guard then correctly refuses. The operator sees a
delete error for an add, and an empty joint table that appears to contradict it.

Two fixes:

**1. RELOAD now actually reloads.** `currentState()` fell through to the saved
draft when the posted payload had no `slaves`, and `reload()` posted exactly
that — so it returned the same stale rows and appeared to do nothing. The
operator was locked out with no way forward: the table proposes a mass delete,
the guard refuses, and the one button that should fix it is a no-op. `reload` is
now an explicit action that bypasses **both** the posted state and the draft, and
the button confirms first because it discards unsaved edits.

**2. The error explains the situation instead of one true fact about it.** It now
states what would be deleted, gives the deliberate-removal path, notes that *the
joint table can look empty while joints are in service*, and — when the table
holds fewer slaves than are in service — says so with both counts and names
RELOAD.

#### Two fixture traps on the way to a passing test

The first draft posted an **empty** table: that hits an earlier "at least one
slave is required" guard and never reaches the code under test. The second kept
only the first row, which drops the **panel ambient**, whose guard fires before
the joint one — so it asserted against the wrong message. Only dropping a
joint-mapped row while keeping the ambient exercises the path.

Both were caught by the test failing rather than passing vacuously, which is the
difference from the earlier cases in this project where a fixture silently missed
its target. **The live case was 2 rows against 12 joints — a fixture has to
reproduce the shape, not just the direction.**

### The slave that vanishes from the table — three hypotheses tested, all wrong

After the RELOAD fix the operator got a much narrower failure: the table now
loads **12 slaves but 13 are in service**, and the one missing is mapped to J49.
So `stateFromApplied` renders every applied slave except one.

Three mechanisms were proposed and **each was falsified by reproducing it**:

| Hypothesis | Why it fails |
|---|---|
| Two applied slaves share a unit address, so grouping (`byAddress`, keyed on `unit_address` alone) collapses them | `readDomain` **validates**, so such a doc would not load at all — the table would be empty, not short by one |
| A slave with no `channels` field renders zero rows (`for k < channels`) | `DEFAULTS.channels` is **4**, not undefined; a missing field yields four rows, not none |
| The same address on two different buses — R4 keys on `(bus_id, unit_address)`, so it validates, while the UI groups on address alone | Real gap, but there is already a guard for it and it fires **first**, with its own message |

That third one is worth keeping in mind — **R4 permits per-bus duplicates while the
UI model requires panel-wide uniqueness** — but it is not this bug.

**So the cause is still unknown, and the honest response is to stop proposing
mechanisms.** Three wrong guesses in a row is the signal this session has already
taught: reasoning about the shape of a system keeps producing plausible answers,
and only measurement separates them.

#### What was done instead: make the panel say which slave

The error named the **joint** (J49) but not the **slave**, and which commissioned
slave the table failed to render is exactly the fact needed to diagnose it. It now
reads:

```
... still mapped to joint(s): J49 (slave sl07, unit 63 on bus2, 1 ch).
```

The slave_id, its unit address, its bus and its channel count are all in the
message, so the next occurrence identifies itself instead of prompting a fourth
hypothesis. If the slave is not in the applied config either, it says that too —
a different fault entirely.

### R17 and revert-on-reject (user instructions 2026-09-08)

Two changes, both from the Modbus Settings deadlock.

#### R17: one unit address may not appear on two buses

Modbus allows it — addresses are per-segment — and **R4 only requires
`(bus_id, unit_address)` to be unique**, which is why such a document validates.
The *panel* cannot represent it: the surviving legacy decode keys
`sensorData[<unit_address>]` by address alone, the diagnostics reading cache keys
`<unit>:<channel>`, ProcessLogic matches on unit address, and the Modbus Settings
table groups rows by address with no bus in the key. Two slaves sharing an
address collapse into one everywhere downstream. A UI pre-check existed; the
validator did not enforce it, so a remote push or a hand-edited file could
introduce what the UI forbids.

**Enforced only when applying.** `readDomain` treats an invalid document as
absent and falls through to the LKG snapshot — so an unconditional new rule could
take a running panel's entire configuration away, no polling and no alarms, to
punish a commissioning mistake. Verified both directions: a panel already
carrying the collision still loads its config, while a new apply of the same
shape is refused naming both buses and both slaves. `applyIfValid` now passes
`applying: true`, which is the discriminator any future rule of this kind should
use.

R4 stays unconditional for same-bus duplicates — panel-wide uniqueness implies
it, but gating R4 would have weakened an existing check.

#### A rejected apply reverts the table

*"Reject new changes and reload automatically once so the user sees what system
is using actively."* The rejected rows used to be echoed back, so the operator
sat looking at a table that had **not** been applied while believing it might
have been — the confusion that started this whole thread. On a fire-safety panel
the displayed configuration should always be the one in service.

The draft is replaced too, not just the returned payload: `draft: null` would
leave the rejected rows persisted and a page refresh would bring them straight
back.

**The trade-off is real and is stated in the error rather than left to be
discovered**: the edits are discarded, so a typo in one field costs the whole
edit. That is the deliberate choice — a table that always shows what is running
is worth more on a safety system than preserving an edit that was refused.

## 2026-09-08 — A stuck scan flag was silently disabling ALL measurement

The empty Data column had a cause after all, and it was not any of the three I
guessed. User observation: *"we have configured sensors only on bus 2 and
observed data is not coming out from function 14 in modbusMaster_V2. Input is
coming from bus 1 and bus 2."*

`function 14` was:

```js
if (flow.get("scanActive") != 1) { return msg }
```

**A fail-CLOSED gate in front of the entire measurement path.** ProcessLogic, the
Alarm Manager, the historian, the BMS image, the cloud gateway and the
diagnostics table are all downstream of it. `scanActive` is set by the Start Scan
button and cleared in exactly **one** place — when the scan's frame counter
reaches `scanTotal` (127).

Every one of these leaves it latched at 1 forever:

- the counter only begins once a frame with `id == 1` has been seen
  (`start_Count`), so if address 1 never answers it never starts;
- one dropped frame leaves the count short of 127;
- **the scan writes its job through the legacy `paraRaw` path, which is bus1
  only** — on this panel, whose sensors are on bus2, the scan could never
  complete;
- Node-RED restarting mid-scan: flow context here is localfilesystem-backed, so
  the flag **survives** while the scan that would clear it does not.

The panel then looks entirely healthy — HMI up, BMS serving, heartbeat advancing,
Device column reading Active — while monitoring **nothing at all**, with no
alarm, no indication, across reboots. On a fire-safety monitor that is the worst
available failure shape.

**Third instance in this project of a flag outliving the thing that would reset
it** — the stuck blacklist alarm, the stale exclude set, now this. The pattern is
worth naming: *state whose clearing depends on an event that may never arrive
needs a deadline, not just a clearer.*

#### The fix: `src/config-service/scan-gate.js`

Three properties, all of which the old gate lacked:

| Property | Behaviour |
|---|---|
| **Bounded** | past 120 s the gate releases, clears the flag and restores `paraRaw` from its backup. A scan is a foreground operation an operator waits for; 127 addresses at a 500 ms worst-case timeout is ~64 s |
| **Scoped** | the scan is bus1-only, so bus2 frames are never gated. Blocking them was pure collateral — and fatal on a bus2-only panel |
| **Fails open** | no start time (a scan predating this code, or context lost) releases rather than being read as "just started". A missing library also passes data through |

Verified against the real node body:

```
THE STUCK PANEL (flag set, no start time, sensors on bus2)
  bus2 frame -> passed         (scan is bus1-only)
  bus1 frame -> passed, scanActive cleared, paraRaw restored, warns

A REAL SCAN, 3s in
  bus1 -> blocked  "scan active 3s - measurement paused"
  bus2 -> passed

A SCAN 3 MINUTES OLD
  bus1 -> passed, cleared, "scan exceeded 120s - releasing"
```

Clearing the flag also **restores `paraRaw` from `paraRaw_backup`** — releasing
the gate without that would leave the Nano scanning addresses 1..127 forever
instead of polling the commissioned slaves.

`scanStartedAt` is now stamped when a scan starts, because without a start time a
latched flag is indistinguishable from a scan that began a moment ago, and the
gate has no safe way to release.

**LIVE-VERIFIED 2026-09-08**: deployed to the panel and data flowed immediately —
the bus2 path is no longer gated at all, and the first bus1 frame cleared the
stale flag and restored polling. This was the cause of the empty Data column and
the panel-wide "No Data", not any of the three mechanisms guessed before it.

#### Caveat: the scan FEATURE is still brittle, only the gate is safe now

What was fixed is the blast radius, not the scan. Its completion logic is
unchanged and remains fragile: counting starts only after a frame with `id == 1`,
it requires exactly `scanTotal` frames, and **the job is written through the
bus1-only legacy `paraRaw` path**. On a panel whose Nano is on bus2, Start Scan
still cannot do anything useful — it will now simply release after 120 s with a
warning instead of disabling the panel forever.

Making the scan actually work per-segment means routing its job through the
compiler rather than `paraRaw`, which is the same bus1-only legacy dependency
that the Diagnostics cutover and the poll-interval work (D7) both ran into. Worth
doing as one piece of work rather than three.

### Second independent reference check: contact-type sensor, ±1 °C (2026-09-08)

Reported: a separate bench setup compared the panel's readings against a
**contact-type sensor**, agreeing to within **1 °C**.

**What this adds to the Fluke check.** J10 at 131 °C against a Fluke 87V at
132.0 °C tested one point, far above the working band, with a reference whose own
combined uncertainty there is ±2.5–3 °C. This one is a different reference, a
different technology, and — being a bench comparison rather than a spot check —
presumably across the normal operating range. Two independent references
agreeing is a materially stronger position on the **measurement chain** than
either alone: sensor element, Modbus decode, sign handling, `0.01` scale, and the
per-channel fan-out are all in the path being compared.

**What it does not establish, and this matters for D3.** If both sensors sat on
the same surface, the comparison validates the *sensor and its decode*. It says
nothing about the **cover-to-joint transfer function** — how the temperature of
the busduct cover, read through a 5 mm mounting plate across a 0.25 mm gap,
relates to the temperature of the conductor joint underneath. That is the
unknown D3 needs, and only a live thermography comparison against a loaded joint
can supply it. A perfect sensor reading the wrong surface is still the wrong
number for an alarm threshold.

**Two things would make this citable rather than indicative**, and neither is
recorded yet:

1. **The temperature range covered.** ±1 °C at 30 °C and ±1 °C at 130 °C are very
   different claims. The Fluke point is at 131 °C; if this bench run spans
   ambient to ~60 °C, together they bracket the working band.
2. **Whether the reference is genuinely independent.** A contact sensor of the
   same class as the device under test can share a systematic bias, in which case
   agreement demonstrates *consistency*, not *accuracy*. A calibrated reference,
   or a different sensing technology, breaks that.

Recorded as a real result with its scope stated, in the same terms as the Fluke
check — the failure mode this project keeps hitting is a true measurement quoted
as evidence for a claim it does not actually support.

### Correction: external thermography measures the cover, not the joint

STATUS.md §6 claimed a thermography survey of the WATCH joints would yield the
cover-to-joint transfer function. **That is wrong for an external survey**, and
worth correcting before a site visit is spent on it.

An IR camera pointed at a closed busduct measures the **cover** — the same
surface the sensor already measures. Comparing the two validates the sensor, its
mounting and the 0.25 mm gap, and it localises the hot spot; it does not see the
conductor. The transfer function needs the joint itself in view.

**What the live survey is still worth doing for:**

1. **Independent confirmation of the flag** — is the flagged joint's cover really
   warmer than its neighbours, measured by something that is not our sensor?
2. **Localisation** — is the warm patch centred on the joint, or is a cable or
   adjacent connection heating that part of the cover? A sensor reading a hot
   spot that is not the joint is measuring the wrong thing.
3. It is the closest available evidence of detection capability without a fault.

**What the transfer function actually needs**, none of which is a live external
survey: a shutdown survey with the cover off (safe on a dead bus, no new
hardware); an IR window over a representative joint; or a contact sensor placed
on the conductor during an outage and left to correlate against the cover sensor
under load. Plan it into the next shutdown.

**Practical notes for the live survey**, since the value depends on what gets
recorded:

- **Emissivity is the main error source.** Painted steel is ~0.9 and behaves;
  bare or galvanised metal is low and variable, and readings on it are close to
  meaningless. If the cover is unpainted, fix a patch of matt electrical tape at
  the measurement spot and read that.
- **Image flagged and healthy joints in the same frame** where possible. The
  comparison is what matters and shared emissivity/angle errors largely cancel.
- **Record the load current and ambient at the time.** ΔT scales with I²R; a
  survey at 40 % load says little about the same joint at full load.
- **Capture the panel's own reading at the same timestamp** — from the HMI or the
  historian — so the pairs are directly comparable rather than approximately
  contemporaneous.

---

## 2026-09-09 — Node-RED at 50 % of a core with nothing connected: the applied config was re-parsed and re-validated per message

**Symptom.** ESBUSBBT06's HMI stayed sluggish after every fix so far. With the
kiosk browser killed, no dashboard client connected, VNC costing 4.5 % and X
4.4 %, Node-RED alone read **49.5 % of a core** — roughly double the 23.4 % the
same panel measured after the diagnostics cache fix, with no code change in
between.

**The measurement that found it.** `/proc/<node-red pid>/io`:

```
rchar        1.98 MB/s     read syscalls
read_bytes   0             physical reads from the SD card
wchar        84.6 KB/s
write_bytes  ~0.4 KB/s     (writeback timing; lifetime ratio says 92 % reach the card)
```

Two facts fall straight out. Both Nanos run 115200 8N1 — **11.5 KB/s per port,
~23 KB/s for both, a hard physical ceiling** — so ~99 % of Node-RED's read
traffic could not possibly be sensor data. And `read_bytes` never moved, so
every one of those reads came from page cache: no flash wear, no disk wait, and
therefore invisible in `vmstat`'s `wa` column or as run-queue pressure. The cost
was pure CPU on the one thread that runs every function node.

**A wrong turn, recorded because it was nearly acted on.** The obvious suspect
was the localfilesystem context store — `global.json` is 466 KB, and 1.98 MB/s
÷ 466 KB ≈ 4.25 whole-file reads per second, which fits suspiciously well. It is
wrong: Node-RED's `localfilesystem` context module defaults `cache` to `true`
(`runtime/lib/nodes/context/localfilesystem.js:153`,
`config.hasOwnProperty('cache') ? config.cache : true`), and the panel's
`contextStorage` sets no options, so `global` is served from RAM. A plausible
arithmetic fit is not evidence; the source was.

**Root cause.** `ConfigStore.readDomain()` does `existsSync` + `readFileSync` +
`JSON.parse` + **a full R1-R17 validation pass**, with no caching, and three
nodes called it on a per-message path: the **Alarm Manager** (once per KPI
message), the **Blacklist Engine** (once per Nano frame), and **Scale Nano
Reading** (which at least had a 10 s cache). At ~74 KB per document and
~20-27 calls/s, that reconciles the whole 1.98 MB/s to a single file:
`/var/busduct/cfg/modbus_joints.json`.

Measured on a fixture scaled to the live panel (71 slaves, 200 joints — the
schema's `joints` cap of 200 bites before 71x4=284, which is the same cap
already flagged for the 240-sensor question):

```
document 73.8 KB     readDomain 464 us/call     readDomainCached 13.3 us/call     35x
```

**Fix: `ConfigStore.readDomainCached(domain)`**, memoised on the file's identity
(`mtimeMs:size:inode`) rather than on a timer. A `stat` replaces a parse plus a
full validation pass, and — the reason for identity over TTL — **an apply is
visible on the very next message** instead of up to 10 s later, which on the
alarm path is a race, not a latency. The LKG snapshot is part of the signature
too, so a corrupt primary that is later repaired stops serving the fallback
without a restart. The cache lives in **module** scope (the fourth time in this
project that has been the right answer: `context`/`flow`/`global` all route
through the localfilesystem store), and the returned document is **deep-frozen**
— every current consumer treats it as read-only, checked, and freezing makes
that a guarantee now that callers share one object.

`Scale Nano Reading`'s 10 s cache is retired in favour of it. That cache was
worse than it looked: besides delaying applies, it wrote the whole ~74 KB
document into **flow** context, which the store then serialised to the SD card
on every flush.

**Honest bound on what this buys.** ~20-27 calls/s x ~451 us saved is ~1 % of a
core on a dev machine, so roughly **6-15 % on a Pi** depending on how badly AJV's
allocation behaviour scales down. That is a real improvement and it removes an
I/O anomaly of two orders of magnitude — but it does **not** account for all of
the 49.5 %. The remaining ~35-40 % is ordinary per-message flow work at ~20 msg/s
and is a separate question. Predicted, not yet measured on the panel.

**Guards.** `test/config-service/applied-cache.test.js` (memoisation, immediate
invalidation on apply, same-size rewrite, deep freeze, LKG repair, absent
document, two roots) and a `flows-integrity` test that fails if the Alarm
Manager, Blacklist Engine or Scale Nano Reading regresses to the uncached call —
the uncached form is the natural thing to reach for and its cost is invisible
until a panel is large.

**Method note.** The first benchmark run reported 464 us/call against a fixture
that did not validate, so it was timing the reject path. It was caught by a
`validates:` line printed before the timings — the same guard added to
`tools/bench-hot-path.js` after it silently measured a never-invoked function.
A benchmark must assert it is measuring the path it claims to measure.

- **2026-09-09** — **`ea1e3cb`'s I/O half is confirmed on the panel; its CPU
  half is not, and cannot be from this measurement.** `/proc/<pid>/io` on
  ESBUSBBT06 now shows `rchar` at **69-79 KB/s** against the **1.98 MB/s**
  recorded before the applied-config cache — a ~96 % reduction, and about what
  one file read every ~20 s instead of ~25/s should look like. The predicted
  **6-15 % of a core** is a different claim and remains unmeasured: between the
  prediction and the measurement `inter_frame_ms` was changed on the panel
  (below), which moved CPU by far more than the cache ever could and destroyed
  the baseline. A prediction and its verification have to be taken on the same
  configuration; this pair was not, so the CPU number stays open.

- **2026-09-09** — **The slow HMI was on the client, and the cause was a clock.**
  §3b of STATUS.md left open whether the server's headroom reaches the operator.
  Per-thread `top` settled where the cost was: the Node-RED main thread at
  **98.7 %** in `state R`, while the V8 worker threads had ~13 s of CPU *each*
  over 3 h 15 m. JavaScript runs on one thread, so >100 % means work off it —
  and idle workers rule out GC and the libuv pool in one reading. Not memory
  either (RSS drift −749 kB/s, a sawtooth) and not disk (`read_bytes` 0).

  Nine sub-second inject timers pushed into dashboard widgets on a fixed
  schedule regardless of whether their data had changed. **Eight of those were
  only wasteful; one was structurally different.** An Angular push whose value
  is unchanged runs a digest and stops — no DOM change, no repaint, nothing on
  the wire. But `new Date().toLocaleString()` into two "Date:" `ui_text` widgets
  changes *every second by construction*, so it guaranteed a repaint every
  second forever and an otherwise idle panel could never go static. Over VNC
  that is the entire cost: the server re-encodes and ships a framebuffer region
  every second whether or not anything happened. Removed (user chose deletion
  over slowing it); six further pushes went 1 s → 10 s, with `once:true` added
  to the four that lacked it so their views still populate on deploy instead of
  sitting blank. Sub-second dashboard pushes ~9/s → 3/s.

  **Operator-observed, not instrumented** — "speed is improved on HMI", no
  before/after `kiosk_cpu` figures. The runbook's own §12a-bis findings 1 and 4
  (`--force-device-scale-factor=1`; `feh` never exiting) are untested and
  independent, and Chromium was previously measured at ~125 % against
  Node-RED's ~23 %, so the browser is still the larger consumer.

- **2026-09-09** — **D7 stopped being theoretical.** `inter_frame_ms` was
  hand-set 250 → 20 ms on ESBUSBBT06 and pegged the event loop at ~99 % of a
  core with no dashboard client attached. The trap is that this single number
  sets the panel's whole CPU load while **`poll_interval_s` — the value R10
  validates and the dashboard shows — never reaches the Nano**: `compileNanoJob`
  emits `comm = [inter_frame_ms × 1000, baud, timeout_ms]`. An operator tuning
  the number the UI presents as the poll interval changes nothing; the effective
  knob is unlabelled. Also worth pinning: the per-frame cost is
  `inter_frame_ms + wire time` (~17 ms for a 1-register read at 9600 baud), so
  250 → 20 ms is ~7× the frame rate, not the ~12× the delay alone implies — an
  arithmetic slip I made and corrected mid-investigation.

  **And the panel is near R10's ceiling**: 88 slaves on one bus at 250 ms sweeps
  in 25.5 s against a 30 s poll interval — 15 % headroom, so four or five more
  devices fail on apply, and the 110-device target is unreachable in this layout
  (`inter_frame_ms ≤ 237 ms`, less with multi-channel spans). `bus2` is built and
  live-verified but unused here; 44 + 44 gives 13.8 s and 54 % headroom. It does
  not cut CPU — two segments at 3.7 frames/s each is 7.4 frames/s of work.

- **2026-09-09** — **`--incognito` improves HMI responsiveness on these panels,
  which is the opposite of what the runbook predicted.** `docs/pi-deployment.md`
  §12a listed it first among "two flags that cause almost every 'kiosk is slow'
  case", on the reasoning that it discards the disk and GPU shader caches so
  every asset re-fetches and shaders recompile on each start. That reasoning is
  correct as far as it goes and it was never measured — it counts what the
  persistent profile *saves* and not what it *costs*.

  On a Pi the profile lives on the SD card, and Chromium writes to it
  continuously: `Cookies`, `History`, `Favicons` and the cache index are SQLite
  databases, plus session-restore state and the dashboard's own `localStorage`.
  Small random writes are the worst case for SD flash — the same property that
  drove the historian's write-path work and the `contextStorage.default`
  findings. A panel boots rarely and then runs for months, so paying a one-off
  cold-cache cost at start to avoid months of profile I/O is the better trade.

  `--incognito` is now **on by default** in `deploy/bin/busduct-kiosk`
  (`BUSDUCT_KIOSK_INCOGNITO=0` reverts). §12a carries the correction inline
  rather than being rewritten, because the shader-cache half still applies: the
  first paint after a boot or a respawn is genuinely slower, which is an
  argument for keeping respawns rare, not for the persistent profile.

  **This is the third time in this project that a confident mechanism turned out
  to be the wrong one** — after the localfilesystem context store (a plausible
  arithmetic fit that was not the cause) and the Nano firmware RAM theory (the
  hang was the Pi's power supply). The pattern is the same each time: a
  mechanism that is real, that would produce the observed symptom, and that was
  reasoned to rather than measured. §12's own standing instruction - measure
  `chromium` in `top` either side of every single change - exists because of it.

- **2026-09-09** — **`docs/pi-deployment.md` §12 restructured so a new panel
  needs no tuning pass.** §12f is now declared the standard build and the
  section opens by saying so: it already carries the lean flag set,
  `--incognito`, the RAM disk cache, no `--no-sandbox`, no
  `--force-device-scale-factor` and `Restart=always`. §12a-§12e are re-framed as
  material for panels already in service and for diagnosing a panel that is slow
  despite §12f — they are kept in full rather than trimmed, because they record
  how each value was arrived at and two of them record getting it wrong.

  Two sections added for the installed base, which was the actual request -
  making the improvements applicable to devices already in the field:
  **§12g `inter_frame_ms`**, which is the largest single lever on Node-RED's CPU
  and is not a kiosk setting at all (with the read-back command, the
  device-count table and the trap that `poll_interval_s` never reaches the
  Nano), and **§12h**, the flow-side changes that arrive with a `git pull` plus
  a flow re-import and need no configuration.

- **2026-09-10** — **Threshold profiles were a silent no-op: every joint on the
  panel was evaluated against one panel-wide set.** `cfg/alarms` has had named
  `profiles` since Slice 2, `cfg/joints` has had `joints[].threshold_profile` to
  select one, and **A3 validates that the reference resolves**. Nothing read it.
  The Alarm Manager loaded `busbartherm_system_config` — one flat
  `{deltaT, ror, persistence}` — and used it for every joint; a grep of every
  function node in the flow found **zero** references to `threshold_profile` or
  `profiles`. An operator could set a per-joint profile, watch it validate, see
  it written to the audit trail, and the panel would carry on using the
  panel-wide numbers. Worse than a missing feature, because it looks like it
  works.

  **This is the second instance of the same shape in two days**, after
  `poll_interval_s` never reaching the Nano (2026-09-09). Both are a field that
  is validated, displayed and stored, but never read by the code that acts on
  it. **Schema validation cannot catch this class of bug** — the document is
  perfectly self-consistent; the defect is that nothing consumes the field. Only
  a test asserting somebody *reads* it can, which is what
  `test/flows-integrity.test.js` now does for this one. Worth a deliberate sweep
  for other write-only config: a field nobody reads is indistinguishable from a
  working feature right up until someone depends on it.

  **The fix.** `src/alarms/threshold-resolver.js` (pure, 18 unit tests) resolves
  a joint's thresholds: its own profile → the `default` profile → the flat
  legacy shape. `buildProcessLogicJoints` now publishes `threshold_profile`,
  ProcessLogic carries it on the KPI message, and the Alarm Manager resolves per
  message instead of reading `cfg.deltaT`/`cfg.ror`/`cfg.persistence` directly
  (12 references rewritten). `runtimeConfig` — written by both the local apply
  and the remote drain — now carries the full `profiles` map **alongside** the
  existing flat fields, so a panel running an older flow, or this one before its
  next alarm apply, is unaffected.

  **Fail-safe direction, as everywhere else on the alarm path**: every fallback
  widens rather than narrows, and the last resort is the panel-wide set that was
  in use before this change — so the worst case is exactly the old behaviour,
  never silence. A missing library, a deleted profile name and a malformed
  profile all end at the default rather than leaving a joint unwatched. `via`
  records which rung answered, so a joint quietly running on the wrong
  thresholds can be surfaced instead of being invisible.

  **A partial profile is rejected whole, not merged.** The schema makes all
  three groups required, so a profile missing one is malformed rather than a
  request to inherit; half-applying it would produce thresholds no one wrote.

  **Deliberately NOT done here: zone-wise binding.** The request that uncovered
  this was per-zone alarm settings (up to 50 zones). That needs
  `zones[].threshold_profile`, `zones.maxItems` raised from 16 to 50, A3 extended
  to validate zone references, and a decision on whether 50 zones want named
  profiles (`profiles.maxProperties` is capped at 16) or inline per-zone
  thresholds — all schema changes, which CLAUDE.md puts in the design chat. The
  resolver's signature takes a profile NAME rather than a joint, so adding a
  zone rung is a change to what the caller passes, not to this module.

- **2026-09-10** — **The sensor plausibility ceiling now comes from the sensor:
  300 °C → 150 °C, and it is read from config instead of hardcoded.** Two
  defects in one line. ProcessLogic carried `const SENSOR_MAX_C = 300` — a
  number inherited rather than derived from anything — while
  `sensor_fault.sensor_error_above_c` sat in `cfg/alarms` being validated and
  never read. That is the **third** instance of the write-only pattern in two
  days, after `poll_interval_s` and `threshold_profile`.

  The operator supplied the element datasheet: an epoxy-coated NTC chip
  thermistor, 100 kΩ ±1 %, **operating range −80 … +150 °C**. So a reading of
  151–300 °C could never be a true measurement, and the band was accepting it as
  one and passing it to the alarms, the historian, the BMS image and the cloud.
  The one number the band exists to catch was the one it let through.

  **The floor stays −40 and was deliberately NOT changed to the sensor's −80.**
  Sensor capability and application plausibility are different quantities, and
  the band wants their INTERSECTION. On the low side the application floor
  binds: no panel this ships into sees −40 °C, so it cannot reject a real
  reading, while −80 would accept 40 more degrees of nonsense for no gain. On
  the high side the sensor ceiling binds, which is exactly what was missing. The
  floor is not configurable because the schema has no field for it; adding one
  is a schema change and belongs in the design chat.

  **A configured ceiling is range-checked, not trusted.** It arrives from a
  mutable global, and a corrupt or hand-edited value of 99999 would silently
  disable sensor-fault detection on a fire-safety monitor. Out-of-range means
  fall back to 150, never obey. The bounds enforced (100–500) are the schema's
  own.

  **Read at the band, not from the config loaded later in ProcessLogic**, which
  sits behind `if (!cfg?.ror?.timeWindowMin) return` — a joint would otherwise
  lose its sensor-fault check entirely whenever the alarm config were
  incomplete. The lookup is wrapped in try/catch so a missing library keeps the
  datasheet defaults rather than removing the check.

  **A prior test asserted the ceiling "unchanged at 300" and was superseded, not
  deleted.** It was correct when written — that change was completing the LOW
  side of a one-sided gate and explicitly not retuning anything else. The
  behavioural test that lifts the real gate out of the flow and runs it now also
  pins `faulted(200) === true` and `faulted(149.5) === false`, so the case the
  old ceiling let through is covered by execution rather than by a regex.

  **Worth watching**: that same test records J10 reading **131 °C** under a heat
  test — real, and only 19 °C below the new ceiling. A heat test driven past
  150 °C will now classify as a sensor fault. That is correct (the element
  cannot measure there, so the value would be fiction) but it is a visible
  behaviour change for anyone running one.

  **Caveat carried forward:** the datasheet is for the thermistor ELEMENT. The
  joints are read through Modbus RTU transmitters with their own output range
  and scaling. 150 is a hard physical ceiling regardless — the element cannot
  exceed it — so it is sound as an upper bound on trust, but the transmitter's
  own specification should be confirmed before treating 150 as exact.

- **2026-09-11** — **Zone-wise alarm thresholds: zones bind to a named profile,
  joint beats zone, and no numbers move.** User decisions (2026-09-10/11): zones
  mostly SHARE threshold sets, so named profiles are the right model; a
  joint-level override beats its zone; `default` is explicitly selectable; up to
  **50 zones**.

  **All thresholds stay in `cfg/alarms.profiles`; `cfg/joints` holds references
  only.** The alternative considered was letting a joint or zone embed literal
  `deltaT`/`ror`/`persistence` values. Rejected for a reason found while
  scoping it: `joints[]`/`zones[]` live in the **`cfg/modbus+joints` domain,
  which R12 gates to maintenance mode for remote pushes**, while `cfg/alarms` is
  deliberately ungated because thresholds are not wiring reality. Embedding
  numbers in a zone row would therefore have made a remote threshold change
  require maintenance mode — inverting an explicit design decision from Slice 2.
  Keeping numbers in one domain also means a fleet-wide retune touches one
  document rather than every joint that embedded values.

  **Built**: `zones[].threshold_profile` (same `^[a-z][a-z0-9_]{0,23}$` key
  pattern as the profile map, so a name is spelled identically wherever it
  appears); `zones.maxItems` **16 → 50**. `zone_id` needed no change — the
  existing `^z[0-9]{1,2}$` already spans z1–z99.

  **A3 now covers zone references, not just joint ones.** A zone reference is
  the more dangerous of the two to leave unchecked: a joint names a profile for
  itself, but a zone names one on behalf of every joint in it, so one dangling
  zone reference silently drops a WHOLE zone back to panel-wide thresholds. The
  error names the scope (`zone 'z2'`) because the two references live in
  different tables and "which zone?" is the first thing an operator asks.

  **The chain is resolved at publish time, in `buildProcessLogicJoints`,
  deliberately beside `resolveAmbientKey`.** The ambient chain is already joint →
  zone → panel there; putting the threshold chain in the same function with the
  same shape is what stops the two drifting into different precedence rules.
  It also keeps the runtime resolver taking a single profile NAME — zones live
  in the joints document, not in the alarm config the resolver sees, so pushing
  the chain downstream would have meant shipping the zone table to the runtime.
  A joint explicitly set to `default` is a real selection and is NOT overridden
  by its zone; only an absent value falls through.

  **STILL INERT, and this is the gating item: there is no way to author a second
  profile.** `applyDefaultProfile` only ever writes `profiles.default`, so the
  Alarm Config tab cannot create `indoor` or `hot_riser`. Until a profile editor
  exists, a zone can only be bound to a profile that arrived by remote config
  push or a hand-edited file. **Phase 2 is that editor plus the per-zone and
  per-joint selectors on the Joint Config table** — all `ui_template` work, which
  needs live verification on the panel and cannot be tested in this repo.

  **Noted, not changed:** `profiles.maxProperties` is still **16**. With zones
  sharing profiles that should be ample, but 50 zones needing more than 16
  distinct sets would hit it. Raising it is a one-line schema change if the
  pilot shows it binding.

- **2026-09-11** — **Named-profile editor (Phase 2 backend): zone-wise thresholds
  are now authorable.** Profiles had been in `cfg/alarms` since Slice 2 and zones
  could bind to one from earlier today, but nothing could CREATE a second
  profile — `applyDefaultProfile` only ever writes `profiles.default`, so a zone
  could only name a profile that arrived by remote push or a hand-edited file.
  `src/config-service/profile-manager.js` (pure, 27 tests) plus two actions on
  the existing Alarm Config node: `profiles_load` and `profiles_apply`.

  **The client sends its WHOLE map on every action**, and the handler takes a
  whole map, never a delta — add, rename and delete are all edits to the map the
  client already holds. That is the `JointMasterUI` data-loss lesson: a UI that
  sends only what it touched lets the server answer from its own last-persisted
  copy, and the template's `$watch` then overwrites an in-progress edit. One
  write path, one validation pass, no partial-update shapes.

  **A hole that every unit test missed, found by running the handler against a
  real store.** `readDomain` returns `null` for an unreadable or invalid
  document. The "is this profile still in use?" check and **A3 are both gated on
  having the joints document**, so with no document BOTH fail OPEN: a profile a
  zone depends on could be deleted, and every joint in that zone would slide
  onto the panel-wide default without a word. The 23 unit tests passed
  throughout, because they all supplied a document.

  The fix is asymmetric on purpose. Adding or editing a profile is safe without
  the joints document, and a fresh panel legitimately has none — refusing every
  edit would make the editor unusable at commissioning. Only a **delete** needs
  the reference check, so only a delete is refused when it cannot be run. Same
  rule as the config-change alarm sweep: refuse to act on absent information,
  never read absence as "nothing is bound". Note "no document" and "document
  says nothing is bound" are different statements and only the first refuses.

  **Method note, and the second time this exact thing has happened.** The
  applied-config cache (2026-09-09) was caught by a benchmark that asserted it
  was measuring the path it claimed to. This was caught by an end-to-end run
  against a real store rather than a mock. A unit test proves a function is
  right about the inputs you thought to give it; only exercising the wiring
  shows what the rest of the system actually hands it.

  **An ordering trap, recorded not fixed.** `validateModbusJoints` does NOT check
  `threshold_profile` references — only A3 does, on the alarms side. So a joints
  apply carrying a zone bound to a non-existent profile SUCCEEDS, and every
  subsequent alarms apply is then blocked by A3 until it is corrected. Observed
  live in the end-to-end run. The UI makes it unreachable (the zone selector is a
  dropdown of existing profiles) but a remote push or hand edit can still do it.
  Two things make it survivable rather than baffling: A3's message now names the
  zone (added this morning), and the block is on the alarms domain, so
  monitoring continues throughout. Whether the joints validator should carry the
  same cross-domain check is a design-chat question.

  **Still to build: the UI itself** — the profile editor `ui_template` on Alarm
  Config, and the profile selectors on the zone and joint tables. All
  client-side Angular in the flow, which this repo's tests cannot exercise, so
  it needs live verification on the panel.

- **2026-09-11** — **The A3 ordering trap is closed at source.** Recorded earlier
  today and fixed the same day: A3 lived only in the alarms validator, so a
  joints apply binding a zone to a non-existent profile **succeeded**, and every
  subsequent alarms apply was then blocked by A3 until someone corrected it. The
  operator's error surfaced on a screen they were not using, about a document
  they had not touched.

  **Reported as A3, not as a new R number.** The invariant — a
  `threshold_profile` named in `cfg/joints` must exist in `cfg/alarms` — is
  symmetric: either document can break it. What existed was an enforcement gap
  on one side, not a second rule. Giving one invariant two ids would mean two
  sets of tests and two messages for one operator problem. It also avoids
  inventing an R number that the design chat owns and could assign elsewhere.
  If that chat prefers a distinct id, it is a rename.

  **Gated on `context.applying`, following R17 exactly.** `readDomain` treats an
  invalid document as absent and falls through to the LKG snapshot, so an
  unconditional check would take the whole configuration away from a panel that
  already carries a dangling reference — no polling, no alarms, on a fire-safety
  monitor — in order to fix a commissioning mistake. New configs cannot introduce
  it; existing ones keep running until someone corrects them. `applyIfValid`
  sets `applying: true` itself (`store.js:234`), so all three joints-apply paths
  pick this up without a caller change, and all three already pass `alarmsDoc`.

  **It does not deadlock commissioning.** With no profiles in `cfg/alarms` at
  all, every reference would dangle and blocking the joints apply would mean
  neither document could be applied first. So the check no-ops when the alarms
  document is absent or carries no profiles, and engages once profiles exist.

  Verified end to end against a real store, not only as units: applying a joints
  document whose zone names `ghost` is refused with *"zone 'z2' references
  threshold_profile 'ghost', which does not exist in cfg/alarms"*, while the same
  document with no profile bound applies cleanly.
