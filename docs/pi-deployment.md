# Deploying this repo to the Raspberry Pi (Node-RED 4.x)

So far only `flows/flows_BBT.json` has been imported into Node-RED (via
the editor's Import menu). That's not enough on its own: the two
refactored function nodes now `require()` a library
(`src/config-service/`) that has to exist on disk on the Pi, plus its
`config/schemas/*.json` files and its own npm dependencies (`ajv`,
`ajv-formats`). This is a one-time setup, then a short update routine
each time the repo changes.

## 1. One-time setup: get the repo onto the Pi

SSH into the Pi, then clone the repo. This repo's active branch is
`claude/code-handoff-strategy-y551k2` (not yet merged to a default
branch), so clone that branch explicitly:

```bash
cd ~
git clone -b claude/code-handoff-strategy-y551k2 https://github.com/brahmadeomk/BBT.git busduct-cloud-edge
cd busduct-cloud-edge
```

For a private repo this prompts for credentials. A Personal Access Token
(https://github.com/settings/tokens, `repo` read access) as the password
works and is what the panels use today.

> **A more secure option, documented but not currently adopted.** A PAT in
> a remote URL is stored in plaintext in `.git/config`, shows in
> `git remote -v`, and lands in shell history. A read-only SSH **deploy
> key** avoids that: it is scoped to one repository, cannot push, and is
> revoked on its own. **§1a** below is the full procedure if and when you
> want to move to it — nothing in the rest of this guide depends on it.

## 1a. Secure pull: a read-only SSH deploy key (optional, not yet adopted)

The panel only ever *pulls*. Making the credential read-only enforces the
standing rule (*"Never modify the production Pi directly - changes flow
repo → tested → deployed"*) at the credential layer: the Pi **cannot**
push, even by accident, even if someone commits on it.

Do all of this on the Pi, as the user that owns the clone (`pi`).

### 1. Generate a key for THIS panel

```bash
ssh-keygen -t ed25519 -N "" -C "busduct deploy - panel p01" -f ~/.ssh/busduct_deploy
chmod 700 ~/.ssh && chmod 600 ~/.ssh/busduct_deploy
```

**One key per panel**, never a shared fleet key — a stolen or
decommissioned panel is then revoked on its own, without a site visit to
every other panel to re-key them.

**No passphrase** (`-N ""`) is deliberate: the pull is run by a
technician over SSH and there is nobody to type a passphrase at boot. The
protection is that the key is read-only, scoped to one repo, and `0600`
on a device that already holds AWS operational certificates under the
same filesystem permissions. A passphrase you have to store on the same
disk to be usable is not protection.

### 2. Register it on the repository (not on your account)

```bash
cat ~/.ssh/busduct_deploy.pub
```

GitHub → the **repository** → **Settings → Deploy keys → Add deploy key**.
Title it after the panel (`panel-p01-pi`), paste the public key, and
**leave "Allow write access" UNCHECKED**.

> Deploy keys are **Settings → Deploy keys on the repo**, not
> **Settings → SSH keys on your account**. The account page is the one
> that grants everything you can reach; that is the mistake to avoid.
>
> A given key can be a deploy key on **only one repository** in all of
> GitHub. If you ever add a second repo, generate a second key.

### 3. Pin GitHub's host key before the first connection

Otherwise the first `git pull` asks *"Are you sure you want to continue
connecting?"* and whoever is at the keyboard says yes to whatever
answered — which is exactly the moment a man-in-the-middle wants. Fetch
the real host keys over TLS instead of trusting the prompt:

```bash
curl -sS https://api.github.com/meta \
  | python3 -c "import json,sys; [print('github.com', k) for k in json.load(sys.stdin)['ssh_keys']]" \
  >> ~/.ssh/known_hosts
sort -u -o ~/.ssh/known_hosts ~/.ssh/known_hosts
chmod 644 ~/.ssh/known_hosts
```

`api.github.com` is authenticated by TLS, so this is a trustworthy
channel for the keys — unlike the interactive prompt, which is trust-on-
first-use.

### 4. Tell SSH to use that key for GitHub

```bash
cat >> ~/.ssh/config <<'EOF'

Host github-busduct
  HostName github.com
  User git
  IdentityFile ~/.ssh/busduct_deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
```

**`IdentitiesOnly yes` is not optional.** Without it SSH offers every key
it can find, GitHub authenticates as whichever one it recognises first,
and you silently end up connected as something other than the deploy key
— including, on a machine that has one, your personal key with write
access. That is the failure that quietly undoes this whole section.

### 5. Verify, then switch the remote

```bash
ssh -T github-busduct
```

Expect: `Hi brahmadeomk/BBT! You've successfully authenticated, but
GitHub does not provide shell access.` The repo name in that greeting
confirms you are on the **deploy key**; a greeting with your *username*
means SSH picked your personal key and step 4 is wrong.

```bash
cd ~/busduct-cloud-edge
git remote set-url origin github-busduct:brahmadeomk/BBT.git
git remote -v          # both lines must show github-busduct:
git pull
```

For a fresh clone, use the same alias:

```bash
git clone -b claude/code-handoff-strategy-y551k2 \
    github-busduct:brahmadeomk/BBT.git busduct-cloud-edge
```

### 6. Confirm it is genuinely read-only

Worth doing once, so you know the guarantee is real rather than assumed:

```bash
git push origin HEAD          # must fail
```

Expect `ERROR: The key you've loaded ... has read-only access`. If it
*succeeds*, the "Allow write access" box was ticked — remove the key on
GitHub and add it again unticked.

### Revoking a panel

GitHub → repo → **Settings → Deploy keys → Delete** the panel's key. That
takes effect immediately and affects nothing else. Do this when a panel is
decommissioned, when an SD card is replaced or discarded, or if anyone
outside the team has had physical access to the Pi — the private key is
readable to anyone who can mount that card.

### What not to do

- **Don't** put a PAT in the remote URL
  (`https://ghp_xxx@github.com/...`). It is stored in plaintext in
  `.git/config`, appears in `git remote -v` output, and lands in shell
  history and any screenshot of the terminal.
- **Don't** copy your own `~/.ssh/id_ed25519` to the Pi. A panel in a
  plant room would then hold a credential for every repository you can
  reach, and revoking it locks *you* out too.
- **Don't** reuse one deploy key across panels. Revocation stops being
  possible without re-keying the fleet.
- **Don't** run `git pull` as root. The clone is owned by `pi`; a
  root-owned object dropped into `.git/` breaks later pulls in ways that
  are annoying to unpick.


Install the Node.js dependencies (`ajv`/`ajv-formats` - pure JS, no
native builds needed, so this works fine on the Pi's ARM CPU):

```bash
npm ci
```

Optional but recommended - confirm everything actually works on this
machine before wiring it into Node-RED:

```bash
npm run ci
```

You should see all tests pass (711 at last count) and the
cloud-agnostic check print OK.

## 2. Create the config store directory

The config service writes to `/var/busduct/cfg` by default. Create it
and make sure the user Node-RED runs as can write to it (usually `pi`,
but check with `ps aux | grep node-red` if unsure):

```bash
sudo mkdir -p /var/busduct/cfg /var/busduct/outbox
sudo chown pi:pi /var/busduct/cfg /var/busduct/outbox
```

(`/var/busduct/outbox` is the Cloud Gateway's disk-backed
store-and-forward queue — Slice 5. Harmless if created before that
flow version is deployed.)

## 3. Bootstrap the migrated config (first time only)

The migration tool (`tools/migrate-legacy-config.js`) only produces
files in the repo (`config/examples/migrated_modbus_joints.json`,
`migrated_alarms.json`) - it doesn't touch the live config store. Until
something has actually been applied to `/var/busduct/cfg`, the
dashboard's "Apply Config" button will fail with *"No cfg/modbus
applied yet - run the migration/commissioning step first"*. Apply the
already-migrated config once, from the Pi:

```bash
node tools/apply-migrated-config.js
```

This refuses to run a second time if `/var/busduct/cfg` already has an
applied config (so it can't accidentally clobber real edits made
through the dashboard afterward) - it's a one-time bootstrap, not
something to re-run routinely.

## 4. Wire the library into Node-RED's settings.js

Open Node-RED's `settings.js` (usually `~/.node-red/settings.js`) and
add a `functionGlobalContext` entry pointing at the path you cloned to
in step 1 - see `src/config-service/node-red/settings.js.example` in
this repo for the exact snippet. Using the path from step 1, the
`require()` line is:

```js
busductConfigService: require('/home/pi/busduct-cloud-edge/src/config-service/node-red'),
busductCloudGateway: require('/home/pi/busduct-cloud-edge/src/cloud-gateway/node-red'),
```

If `settings.js` already has a `functionGlobalContext` block, add these
as more keys inside it rather than replacing the block.

## 5. Restart Node-RED (not just Deploy)

`functionGlobalContext` entries are `require()`'d once when
`settings.js` loads at Node-RED **startup**. A plain Deploy in the
editor does not pick this up:

```bash
sudo systemctl restart nodered
```

(or `node-red-stop && node-red-start` if that's how it's installed -
check with `systemctl status nodered` first to see which applies.)

## 5b. Two RS-485 segments

Setup for a second Nano lives with the things it configures, not here:

- **Stable device names + hub-port mapping**:
  `deploy/udev/99-busduct-nano.rules` — install instructions and this panel's
  verified port mapping are in that file's header.
- **Per-segment USB recovery**: `BUSDUCT_UHUBCTL_BUS2` in
  `/etc/busduct/nodered.env`, plus the matching scoped sudoers line — see
  `deploy/sudoers.d/busduct-nodered`.
- **Replacing a dead Nano**: `docs/nano-replacement.md`.

## 5c. Wi-Fi screen helper (optional, for panels that join Wi-Fi on site)

The paths below are relative to the repo, so start by going there and
pulling — `install` reports *"cannot stat 'deploy/bin/busduct-wifi'"* if you
run it from your home directory or before the file has been pulled.

```bash
cd ~/busduct-cloud-edge
git pull

sudo install -o root -g root -m 0755 deploy/bin/busduct-wifi /usr/local/sbin/busduct-wifi
sudo cp deploy/sudoers.d/busduct-nodered /etc/sudoers.d/busduct-nodered
sudo chmod 440 /etc/sudoers.d/busduct-nodered
sudo visudo -cf /etc/sudoers.d/busduct-nodered      # must print "parsed OK"

# confirm it works before touching the dashboard:
sudo /usr/local/sbin/busduct-wifi scan | head        # should list networks
```

Needs NetworkManager (`nmcli`), the default on Raspberry Pi OS Bookworm and
later. Without the helper installed, the **Slave Config → Wi-Fi Network** screen
still loads and says what is missing rather than failing silently. Rationale for
the wrapper: `docs/security-hardening.md` §2b.

## 6. Re-import the latest flow

The function node bodies in `flows/flows_BBT.json` have changed since
you first imported it (the Config Manager / JointMasterBackEndNode
refactor, plus the bug fixes from live testing). In the Node-RED
editor: Menu → Import → select `flows/flows_BBT.json` from the cloned
repo → import, replacing the existing flow (or importing over the
same tabs) → Deploy.

## 7. Verify

- Open the joint configuration table - existing joints should load.
- Press "Add Joint" - a new blank editable row should appear immediately.
- Open the alarm/threshold configuration screen - the current
  deltaT/ror/persistence values should load (not blank).
- Save/apply a change on each and confirm it's accepted (or, for an
  intentionally bad value, that it's rejected with a clear error).
- Open the new **Modbus Settings** group (same "Joint Config" dashboard
  tab): the bus parameters and all commissioned slaves should load,
  with their display names — one row per channel (the current panel's
  units are all single-channel, so one row each). Apply a harmless
  change (e.g. rename a sensor) — it should succeed *without*
  disturbing live polling; a real change (e.g. baud or a slave's unit
  address) should trigger a Nano job resend. To commission a
  multi-channel unit, use **+CH** on its row (same unit address,
  next channel, its own base address; model/words/scale/poll must
  match across the unit's rows). **The old "Parameter – Modbus
  Configuration" and "Comm Parameters" screens have been removed from
  the flow** — the new table is the only commissioning path, so verify
  it loads correctly immediately after importing this flow version.
  (The "Slave Config" dashboard tab keeps the Read/Transfer selector
  and the SLAVE Active status display; the "Communication Settings"
  dashboard tab is gone.)
- In the joint table, each joint now also selects a **Ch**annel of its
  slave. Existing rows default to channel 1. Two joints may share a
  multi-channel slave on different channels; mapping the same slave +
  channel twice is rejected with the conflicting joint named.
- Open the new **Cloud Gateway** flow tab (editor, not dashboard) and
  watch the debug sidebar: "gateway telemetry" fires every 10 minutes
  with `flushed_chunks` ≥ 1 (once sensors are reporting) and outbox
  counts, "gateway heartbeat" fires hourly (and once ~30s after
  startup) with the firmware and applied config versions. The
  telemetry status includes `transport_mode`: `"loopback"` until the
  panel is provisioned against AWS IoT, `"aws"` (plus
  `connected: true/false`) afterwards. If both debugs stay silent, the
  `busductCloudGateway` entry in settings.js (step 4) is missing or
  Node-RED wasn't restarted (step 5). Note this flow version needs
  `npm ci` after pulling (new dependencies: mqtt, js-yaml).

## 8. Connect to AWS IoT (Slice 6, once the AWS account is ready)

Follow `docs/aws/README.md`: an admin registers the per-device policy
+ provisioning template once, then per panel you write
`/etc/busduct/edge-config.yaml` (identity + ATS endpoint), run
`node tools/provision-panel.js --template=... --claim-cert=... --claim-key=...`,
delete the claim material, and restart Node-RED. The gateway detects
the certs at startup and switches from loopback to the AWS transport
automatically — no flow change needed. Verify `transport_mode: "aws"`
and `connected: true` in the "gateway telemetry" debug, and the panel's
messages arriving in AWS IoT Core's MQTT test client.

If something's still wrong, check the Node-RED debug sidebar / log
(`journalctl -u nodered -f` if run as a service) for errors mentioning
`busductConfigService` - that usually means step 4 or 5 wasn't
completed. An error like *"No cfg/modbus applied yet"* means step 3
(bootstrap) wasn't done.

## 9. Remote config channel (Slice 7, after AWS is connected)

After pulling this version: restart Node-RED AND re-import the flow
(library + flow both changed). The Cloud Gateway tab gains a "Remote
Config Setup" node - its debug shows `enabled: true` with the cmd
topic once the panel runs on the AWS transport. Push examples and the
maintenance-mode rule: `docs/aws/README.md` Part E. To allow a remote
wiring change (R12), set the `maintenanceMode` global to `true`
locally (e.g. a temporary inject with a change node, or from the
Settings screen once one exists) and set it back after.

## 10. Local historian (InfluxDB, optional but recommended)

The panel already runs InfluxDB 1.x. To enable the tiered local
historian (7-day full resolution + daily/weekly/monthly/yearly trends):

```bash
influx -host 127.0.0.1 -port 8086 < tools/influx-setup.influxql   # once
```

Add `busductHistorian` to settings.js functionGlobalContext (see
settings.js.example), restart Node-RED, re-import the flow. The
Historian tab then writes bt_kpi points to the `busduct` database, and
a new **Trends** dashboard tab appears in the HMI (Sensor + Range
dropdowns → on-demand chart). Full details, read queries and flash-wear
notes: `docs/historian.md`.

Optional **Grafana** analysis dashboard (provisioning-as-code under
`tools/grafana/`): copy the two provisioning YAMLs to
`/etc/grafana/provisioning/{datasources,dashboards}/` and the dashboard
JSON to `/var/lib/grafana/dashboards/busduct/`, then
`sudo systemctl restart grafana-server`. See `docs/historian.md`
"Visualisation".

## 11. Security hardening (Slice 8a — do this before the pilot)

Full runbook: **`docs/security-hardening.md`**. Three things, none of
which change the flow's behaviour:

1. **Dashboard/kiosk PINs from the environment.** They are no longer in
   the flow export. Copy `deploy/nodered.env.example` to
   `/etc/busduct/nodered.env`, set real values, wire it into the service
   (`systemctl edit nodered` → `EnvironmentFile=`), restart. Gates fail
   closed until set.
2. **Scoped sudo.** Install `deploy/sudoers.d/busduct-nodered`
   (`uhubctl` only, NOPASSWD) and remove any broad `NOPASSWD: ALL` for
   the Node-RED user.
3. **Secure the editor.** Add `adminAuth` (bcrypt) to `settings.js`
   (snippet in `settings.js.example`), optionally TLS or loopback-only.

After re-importing this flow version, verify each dashboard gate denies
access with no PIN set and admits with the correct PIN once configured.

## Updating later

Whenever this repo changes (new commits pushed):

```bash
cd ~/busduct-cloud-edge
git pull
npm ci   # only needed if package.json/package-lock.json changed
sudo systemctl restart nodered
git show --stat HEAD          # did flows/flows_BBT.json change?
```

**If `flows/flows_BBT.json` is in that list you MUST re-import it in the
Node-RED editor.** A `git pull` updates the repo working copy; Node-RED
runs from its *own* copy (`~/.node-red/flows_<hostname>.json`), so pulling
alone changes nothing you can see. Menu → Import → select
`flows/flows_BBT.json` from the cloned repo → import over the existing
tabs → Deploy → reload the dashboard page in the browser.

The two halves update independently and both are needed:

| What changed | What updates it |
|---|---|
| anything under `src/` | `git pull` + **restart** Node-RED (a Deploy does not re-`require()` the library) |
| `flows/flows_BBT.json` (flow wiring, function node bodies, dashboard `ui_template` markup/CSS) | **re-import** the file in the editor + Deploy |

A symptom of skipping the re-import is a dashboard that shows *some* of a
change but not all of it — e.g. new column headers appear (they came with an
earlier import) while a newly added button does not.

### Deploying the cloud message contract + device health (2026-08-27)

This release changes what the panel PUBLISHES, so the order matters more
than usual. Do the AWS step first.

**Step 0 — push the AWS policy BEFORE the code.** The LWT moved to a new
`status/{c}/{s}/{p}` topic, and AWS IoT authorises the will topic as part
of establishing the connection. In AWS IoT → Security → Policies →
`bt-panel-policy` → *Create new version* from the current
`docs/aws/iot-policy-panel.template.json` (REGION/ACCOUNT_ID replaced) →
set it **active**. Skipping this no longer takes the panel dark - it
falls back to connecting without a will - but you get a degraded panel
and a warning on every flush until you fix it.

**Step 1 — pull and restart.**

```bash
cd ~/busduct-cloud-edge
git pull
sudo systemctl restart nodered      # NOT just a Deploy - new modules under src/
```

**Step 2 — re-import the flow.** `flows/flows_BBT.json` changed: three new
nodes on the **Cloud Gateway** tab ("device health (60s)" → "Publish
Device Health" → debug). Menu → Import → the repo's
`flows/flows_BBT.json` → Deploy.

#### Verify, in the order that isolates faults

1. **The library loaded.** The "Publish Device Health" node's status line
   should read something like `20/20 live | bus1:ok | changed` within ~35 s
   of the deploy. `lib not loaded - RESTART Node-RED` means step 1's
   restart did not happen (or `settings.js` is missing the entry).

2. **A message is actually queued.** Its debug output shows
   `device_health: "changed"` on the first tick.

3. **It goes QUIET.** Watch the next few ticks: they must report
   `"unchanged"`. If every 60 s tick says `"changed"` on a calm panel,
   something volatile is leaking into change detection - that is a bug,
   not a quirk, and it would publish 60× more than intended.

4. **`bus1:ok`, not `unknown`.** `unknown` after a minute of running means
   the tracker is seeing no frames - check the Blacklist Engine node.
   On a two-segment panel both buses must appear.

5. **It reacts to a real fault.** Unplug one sensor. Within ~3 failed
   polls the status line drops to `19/20 live` and a new message goes out
   naming the device by its commissioned address. Plug it back in: after
   the probe backoff it returns to `20/20 live`. This is the same drill as
   the blacklist verification above, now visible from the cloud.

6. **It reaches AWS.** In the IoT MQTT test client subscribe to
   `dt/+/+/+/tel` and confirm a `{"type":"device_health","v":1,...}`
   message. Also subscribe to `status/+/+/+` - it should be silent while
   the panel is up.

7. **The LWT is on its new topic.** Pull the panel's Ethernet abruptly;
   within ~7.5 min (300 s keep-alive) `status/{c}/{s}/{p}` gets
   `{"type":"lwt","v":1,"thing_name":"..."}`. A graceful
   `systemctl restart nodered` must NOT produce one.

8. **Check the will was accepted.** In the "gateway flush" debug output,
   an `lwt:` field means the panel connected WITHOUT its will because the
   broker refused it - i.e. step 0 was skipped or the policy version is
   not active. Telemetry is fine; fix the policy and restart. No `lwt:`
   field means all is well.

9. **Field names.** In a telemetry message, the per-joint ambient is now
   `amb_avg` (it was `ambient` in keyed mode). Nothing on the panel reads
   it, so this only matters to whoever is building the cloud side.

### Troubleshooting: a dashboard table is blank

A blank Modbus Settings table has two causes that look identical in the
browser — the server having no rows to give, or the rows never reaching the
widget. Don't guess; run the self-test on the Pi:

```bash
cd ~/busduct-cloud-edge && node tools/modbus-settings-selftest.js
```

It runs the exact handler the dashboard calls, against the real applied
config, and prints either the rows it would hand over (→ the problem is
delivery: re-import the flow, Deploy, reload the page, press **RELOAD** on
the card) or the specific config-store failure (→ the blank table is honest).

If the handler itself throws, the error now also appears as a red status on
the `ModbusSettingsBackEndNode` node, in the debug sidebar, and as an alert
on the dashboard card — it is no longer silent.
