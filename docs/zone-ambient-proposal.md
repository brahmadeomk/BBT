# Zone as the place both ambient and thresholds are set

**Status: PROPOSAL, not built (2026-09-11).** For the design chat. Raised by the
operator after the zone-wise threshold work landed: *"Can we match the profile
and ambient sensor in the zone table and use only the zone drop-down to link
all?"*

---

## 1. The ask

Put **both** the alarm profile and the ambient sensor on the zone row, and let a
joint inherit both by naming its zone — so the joint table's primary control is
one zone dropdown rather than three separate columns.

## 2. The surprising part: most of this already exists

The three-level chain is already modelled, validated and resolved:

| Layer | State |
|---|---|
| `zones[].ambient_sensor` in the schema | **present** |
| `joints[].ambient_sensor` in the schema | **present** |
| **R14** validating any ambient ref at panel / zone / joint level | **present** |
| **R9** requiring a resolvable ambient when ΔT alarms are used | **present** |
| Runtime resolution joint → zone → panel (`resolveAmbientKey`) | **present** |
| **A UI to set a zone's ambient** | **missing** |
| An apply path that *preserves* a declared zone ambient | **missing** |

So this is **not a schema change**. It is a UI addition plus one change to the
apply path. That materially lowers the cost and the risk.

## 3. How it actually works today, and why it is fragile

The zone table has no ambient column at all. The operator sets `ambientSlaveID`
on **every joint row**, and `resolveAmbientChain`
(`src/config-service/ambient-resolution.js`) *reverse-engineers* the hierarchy
from those flat values on **every apply**:

- **panel default** = the **mode** — a majority vote across all joints
- **zone override** = only when **every** joint in that zone agrees *and* that
  value differs from the panel default
- **joint override** = whatever differs from the panel default and is not
  already covered by a zone override

That is a migration heuristic (it is shared with
`tools/migrate-legacy-config.js`, where it is entirely appropriate) which became
the live apply path. It has two sharp edges:

1. **Editing joints you touched can change joints you did not.** The panel
   default is a majority vote. Re-point or add enough joints and the mode flips;
   the panel default is silently rewritten, and with it the effective ambient of
   every joint that was relying on it. Nothing on screen says this happened.
2. **One exception collapses a whole zone.** A zone override only materialises
   when *all* its joints agree. Give one joint in an outdoor zone its own ambient
   and the zone override disappears, scattering back into per-joint overrides —
   so the zone stops expressing anything, from a single-row edit.

Both are the same failure this project keeps meeting: **a derived value that
looks declared.** It is the shape of `poll_interval_s` (validated, displayed,
never sent) and of `threshold_profile` (validated, stored, never read).

## 4. The proposal

**Declare, don't infer.**

- The **zone row** carries `ambient_sensor` and `threshold_profile`, both set
  explicitly by the operator.
- The **joint row** shows its zone, plus the two override columns, which read
  *"inherit"* when unset.
- The live apply path **stops calling `resolveAmbientChain`** and writes what the
  operator declared. The function stays where it is genuinely correct — the
  one-time legacy migration.

The win is not one dropdown instead of three; it is removing an inference that
can change values nobody edited.

## 5. What should deliberately NOT change

1. **Keep the joint-level ambient override.** The schema comment names the real
   case: *"a joint whose local ambient differs from its zone's (e.g. right next
   to a vent/doorway)"*. Without it, one exceptional joint forces the operator to
   invent a zone; zones stop meaning "a physical stretch of busduct" and start
   meaning "a config bundle", and the 50-zone ceiling gets eaten by exceptions.
2. **Do not couple the two settings.** They do not always move together — a joint
   beside a vent needs a different *ambient* but usually the same *thresholds*; a
   critical riser may want tighter *thresholds* on the same *ambient*. Two
   independent, independently-inheritable columns, not one "environment" concept.

## 6. Decisions for the chat

1. **Adopt declare-over-infer for ambient?** This is the substantive one. It
   changes what a joint-table apply writes, which is a behaviour change on a
   fire-safety monitor even though no schema field moves.
2. **What happens on the first apply after the change?** Existing applied
   documents already contain a valid three-level chain — the derived values are
   really in there. The requirement is that the new apply path **preserves what
   is already applied** instead of re-deriving, and seeds the zone table from it.
   Confirm that is the intent rather than asking operators to re-enter ambients.
3. **Should the panel-wide default stay editable, and where?** It is currently
   only ever a by-product of the majority vote. If zones declare their own, the
   panel default becomes the fallback for zones that declare nothing, and it
   needs a home on a screen.
4. **Does the joint table keep its ambient column, or move it behind an
   "advanced" toggle?** Keeping the capability is separate from how prominent it
   should be; the operator's ask was about the *primary* path.

## 7. Blast radius if adopted

| Area | Change |
|---|---|
| `config/schemas/*` | **none** |
| `validate-modbus-joints.js` (R9/R14) | **none** |
| `process-logic-joints.js` runtime chain | **none** |
| `joint-master-handler.js` `applyJoints` | stop deriving; carry declared zone/joint values |
| `ZoneMasterUI` / `ZoneMasterBackEnd` | add an ambient column, as the profile column was added |
| `JointMasterUI` | ambient column becomes an explicit override ("inherit" when blank) |
| `tools/migrate-legacy-config.js` | **none** — `resolveAmbientChain` stays here |
| `buildLegacyDrafts` | carry `ambient_sensor` on the zone draft, as it now does for `threshold_profile` |

## 8. Risks

- **Silent re-scoping on the first apply.** If the new path does not preserve the
  existing applied chain, a panel could lose zone overrides wholesale and fall
  back to the panel default — ΔT computed against the wrong reference on a fire
  monitor. This is the one that needs a test before it is deployed anywhere.
- **R9 is cross-domain.** ΔT alarming requires every joint to resolve an ambient.
  An operator clearing a zone's ambient while joints rely on it must be refused
  with a message naming them, in the same way deleting an in-use profile now is.
- **The UI edit touches the joint and zone tables**, which is where the
  `$watch` data-loss bug happened. The full-state-on-every-action discipline and
  the column-alignment guard both apply.

---

**Recommendation:** adopt. It removes an inference that can move values the
operator never edited, it costs no schema change, and the runtime already
resolves the chain it would produce. The decision that actually needs making in
the chat is §6.2 — the first-apply preservation — because that is where a wrong
answer is dangerous rather than merely inconvenient.
