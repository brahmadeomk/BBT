# BusductTherMo Edge Device — User Manual

**Audience:** panel operators and commissioning technicians who use the
edge device's on-screen dashboard (HMI). It covers day-to-day
monitoring, acknowledging alarms, reading trends, commissioning sensors
and joints, setting alarm thresholds, and basic troubleshooting.

This is the *operator/technician* manual. Installation, cloud
provisioning and other admin tasks are covered separately:

| Task | Document |
|---|---|
| Installing the software on the Pi | `docs/pi-deployment.md` |
| Connecting the panel to AWS IoT / provisioning | `docs/aws/README.md` |
| Local historian (InfluxDB) setup & Grafana | `docs/historian.md` |
| Remote config & certificate rotation from the cloud | `docs/aws/README.md` Parts E & F |

---

## 1. What the system does

Each **busduct panel** carries an **edge device** — a Raspberry Pi
running the monitoring software — that continuously reads the
temperature of the busduct **joints** through RS-485 (Modbus RTU)
sensors, computes safety KPIs, raises alarms, keeps a local history, and
(when connected) forwards summaries to the cloud.

```
  Temperature sensors ──RS-485──▶  Arduino Nano  ──USB──▶  Raspberry Pi (edge device)
   (one or more channels                (Modbus RTU            • HMI dashboard (this manual)
    per sensor unit)                      master)              • alarm engine
                                                               • local historian (7 days + trends)
                                                               • cloud gateway ──▶ AWS IoT (optional)
```

- A **joint** is a physical busduct connection point being monitored.
- A **sensor unit** (Modbus *slave*) sits on the RS-485 line and can
  report one or more temperature **channels**.
- A **zone** groups joints that share an environment (e.g.
  air-conditioned vs. open-air), mainly so they can share an **ambient**
  temperature reference.

The edge device keeps working with the network unplugged — cloud
connectivity is an add-on, not a dependency. Local monitoring, alarms
and history never stop.

---

## 2. The temperature KPIs

For every joint the system reports and evaluates:

| KPI | Meaning |
|---|---|
| **Temp (°C)** | The joint's absolute temperature, latest reading. |
| **EMA Temp** | A smoothed (exponential moving average) temperature — filters out single-sample noise. |
| **ΔT (delta-T)** | Joint temperature **minus its ambient reference**. The most important early-warning indicator: a healthy joint stays close to ambient; a degrading joint runs hotter than its surroundings even before the absolute temperature looks alarming. |
| **RoR (rate-of-rise, °C/hr)** | How fast the temperature is climbing. A fast rise is a fault signature even at a still-safe absolute temperature. |
| **Ambient (°C)** | The ambient reference used for this joint's ΔT (see §6.4). |

Alarms are driven mainly by **ΔT**, **RoR** and **persistence** (how
long a condition must hold before it counts) — not by absolute
temperature alone.

---

## 3. Accessing the dashboard

1. On a device on the same network as the panel, open a browser to the
   Pi's dashboard:

   ```
   http://<panel-ip>:1880/ui
   ```

   (Ask your integrator for the panel's IP address or hostname. The
   editor at `http://<panel-ip>:1880` is for engineers, not operators.)

2. If a **login** screen appears, sign in with your operator
   credentials. Access to configuration screens may be restricted by
   role — see the **Settings → Configuration Access** and **Password**
   tabs.

The dashboard is a set of **tabs** down the left/side menu. The ones an
operator uses most:

| Tab | Purpose | Who |
|---|---|---|
| **Home** | Overview / embedded Grafana trend view | Operator |
| **TEMPERATURE** | Live per-joint temperatures and KPIs | Operator |
| **Active Alarms** | Currently-active alarms; **acknowledge** here | Operator |
| **Alarm History** | Past alarm raise/clear events | Operator |
| **Trends** | Historian charts: 7-day live + daily/weekly/monthly/yearly | Operator |
| **Audit Trail** | Who changed what, and when | Operator / Supervisor |
| **Joint Config** | Joint ↔ sensor ↔ channel ↔ zone mapping | Technician |
| **Slave Config / Modbus Settings** | Commission sensor units (slaves, channels, bus) | Technician |
| **Alarm Config** | Threshold profiles (ΔT / RoR / persistence) | Technician |
| **Notification / Alert Settings** | Email / SMS recipients | Technician |

Other tabs (Diagnostics, Connection Analytics, CSV, Calibration) are for
engineering and are described briefly in §10–§11.

---

## 4. Daily operation (operators)

### 4.1 Reading temperatures

Open **TEMPERATURE**. Each configured joint shows its live Temp and its
KPIs. A joint reading is only trustworthy when its **sensor status** is
**OK**:

