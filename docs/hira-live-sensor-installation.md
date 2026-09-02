# Hazard Identification & Risk Assessment — installing BusductTherMo joint sensors

**DRAFT FOR COMPETENT-PERSON REVIEW. NOT AN APPROVED DOCUMENT.**
Prepared 2026-09-01. This is a starting structure with the hazards that are
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

**The task as described — "live installation" — is very likely the wrong
starting point, and the assessment below concludes that most of this work should
be eliminated rather than controlled.**

Three reasons specific to this installation:

1. **Mounting a joint temperature sensor requires access to the joint.** On a
   busduct that means removing or opening the joint cover, which is the barrier
   that makes the enclosure safe. Once it is off, exposed live conductors at full
   fault level are present.

2. **If the sensor is secured under a joint bolt** — a common arrangement for
   getting a thermal path to the conductor — then fitting it means slackening a
   live current-carrying connection. That is not "work near live parts"; it is
   deliberately loosening a joint carrying load current, with the risk of arcing,
   local overheating and a subsequent joint failure. **[VERIFY — the mounting
   method is not documented in this repository and must be established before
   this assessment can be completed.]**

3. **Busduct joints sit close to the source.** Prospective fault current and
   therefore incident energy are typically at their highest here. **[SITE — an
   arc flash study giving the incident energy and boundaries at each work
   position is a prerequisite, not an optional extra.]**

**Recommendation: plan the installation into a shutdown.** The monitoring system
is a long-term asset; there is rarely a business case that justifies energised
work to install it. If a shutdown is genuinely unavailable for some positions,
those positions need an *energised work permit* justified individually — not a
blanket decision for the whole installation.

If site management decides after review that specific positions must be done
live, this document is structured to support that, but the justification and the
residual risk acceptance belong to the duty holder, not to this document.

---

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
| Mounting method | **[VERIFY — not documented; see §1.2]** | — |
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

### A — Electrical, energised equipment

| # | Hazard | Who | Inherent (S×L) | Key controls | Residual |
|---|---|---|---|---|---|
| A1 | Contact with exposed live busbar after joint cover removal | Installer, standby | 5×4 = **20** | Eliminate: work dead. If not: energised work permit, arc-rated PPE to the studied incident energy, insulated barriers over adjacent phases, defined approach boundaries, standby person | **[SITE]** |
| A2 | Arc flash / arc blast from tool or fastener bridging phases | Installer, anyone within the arc flash boundary | 5×3 = **15** | Work dead. Insulated tools only, tethered. Arc flash boundary demarcated and cleared of other trades. Face shield + arc-rated coverall to study | **[SITE]** |
| A3 | Dropped tool or fastener falls into the open busduct | Installer, plant | 5×4 = **20** | **Work dead.** Tool tethering, tool tally in/out, catch tray or barrier beneath the opening, no loose fasteners over an open enclosure | **[SITE]** |
| A4 | Induced or capacitively coupled voltage on an isolated busduct running parallel to live circuits | Installer | 4×3 = **12** | Prove dead **at the point of work** with a proving unit before and after. Apply working earths. Do not rely on isolation alone on long parallel runs | |
| A5 | Backfeed from generator, UPS, PV or an alternative incomer | Installer | 5×3 = **15** | Full isolation schedule identifying **every** source, not just the main incomer. LOTO on each. Test dead at the point of work | **[SITE]** |
| A6 | Re-energisation onto a fault left by the work (tool, swarf, displaced conductor) | Installer, operators, plant | 5×3 = **15** | Tool tally reconciled before closing. Visual inspection and IR test before re-energisation. Controlled energisation with personnel clear | |

### B — The installation act

| # | Hazard | Who | Inherent | Key controls | Residual |
|---|---|---|---|---|---|
| B1 | Slackening a live joint bolt to fit the sensor **[VERIFY mounting]** | Installer, plant | 5×4 = **20** | **Not to be done live under any circumstances.** Dead, isolated, earthed. Torque to the busduct manufacturer's figure with a calibrated wrench; record the value | |
| B2 | Joint left under-torqued or over-torqued after sensor fitting | Operators, plant | 4×3 = **12** | Calibrated torque wrench, recorded per joint, second-person check. Thermographic survey after re-energisation and load — the joint you just disturbed is now the one most likely to run hot | |
| B3 | Drilling or penetrating the enclosure — swarf, loss of IP rating, reduced clearance | Installer, plant | 4×3 = **12** | Prefer non-penetrating mounting. If penetration is unavoidable: dead only, swarf controlled and vacuumed, clearances re-checked against the busduct rating, IP restored | |
| B4 | Sensor body or cable reduces phase-to-phase or phase-to-earth clearance | Operators, plant | 5×3 = **15** | Clearances confirmed against the busduct manufacturer's data **before** selecting the mounting position. Written confirmation from the busduct OEM that the arrangement does not void the type test **[SITE]** | |
| B5 | Adhesive or thermal compound degrades at operating temperature and the sensor falls into the enclosure | Operators, plant | 5×2 = **10** | Mechanical retention, not adhesive alone. Compound rated above the maximum joint temperature plus alarm threshold headroom | |

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

---

## 5. Hierarchy of controls — applied

| Level | Applied to this work |
|---|---|
| **Eliminate** | **Install during a planned shutdown.** Removes hazards A1–A6 and B1 outright. This is the principal recommendation of this assessment. |
| **Substitute** | Non-contact mounting (clamp-on, external surface sensor) instead of anything requiring a joint bolt to be disturbed. Non-penetrating fixings instead of drilling. |
| **Engineering** | Insulating barriers, arc-rated screens, catch trays under open enclosures, MEWP instead of ladders, exclusion zones, tethered tools. |
| **Administrative** | Permit to work; isolation and LOTO with a full source schedule; competent person appointment; toolbox talk; tool tally; per-joint commissioning record. |
| **PPE** | Arc-rated clothing to the studied incident energy, insulated gloves with leather overs, face shield, safety footwear, fall arrest. **PPE is the last line and does not make live work acceptable where a shutdown is available.** |

---

## 6. Prerequisites — none of this work is planned until these exist

- [ ] **[SITE]** Arc flash study giving incident energy and boundaries at each work position
- [ ] **[SITE]** Isolation schedule identifying every source that can energise the busduct
- [ ] **[VERIFY]** Sensor mounting method, confirmed in writing with the busduct OEM as not affecting the assembly's type test or clearances
- [ ] **[VERIFY]** Sensor supply arrangement and whether it needs separate isolation
- [ ] **[SITE]** Competent person appointed in writing; installer competencies recorded
- [ ] **[SITE]** Rescue plan for the access method actually used (height, shaft)
- [ ] **[SITE]** Confirmation of whether any position genuinely cannot be shut down, with the business justification
- [ ] Busduct manufacturer's torque figures, and a calibrated wrench
- [ ] Thermographic survey scheduled for after re-energisation and return to load

---

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

## 10. What this draft cannot tell you

Stated plainly so the gaps are not mistaken for completeness:

1. **The mounting method** — the single most important input, and it is not
   documented anywhere in this repository. Everything in §B is provisional
   until it is established.
2. **Incident energy** — without an arc flash study there is no basis for
   selecting PPE, and no basis for deciding whether a position can be worked
   live at all.
3. **Likelihood scores** — these depend on crew, equipment and the specific
   physical arrangement. The severities are defensible; the likelihoods are
   placeholders.
4. **Whether a shutdown is available** — a commercial and operational question
   that determines whether most of this document is even needed.
