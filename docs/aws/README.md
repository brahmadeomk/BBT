# AWS IoT setup & testing guide (Slice 6)

Complete runbook: Part A is one-time AWS account setup (~30–45 min,
needs an AWS admin login), Part B is per-panel commissioning on the Pi
(~15 min), Part C is verification and the link-loss tests that feed
the combined Slice 5+6 soak.

Files referenced here (in this directory):

| File | What it is |
|---|---|
| `iot-policy-panel.template.json` | Per-device policy — every panel gets this, locked to its own topics |
| `iot-policy-claim.template.json` | Claim-certificate policy — provisioning bootstrap ONLY |
| `provisioning-template.json` | Fleet Provisioning template body |

---

## Part A — one-time AWS account setup

Use the same region for everything. The examples below use
**ap-south-1 (Mumbai)** — change if your account standardizes on a
different region. You need your 12-digit **account ID** (top-right
menu in the console) for the policy files.

### A1. Find the ATS device endpoint

Console: **AWS IoT Core → Settings (left nav, bottom) → Device data
endpoint**. It looks like:

```
a1b2c3d4e5f6g7-ats.iot.ap-south-1.amazonaws.com
```

CLI equivalent:

```bash
aws iot describe-endpoint --endpoint-type iot:Data-ATS --region ap-south-1
```

Write it down — it goes into every panel's `edge-config.yaml`
(`mqtt.endpoint`). Only the `-ats` endpoint works with the Amazon Root
CA the panel uses.

### A2. Register the per-device policy (`bt-panel-policy`)

1. Open `iot-policy-panel.template.json` from this repo and replace
   every `REGION` with your region and `ACCOUNT_ID` with your account
   ID (and remove the `__comment` line — the console rejects unknown
   top-level keys).
2. Console: **AWS IoT Core → Security → Policies → Create policy**.
   Name: `bt-panel-policy`. Switch the policy document to **JSON**
   and paste the edited file. Create.

CLI equivalent:

```bash
sed -e 's/REGION/ap-south-1/g' -e 's/ACCOUNT_ID/123456789012/g' \
    -e '/"__comment"/d' docs/aws/iot-policy-panel.template.json > /tmp/panel-policy.json
aws iot create-policy --policy-name bt-panel-policy \
    --policy-document file:///tmp/panel-policy.json
```

What it does: a panel may connect **only** with its own thing name as
client ID, and may publish/subscribe **only** on topics containing its
own `customer_id/site_id/panel_id` (read from thing attributes set at
provisioning). One panel's stolen certificate cannot read or spoof
another panel.

### A3. Create the provisioning IAM role (`bt-provisioning-role`)

Fleet Provisioning needs an IAM role AWS IoT assumes to create
things/certificates during registration.

Console: **IAM → Roles → Create role** → trusted entity type *AWS
service* → service **IoT** → use case *IoT* → next → make sure the
managed policy **`AWSIoTThingsRegistration`** is attached → name it
`bt-provisioning-role` → create. Note its ARN
(`arn:aws:iam::<account>:role/bt-provisioning-role`).

### A4. Create the thing type (`bt-panel`)

AWS allows at most **3 attributes on a thing without a thing type**,
and our template stamps 4 (customer/site/panel/serial) — skipping this
step makes registration fail with *"To use more than 3 attributes, a
thing must have a type specified"*.

Console: **AWS IoT Core → All devices → Thing types → Create thing
type** → name `bt-panel`. CLI:

```bash
aws iot create-thing-type --thing-type-name bt-panel --region ap-south-1
```

### A5. Register the provisioning template (`bt-panel-provisioning`)

Console: **AWS IoT Core → Connect many devices → Provisioning
templates → Create provisioning template** →
*Provisioning devices with claim certificates*:

- Name: `bt-panel-provisioning`
- Provisioning role: `bt-provisioning-role`
- Claim certificate policy: you'll attach it in A6 (skip auto-create
  here if the wizard offers, or let it create one and replace its
  document with `iot-policy-claim.template.json` after)