| Sensor status | Meaning | What to do |
|---|---|---|
| **OK** | Reading is valid. | Normal. |
| **Communication_Error** | The Pi/Nano could not talk to the sensor unit over RS-485 (wiring, address, power). | Check the unit's wiring/address; see §12. Raised as a sensor fault. |
| **Sensor_Error** | The unit answered but the reading is invalid (open/short probe). | Inspect the probe. Raised as a sensor fault. |

Non-OK readings are **not** written to the historian (so trends aren't
poisoned by garbage) — a gap in a trend is a record of the outage
itself, and the fault appears in the alarm/audit trail.

### 4.2 Acknowledging alarms

Open **Active Alarms**. Each active alarm shows the joint, the condition
(e.g. high ΔT, high RoR, sensor fault) and when it began.

- Press **ACK** on an alarm to acknowledge it. Acknowledging records
  *you saw it* (into the audit trail and, if connected, to the cloud) —
  it does **not** clear the alarm.
- An alarm **clears on its own** only when the condition actually goes
  away and stays away (see §7 on hysteresis and clear-persistence).

### 4.3 Alarm history

**Alarm History** lists past raise/clear/ack events with timestamps —
use it to review what happened overnight or during a shift you missed.

### 4.4 Trends (local history)

Open **Trends**. Two dropdowns drive the chart:

1. **Sensor** — pick the joint (the list is filled automatically from
   whatever the historian has actually recorded).
2. **Range** — pick the window/granularity:

   | Range | Shows |
   |---|---|
   | **Live · 7 days (full)** | Every sample, highest resolution |
   | **Daily · 30 days** | Hourly rollups |
   | **Weekly · 90 days** | Hourly rollups |
   | **Monthly · 1 year** | Daily rollups |
   | **Yearly · 5 years** | Daily rollups |

The chart plots temperature, ambient, ΔT and rate-of-rise. Click a
series name in the legend to hide/show it (useful when the RoR scale
differs from the temperatures).

> For richer analysis (zoom, export, side-by-side panels) the panel can
> also run **Grafana** — see the **Home** tab or `docs/historian.md`.

---

## 5. Alarm thresholds (technicians) — **Alarm Config**

Thresholds live in named **profiles**. The **`default`** profile always
exists and cannot be deleted or renamed. Each profile defines:

| Field | Meaning |
|---|---|
| **ΔT threshold** | ΔT (joint − ambient) above which the joint is in alarm. |
| **RoR threshold** | Rate-of-rise above which the joint is in alarm. |
| **Persistence** | How long the condition must hold continuously before the alarm is raised (rejects momentary spikes). |
| **Clear hysteresis (%)** | The condition must fall this far *below* the threshold before it counts as cleared (stops flapping around the threshold). |
| **Clear persistence (min)** | How long it must stay clear before the alarm actually clears. |
| **Sensor fault** | Panel-wide handling of communication/probe faults. |
| **Notifications** | Which channels fire on alarm: email, SMS, cloud. |

Changing thresholds does **not** require maintenance mode — they aren't
wiring reality. When you **Apply** a valid change, the running alarm
engine evaluates the very next sample against the new values; existing
alarms raise/clear through their normal paths (no mass-clear).

If a value is rejected, the on-screen message names the exact rule
(e.g. the ΔT/RoR ordering rules) — fix the flagged field and re-apply.

---

## 6. Commissioning sensors & joints (technicians)

Do this in order: **first** commission the sensor units (Modbus
Settings), **then** map joints to them (Joint Config).

### 6.1 Modbus Settings — commissioning sensor units

On **Slave Config → Modbus Settings** (also reachable from Joint
Config):

- **Bus form** — the single RS-485 bus parameters: baud, parity, stop
  bits, polling and timeout. The firmware has one RS-485 port, so there
  is exactly one bus.
- **Slaves table — one row per channel.** A physical sensor unit that
  reports several temperature channels appears as **several rows sharing
  the same unit address**, each with its **own base address** and name.

Per-row fields:

| Field | Notes |
|---|---|
| **Unit address** | The Modbus address of the physical unit. Repeats across a unit's channel rows. |
| **Channel** | 1..N within the unit. No gaps, no repeats. |
| **Base address / name** | Each channel's own register address and display label. Addresses within a unit must be unique and non-overlapping. |
| **Model / words / scale / poll interval** | Unit-level fields. They **must match across all rows of the same unit** (see §6.3). |

Use the **+CH** button on a row to pre-fill the next channel row for the
same unit (same address, next channel, its own base address).

### 6.2 Why one poll interval per unit (not per channel)

