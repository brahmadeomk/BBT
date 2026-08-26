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
| §5 — MGate configuration | **From the MGate 5217 Series User Manual v1.4** (supplied by the user), with the parameter names, ranges and defaults quoted from it. Page references are given so each step can be checked. |

Manual facts that shaped this document (v1.4): the gateway connects **up to 32
Modbus TCP servers** (p5); each Modbus command has a **Read quantity of 1 or 2
registers only** (p19) — so one command produces one BACnet object; the CSV's
**`cmdIndex` runs 1 to 1200** (p57), which settles it: **a "point" is a Modbus
command**, so the budget in §1 is exactly right. Every command carries **Data
scaling (multiplication)** and **Data addition** (p20), and Moxa advise keeping
**COV subscriptions under 300** (p21). The **virtual node** scheme — each Modbus
device becoming its own BACnet device via a 6-digit instance (p57) — is what §5b
uses to avoid handing the BMS one flat list of a thousand objects.

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
| Data type | **signed 16-bit** two's complement | Set the command's **`Data Format` = `int16`** (p19). Left on `uint16`, −1 reads as 65535 and every no-data point reads as 32768 |
| Scaling | temperature / ΔT / RoR are **×10** | `615` = 61.5 °C. **Set `Data scaling (multiplication)` = `0.1` on those commands** (p20; range −1000…1000). The BMS then reads 61.5 directly and nobody has to remember a convention |
| Counts, levels, states, indices, heartbeat | **unscaled** | Never apply the ÷10 to these |
| No-data sentinel | **−32768** on a measurement point | Device blacklisted / joint dark. The gateway has no way to express BACnet `Reliability` per command, so **this stays a documented convention the BMS must honour**. Note the interaction with scaling: with ×0.1 applied the sentinel arrives as **−3276.8**, so tell the BMS that value, not −32768. Do not leave it implicit — a joint reading −3276.8 °C is the failure most likely to be misread later |
| Levels | 0 none, 1 WATCH, 2 WARNING, 3 CRITICAL | Map as **Multi-state input** (p20) with no scaling, or **Integer value**. Never apply the ×0.1 |
| Joint state | 0 LIVE, 1 STALE, 2 OFFLINE | Same |
| `heartbeat` (reg 0) | increments every refresh, wraps 0..32767 | **Map this on every gateway.** A frozen value means the Pi or the flow has stopped — Modbus itself has no liveness, so this is the only way the BMS can tell a dead panel from a calm one |

**Naming.** Each command has a **`Description` field, 0–40 characters** (p20),
which becomes the BACnet object's Description property — put the joint id and
point there (`J001 deltaT`). Note the manual's warning: editing the description
later **overwrites** the mapped object's description (p21). The BMS must support
the Description property to see it, so also keep the object-instance ↔ joint
table below as the authoritative reference. The joint↔index table for a commissioned panel comes from:

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

## 5. Gateway configuration (MGate 5217 manual v1.4)

> **One Modbus command = one register = one BACnet object = one point.**
> `Read quantity` accepts only **1 or 2** (p19), so you cannot poll a
> 125-register block into one command. At Tier 3 that means **hundreds of
> commands** — which is why step 5 uses the CSV import rather than the web UI.

1. **Power and network.** 12–48 VDC / 24 VAC. Reach the web console, set a
   static IP on the panel's network. Update firmware **before** configuring —
   note the CSV format changed at firmware v1.3 (p54), so match the two.
2. **Protocol Conversion** (p16): choose the pairing that makes the MGate a
   **Modbus TCP Client** on one side and a **BACnet/IP Server** on the other.
   The manual's own order is: set Protocol Conversion, configure the
   client/master side first, then the server/slave side, then review **I/O Data
   Mapping**.
3. **Modbus TCP Client settings** (p17):
   - `Initial delay` **0** (default) — the Pi is up long before the gateway.
   - `Max. retry` **3** (default).
   - `Response timeout` **1000 ms** (default) is comfortable; our server answers
     from an in-memory buffer.
   - Add the panel with **Add**: `Slave ID` **1**, a `Device Name`, and the Pi's
     **IP**. Port **1502**. (Up to 32 Modbus TCP servers per gateway, p5 — so one
     gateway could serve several panels if point budget allows.)
   - `Poll interval` default **1000 ms** (range 100–1,200,000, p26). See the
     scan-time warning below before lowering it.
4. **Per-command settings** (p19) — for every register:
   - `Data Format` **`int16`** (signed; see §3).
   - `Function` **3 – Read holding registers**.
   - `Read starting address` = the register from `docs/bms-register-map.md`.
   - `Read quantity` **1**.
