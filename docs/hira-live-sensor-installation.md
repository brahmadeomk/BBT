# Hazard Identification & Risk Assessment — installing BusductTherMo joint sensors

**DRAFT FOR COMPETENT-PERSON REVIEW. NOT AN APPROVED DOCUMENT.**
Prepared 2026-09-01. **Rev 3, same day** — magnetic clamp confirmed; see §1.3,
which is now the most important engineering item in this document. **Rev 2** — revised throughout after the mounting
method was confirmed as *external, on the busduct cover, cover isolated from the
conductors*. Rev 1 assumed the joint had to be opened and concluded the work
should be eliminated; that conclusion no longer stands. Superseded items are
marked rather than deleted, because they all return if the enclosure is opened
or penetrated (§1). This is a starting structure with the hazards that are
foreseeable from the system design. It is **not** site-specific, it has not been
prepared by a competent person under any electrical safety regime, and it must
not be used to authorise work. It must be completed, verified against the actual
installation, and signed off by the site's electrical competent person and EHS
authority before any work is planned against it.

Sections marked **[SITE]** cannot be answered from the design and must be filled
in on site. Sections marked **[VERIFY]** contain assumptions that must be
confirmed.

---

## 1. The primary finding, stated first

**Revised 2026-09-01 following confirmation of the mounting method: the sensor
is fixed to the busduct COVER, and the cover is isolated from the conductors.**

That changes the assessment materially. The earlier draft assumed the joint had
to be opened, and concluded the work should be eliminated. It does not, so:

**Live installation is credible for this arrangement**, because the work stays
entirely outside an intact enclosure. No live conductor is exposed, no
current-carrying connection is disturbed, and the barrier that makes the busduct
safe is never removed. The severe electrical hazards of the previous draft
(A1–A3, B1) do not arise **provided the two conditions below hold**.

### The two conditions everything now rests on

**1. The cover must not be removed, opened or penetrated.**
**Satisfied by design: the sensor uses a magnetic clamp** (confirmed
2026-09-01), which is non-penetrating. Two residual ways integrity is still lost
in practice, each returning the work to Rev 1 risk levels and requiring a
shutdown:

- **Removing the cover "just to see"**, or to route the cable more neatly.
- **Cover already ill-fitting, corroded or previously disturbed** on the run in
  question, so that clamping to it displaces it.

Drilling is now excluded by the hardware rather than by a rule someone has to
remember, which is a materially stronger control. The method statement should
still say so explicitly, because a magnet that will not hold (see §1.3) is
exactly the situation in which someone reaches for a drill.

**2. The cover must be verified as bonded and at earth potential at each work
position** — not assumed from the design. An isolated-from-conductors cover is
not a live part in normal operation, but on most busduct systems the housing is
part of the earth path: under an earth fault it carries fault current and rises
in potential while someone is touching it. That is a low-likelihood,
high-severity hazard which stays in the register (A7) rather than disappearing.

### 1.3 The magnetic clamp has one failure mode that must be designed out

**A permanent magnet loses holding force as it gets hot, and above its maximum
working temperature the loss is permanent — it does not come back when it
cools.** Approximate limits, to be confirmed with the magnet supplier rather
than taken from here:

| Magnet | Approx. max working temperature |
|---|---|
| NdFeB, standard N grade | ~80 °C |
| NdFeB, H / SH / UH / EH grades | ~120–200 °C |
| SmCo (samarium cobalt) | ~250–300 °C |
| AlNiCo | ~450 °C+ |

A loaded busduct cover commonly runs **60–90 °C**, and the alarm thresholds this
system exists to detect sit *above* that. So a standard N-grade neodymium clamp
is inside its degradation range in normal service and past it during the event
being monitored.

**This is a correlated failure, and that is what makes it serious.** The sensor
is most likely to lose grip and fall off *at the moment the joint is
overheating* — the exact event it was installed to detect. The failure is not
independent of the hazard; it is caused by it. A system that detaches precisely
when it matters is worse than no system, because the joint reads normal (or
reads nothing, and looks like a comms fault) at the point of failure.

