# Device Blacklisting & Recovery — Specification

Status: **design agreed, not yet implemented** (see Slice 9 in the
workplan addendum). Written 2026-07-24 from the design chat.

---

## 1. Why

At the current provisioning target of **100 joint sensors + 10 ambient
sensors on one panel**, a single unresponsive slave taxes every scan
cycle. With the firmware default now at `TimeOut = 300 ms` and
`retries = 2`, one dead slave costs ~900 ms per scan; three dead slaves
cost ~2.7 s, which alone approaches the shortest sensible poll interval.
Before the timeout fix (5000 ms) the same three slaves cost ~45 s.

This is not hypothetical on this hardware. The J28 investigation
(20 July) found a degraded RS-485 transceiver that failed intermittently
and, on some events, dragged neighbours J29/J30 down with it —
self-recovering within 2–3 seconds. A marginal device that flaps is the
normal failure mode here, and it is the case this spec must handle
without either (a) wasting the whole scan budget or (b) flapping the
alarm state alongside it.

**Blacklisting = temporarily removing a slave from the scan so one bad
device cannot degrade the other 109.**

---

## 2. The state this introduces

Blacklisting creates a condition the alarm model does not currently
represent: *we can no longer measure this joint*. That is distinct from
both "the joint is fine" and "the joint is in alarm".

**Governing rule:**

> **Never auto-clear a process alarm because the ability to measure it
> was lost.** A joint that was CRITICAL and then went dark may be
> getting worse. Clearing it asserts "resolved", which is false.

### Per-joint states

| State | Meaning | New process alarms? |
|---|---|---|
| `LIVE` | Fresh data flowing | Yes |
| `STALE` | Slave blacklisted; joint **had an active alarm** at blacklist time. Alarm is **held** at its last level, with `last_valid_ts` and `last_valid_value`. | No |
| `OFFLINE` | Slave blacklisted; joint had **no** active alarm. | No |

`STALE` and `OFFLINE` both mean "not measurable". They are separated so
the HMI/BMS/cloud can distinguish *a held alarm you must still act on*
from *a joint that is simply dark*.

### Alarm actions at blacklist time

| Item | Behaviour |
|---|---|
| SYSTEM alarm | **One per slave**, not per joint: `sl07 blacklisted after 3 consecutive failures; joints J25–J28 not measurable`. ACK-able, so it can be acknowledged while maintenance is scheduled without cluttering the active list. |
| Active process alarms on affected joints | **Held** at current level, marked `STALE`. Not cleared, not escalated. |
| Joints with no active alarm | Marked `OFFLINE`. |
| Any joint | No new process alarm may raise while not measurable. |

---

## 3. What must freeze

Two pieces of engine state must stop advancing during a blackout, or
recovery produces false alarms.

### 3.1 EMA / RoR baseline

`ProcessLogic` maintains `emaTemp` and derives RoR as
`(sensorVal - emaTemp) / tauSec * 3600`. If a slave returns after a
20-minute blackout and the joint is 8 °C hotter, computing RoR against
the pre-blackout EMA yields a large spurious rate and an immediate false
CRITICAL.

**Required:** on restore, **reset the EMA baseline to the first fresh
reading** (`emaTemp = sensorVal`, as at cold start) rather than carrying
the stale one. RoR is naturally 0 for that first sample and builds
normally from there.

`ProcessLogic` already freezes KPI updates on `Sensor_Error`
(`sensor_error_above_c`, default 300 °C) — extend that same freeze/reset
path to the blacklist case rather than adding a parallel mechanism.

### 3.2 Persistence timers

A joint 2 minutes into a 5-minute CRITICAL persistence window must not
continue accumulating against stale or absent data and "raise" during
the blackout.

**Required:** persistence timers **pause** on blacklist and **restart
from zero** on restore. Restarting (rather than resuming) is deliberate:
the condition must re-prove itself against fresh data.

---

## 4. Detection and recovery

```
        3 consecutive failures
LIVE ───────────────────────────► BLACKLISTED
  ▲                                    │
  │                              probe on backoff
  │                              30s → 1m → 2m → 5m (cap)
  │                                    │
  └──── 3 consecutive good reads ──────┘
```

### Parameters (all configurable, `cfg/modbus` or `cfg/alarms`)

