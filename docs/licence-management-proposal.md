# Licence management — design proposal

**Status: PROPOSAL, NOT BUILT.** Requested 2026-09-01. This crosses the
edge → cloud contract, the BMS register map, the HMI, and adds
cryptography, so per the repo's working agreement it wants sign-off in the
companion design chat before implementation.

## What was asked

> Licence management — enter a 1-month licence remotely from the cloud, or
> by entering a code on the device. After expiry the device stops showing
> edge screens and disables BMS data sharing. The edge device shows how
> many days are left before renewal.

Everything here is buildable. Two things need a decision before it is, and
the first is not a technical one.

---

## 1. The blocking question: what must a lapsed licence never switch off

**This is a thermal monitoring system for busduct joints. Its purpose is
noticing a joint getting hot before it becomes a fire.**

A licence that lapses on a Friday, on a panel nobody is standing in front
of, must not mean that an overheating joint goes unseen until Monday.
"Stops showing edge screens and disables BMS data sharing" as literally
specified would do exactly that — the HMI goes blank *and* the building
management system stops receiving temperatures, so both the local and the
remote way of noticing are gone at the same moment.

Three further consequences worth weighing:

- **Liability.** Disabling a safety-related function for a commercial
  reason is a different thing from disabling a reporting feature. If a
  joint fails during a lapse, "the monitoring was switched off for
  non-payment" is a difficult position.
- **Sales.** An integrator who learns during evaluation that the panel
  goes dark on expiry may decline on that basis alone. BMS integrators in
  particular treat a device that can stop answering as a liability in
  their own system.
- **Support load.** A panel that stops answering Modbus is
  indistinguishable, from the BMS side, from a dead panel. Every lapse
  becomes a fault call.

### Recommendation

Gate **commercial value**, never **safety function**. Concretely:

| Always on, at any licence state | Gated on expiry |
|---|---|
| Alarm evaluation (ΔT, RoR, sensor fault, blacklist) | Trends / historian screens |
| Alarm relay output and alarm e-mail/SMS | Joint & Modbus configuration screens |
| Active Alarms list | Diagnostics, BMS register view, audit trail |
| A **minimal live temperature view** (joint, °C, status) | Cloud telemetry publishing |
| The licence banner itself | BMS **values** (see §5 for how) |

That still gives real commercial leverage — a panel with no trends, no
configuration, no cloud and no BMS values is not a product anyone runs
long-term — without the failure mode being "nobody saw the joint heat up".

**If the design chat decides otherwise and wants a full blackout, say so
explicitly and it will be built that way.** It is a business decision, not
mine. This section exists so it is made deliberately rather than inherited
from a one-line requirement.

---

## 2. Offline code format

The technician-typed path is the harder half; the cloud path is nearly
free (§3).

Requirements: short enough to type without errors, impossible to forge,
useless on any other panel, and verifiable with **no** secret stored on the
device (a symmetric key on a field device is extractable by anyone who can
mount the SD card, and one leak forges licences for the whole fleet).

### Proposed: 24 characters, 4 groups of 6

```
BBT licence key:  X4K7M2-9PDQR3-TVW8SN-6HJYZ2
```

- **Crockford base32** — no `I`, `L`, `O`, `U`, so no `1`/`I` or `0`/`O`
  confusion on a plant-room touchscreen, and case-insensitive on entry.
- 120 bits total: **48-bit payload + 72-bit signature.**

Payload (48 bits):

| Field | Bits | Notes |
|---|---|---|
| format version | 4 | so the scheme can change without breaking issued keys |
| expiry | 16 | days since 2026-01-01 — good to year 2205 |
| feature flags | 8 | reserved: BMS, cloud, trends, multi-bus… |
| panel binding | 20 | truncated SHA-256 of `thing_name` |

**Panel binding is what stops one customer's key licensing a whole site.**
A key typed into the wrong panel is rejected on the spot with *"this key is
for a different panel"*, which is also a much better error than a silent
failure.

Signature: **Ed25519, truncated to 72 bits.** The vendor holds the private
key; the public key ships in the device image, so a stolen panel yields
nothing that forges licences. Forgery needs ~2^72 work — at a billion
attempts a second, longer than anyone will spend to avoid a renewal fee.

> **Decision needed:** 24 characters is at the upper end of what a
> technician will retype cheerfully. Dropping the panel binding to 12 bits
> and the signature to 64 gets it to 20 characters (4 × 5) at the cost of
> weaker forgery resistance and more cross-panel collisions. My
> recommendation is to keep 24 and offer a **QR code** on the renewal
> e-mail that the HMI can accept via a USB scanner, making the length moot
> for most sites.

---

## 3. Remote path

Nearly free, because Slice 7 already built the channel. A new
`domain: "licence"` on the existing `cmd/{c}/{s}/{p}/config` topic,
carrying the same 24-character key (or the raw 15 bytes, base64), acked on
`.../config/ack` like every other domain, and audited through the existing
audit writer.

No new topic, no new policy statement, no new plumbing — it routes through
`processRemoteConfig` alongside `alarms`, `modbus_joints` and `edge`.

---