**Required:**
- Magnet grade selected for the **maximum credible cover temperature**, which is
  the alarm-threshold temperature plus margin, **not** the normal running
  temperature. **[VERIFY — grade and rated temperature]**
- A **secondary mechanical retention** (lanyard, strap or captive tether) so a
  clamp that does let go cannot fall onto people or plant below, and so the
  failure is visible rather than silent.
- Detachment must be **detectable**: a sensor that falls off will read close to
  ambient. Consider whether a joint reading *at or below* ambient for a
  sustained period should raise a fault. ΔT going persistently negative is not a
  physical condition for a loaded joint. **[Design-chat item — this is a
  plausible new alarm rule, and the current A-rules do not cover it.]**

### 1.4 Two practical checks before any of this matters

- **The cover must be ferromagnetic.** Many busduct enclosures are **aluminium**
  or aluminium alloy, and a magnet will not hold to them at all. **[SITE —
  confirm the cover material on the actual runs; a magnet test on one cover
  settles it in seconds.]** If the covers are aluminium, the magnetic clamp is
  not viable and the fixing decision reopens.
- **Paint, powder coating and any air gap are thermal insulators** between the
  cover and the sensor, adding to the cover-to-joint lag in §1.5. Surface
  condition at each clamp position affects the reading.

### The concern that now matters more than the installation risk

**A sensor on the cover measures the COVER, not the joint.** There is thermal
resistance and thermal mass between the conductor and the cover, so:

- absolute temperature is **substantially lower** than the joint itself;
- rate of rise is **damped and delayed** — the RoR signal this system alarms on
  (A2 rules) is exactly the signal a thermal mass attenuates most;
- ΔT against ambient still works, but the numbers are not conductor ΔT.

**This does not make the approach wrong** — cover-mounted monitoring is a normal
and defensible technique — **but the alarm thresholds must be derived from
cover-temperature behaviour, not from conductor limits.** Setting a ΔT threshold
appropriate to a joint, and then applying it to a reading that is 30–50 % of the
joint's rise, produces a system that looks healthy while a joint overheats.
That is a worse outcome than not fitting the system, because it displaces the
inspection regime that would have caught it.

This is now the single most important open item, and it is an engineering
question, not a safety-permit question. See E6, and §10.2.

## 2. Scope

**In scope**: physical installation and commissioning of busduct joint
temperature sensors, their ambient reference sensors, RS-485 field wiring back
to the panel, and the first energised functional check.

**Out of scope**: the panel-side equipment (Raspberry Pi, Nano modules, network),
which is LV/SELV work inside a controlled enclosure and should carry its own,
much shorter assessment; and routine maintenance once installed.

### What is being installed

| Item | Detail | Source |
|---|---|---|
| Joint sensors | Modbus RTU temperature transmitters, 1 or 4 channels per unit | `config/schemas/busduct_modbus_joint_config.schema.json` |
| Ambient sensors | Same bus, used as the ΔT reference | R14 chain, `docs/edge-user-manual.md` |
| Field bus | RS-485 twisted pair, up to ~110 devices across 2 segments | R16 |
| Typical scale | Up to 100 joints + 10 ambient per panel | Slice 10 target |
| Mounting method | **Magnetic clamp on the busduct cover, external. Cover isolated from conductors** (confirmed 2026-09-01) | user, 2026-09-01 |
| Magnet grade / rated temperature | **[VERIFY — must exceed the alarm-threshold cover temperature, not the running temperature; see §1.3]** | — |
| Cover material | **[SITE — must be ferromagnetic. Aluminium enclosures are common and a magnet will not hold; see §1.4]** | — |
| Sensor supply | **[VERIFY — loop-powered, or separate supply? Determines whether a second isolation is needed]** | — |

---

## 3. Method

5 × 5 matrix. **Risk = Severity × Likelihood**, assessed twice: *inherent*
(no controls) and *residual* (with the controls in §5 in place and verified).

