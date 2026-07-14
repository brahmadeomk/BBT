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