## 4. Clock tampering, and why `clock_synced` matters

Expiry is a date comparison on a device where anyone with the SD card can
`sudo date`. Setting the clock **back** would extend a licence indefinitely
if the check were naive.

**Proposed: a monotonic time watermark.** Persist the highest time the
panel has ever credibly seen, advanced from three sources:

1. the system clock, **but only while `clock_synced` is true** — the field
   added to the health snapshot on 2026-09-01, which turns out to be load-
   bearing here;
2. the timestamp on any message received from the cloud;
3. the panel's own monotonic uptime, accumulated across reboots.

Evaluate expiry against `max(watermark, now)`. Winding the clock back then
does nothing; winding it forward only expires the licence *early*, which
is self-punishing and needs no defence.

The watermark file must be integrity-protected (HMAC with a key derived
from the device certificate) or it is just a number to edit. It should
also be **out of the config store** — it is not operator-editable state and
must not be restorable from a config backup.

---

## 5. BMS behaviour on expiry

**Do not close the Modbus TCP socket.** From the BMS side that is
identical to a dead panel: it raises the integrator's own comms alarms,
generates a fault call, and gives them no way to tell "licence lapsed"
from "panel failed".

Proposed instead:

- Keep the socket open and keep answering.
- Serve the existing **`NO_DATA` sentinel (−32768)** for measurement
  registers — a value the register map already defines and integrators
  already handle for dark joints.
- Add a **licence status register** to the Tier 1 block: `0` = unlicensed,
  `1` = licensed, `2` = in grace, plus a days-remaining register. The
  register map is **append-only**, so this is a legal addition at the next
  free Tier 1 offset and needs a `point_map_version` bump (rule I4).

That gives the integrator an unambiguous, machine-readable reason, and lets
them raise their own "BusductTherMo licence expiring" point long before
anything stops.

---

## 6. Grace period

A hard cutoff at midnight on day 30 is operationally hostile — renewals are
processed by people, and a purchase order clearing a day late should not
blind a plant room.

Proposed: **14-day grace**, during which everything keeps working and the
banner escalates.

| State | Days | HMI |
|---|---|---|
| Licensed | > 30 left | nothing |
| Expiring | ≤ 30 left | quiet footer: *"Licence: 18 days remaining"* |
| Urgent | ≤ 7 left | amber banner |
| Grace | expired, ≤ 14 days | red banner, everything still working |
| Enforced | grace exhausted | gated per §1 |

---

## 7. Days-remaining surfaces

- **HMI** — the banner above, on every dashboard tab, not one page.
- **`device_health`** — add `licence: {state, days_remaining, expires}`.
  This is the commercially useful half: the fleet view can list which
  panels expire next month rather than discovering it from a support call.
  An added optional field, so the wire contract stays `v: 1`.
- **BMS** — the registers in §5.
- **Heartbeat** — not needed; `device_health` already publishes on change
  plus hourly, which is finer than the licence state changes.

---

## 8. Where the state lives

**Not a fifth config domain.** `cfg/modbus`, `cfg/alarms` and
`cfg/integration` are operator-editable, backed up, and restorable — all
three properties are wrong for a licence. A restorable licence is an
unlimited licence.

Proposed: `/etc/busduct/licence.json` (the signed key as received, plus the
decoded fields as a convenience) and `/var/busduct/licence-state`
(the integrity-protected time watermark). Neither in the config store,
neither in the config backup, both `0600`.

---

## 9. Decisions needed from the design chat

1. **§1 — what a lapsed licence may switch off.** The blocking one.
   Recommendation: gate commercial value, never the alarm path or a
   minimal live temperature view.
2. **§2 — 24-character key, or 20 with weaker binding?** Recommendation:
   24, plus QR entry.
3. **§5 — `NO_DATA` + a status register, or actually stop answering?**
   Recommendation: keep answering.
4. **§6 — is 14 days the right grace?**
5. **Licence term source of truth.** If the cloud can push a licence, the
   cloud already knows the expiry — should a panel that has been online
   recently trust the cloud over its local key, so a renewal takes effect
   without anyone typing anything? Recommendation: yes, with the typed key
   as the offline fallback.
6. **Who holds the Ed25519 private key, and what happens if it is lost?**
   Every issued licence is unverifiable if the key is lost and the public
   key is baked into shipped images. This needs a real answer before the
   first key is issued — a documented escrow, and a format-version field
   (§2) reserved for rotating to a second key.

## 10. Rough size

Assuming the recommendations above are accepted:

| Piece | Size |
|---|---|
| `src/licence/` — key decode, Ed25519 verify, watermark, state machine | ~2 days, pure and unit-testable |
| HMI banner + gating on the listed screens | ~1 day |
| BMS registers + `point_map_version` bump | ~half day |
| Remote domain on the existing cmd channel | ~half day |
| `device_health` field + fleet surface | ~half day |
| Vendor-side key issuing tool (`tools/licence-issue.js`) | ~half day |

Roughly a week, dominated by the HMI gating rather than the cryptography.
It does not touch the Modbus polling path, the alarm engine, or the
outbox, which is deliberate — nothing about licensing should be able to
break measurement.