| Parameter | Default | Rationale |
|---|---|---|
| `blacklist_after_failures` | 3 | Tolerates the 2–3 s transient seen at J28 without blacklisting |
| `probe_backoff_s` | `[30, 60, 120, 300]` | Capped at 5 min; one 300 ms timeout per probe is negligible |
| `restore_after_good_reads` | 3 | **Hysteresis** — stops a marginal device flapping in and out, which is exactly the J28 behaviour |

### Probe mechanics

A probe re-includes the slave in a single scan cycle. It is not a
separate code path — the slave is simply not skipped for that cycle.
Cost is one transaction (~300 ms worst case) at the current backoff
interval.

### On restore

1. Reset EMA baseline to the first fresh reading (§3.1)
2. Restart persistence timers from zero (§3.2)
3. Set affected joints to `LIVE`
4. Re-evaluate alarms **against fresh data only**
5. Held `STALE` alarms follow the **normal clear path** — including
   clear hysteresis and `clear_persistence_min` — never an instant clear
   (consistent with rule A10)
6. Clear the SYSTEM alarm for that slave
7. Write the full blacklist → restore cycle to the audit trail

---

## 5. Where the logic lives

**Pi-side, not firmware.** The Nano stays a dumb executor of job JSON;
decisions stay testable, auditable and remotely tunable. Blacklisting is
implemented by omitting the slave's read packets from the compiled job.

### 5.1 Prerequisite firmware fix

The firmware currently re-initialises the bus on **every** job update:

```c
Serial1.begin(Modbus_Baud);
node.begin(1, Serial1);
node.setTimeout(TimeOut);
```

The Nano job compiler already suppresses no-op resends for this reason
(a resend briefly disrupts live polling). But blacklist/probe churn
means legitimate job changes every few minutes, so every blacklist and
every probe would glitch the bus.

**Required before Pi-side blacklisting is practical:**

> Re-initialise `Serial1` / timeout **only when the `comm` parameters
> actually change**, not on every job update. Small, self-contained,
> and removes a latent glitch from every config apply regardless of
> blacklisting.

### 5.2 Interaction with existing rules

- **R10 (scan-time capacity)** should compute worst-case scan time from
  the *configured* slave list, not the currently-active one. Blacklisting
  is a runtime state; the config must remain valid for the full fleet.
- **R16 (bus loading)** is unaffected — unit load is electrical and
  applies whether or not a device is being polled.

---

## 6. Exposure

| Surface | Requirement |
|---|---|
| HMI | Joint tiles show `STALE` / `OFFLINE` distinctly from LIVE and from alarm colours. Held alarms display `last_valid_ts`. |
| Cloud | SYSTEM alarm published as an alarm event. Telemetry for non-measurable joints omits values rather than repeating the last one — a repeated stale value is indistinguishable from a healthy flat reading. |
| BMS (`cfg/integration`) | The `system health` summary register must reflect blacklist state; `live joint count` already exists in the proposed map and drops accordingly. |
| Audit trail | Every blacklist, probe, and restore recorded with slave, affected joints, and failure counts. |

---

## 7. Fleet value

Blacklist/restore events are a per-device reliability metric. Aggregated
across panels they identify marginal transceivers **before** they fail
outright — the J28 class of fault, caught by trend rather than by a site
visit. Worth surfacing in the cloud fleet view alongside the existing
`uhubctl` USB recovery counts.

---

## 8. Acceptance criteria

1. A slave failing 3 consecutive reads is blacklisted; scan time drops
   accordingly; one SYSTEM alarm is raised naming the affected joints.
2. A joint in CRITICAL at blacklist time **remains** CRITICAL, marked
   `STALE`, with a `last_valid_ts` — it is not cleared.
3. No new process alarm raises on a non-measurable joint.
4. A slave restored after a 20-minute blackout with an 8 °C temperature
   change produces **no** spurious RoR alarm (EMA reset verified).
5. A device failing every other probe does not flap: it stays
   blacklisted until 3 consecutive good reads.
6. Held alarms clear through the normal clear path with hysteresis and
   persistence, never instantly.
7. Blacklist and probe cycles cause **no** `Serial1` re-init (firmware
   guard in place) and no observable disturbance to other joints.
8. Full cycle appears in the audit trail.