5. **BACnet object per command** (p20):
   - `Convert to BACnet object`: **Analog value** for temperature/ΔT/RoR;
     **Multi-state input** or **Integer value** for levels, states, counts and
     the heartbeat.
   - `Description`: the joint id and point, e.g. `J001 deltaT` (≤40 chars).
   - `Units`: °C for temperatures; leave unset for counts and levels.
   - **`Data scaling (multiplication)` = `0.1`** on the ×10 points **only**.
     Leave it at 1 for counts, levels, states, indices and the heartbeat.
   - `COV increment`: see the COV warning below.
6. **Build the command list as a CSV, not by hand** (Chapter 7, p54). Create two
   or three commands in the web console first, **Export** to get the template,
   then generate the rest. The CSV has four sections; the one that matters here
   is **`[command_parameters]`**, one row per point, with fields including
   `cmdIndex` (**1–1200, must increase in order**), `cmdEnable`, `cmdName`
   (≤39 chars), `cmdDevIndex`, `cmdDataFormat` (`int16`), `cmdFunc` (`3`),
   `cmdTrigger` (`Cyclic`) and `cmdPollinterval`, plus the BACnet object fields
   (p57–58). Import, and check the error message against the named field if it
   rejects.
   - Generate the rows from the panel itself so they cannot drift from the live
     configuration — the joint↔register table in §3 is the input.
   - Note `cmdIndex` maxing at 1200: the CSV cannot express more points than the
     model licenses, so the split in §4 has to be decided *before* the sheet is
     generated, not after.
7. **BACnet/IP Server settings** (p29):
   - `Device name` and `Device instance` (0–4194302) — **distinct per gateway**,
     recorded against the joint range it covers.
   - `BACnet/IP port` **47808** default.
   - `Ethernet port network number` (default 1) and `Virtual network number`
     (default 1000, the Modbus side).
   - **Different subnet from the BMS?** Set `BBMD role` = *Register as a foreign
     device*, with the remote BBMD IP, UDP port and time-to-live (p29). Ask the
     BMS integrator for these; guessing them wastes a site visit.
8. **Save and export the configuration**, and store the CSV plus the export with
   the panel's commissioning file. Two gateways with several hundred
   hand-checked points is not something to rebuild from memory.

### Two warnings from the manual that bite specifically at Tier 3

**COV: keep subscriptions under 300** (p21). At Tier 3 a panel has 600–1200
points, so the BMS **must not** COV-subscribe everything. Subscribe COV to the
Tier 1 summary, the per-zone rollups and the alarm levels — the points that
change rarely and matter immediately — and let the BMS poll the per-joint
temperatures on a normal scan. Set `COV increment` deliberately: on a ×0.1
temperature, `1` means "notify on a 1 °C change", which is sensible; leaving it
at the smallest value turns every reading into a notification.

**Scan time grows with command count.** The manual is explicit that "the module
sends all requests in turns, [so] the actual polling interval also depends on the
number of requests in the queue" (p26). With ~700 single-register commands the
achievable cycle is set by the queue, not by `Poll interval`. Two practical
consequences: measure the real update rate on the I/O Data Mapping page before
promising the customer a refresh rate, and treat this as a second reason to
split across two gateways — halving the command count halves the scan.

## 5b. Virtual devices — strongly recommended, and free

By default the whole panel arrives at the BMS as **one BACnet device carrying
600–1200 flat objects**. An operator hunting for one joint scrolls a list of a
thousand. The MGate's *virtual node* feature fixes that, and it costs nothing to
use.

**How the gateway builds a device instance** (p57): the BACnet device instance is
**six digits**, `1 | 02 | 404` —

| Digits | Meaning |
|---|---|
| 1st | serial port — **always `1` in Modbus TCP mode**, not configurable |
| 2nd–3rd | **`devSequence`** (1–32 for Modbus TCP), set per Modbus device in the CSV |
| last 3 | the gateway's own base instance, from BACnet/IP Server Settings |

So **each Modbus *device* becomes its own BACnet device**. Our panel is one
Modbus device today, which is why everything lands in one flat list.

**Verified: our server answers on any unit id.** Modbus TCP treats the unit id as
a serial-gateway artefact, and our server does not filter on it — tested across
unit ids 1, 2, 5, 8, 32 and 247, all served identically. So the panel can be
presented as **up to 32 Modbus devices at the same IP:1502, differing only by
unit id**, with **no change to the panel's code or configuration**. It is purely
a gateway-side grouping.