- Status: **Active**
- Template document: paste `provisioning-template.json` (remove the
  `__comment` line). It derives the thing name
  `bt-{CustomerId}-{SiteId}-{PanelId}`, stamps
  customer/site/panel/serial as **thing attributes** (which the
  per-device policy's variables read), activates the new certificate,
  and attaches `bt-panel-policy` to it.

CLI equivalent:

```bash
sed '/"__comment"/d' docs/aws/provisioning-template.json > /tmp/template-body.json
aws iot create-provisioning-template \
    --template-name bt-panel-provisioning \
    --provisioning-role-arn arn:aws:iam::123456789012:role/bt-provisioning-role \
    --template-body file:///tmp/template-body.json \
    --enabled
```

**Already registered the template with an older body?** Templates are
versioned — push the current body as a new default version (console:
open the template → *Edit template document* → paste → save; or CLI):

```bash
aws iot create-provisioning-template-version \
    --template-name bt-panel-provisioning \
    --template-body file:///tmp/template-body.json \
    --set-as-default
```

### A6. Create the claim certificate (what technicians carry)

1. Console: **AWS IoT Core → Security → Certificates → Add
   certificate → Create certificate** (auto-generate) → **Download**
   the certificate (`claim.pem.crt`), the private key
   (`claim.pem.key`), and the **Amazon Root CA 1** — this is the ONLY
   moment the private key can be downloaded → set the certificate
   **Active**.
2. Create the claim policy: **Security → Policies → Create policy**,
   name `bt-claim-policy`, JSON from `iot-policy-claim.template.json`
   (REGION/ACCOUNT_ID replaced, `__comment` removed). This policy can
   *only* run the provisioning exchange — a leaked claim key cannot
   publish telemetry or read anything.
3. Attach the policy to the claim certificate: open the certificate →
   **Attach policies** → `bt-claim-policy`.

Store `claim.pem.crt` + `claim.pem.key` somewhere controlled (they
provision new panels; treat like a master key with training wheels).

**Account setup is done.** Nothing above repeats per panel.

---

## Part B — per-panel commissioning (on the Pi)

### B1. Prepare directories and the root CA

```bash
sudo mkdir -p /etc/busduct/certs /etc/busduct/claim
sudo chown -R pi:pi /etc/busduct
curl -o /etc/busduct/certs/AmazonRootCA1.pem \
     https://www.amazontrust.com/repository/AmazonRootCA1.pem
```

### B2. Write the panel's edge config

Create `/etc/busduct/edge-config.yaml`. Minimal working example —
replace the identity values and the endpoint with yours (full spec
with every optional field: `docs/busduct_edge_config.yaml`):

```yaml
config_version: 1
identity:
  customer_id: c1001          # your internal customer code
  site_id: s01                # site/substation code
  panel_id: p01               # panel code
  thing_name: bt-c1001-s01-p01   # MUST be bt-{customer}-{site}-{panel}
  hw_serial: BT26-000001
  fw_version: 23022026
mqtt:
  endpoint: a1b2c3d4e5f6g7-ats.iot.ap-south-1.amazonaws.com   # from step A1
  port: 8883
  cert_path: /etc/busduct/certs/device.pem.crt
  key_path: /etc/busduct/certs/private.pem.key
  root_ca_path: /etc/busduct/certs/AmazonRootCA1.pem
  keep_alive_sec: 300
  reconnect_backoff: { initial_sec: 2, max_sec: 300 }
topics:
  telemetry: dt/{customer_id}/{site_id}/{panel_id}/tel
  alarm:     dt/{customer_id}/{site_id}/{panel_id}/alarm
  telemetry_basic_ingest: $aws/rules/btTelemetry/dt/{customer_id}/{site_id}/{panel_id}/tel
  use_basic_ingest: false     # keep false until the IoT Rule exists (Part D)
buffer:
  path: /var/busduct/outbox
```

`thing_name` must match what the template derives
(`bt-<customer_id>-<site_id>-<panel_id>`) — the provisioning tool
warns if it doesn't.

### B3. Copy the claim material and provision

Copy `claim.pem.crt`/`claim.pem.key` (from A6) to
`/etc/busduct/claim/`, then:

```bash
cd ~/busduct-cloud-edge
git pull && npm ci        # this flow version adds mqtt + js-yaml
node tools/provision-panel.js \
  --template=bt-panel-provisioning \
  --claim-cert=/etc/busduct/claim/claim.pem.crt \
  --claim-key=/etc/busduct/claim/claim.pem.key
```

Expected output:

```
Provisioning bt-c1001-s01-p01 against a1b2...-ats.iot.ap-south-1.amazonaws.com (template: bt-panel-provisioning)...
Thing registered: bt-c1001-s01-p01 (certificate 1a2b3c...)
Credentials written: /etc/busduct/certs/device.pem.crt, /etc/busduct/certs/private.pem.key (0600)
Restart Node-RED to bring the gateway up on the AWS transport.
```

The tool refuses to run again once `device.pem.crt` exists (use
`--force` only for a deliberate re-provision).

### B4. Clean up and restart

```bash
rm -rf /etc/busduct/claim          # claim material does not live on panels
sudo systemctl restart nodered
```

No flow change or Deploy is needed — `getGateway()` detects the
config + certs at startup and comes up on the AWS transport instead of
the loopback.

---

## Part C — testing

### C1. First-connect checks (5 minutes)

On the **panel** (Node-RED editor → Cloud Gateway tab → debug
sidebar):

- Within ~30s of restart, "gateway heartbeat" fires with
  `heartbeat: "queued"` and the config versions.
- The next "gateway telemetry" (up to 10 min) shows
  `transport_mode: "aws"` and `connected: true`, outbox draining to 0.
- If `transport_mode` is still `"loopback"`, the debug's status shows
  *why* (config unreadable, certs missing). If `"aws"` but
  `connected: false`, see Troubleshooting.

In the **AWS console** (same region):

- **IoT Core → All devices → Things**: `bt-c1001-s01-p01` exists, with
  attributes `customer_id/site_id/panel_id/hw_serial`, a certificate
  attached, and `bt-panel-policy` on that certificate.
- **IoT Core → MQTT test client → Subscribe to a topic**: subscribe to
  `dt/#`. Within one flush interval you should see:
  - `dt/c1001/s01/p01/tel` — heartbeat
    (`{timestamp, fwVersion, configVersions}`) and telemetry batches
    (`{timestamp, interval_min: 10, joints: {J01: {dt_min, dt_max,
    dt_avg, ror_max, t_max, ambient}, ...}}`)
  - timestamps are edge UTC — the time the panel *built* the message.

### C2. Alarm path test

1. On the panel dashboard, lower a threshold temporarily (e.g. set the
   default profile's deltaT watch just below a joint's current ΔT) —
   or warm a sensor.
2. MQTT test client on `dt/c1001/s01/p01/alarm`: an
   `{action: "RAISE", joint_id, level, kpi, value, threshold,
   persistence_min, absolute_temp_c, ...}` message appears when the
   alarm raises locally (after its persistence time).
3. Restore the threshold; a `{action: "CLEAR", ...}` follows when it
   clears locally. Exactly one RAISE and one CLEAR — no repeats while
   the alarm stays active (that's the on-state-transition policy).

### C3. Security check (2 minutes, once)

In the MQTT test client, try publishing to another panel's topic name
from the console (that's allowed — the console uses your admin
credentials). Then confirm isolation from the device side: the panel's
policy only permits its own namespace, so if you ever see a panel
publish outside `dt/c1001/s01/p01/*`, the policy attachment is wrong.
Also confirm the panel connects **only** with client ID
`bt-c1001-s01-p01` — a second MQTT client using the same cert but a
different client ID must be refused.

### C4. Link-loss & recovery drills (these feed the combined soak)

**Short pull (~1 h):**
1. Unplug the panel's WAN/router uplink (leave the panel itself up).
2. Debug sidebar: `connected: false`; outbox `telemetry` count starts
   growing (~6/h plus 1 heartbeat/h); local HMI/historian/alarms keep
   working untouched.
3. Replug. Expect: reconnect within ≤300s (jittered backoff),
   `connected: true`, outbox draining at ≤5 msg/s to 0, and the
   MQTT test client showing the held messages arrive with their
   **original** edge timestamps (no data invented, none lost).

**Router reboot:** power-cycle the router; the panel must reconnect by
itself (same expectations, shorter gap).

**Unclean-disconnect / LWT check:** pull the panel's Ethernet cable
(or power) abruptly. On `dt/c1001/s01/p01/tel` the broker publishes
`{"lwt": true, "thing_name": "bt-c1001-s01-p01"}` within roughly the
keep-alive window (≤ ~7.5 min at 300s keep-alive). A graceful
`systemctl restart nodered` should NOT produce an LWT.

**24 h pull (the soak's centerpiece):** same as the short pull, left
for 24 h. Watch outbox bytes stay far below the 200 MB cap
(~300 bytes × ~168 messages/day ≈ 50 KB/day — enormous headroom), and
full drain on reconnect. Alarms raised while offline must arrive as
queued RAISE/CLEAR pairs in order (alarm class drains first).

Run C1+C2 checks daily during the 24 h soak window against the
historian: for a handful of joints, compare each interval's
`dt_min/dt_max/dt_avg/t_max` against the historian's raw samples for
the same window.

### C5. Running the combined 24 h soak (mechanically verified)

The repo ships a recorder + verifier so the soak acceptance is checked
by tooling, not eyeballs.

1. **Enable evidence recording** — give Node-RED the env var and
   restart:

   ```bash
   sudo mkdir -p /var/busduct/soak && sudo chown pi:pi /var/busduct/soak
   sudo systemctl edit nodered
   # in the editor add:
   #   [Service]
   #   Environment=BUSDUCT_SOAK_LOG=/var/busduct/soak
   sudo systemctl restart nodered
   ```

   While set, the gateway appends JSON-lines evidence:
   every raw KPI sample entering the batcher (`kpi.jsonl` — the same
   stream the historian consumes, i.e. ground truth), every alarm tap
   (`alarm-taps.jsonl`), every flush status, every message actually
   accepted by AWS (`published.jsonl`, with drain time), and every
   connect/disconnect (`connection.jsonl`). Unset the variable (and
   restart) after the soak — it's inert then.

2. **Run for 24 h**, performing the C4 drills during the window: at
   least one ~1 h link pull, one router reboot, and (ideally) the
   long pull. Trigger at least one real alarm RAISE/CLEAR (C2) so
   alarm parity isn't vacuous.

3. **Verify**:

   ```bash
   node tools/soak-verify.js /var/busduct/soak
   ```

   PASS means: every published interval's per-joint aggregates
   (dt_min/dt_max/dt_avg, ror_max, t_max, ambient) exactly match a
   recomputation from the raw KPI samples; the published alarm
   RAISE/CLEAR sequence matches the locally-observed transitions in
   order (a trailing still-queued alarm is tolerated, a reorder or
   loss is not); and the report lists each offline window with the
   maximum message hold time — messages held during pulls must appear
   drained with their original edge timestamps. That is the combined
   Slice 5+6 "Done when" in one exit code.

---

## Part D — optional: Basic Ingest (cost optimization, later)

Once telemetry flows, you can bypass broker fan-out charges:

1. **IoT Core → Message routing → Rules → Create rule** named
   `btTelemetry`, SQL
   `SELECT * FROM 'dt/+/+/+/tel'` (adjust when created via Basic
   Ingest the rule receives directly), action = wherever telemetry
   lands (Timestream/S3/Lambda — cloud-side design decision).
2. Flip `topics.use_basic_ingest: true` in the panel's edge config and
   restart Node-RED. The panel now publishes telemetry to
   `$aws/rules/btTelemetry/dt/...` (the rule sees the same inner
   topic); alarms keep normal broker delivery.

Don't enable it before the rule exists — messages published to
`$aws/rules/...` without a matching rule are dropped.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `transport_mode: "loopback"`, reason "no usable edge config" | `/etc/busduct/edge-config.yaml` missing/unreadable or fails validation — the reason string names the missing field |
| `transport_mode: "loopback"`, reason "panel not provisioned" | cert/key/CA files missing at the paths the config names — run B3 |
| `transport_mode: "aws"`, `connected: false`, never connects | Wrong endpoint (must be the `-ats` one, correct region); or cert not ACTIVE; or policy not attached to the cert; or client ID ≠ thing name (`identity.thing_name` typo) |
| Connects, then drops every few seconds | Another client using the same client ID (AWS kicks the older one) — is the panel provisioned twice, or a test client connected as the thing? |
| `provision-panel.js`: "certificate create rejected" | Claim cert inactive, or `bt-claim-policy` not attached to it |
| `provision-panel.js`: "register thing rejected" | Template not Active, name mismatch in `--template=`, or provisioning role missing `AWSIoTThingsRegistration` |
| `provision-panel.js`: "register thing rejected ... To use more than 3 attributes, a thing must have a type specified" | The `bt-panel` thing type is missing (step A4), or the registered template predates `ThingTypeName` — create the thing type and push a new default template version (see A5) |
| `provision-panel.js`: "no response within 30000ms" | Endpoint/port unreachable (firewall must allow outbound TCP 8883), or wrong region endpoint. (Older repo versions also had a subscribe/publish race causing this intermittently — `git pull` if you see it with a reachable endpoint) |
| Telemetry visible in test client but nothing in your data store | That's Part D — the test client shows broker traffic; routing to storage needs an IoT Rule |
| Messages stop after enabling Basic Ingest | `btTelemetry` rule doesn't exist/enabled in that region — flip `use_basic_ingest` back to `false` until it does |

Panel-side logs: `journalctl -u nodered -f` — the gateway never
crashes Node-RED on connection errors (they feed the backoff), so look
at the debug sidebar's `connected` field rather than expecting stack
traces.

---

## Part E — pushing remote config from the cloud (Slice 7)

The panel subscribes to `cmd/{customer}/{site}/{panel}/config` and
acknowledges every push on `cmd/.../config/ack` (QoS 1 through the
outbox, so acks survive link drops). Test from **IoT Core → MQTT test
client**: subscribe to `cmd/C000/S000/P000/config/ack`, then publish to
`cmd/C000/S000/P000/config`.

Envelope:

```json
{
  "request_id": "any-string-echoed-back",
  "user": "who is pushing (lands in the audit trail)",
  "domain": "alarms | modbus_joints | edge",
  "doc": { }
}
```

**1. Telemetry interval (the `edge` domain):**

```json
{ "request_id": "iv-1", "user": "ops", "domain": "edge",
  "doc": { "telemetry_interval_min": 5 } }
```

Applied live (next batch on the new cadence within a minute) and
persisted across restarts. Bounds 1–1440 minutes.

**2. Alarm thresholds (`alarms` domain)** — freely tunable, no
maintenance mode needed. `doc` is a complete cfg/alarms document
(bump `config_domain_versions.alarms` past the applied version or A6
rejects). On accept, the running Alarm Manager evaluates the very next
sample against the new thresholds — alarms raise/clear through their
normal persistence paths (A10), never a mass-clear.

**3. Wiring/commissioning (`modbus_joints` domain)** — gated by **R12**:
rejected with `{"rule":"R12"}` unless the panel is in maintenance mode
(local action: set the `maintenanceMode` global to `true` via the
panel — deliberately not settable from the cloud). On accept the panel
converges exactly like a local apply: decode pipeline rewired,
dashboard tables refreshed, Nano job recompiled and resent only if the
compiled job actually changed.

Every push — accepted or rejected — is acknowledged with either
`applied_versions` or `errors: [{rule, message}]` citing the exact
R/A rule ids, and recorded in the panel's audit trail.

## Part F — certificate rotation (Readiness Workplan Phase 1)

The panel accepts a **new operational certificate** pushed over a
dedicated command channel and switches to it **atomically, with
automatic rollback** if the new cert can't connect — so a
bad/expired/mis-issued cert can never strand the panel offline.

Channel (separate from the config channel above, because rotation is
rarer, connection-affecting and higher-privilege):

- push topic: `cmd/{customer}/{site}/{panel}/cert`
- ack topic:  `cmd/{customer}/{site}/{panel}/cert/ack` (QoS 1 via the
  outbox alarm class)

The per-device policy (`iot-policy-panel.template.json`) already grants
subscribe/receive on `.../cert` and publish on `.../cert/ack`; no new
thing attributes are needed (it reuses customer/site/panel).

Envelope:

```json
{
  "request_id": "rot-2026-07-21-a",
  "user": "who is rotating (audit trail)",
  "certificate": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  "ca": "-----BEGIN CERTIFICATE-----\n...  (optional, usually omitted)",
  "certificate_id": "aws-cert-id (optional, audit only)"
}
```

What the panel does on receipt (all-or-nothing):

1. Validates the PEM. Junk → rejected ack, **no filesystem change**.
2. Backs up the current cert/key (`.bak` beside the live files).
3. Writes the new material atomically (temp file + rename; key `0600`).
4. Reconnects to AWS IoT with the new cert and waits for the broker to
   accept it (default 60s).
5. **Accepted** → commit; ack `result:"applied"` with `certificate_id`.
   **Not accepted** → restore the previous cert/key, reconnect on the
   old cert, ack `result:"rejected"`, `rolled_back:true`, and an
   `errors:[{rule:"CERT", ...}]` explaining the failure.

Every outcome is written to the panel's audit trail (`CERT_ROTATION`).

**Rotation runbook (per panel):**

1. In AWS IoT, create/register the **new** certificate, attach the
   same `bt-panel-policy`, and **attach it to the same thing**
   (a thing may carry several active certs — attach the new one
   *before* rotating so both old and new are valid during the switch).
2. Publish the envelope above to `cmd/{c}/{s}/{p}/cert` (MQTT test
   client, or your fleet tooling). Watch `cmd/.../cert/ack`.
3. On `applied`, **deactivate then delete the old certificate** in AWS
   IoT once you've confirmed telemetry is still flowing on the new one.
4. On `rejected`/`rolled_back`, the panel is still live on the old
   cert — investigate (policy not attached to the new cert? cert not
   attached to the thing? wrong key?) and retry.

Bench/portability note: on the loopback transport (unprovisioned bench,
or the Slice 8 Mosquitto drill without file-based creds) the channel
reports `enabled:false` — rotation only runs on a real MQTT-TLS
transport that reads its credentials from disk.
