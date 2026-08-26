# BACnet via Moxa MGate 5217I-1200-T — integration process

Customer requirement: **BACnet/IP interface, full Tier 3 exposure**, using
**Moxa MGate 5217I-1200-T** gateways — two of them where the panel(s) carry more
than ~200 sensors.

---

## 0. What in this document is verified, and what is not

Be clear about this before commissioning, because the two halves have very
different confidence:

| Part | Confidence |
|---|---|
| §1–§4 — our register map, point budget, split boundaries, data types, concurrent-client behaviour | **Verified against this repo's code and by running it.** Numbers here were computed and tested, not recalled. |
| §5 — MGate configuration | **Cross-check every field name against the Moxa manual.** The tooling environment blocks `moxa.com`, so the OEM manual could not be read directly. The *values* to enter are ours and correct; the *menu paths* are described generically on purpose. |

Product facts used below come from Moxa's public product pages (see Sources):
2 serial ports + 2 Ethernet ports, Modbus RTU/ASCII/TCP **client/master** to
BACnet/IP **server**, 600- and 1200-point models, "virtual node" support to
present each Modbus device as its own BACnet device, and Modbus command entry
via an Excel sheet. Anything more specific must come from the manual.

---

## 1. Topology: how many gateways you actually need

The MGate is a **Modbus client**. Our panel is a **Modbus TCP server**
(`src/integration/modbus-tcp-slave.js`, default port 1502, unit id 1). So the
gateway polls the Pi over Ethernet; no serial wiring is involved on our side and
the MGate's two serial ports go unused.

**Verified: two gateways can poll one Pi simultaneously.** Tested by binding the
real server and running two Modbus TCP clients concurrently against different
register ranges — both served, repeatedly, no resets. Nothing in the panel needs
to change to support a second gateway.

### Point budget at Tier 3 (computed from `register-map.js`)

Points per block: Tier 1 = 12, ACK = 1 (writable), Tier 2 = 7 per zone,
Tier 3 = **6 per joint**.

| Joints | Zones | Points (all 6/joint) | Gateways | Points (skip `absolute_temp`) | Gateways |
|---:|---:|---:|---:|---:|---:|
| 100 | 8 | 669 | 1 | 569 | 1 |
| 150 | 8 | 969 | 1 | 819 | 1 |
| **200** | 8 | **1269** | **2** | **1069** | **1** |
| 215 | 8 | 1359 | 2 | 1144 | 1 |
| 220 | 16 | 1445 | 2 | 1225 | 2 |
| 250 | 16 | 1625 | 2 | 1375 | 2 |

**`absolute_temp` (offset +5) is a documented duplicate of `temp` (+2)** — it
exists only for gateways that want a separate point. Dropping it saves one point
per joint, and **at 200 joints that is the difference between needing two
gateways and one**. Ask the BMS integrator whether they want it before you buy
the second gateway; the crossover with it dropped is ~215 joints.

> Sensor count vs joint count: the budget is driven by **joints** (Tier 3 is
> per joint). Ambient probes are not joints and consume no Tier-3 points — a
> 200-joint + 20-ambient panel costs the same as 200 joints.

### Two panels vs one big panel

If the >200 sensors are **two panels** (two Pis), the clean split is **one
gateway per panel** — each polls its own Pi, each becomes its own BACnet device,
and no register-range arithmetic is needed. Only split a *single* panel's range
across two gateways (§4) when one panel genuinely exceeds the point limit.

---

## 2. Panel-side configuration (do this first)

Set the integration domain to full Tier 3 and apply it:

```bash
cd ~/busduct-cloud-edge
# edit config/examples/integration.json (or your panel's copy):
#   "exposure_tier": 3
#   "modbus_tcp": { "enabled": true, "port": 1502, "unit_id": 1 }
node tools/apply-integration-config.js
```

Then confirm the panel is actually serving, **before** the gateway is involved:

```bash
node tools/bms-read.js            # Tier 1, decoded
node tools/bms-read.js --all      # every mapped register
```

`bms-read.js` prints the map **`extent`** — the highest register in use. Write it
down; it is the number the gateway's poll ranges must respect, and it grows as
joints are added.

Firewall: the gateway must reach the Pi on **TCP 1502**. If the panel runs a
firewall, open it to the gateway's IP only.

---

## 3. Register → BACnet mapping rules

These are properties of our map and are **not negotiable by gateway
configuration** — the BMS has to be told about them. Full map:
`docs/bms-register-map.md`.