| Severity | | Likelihood | |
|---|---|---|---|
| 5 | Fatality / permanent disability | 5 | Almost certain |
| 4 | Major injury, lost time > 7 days | 4 | Likely |
| 3 | Injury requiring medical treatment | 3 | Possible |
| 2 | Minor injury, first aid | 2 | Unlikely |
| 1 | Negligible | 1 | Rare |

| Score | Band | Action |
|---|---|---|
| 15–25 | **Intolerable** | Do not proceed. Eliminate or redesign. |
| 10–14 | **High** | Only with a written safe system of work, permit, and duty-holder sign-off. |
| 5–9 | **Medium** | Proceed with the documented controls and supervision. |
| 1–4 | **Low** | Proceed with standard site rules. |

**Scores below are indicative.** Severity is largely fixed by physics; likelihood
is entirely site-dependent and must be re-scored against the actual installation,
crew competence and equipment condition. **[SITE]**

---

## 4. Hazard register

### A — Electrical

*Revised for external cover mounting. The hazards that dominated the previous
draft — exposed conductors, arcing tools, dropped fasteners inside the enclosure —
arise only if the enclosure is opened or penetrated, which this method does not
do. They are retained as **A1c** because that is the failure mode to guard
against, not because it is the plan.*

| # | Hazard | Who | Inherent (S×L) | Key controls | Residual |
|---|---|---|---|---|---|
| A1c | **Enclosure integrity lost during the work** — cover drilled, removed, or displaced — returning the job to exposed live conductors and arc flash | Installer, plant | 5×2 = **10** | **Non-penetrating fixing only** (magnetic / strap / clamp / adhesive), specified in the method statement and verified in the toolbox talk. Explicit written prohibition on removing or opening any cover. Any position where the cover is loose, corroded or previously disturbed is **stopped and referred**, not improvised | 5×1 = **5** |
| A7 | **Touch voltage on the cover during an earth fault** while it is being handled — the housing is normally part of the earth path | Installer | 5×2 = **10** | Verify bonding and earth continuity at each work position before contact **[SITE]**. Do not work during switching operations or planned maintenance on the same board. Insulating gloves as a secondary measure | 5×1 = **5** |
| A8 | Static or stored charge on a cover panel that is bonded only through a hinge or a corroded joint | Installer | 3×2 = **6** | Continuity check as A7. Treat a cover failing continuity as a defect to be reported, not worked around | 3×1 = **3** |
| A4 | Induced or capacitively coupled voltage — relevant only if a run **is** isolated for other reasons and assumed safe | Installer | 4×2 = **8** | Prove dead at the point of work; do not rely on isolation alone on long parallel runs | |
| A5 | Backfeed from generator, UPS, PV or alternative incomer — relevant only where a shutdown **is** used | Installer | 5×2 = **10** | Isolation schedule covering **every** source, LOTO on each, test dead at the point of work | **[SITE]** |

**No longer applicable with an intact enclosure**, and deliberately recorded as
removed rather than silently dropped: contact with exposed busbar (old A1),
arc flash from a bridging tool (old A2), dropped fastener into the busduct
(old A3), re-energisation onto a fault left inside (old A6), and slackening a
live joint bolt (old B1). **All of these return the moment condition 1 in §1 is
broken.**

### B — The installation act

