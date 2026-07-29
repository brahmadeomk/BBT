# BMS Integration (Slice 11) — deployment & runbook

The panel exposes its live state to a customer Building Management System as
a **Modbus TCP slave** on the Pi, read by an **off-the-shelf Modbus→BACnet
gateway** (e.g. Intesis INMBSBAC, Babel Buster). No native BACnet stack and
no BOM commitment yet; the point model designed here carries over unchanged
if native BACnet/IP on the Pi becomes a product later.

The BMS interface is a **peer adapter** of the cloud gateway — fed from the
same internal link-node bus, computed locally, and **works with the internet
down** (the BMS is often the customer's alarm path of record).

## Architecture

```
ProcessLogic joint KPIs ─┐
Alarm Manager active ────┼─► BmsService (singleton) ─► register image ─► Modbus TCP slave ─► gateway ─► BACnet
blacklist joint state ───┘         │  worst-joint latch, heartbeat            ▲
                                   └──────── ACK write (FC6/16) ──────────────┘  ─► alarm ACK path (audit)
```

- Pure, unit-tested core (`src/integration/`): `register-map.js`
  (deterministic layout), `rollup.js` (latch + aggregates),
  `holding-registers.js` (image), `ack.js` (ACK decode),
  `modbus-tcp-slave.js` (adapter with an **injected** server factory),
  `bms-service.js` (orchestration).
- `src/integration/node-red/index.js` exposes it as **`busductIntegration`**
  (functionGlobalContext). Same restart-not-Deploy rule as the other
  libraries.
- Config domain **`cfg/integration`** (schema
  `config/schemas/busduct_integration_config.schema.json`, validator
  `src/config-service/validate-integration.js`, rules I1–I5) follows the
  same store/validate/audit path as the other three domains.

## Customer-facing map

`docs/bms-register-map.md` — versioned, **append-only** (rule stated on
page 1). Deliver it plus the per-panel index table (generator snippet at the
bottom of that doc) with each commissioned panel.

## Pi setup

1. **Install the Modbus server library** (pure JS, no native build on ARM):
   ```
   cd /home/pi/busduct-cloud-edge && npm i jsmodbus
   ```
   It's an `optionalDependency`; without it the service still computes the
   register image but binds no socket (so you can bench the map before wiring
   the gateway).
2. **settings.js** — add the `busductIntegration` functionGlobalContext entry
   (see `src/config-service/node-red/settings.js.example`). Restart Node-RED.
3. **Apply a `cfg/integration` document** (example:
   `config/examples/integration.json`) — through the remote config channel or
   a local apply. Pick:
   - `modbus_tcp.port` — **1502 recommended** (a privileged <1024 port such
     as 502 needs `CAP_NET_BIND_SERVICE` on the Node-RED process or an
     nftables redirect; I2 warns about this). Point the gateway at whatever
     you choose.
   - `exposure_tier` — 1 (summary only), 2 (+per-zone), or 3 (+per-joint).
   - `severity_bitmap.enabled` — compact per-joint levels for
     point-licence-sensitive sites.
4. **Firewall** the Modbus port to the BMS VLAN only (Modbus TCP is
   unauthenticated); optionally set `modbus_tcp.bind_host` to the BMS-facing
   interface address.

## Flow wiring (BMS Integration tab)

> **Status (2026-07-29): BUILT.** The tab ships in `flows/flows_BBT.json`
> (nodes `b115ac57e0f100xx`) and was verified end-to-end against the real
> 21-slave migrated config with a fake server factory. What remains is the
> **reference-gateway live validation** (workplan §11 step 8), which needs
> the Modbus→BACnet hardware.

The shipped **BMS Integration** tab, all thin nodes calling
`global.get('busductIntegration')`:

1. **Server host node** (`inject` @boot → function): build the singleton with
   the production factory and start it:
   ```js
   const I = global.get('busductIntegration');
   const { jsmodbusServerFactory } = require('/home/pi/busduct-cloud-edge/src/integration/node-red/jsmodbus-server-factory');
   const store = global.get('busductConfigService').getStore();  // or however the store is exposed
   const svc = I.getBmsService(store, { serverFactory: jsmodbusServerFactory });
   flow.set('bmsStarted', !!svc);
   ```
2. **KPI joint tap** — a `link in` from the existing `KPI Stream - Joint
   (link out)` → function → `svc.ingestJoint(msg.payload)`.
3. **Active-alarm tap** — `link in` from `Alarm Events - Active (link out)` →
   `svc.ingestAlarmsActive(msg.payload)`.
4. **Blacklist state** — a 5 s `inject` reading
   `global.busduct_blacklist_state` → `svc.ingestBlacklistState(state)`.
5. **Refresh tick** — an `inject` every 2–5 s → `svc.refresh()`. This bumps
   the heartbeat and pushes the new image to the slave. (Choose the period
   with the customer; the heartbeat's usefulness as a liveness signal depends
   on it being faster than the BMS's poll interval.)
6. **ACK output** — once, wire `svc.onAck(cmd => …)` to emit a message into
   the **same** node the HMI's ACK button feeds (summary ACK → ack all
   active; joint ACK → ack that joint's alarms). This is what puts a
   BMS-originated ACK into the audit trail.

All heavy logic is in the library; the function nodes stay thin, per the
standing rule. `flows-integrity.test.js` will guard the new `link`
references once the tab is added.

## Reference-gateway validation (Done-when)

Per the workplan, Slice 11 is done when:

1. A reference Modbus→BACnet gateway reads **Tier 1** and presents it as
   BACnet objects **with no custom mapping** (contiguous, fixed-stride,
   ×10-scaled signed points make this a stock configuration).
2. A **frozen Pi is detectable** — stop Node-RED and confirm the `heartbeat`
   register stops advancing while the TCP socket may still answer (that's the
   whole point of the counter).
3. A **BMS-originated ACK appears in the audit trail** — write `1` to the ACK
   register from the gateway/a Modbus master and confirm the audit entry
   attributes the acknowledgement to the BMS.

Bench the register values first with a plain Modbus master (e.g.
`modpoll`/a Python `pymodbus` client) against the Pi's port before
introducing the gateway, cross-checking a few points against the HMI.
