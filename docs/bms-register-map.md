# BusductTherMo — BMS Modbus Register Map

**Point-map version: 1**
**Protocol: Modbus TCP (function code 3 — Read Holding Registers; FC 6/16 — Write Single/Multiple to the ACK register only)**

---

## ⚠️ APPEND-ONLY CONTRACT (read first)

This register map is **append-only and versioned**. A published address is
frozen forever:

- **Points are never renumbered.** New points are only ever *appended* into
  the reserved gaps or after the last block. One renumber would silently
  break every deployed gateway configuration in the field.
- The **`point_map_version`** register (and the version in the header above)
  increments whenever points are appended. A gateway configured for version
  *N* keeps working against version *N+1* — everything it knew is still at
  the same address.
- Raising the panel's **exposure tier** only *adds* blocks (Tier 2, then
  Tier 3); it never moves Tier 1.

If you are integrating a gateway, map against the version you were given and
you are safe across upgrades.

---

## Conventions

- **Addressing:** zero-based holding-register addresses (register 0 = 40001
  in 4xxxx convention; confirm your gateway's base). Modbus **unit id** is
  configured per panel (`cfg/integration.modbus_tcp.unit_id`, default 1).
- **Data type:** every register is a **signed 16-bit** integer (two's
  complement).
- **Scaling:** temperature / ΔT / RoR points are **×10** (0.1 resolution):
  a register value of `604` means `60.4`. Counts, levels, states, indices,
  and the heartbeat are **unscaled** integers.
- **No-data sentinel:** `-32768` (0x8000) on a measurement point means "no
  reading" (device blacklisted / joint dark) — distinct from a real `0.0`.
- **Levels:** `0` = none, `1` = WATCH, `2` = WARNING, `3` = CRITICAL.

---

## Block layout (fixed bases)

| Block | Base | Present when |
|---|---|---|
| Tier 1 — panel summary | `0` | always |
| Control (ACK) | `16` | always |
| Severity bitmap (optional) | `32` | `severity_bitmap.enabled` |
| Tier 2 — per zone | `100` | `exposure_tier ≥ 2` |
| Tier 3 — per joint | `500` | `exposure_tier = 3` |

---

## Tier 1 — panel summary (base 0)

| Addr | Point | Scale | Meaning |
|---|---|---|---|
| 0 | `heartbeat` | 1 | Scan counter, increments every refresh, wraps 0..32767. **A frozen value = the Pi/flow has stopped** (Modbus has no liveness of its own). |
| 1 | `system_health` | 1 | 0 = OK, 1 = DEGRADED (a device blacklisted / comm fault), 2 = FAULT (no live joints). |
| 2 | `highest_alarm_level` | 1 | Highest active process alarm level across the panel (0..3). |
| 3 | `active_alarm_count` | 1 | Number of active process alarm instances. |
| 4 | `count_watch` | 1 | Active WATCH instances. |
| 5 | `count_warning` | 1 | Active WARNING instances. |
| 6 | `count_critical` | 1 | Active CRITICAL instances. |
| 7 | `worst_joint_index` | 1 | Tier-3 index of the latched worst joint (−1 = none; −2 = a worst joint exists but Tier 3 isn't exposed). |
| 8 | `panel_max_temp` | ×10 | Panel maximum joint temperature (°C). |
| 9 | `panel_max_deltaT` | ×10 | Panel maximum ΔT (°C). |
| 10 | `panel_max_ror` | ×10 | Panel maximum rate-of-rise (°C/hr). |
| 11 | `live_joint_count` | 1 | Joints currently measurable. |
| 12–15 | *reserved* | — | Reserved for future Tier-1 appends. Read 0. |

**Per-level counts are provided so a WARNING is never masked by a CRITICAL** —
a summary that only showed the highest level would hide lower-level activity.

**Worst joint is latched:** once a joint holds the worst (highest) level it
keeps `worst_joint_index` until its alarm clears, even if another joint later
reaches the same level (first-raised wins). This stops the point oscillating.

## Control block (base 16)

| Addr | Point | Access | Meaning |
|---|---|---|---|
| 16 | `ack_command` | **R/W** | Write to acknowledge alarms (below). Reads back the last value written. |
| 17–19 | *reserved* | — | Reserved. |

**ACK semantics** (write with FC 6 or FC 16):

| Value written | Effect |
|---|---|
| `1` | **Summary ACK** — acknowledges **all currently active alarms**. |
| `1000 + i` | Acknowledge all active alarms on the Tier-3 joint at index `i`. |
| `0` or anything else | No-op (0 is the idle/reset value). |

A BMS-originated ACK is routed through the **same** acknowledgement path as
the HMI, so it appears in the panel's audit trail attributed to the BMS.
"Summary ACK acknowledges all currently active" is deliberate — a single
Modbus point cannot carry per-alarm intent.

## Severity bitmap (optional, base 32)

Enabled with `severity_bitmap.enabled` for point-licence-sensitive customers
who cannot afford full Tier-3 detail. Each register packs **8 joints, 2 bits
each** (the joint's level 0..3):

- Joint Tier-3 index `i` lives in register `32 + floor(i/8)`, bit-shift
  `(i mod 8) × 2`.
- Up to 128 joints → up to 16 registers (32..47).

## Tier 2 — per zone (base 100, stride 8)

Zone `z` (in the panel's fixed zone order) occupies base `100 + z×8`:

| Offset | Point | Scale |
|---|---|---|
| +0 | `highest_alarm_level` | 1 |
| +1 | `active_alarm_count` | 1 |
| +2 | `max_temp` | ×10 |
| +3 | `max_deltaT` | ×10 |
| +4 | `max_ror` | ×10 |
| +5 | `count_warning` | 1 |
| +6 | `count_critical` | 1 |
| +7 | *reserved* | — |

## Tier 3 — per joint (base 500, stride 8)

Joint `j` (in cfg/joints order — this is the joint's stable Tier-3 index)
occupies base `500 + j×8`:

| Offset | Point | Scale | Meaning |
|---|---|---|---|
| +0 | `level` | 1 | Joint highest active alarm level (0..3). |
| +1 | `state` | 1 | 0 = LIVE, 1 = STALE (held alarm, device dark), 2 = OFFLINE. |
| +2 | `temp` | ×10 | Temperature (°C); −32768 = no data. |
| +3 | `deltaT` | ×10 | ΔT (°C); −32768 = no data. |
| +4 | `ror` | ×10 | Rate-of-rise (°C/hr); −32768 = no data. |
| +5 | `absolute_temp` | ×10 | Duplicate of `temp` for gateways wanting a distinct point. |
| +6, +7 | *reserved* | — | Reserved for future per-joint appends. |

A **STALE** joint (state 1) is holding its last alarm while its device is
dark — its measurement registers read the no-data sentinel, not a stale
value, so a gateway never mistakes a frozen reading for a live one.

---

## Per-panel index map

The joint↔index and zone↔index mapping is panel-specific (it follows the
panel's cfg/joints order). Generate the current mapping for a delivered
panel from the applied config with:

```
node -e "const {buildRegisterMap}=require('./src/integration/register-map'); \
  const i=require('/var/busduct/cfg/integration.json'); \
  const j=require('/var/busduct/cfg/modbus_joints.json'); \
  const m=buildRegisterMap(i,j); \
  console.log('zones', (m.tier2?.zones||[]).map(z=>[z.index,z.zone_id,z.base])); \
  console.log('joints', (m.tier3?.joints||[]).map(x=>[x.index,x.joint_id,x.base]));"
```

Deliver that index table alongside this map for each commissioned panel.