| # | Hazard | Who | Inherent | Key controls | Residual |
|---|---|---|---|---|---|
| B3 | **Drilling or penetrating the cover** to fix the sensor — swarf inside onto live parts, IP rating lost, clearance reduced | Installer, plant | 5×2 = **10** | **Prohibited.** Non-penetrating fixing specified at procurement, not decided on site. If no non-penetrating option holds, the position is done during a shutdown | 5×1 = **5** |
| B5 | **Magnetic clamp loses holding force as the cover heats and the sensor falls.** Above the magnet's maximum working temperature the loss is permanent. **Correlated with the hazard being monitored**: most likely to let go exactly when the joint is overheating | Installer, third parties below, plant | 4×3 = **12** | Magnet grade rated above the **alarm-threshold** cover temperature, not the running temperature **[VERIFY]**. Secondary mechanical retention on every position. Periodic verification of grip as a maintenance task | |
| B8 | **Magnet will not hold — cover is aluminium or non-ferrous** | Installer | 2×3 = **6** | Magnet test on a sample cover **before** procurement commits to this fixing **[SITE]**. If non-ferrous, the fixing decision reopens; do not improvise with adhesive or a drill on site | |
| B9 | **Finger pinch or crush** as a strong magnet snaps onto the cover | Installer | 3×4 = **12** | Gloves. Controlled approach technique, sliding onto the surface rather than dropping on. Two-handed placement where the magnet is strong enough to require it | |
| B10 | Strong magnet attracts loose ferrous debris, tools or swarf and carries it into the work | Installer, plant | 2×3 = **6** | Clean the clamp face and the cover position before placement. Keep the clamp bagged until the moment of fitting | |
| B11 | Magnet or its field affects nearby instrumentation, or the clamp heats by eddy currents in the enclosure field | Plant | 2×2 = **4** | OEM confirmation **[SITE]**. Check clamp temperature against cover temperature during the E6 survey — a clamp running hotter than the cover indicates induced heating | |
| B6 | Sensor or cable obstructs cover removal for future maintenance, or is damaged when a cover is next removed | Maintainers | 2×4 = **8** | Position clear of cover fixings and joint access. Cable with enough slack to allow cover removal without disconnection. Record the position per joint | |
| B7 | Cover surface preparation (cleaning, abrading for adhesive) generates dust or damages the finish/corrosion protection | Installer, plant | 2×3 = **6** | Minimum preparation consistent with the fixing. Reinstate any coating disturbed | |

### C — Physical and environmental

| # | Hazard | Who | Inherent | Key controls | Residual |
|---|---|---|---|---|---|
| C1 | Contact burn from hot busduct surface (loaded busducts commonly run 60–90 °C) | Installer | 3×4 = **12** | Work dead **and allowed to cool** — isolation does not make it cold. Measure surface temperature before contact. Heat-resistant gloves | |
| C2 | Fall from height — busducts are typically at high level or in riser shafts | Installer | 5×3 = **15** | Scaffold or MEWP, not ladders, for anything needing two hands. Edge protection. Trained operators | **[SITE]** |
| C3 | Restricted access / riser shaft — possible confined space | Installer, rescuer | 5×2 = **10** | Confined space assessment **[SITE]**. Atmospheric testing if applicable. Rescue plan and equipment before entry, not after | |
| C4 | Dropped object onto people below | Third parties | 5×3 = **15** | Exclusion zone at floor level, barriers and signage, tool tethering, no work over occupied areas | |
| C5 | Magnetic field adjacent to high-current busbar | Installer with implanted medical device | 4×2 = **8** | Screening question in the induction. Persons with pacemakers/ICDs excluded from close approach **[SITE — field strength at the work position]** | |
| C6 | Poor lighting in shafts and behind equipment | Installer | 3×3 = **9** | Task lighting, appropriate to the area classification | |
| C7 | Lone working | Installer | 5×3 = **15** | Prohibited for any energised or at-height work. Standby person with rescue competence and means of raising alarm | |

### D — Field wiring

| # | Hazard | Who | Inherent | Key controls | Residual |
|---|---|---|---|---|---|
| D1 | RS-485 cable routed with or near power conductors — induced voltage onto a SELV circuit reaching the panel and the technician | Panel technician | 4×3 = **12** | Segregation per the wiring regulations. Screened twisted pair, screen earthed at one end only. Segregated containment. Treat the field bus as LV until proven otherwise at the panel end | |
| D2 | Cable entry breaches enclosure IP rating or fire compartmentation in a riser | Operators, plant | 4×3 = **12** | Correct glands. Fire-stopping reinstated and inspected where the run crosses a compartment boundary **[SITE]** | |
| D3 | Cable damaged by hot surface over time, exposing conductors | Operators | 3×3 = **9** | Cable rated above the maximum busduct surface temperature; routed clear of hot surfaces; strain relief | |