### Recommended grouping

| `devSequence` | Unit id | Virtual BACnet device | Contents | Points (200 joints, 8 zones) |
|---:|---:|---|---|---:|
| 1 | 1 | `Panel Summary` | Tier 1 (0–11) + ACK (16) | 13 |
| 2 | 2 | `Zone 1` | zone block + its joints' Tier 3 | ~157 |
| 3 | 3 | `Zone 2` | " | ~157 |
| … | … | … | " | … |
| 9 | 9 | `Zone 8` | " | ~157 |

With a gateway base instance of `404`, the BMS discovers `101404` (Panel
Summary), `102404` (Zone 1), `103404` (Zone 2) … — navigable, and each device's
object list is short enough to read.

**Why this is worth doing beyond cosmetics:**

- A zone that goes dark is visible as *a whole BACnet device* failing, not as
  scattered objects going stale.
- The ACK object sits alone on `Panel Summary`, which makes it obvious that it
  is panel-wide and not per-zone.
- It composes with the two-gateway split (§4): gateway A takes the summary plus
  the first zones, gateway B the rest. Give the two gateways **different base
  instances** (e.g. `404` and `405`) so no instance number collides.

**Caveats worth knowing before committing:**

- **The point budget does not change.** Virtual devices regroup the same
  commands; `cmdIndex` still caps at 1200 per gateway.
- **`devSequence` caps at 32** for Modbus TCP, so at most 32 virtual devices per
  gateway — ample for one device per zone, not enough for one per joint.
- **It relies on our server ignoring the unit id.** That is normal Modbus TCP
  behaviour and is now pinned by a test
  (`test/integration/jsmodbus-server-factory.test.js`), but it is worth knowing
  the dependency exists: a future change to a server library that *does* filter
  on unit id would break the BMS grouping while every one of our own tools kept
  working.

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

## 7. What the manual settled, and what is still open

Answered by the v1.4 manual:

| Question | Answer |
|---|---|
| Does the 1200-point limit count registers or objects? | **Objects/commands.** `cmdIndex` runs 1–1200 (p57) and `Read quantity` is 1–2 (p19), so one command = one point. The §1 budget stands. |
| Can the gateway apply our ×10 scaling? | **Yes** — `Data scaling (multiplication)`, range −1000…1000 (p20). Use `0.1`. |
| Can it express BACnet `Reliability` for the no-data sentinel? | **No** per-command field exists. It stays a documented convention — and remember scaling turns −32768 into **−3276.8** (§3). |
| Max Modbus TCP servers per gateway | **32** (p5), so one gateway could serve several panels if the point budget allows. |

Still open, and only measurable on real hardware:

- **Actual scan time** with ~700 commands. The manual says requests are sent in
  turns and the real interval depends on queue depth (p26), but gives no figure.
  Measure it on the I/O Data Mapping page before committing to an update rate
  with the customer.
- **Whether the BMS supports the BACnet `Description` property** — if not, the
  object names carry no joint identity and the index table from §3 becomes the
  only reference. Ask the integrator early.

---

## Sources

- [Moxa MGate 5217 Series product page](https://www.moxa.com/en/products/industrial-edge-connectivity/protocol-gateways/modbus-tcp-gateways/mgate-5217-series)
- [MGate 5217I-1200-T product page](https://www.moxa.com/en/products/industrial-edge-connectivity/protocol-gateways/modbus-tcp-gateways/mgate-5217-series/mgate-5217i-1200-t)
- [MGate 5217 Series datasheet (v1.5, PDF)](https://www.moxa.com/getmedia/8b9fe908-bc8c-454b-ba33-94194555cd4c/moxa-mgate-5217-series-datasheet-v1.5.pdf)
- [MGate 5217 Series user manual (v1.4, PDF)](https://www.moxa.com/getmedia/55a90d7f-7625-45dd-be88-38557a058eb0/moxa-mgate-5217-series-manual-v1.4.pdf)
- [MGate 5217 BACnet PICS / compatibility guide (PDF)](https://www.moxa.com/getmedia/948c095b-96fd-44f7-b076-7aeb84d9bf1c/moxa-mgate-5217-series-pics-compatibility-guide-v1.1.pdf)

Primary source for §5: **MGate 5217 Series User Manual v1.4** (October 2024),
supplied by the user. Page references throughout are to that document.

Panel-side references: `docs/bms-register-map.md` (the customer-facing point
map), `docs/bms-integration.md` (deployment and runbook).