The firmware reads **all of a unit's channels in a single Modbus
transaction** (one address-span read). So there is exactly **one poll
interval per unit**. That's why the poll interval (and model/words/scale)
must be identical across a unit's channel rows — a mismatch is rejected
with a friendly error at Apply. You set the cadence for the *unit*, and
every channel on it is read at that cadence.

### 6.3 Applying — what's checked

**Apply** runs full validation (rules R1–R15) plus friendly pre-checks:

- channel numbers within a unit are 1..N with no gaps/repeats;
- base addresses within a unit are unique and non-overlapping;
- you **cannot delete a slave or a channel** that is still mapped to a
  joint or used as an ambient reference — the error names what's using
  it. Remove the mapping first.

A **label-only** change (renaming a sensor) applies without disturbing
live polling. A real change (baud, unit address, a channel's address)
triggers a **Nano job resend** — the firmware briefly re-initialises the
serial link to pick it up. This is normal.

### 6.4 Joint Config — mapping joints

On **Joint Config → Joint Master – Zone A**:

- Each **joint** maps to one **sensor unit** and one dedicated
  **channel** of that unit (the **Ch** column). Two joints may share a
  multi-channel unit on *different* channels; mapping the same
  (unit, channel) pair twice is rejected with the conflicting joint
  named.
- Each joint belongs to a **zone**.
- **Ambient reference** for ΔT resolves through a 3-level chain, most
  specific first:
  1. the joint's own ambient sensor, else
  2. the joint's zone ambient sensor, else
  3. the panel-wide default ambient sensor.

  If your alarms use ΔT, every joint must resolve an ambient somewhere
  in that chain (enforced by the rules). This lets a busduct run that
  passes through both an air-conditioned zone and an open-air zone use a
  different ambient reference per zone — or per joint for an exception.

Press **Add Joint** for a new row, edit inline, then **Apply Config**.
If a joint references a sensor unit that hasn't been commissioned yet,
Apply rejects it — commission the unit in Modbus Settings first.

### 6.5 Maintenance mode (for wiring changes)

Wiring/commissioning changes pushed **from the cloud** are gated to
**maintenance mode** (safety rule R12) so a remote edit can't disturb a
live panel unexpectedly. **Local** edits made at the panel are not
gated.

To allow a remote wiring change, an engineer sets the panel's
`maintenanceMode` flag on, makes the change, and sets it back off.
Alarm-threshold changes are **not** gated by maintenance mode.

---

## 7. How alarms behave

- An alarm **raises** only after its condition (ΔT / RoR) holds for the
  profile's **persistence** time — momentary spikes don't alarm.
- An alarm **clears** only after the condition drops below the threshold
  by the **clear hysteresis %** and stays clear for the **clear
  persistence** time — so readings hovering at the threshold don't
  flap on and off.
- **Sensor faults** (communication/probe errors, §4.1) raise their own
  alarms so a blind sensor is never mistaken for a healthy cold joint.
- **System events** — e.g. the panel's automatic USB power-cycle
  recovery of the sensor link — are logged as informational SYSTEM
  events.
- **Notifications** (email / SMS / cloud) fire per the profile's
  notification settings (§11).

Acknowledging (§4.2) marks an alarm as seen; it never clears it.

---

## 8. Cloud connectivity (what operators see)

Cloud is optional. When the panel is provisioned to AWS IoT, the Cloud
Gateway forwards **aggregated** telemetry and alarms; the local
historian still keeps *every* sample regardless.

- **Telemetry** is sent on an interval (default every 10 minutes). The
  cloud can retune this remotely (1–1440 min) — the change takes effect
  within a minute, no panel visit needed.
- **Heartbeats** carry the firmware version, applied config versions and
  a **panel health** block: CPU temperature, MAC id, free/available RAM,
  Pi under-voltage/throttling flags, and network signal (Wi-Fi RSSI, or
  cellular signal when a USB modem is in use).
- **Remote configuration** — thresholds, wiring (maintenance-gated) and
  the telemetry interval can be pushed from the cloud; every push is
  **acknowledged** and recorded in the audit trail. See
  `docs/aws/README.md` Part E.
- **Certificate rotation** — the panel's security certificate can be
  renewed from the cloud with an automatic switch-and-rollback so it
  can't be knocked offline by a bad certificate. See `docs/aws/README.md`
  Part F.

If the link drops, messages are held in a disk-backed **outbox** and
drain in order when connectivity returns — nothing is lost and ordering
is preserved.

---

## 9. Audit trail

**Audit Trail** shows every configuration change — joint edits, Modbus
commissioning, threshold changes, remote pushes, certificate rotations —
with the timestamp, the user (local or `remote:<name>`), the action, and
before/after values where applicable. Use it to answer "what changed and
who changed it" after any behaviour change.

---

## 10. Diagnostics & connection health

- **Device Health** — a live table of **blacklisted** sensor units (a
  device that failed repeated reads is temporarily dropped from the scan
  so it can't slow the others), showing each one's recovery countdown and
  the joints it affects, plus joints currently **STALE** (alarm held while
  the device is dark) or **OFFLINE**. Each blacklisted unit also raises a
  `DEVICE_BLACKLIST` alarm in **Active Alarms**. "✔ All devices live" means
  nothing is blacklisted.
- **Diagnostics / Modbus Dashboard** — low-level Modbus read/transfer
  status for engineers verifying the RS-485 link.
- **Connection Analytics → Disconnections** — a history of link drops
  (sensor link and/or cloud), useful for spotting a flaky cable or
  network.
- **Automatic sensor-link recovery** — if the RS-485 line goes silent,
  the panel power-cycles the sensor USB hub and re-sends the sensor job
  to the Nano automatically; this is logged as a SYSTEM recovery event.

---

## 11. Notifications (email / SMS)

On **Alert Settings** / **Notification Settings**, configure who is
notified when alarms fire. Which alarms notify, and on which channels
(email / SMS / cloud), is set per alarm profile in **Alarm Config**
(§5). Send a test where the screen offers one after changing recipients.

---

## 12. Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| A joint shows **Communication_Error** | RS-485 wiring, wrong unit address, or unit unpowered | Check wiring and that the unit's address matches its Modbus Settings row; watch Diagnostics for the address. |
| A joint shows **Sensor_Error** | Open/short probe | Inspect/replace the probe. |
| **All** joints go silent at once | RS-485 bus fault or Nano/USB issue | The panel auto-recovers (§10); if it persists, check the Nano's USB connection and power. |
| A joint reads but **no ΔT / no ambient alarms** | No ambient reference resolved for that joint | Set an ambient at joint, zone, or panel level (§6.4). |
| **Apply** rejected with a rule id (Rxx / Axx) | A validation rule failed | Read the on-screen message — it names the field/rule; fix and re-apply. |
| Can't **delete** a slave/channel | It's still mapped to a joint or used as ambient | Remove the mapping in Joint Config first, then delete. |
| Trend chart is **empty** | Historian not set up, or no OK samples yet for that sensor | Confirm the historian is enabled (`docs/historian.md`); pick a sensor that has data. |
| Cloud shows **not connected** | Panel not provisioned, or link down | Local monitoring is unaffected; for cloud see `docs/aws/README.md`. |
| A config change "didn't take" after a software update | Node-RED needs a **restart**, not just a redeploy, after a library update | An engineer restarts the Node-RED service (see `docs/pi-deployment.md`). |

If a screen behaves unexpectedly right after a software update, an
engineer should re-import the flow and restart Node-RED per
`docs/pi-deployment.md`.

---

## 13. Good-practice notes

- **Commission before you map:** always add a sensor unit in Modbus
  Settings before mapping a joint to it.
- **Rename freely, rewire carefully:** renaming a sensor is disruption-
  free; changing a bus/address briefly re-inits the sensor link.
- **Trust ΔT and RoR, not just absolute temperature** — they catch a
  degrading joint earliest.
- **Acknowledge promptly, investigate the cause** — an ACK is a record
  that you saw it, not a fix.
- **Keep an eye on panel health** (heartbeat under-voltage flags): a Pi
  reporting under-voltage can misbehave; check the power supply.

---

## 14. Glossary

| Term | Meaning |
|---|---|
| **Joint** | A monitored busduct connection point. |
| **Zone** | A group of joints sharing an environment / ambient reference. |
| **Slave / sensor unit** | A Modbus RTU device on the RS-485 bus reporting one or more channels. |
| **Channel** | One temperature measurement within a sensor unit. |
| **Nano** | The Arduino that acts as the Modbus RTU master, driven by the Pi. |
| **ΔT (delta-T)** | Joint temperature minus its ambient reference. |
| **RoR** | Rate-of-rise of temperature (°C/hr). |
| **EMA** | Exponential moving average (smoothed temperature). |
| **Persistence** | Time a condition must hold before it alarms. |
| **Hysteresis** | The gap below the threshold required before an alarm clears. |
| **Ambient reference** | The temperature ΔT is measured against (joint → zone → panel chain). |
| **Historian** | The on-Pi InfluxDB store: 7-day full resolution + daily/monthly rollups. |
| **Outbox** | Disk-backed queue that holds cloud messages during a link outage. |
| **Heartbeat** | Periodic health/status message to the cloud. |
| **Maintenance mode** | A local flag that must be on to accept remote wiring changes. |
| **HMI** | The on-screen dashboard described in this manual. |