### E — Commissioning, and hazards this system introduces

*These are specific to a monitoring system and are frequently missed, because
they are not injuries during installation — they are conditions that cause the
system to mislead people later.*

| # | Hazard | Who | Inherent | Key controls | Residual |
|---|---|---|---|---|---|
| E1 | **Sensor mapped to the wrong joint.** A hot joint then alarms as a different joint, sending the response to the wrong place, while the real joint appears healthy | Operators, plant | 5×3 = **15** | Per-joint commissioning check: heat or otherwise stimulate **each** sensor individually and confirm the expected joint id and name changes on the HMI. Record the result per joint. Do not accept "all sensors are reading" as proof of mapping | |
| E2 | **Configuration saved but never applied** — the joint appears configured but is not monitored | Operators, plant | 5×2 = **10** | The HMI Configuration Status banner names unapplied joints; commissioning is not complete until it reads green and the joint count matches the physical count | |
| E3 | **False confidence during installation.** The monitoring system is partially installed and is assumed to be watching joints it is not yet watching | Operators, plant | 4×4 = **16** | Explicit statement of coverage at each stage. The system is not a control measure until commissioning is signed off. Existing thermographic inspection regime continues unchanged until then | |
| E4 | Wrong scale or channel mapping gives plausible but wrong temperatures | Operators, plant | 5×2 = **10** | Verify each commissioned sensor against a calibrated reference at a known temperature. Confirm the Scale column matches the sensor datasheet — a wrong scale produces readings that look reasonable | |
| E5 | Ambient reference sensor on a different RS-485 segment from the joints that use it — a segment failure removes ΔT for joints on the healthy segment | Operators | 3×3 = **9** | Provide an ambient reference on each segment | |
| E6 | **Cover temperature read as if it were joint temperature.** Thermal resistance and mass between conductor and cover mean the reading is lower than the joint and its rate of rise is damped and delayed. Thresholds set for a conductor then produce a system that reads healthy while a joint overheats | Operators, plant | 5×4 = **20** | Characterise the cover-to-joint relationship before setting thresholds: thermographic survey of joints **and** covers together, under representative load, on at least a sample of positions. Derive ΔT and RoR thresholds from the COVER data. Re-validate after any busduct rating or load change. Retain thermographic inspection at reduced frequency rather than withdrawing it **[SITE]** | |
| E8 | **Sensor detached but not detected** — it reads near ambient and looks like a healthy cool joint | Operators, plant | 5×3 = **15** | Treat a sustained near-ambient or negative ΔT as a fault, not as good news **[design-chat item — no current A-rule covers this]**. Physical check of clamp grip at each thermographic survey | |
| E7 | **Inspection regime withdrawn on the strength of an uncharacterised system** | Operators, plant | 5×3 = **15** | Thermography continues unchanged until E6 is closed and the system has demonstrated it detects a real rise. Withdrawal is a documented decision, not a drift | |

---

## 5. Hierarchy of controls — applied

| Level | Applied to this work |
|---|---|
| **Eliminate** | **External cover mounting already eliminates the dominant hazards** — the enclosure is never opened, so exposed conductors, bridging tools, dropped fasteners inside and disturbed joint bolts do not arise. Shutdown is reserved for any position where a non-penetrating fixing will not hold. |
| **Substitute** | **Non-penetrating fixing instead of drilling** — the single most important substitution, and the one that keeps this assessment valid. Decided at procurement, not on site. |
| **Engineering** | Insulating barriers, arc-rated screens, catch trays under open enclosures, MEWP instead of ladders, exclusion zones, tethered tools. |
| **Administrative** | Permit to work; isolation and LOTO with a full source schedule; competent person appointment; toolbox talk; tool tally; per-joint commissioning record. |
| **PPE** | Insulating gloves (A7 touch voltage), safety footwear, fall arrest and helmet for the access method. **Arc-rated clothing is not the basis of this assessment** — it would be needed only if the enclosure were opened, which this method does not do. |

---

## 6. Prerequisites — before work is planned against this document