| Property | Value | Consequence for the BACnet side |
|---|---|---|
| Function code | **FC 3** (read holding registers) | Read-only points map naturally to **AV** (or AI if the gateway/BMS prefers); the ACK register needs a **writable** object |
| Data type | **signed 16-bit** two's complement | The gateway must be told *signed*. Left unsigned, −1 reads as 65535 and every no-data point reads as 32768 |
| Scaling | temperature / ΔT / RoR are **×10** | `615` = 61.5 °C. Either scale on the gateway (if it supports a multiplier — confirm in the manual) **or** state ×10 explicitly in the point list so the BMS divides. Do not leave it implicit |
| Counts, levels, states, indices, heartbeat | **unscaled** | Never apply the ÷10 to these |
| No-data sentinel | **−32768** on a measurement point | Device blacklisted / joint dark. **The BMS must treat this as "no data", not as −3276.8 °C.** If the gateway can express BACnet `Reliability` or out-of-service, use it; otherwise it must be a documented rule in the point list |
| Levels | 0 none, 1 WATCH, 2 WARNING, 3 CRITICAL | Good candidate for a **Multi-state Value** if the gateway supports it; otherwise AV |
| Joint state | 0 LIVE, 1 STALE, 2 OFFLINE | Same |
| `heartbeat` (reg 0) | increments every refresh, wraps 0..32767 | **Map this on every gateway.** A frozen value means the Pi or the flow has stopped — Modbus itself has no liveness, so this is the only way the BMS can tell a dead panel from a calm one |

**Naming.** Map BACnet object names to the panel's joint ids (`J001`…), not to
register numbers. The joint↔index table for a commissioned panel comes from:

```bash
node -e "const {buildRegisterMap}=require('./src/integration/register-map'); \
  const i=require('/var/busduct/cfg/integration.json'); \
  const j=require('/var/busduct/cfg/modbus_joints.json'); \
  const m=buildRegisterMap(i,j); \
  console.log((m.tier3?.joints||[]).map(x=>[x.index,x.joint_id,x.base]));"
```

Deliver that table with the point list — it is what makes the BACnet points
readable to the building operator.

---

## 4. Splitting one panel across two gateways

Only needed when a single panel exceeds the point limit (§1). Worked example —
**200 joints, 8 zones, Tier 3** (`extent` 2098):

| | Register range | Contents | Points |
|---|---|---|---|
| **Gateway A** | `0 … 1299` | Tier 1 (0–11), **ACK (16)**, 8 zones (100–163), joints **J001–J100** (500–1299) | 669 |
| **Gateway B** | `1300 … 2098` | joints **J101–J200**, plus register `0` for the heartbeat | 601 |

Joint index *i* lives at `500 + i×8`, so the boundary is exact and you can move
it: to give gateway A *k* joints, its range ends at `500 + k×8 − 1`.

Three rules for the split:

1. **The ACK register (16) belongs to exactly one gateway.** It is the only
   writable point. Mapping it on both gives you two BACnet objects that write the
   same register, and an operator acknowledging on the wrong one is confusing at
   best. Put it on gateway A.
2. **Panel-level summary points (Tier 1) go on gateway A only** — except the
   heartbeat, which goes on both so each BACnet device proves its own liveness.
3. **Each gateway is its own BACnet device instance.** Assign distinct device
   instance numbers and document which joint range each covers, or the BMS
   integrator will have no way to tell them apart.

---

## 5. Gateway configuration — the values to enter

> **Cross-check the field names against the MGate 5217 manual.** The steps below
> are ordered correctly and the values are right; the exact menu labels are
> deliberately not invented here.

1. **Power and network.** 12–48 VDC / 24 VAC. Reach the web console on the
   default IP (from the manual / quick install guide). Set a static IP on the
   panel's network.
2. **Firmware.** Update to current before configuring — doing it afterwards can
   clear the configuration.
3. **Set the Modbus role to TCP *client* (master).** The gateway initiates; our
   Pi is the server. This is the single most common mis-set field on this job.
4. **Add the Pi as a Modbus TCP server**: its IP, **port 1502**, **unit/slave id
   1** (both from `cfg/integration.modbus_tcp`).
5. **Define the read commands** — FC 3, in blocks of **≤125 registers** (the
   Modbus per-request maximum). For gateway A of the worked example that is
   ranges `0–11`, `16`, `100–163`, then `500–1299` in seven 125-register blocks.
   Moxa's product page describes bulk command entry via an Excel sheet; use it
   rather than hand-entering hundreds of rows.
   - Poll interval: **1–5 s is ample.** Our image is refreshed on a 5 s tick, so
     polling faster only adds load without adding freshness.