**Now much shorter than the previous draft**, because external cover mounting
removes the arc-flash-study and isolation-schedule prerequisites that dominated
it. What remains is not optional.

- [ ] **[SITE]** Magnet test on a sample cover — is it ferromagnetic at all? (§1.4)
- [ ] **[VERIFY]** Magnet grade and rated working temperature, selected against
      the **alarm-threshold** cover temperature rather than the running
      temperature (§1.3). A standard N-grade neodymium clamp is very likely
      inadequate.
- [ ] **[VERIFY]** Secondary mechanical retention specified for every position
- [ ] Decision on whether sustained near-ambient / negative ΔT should raise a
      detachment fault (E8) — design-chat item
- [ ] **[VERIFY]** Sensor supply arrangement (loop-powered or separate)
- [ ] **[SITE]** Earth continuity verified on the covers to be worked (A7)
- [ ] **[SITE]** Written confirmation from the busduct OEM that an externally
      attached sensor does not affect the assembly's rating or type test, and
      does not impair cover ventilation or heat dissipation
- [ ] **[SITE]** Access method and rescue plan for the positions concerned
      (height, riser shafts) — unchanged by the mounting method
- [ ] **[SITE]** Method statement stating explicitly that **no cover is to be
      opened, removed or drilled**, with the stop-and-refer rule for any position
      where that would be needed
- [ ] **E6 characterisation plan agreed** — how cover-to-joint behaviour will be
      established before thresholds are trusted
- [ ] Thermographic survey scheduled to run alongside commissioning, giving both
      the baseline and the E6 data

## 7. Emergency arrangements **[SITE]**

- Isolation point for emergency de-energisation, known and reachable by the standby person
- Electrical burns and arc flash injury first aid; nearest burns-capable facility
- Rescue from height / from shaft — equipment on site before work starts
- Means of raising the alarm from the work position (mobile coverage in riser shafts is often absent)

---

## 8. Sign-off

This document is not valid until all three are complete.

| Role | Name | Signature | Date |
|---|---|---|---|
| Prepared by (competent person) | | | |
| Reviewed by (EHS) | | | |
| Approved by (duty holder / plant owner) | | | |

Residual risk accepted for: ______________________________________

---

## 9. Standards and legislation to confirm applicability **[SITE]**

Listed as a starting point for the competent person to confirm — **the specific
editions and clauses applicable to this site have not been verified here.**

- Central Electricity Authority (Measures relating to Safety and Electric Supply)
  Regulations — permit-to-work and work on live conductors
- The Factories Act 1948 and the applicable State Factory Rules
- IS 3043 — earthing
- IS/IEC 61439 — low-voltage switchgear and controlgear assemblies (busduct
  systems and the effect of modification on type testing)
- NFPA 70E / IEEE 1584 — arc flash risk assessment and incident energy
  calculation, where the site references them
- The busduct manufacturer's own installation and maintenance instructions,
  which take precedence on torque, clearance and permitted modification

---

## 10. What this draft still cannot tell you

Revised after the mounting method was confirmed. The list is shorter, and its
priority has inverted.

1. **The cover-to-joint thermal relationship (E6).** Now the largest open item
   by some distance. Without it the thresholds are guesses, and a monitoring
   system with wrong thresholds is worse than none, because it displaces the
   inspection that would have found the fault. This is measurement engineering,
   not safety paperwork, and it needs load-condition data from this site.
2. **The fixing method.** Must be non-penetrating, and must be settled at
   procurement. The whole safety case in §1 rests on it.
3. **Likelihood scores.** Severities are defensible; likelihoods are
   placeholders until scored against the crew, the access and the specific runs.
4. **Cover ventilation.** Whether an attached sensor and its cable affect heat
   dissipation from the cover is an OEM question, not one this document can
   answer.

**Superseded by the 2026-09-01 revision:** the arc flash study, the full
isolation schedule and the shutdown recommendation, all of which the previous
draft made prerequisites on the assumption that the joint had to be opened.
They return in full if condition 1 of §1 is ever broken.