6. **Set the data type to signed 16-bit**, and apply the ×10 scaling here if the
   gateway supports a multiplier (§3).
7. **Map to BACnet objects.** Read-only points → AV (or AI); the ACK register →
   a writable object; levels/state → Multi-state Value if available.
8. **BACnet device identity.** Set the device instance number, device name, and
   BACnet/IP port (normally 47808/0xBAC0). If the BMS is on another subnet,
   configure BBMD/Foreign Device registration — ask the BMS integrator which.
9. **Virtual nodes.** Moxa's "virtual node" feature presents each Modbus device
   as a separate BACnet device. We are **one** Modbus device (one unit id), so
   this is not needed for a single panel; it becomes relevant only if one gateway
   ever polls several panels.
10. **Save, export the configuration, and store the export with the panel's
    commissioning file.** Two gateways with hand-entered point maps are exactly
    the thing you do not want to rebuild from memory after a failure.

---

## 6. Verification, in the order that isolates faults

Each step proves one link, so a failure tells you where the problem is:

1. **Panel serves its own registers** — `node tools/bms-read.js` on the Pi.
   Fails here → the problem is ours (service not started, config not applied).
2. **Panel reachable from the gateway's network** —
   `node tools/bms-read.js --host=<pi-ip>` from another machine on that subnet.
   Fails here → network or firewall, not the gateway.
3. **Gateway is polling** — the MGate's diagnostics show Modbus traffic and
   errors. Fails here → client mode, IP, port 1502, or unit id.
4. **BACnet objects appear** — discover the device from the BMS or any BACnet
   explorer. Check a known value against the panel: `panel_max_temp` on the
   dashboard should equal the BACnet point ÷10.
5. **Heartbeat advances** — read it twice a few seconds apart. `bms-read.js`
   does this automatically and reports `FROZEN` if it does not.
6. **ACK round-trip** — write `1` to the ACK object from the BMS, then confirm
   the acknowledgement appears in the panel's **Audit Trail** attributed to BMS.
   `node tools/bms-read.js --ack=1` does the same thing over raw Modbus, so you
   can tell a BMS-side problem from a gateway-side one.
7. **No-data behaviour** — blacklist a device (unplug one sensor), confirm its
   joint's points go to the −32768 sentinel and that the BMS shows them as
   no-data rather than a large negative temperature. **Do this before handover**;
   it is the failure mode most likely to be misread months later.

---

## 7. Open items to confirm against the manual or with Moxa

Worth settling before ordering the second gateway:

- **Does the 1200-point limit count Modbus registers polled, or BACnet objects
  created?** The budget in §1 counts *mapped points*, which is the conservative
  reading. If reserved gaps inside a polled block also count, the usable joint
  count per gateway drops and the split in §4 must move.
- **Does the gateway support a scaling multiplier**, or must the BMS divide by
  10 (§3)?
- **Can it express BACnet `Reliability` / out-of-service** for the −32768
  sentinel, or is that purely a documented convention for the BMS (§3)?
- **Maximum concurrent Modbus commands and total poll cycle time** at ~800
  registers per gateway — this determines the achievable BACnet update rate.

---

## Sources

- [Moxa MGate 5217 Series product page](https://www.moxa.com/en/products/industrial-edge-connectivity/protocol-gateways/modbus-tcp-gateways/mgate-5217-series)
- [MGate 5217I-1200-T product page](https://www.moxa.com/en/products/industrial-edge-connectivity/protocol-gateways/modbus-tcp-gateways/mgate-5217-series/mgate-5217i-1200-t)
- [MGate 5217 Series datasheet (v1.5, PDF)](https://www.moxa.com/getmedia/8b9fe908-bc8c-454b-ba33-94194555cd4c/moxa-mgate-5217-series-datasheet-v1.5.pdf)
- [MGate 5217 Series user manual (v1.4, PDF)](https://www.moxa.com/getmedia/55a90d7f-7625-45dd-be88-38557a058eb0/moxa-mgate-5217-series-manual-v1.4.pdf)
- [MGate 5217 BACnet PICS / compatibility guide (PDF)](https://www.moxa.com/getmedia/948c095b-96fd-44f7-b076-7aeb84d9bf1c/moxa-mgate-5217-series-pics-compatibility-guide-v1.1.pdf)

Panel-side references: `docs/bms-register-map.md` (the customer-facing point
map), `docs/bms-integration.md` (deployment and runbook).
