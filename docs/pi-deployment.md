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

### Find the real settings.js first

`~/.node-red/settings.js` is only right if you are logged in as the user
Node-RED runs as. **Panels in the field are not all the same**: some run
Node-RED as `pi` (`/home/pi/.node-red/settings.js`), others as **root**
(`/root/.node-red/settings.js`). Editing the wrong one is a silent no-op —
the entries are simply never loaded, and the symptom is a function node
throwing *"Cannot read properties of undefined"*.

```bash
ps -o user= -C node-red                       # who runs it
sudo systemctl show -p User --value nodered   # or, if it is a systemd unit
sudo lsof -p "$(pgrep -n node-red)" 2>/dev/null | grep settings.js   # definitive
```

Set these once and every command below works on either layout:

```bash
NR_USER=$(ps -o user= -C node-red | head -1)
NR_HOME=$(getent passwd "$NR_USER" | cut -d: -f6)/.node-red
echo "$NR_USER -> $NR_HOME"
```

### Add the entries

Open `$NR_HOME/settings.js` and add a `functionGlobalContext` entry
pointing at the path you cloned to in step 1 — see
`src/config-service/node-red/settings.js.example` in this repo for the
exact snippet. **The `require()` path is the CLONE path**, not the
Node-RED user's home, and the two are unrelated: a Node-RED running as
root reads a clone under `/home/pi` perfectly well. Using the path from
step 1:

```js
busductConfigService: require('/home/pi/busduct-cloud-edge/src/config-service/node-red'),
busductCloudGateway: require('/home/pi/busduct-cloud-edge/src/cloud-gateway/node-red'),
```

If `settings.js` already has a `functionGlobalContext` block, add these
as more keys inside it rather than replacing the block.

> **If Node-RED runs as root**, note what that costs before the pilot: the
> scoped sudoers rule in §11 grants nothing root does not already have, so
> that control is inert, and the editor on :1880 becomes a root-level
> surface — `adminAuth` is then the only thing standing in front of
> arbitrary root code execution, not a second layer. Moving the service to
> an unprivileged user is the fix; it is a change to the service unit and
> the ownership of `/var/busduct`, so it belongs in a maintenance window,
> not mid-session. See `docs/security-hardening.md` §2.

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

## 12. The panel HMI (kiosk)

> ### New panel? Do §12f and stop.
>
> **`§12f` is the standard build.** It installs a supervised kiosk that already
> carries everything the rest of this section was written to discover — the lean
> flag set, `--incognito`, the RAM disk cache, no `--no-sandbox`, no
> `--force-device-scale-factor`, the splash dropped once the browser paints, and
> `Restart=always` so the HMI cannot be exited onto the desktop. A new device
> needs no tuning pass and no measurements.
>
> **§12a–§12e are for panels already in service** that were set up by hand
> before §12f existed, and for diagnosing a panel that is slow *despite* §12f.
> They record how each setting was arrived at, including the two occasions this
> project reached a confident wrong answer. Also relevant on an existing panel:
> **`inter_frame_ms`** is the single biggest lever on Node-RED's CPU and is not
> a kiosk setting at all — see §12g.

Observed live 2026-09-08: the HMI was noticeably faster in an ordinary Pi browser
window than in kiosk mode. That is backwards — kiosk renders *less* than a
windowed browser — so it points at the launch configuration rather than at kiosk
itself. On the 71-device panel Chromium was measured at **~125 % CPU across four
processes**, against Node-RED's ~23 %, so the browser is the larger consumer.

Ordered by effect. **Measure `chromium` in `top` before and after each step** —
this project has repeatedly found the obvious explanation to be the wrong one.

### 12a. Two flags that cause almost every "kiosk is slow" case

> **CORRECTION 2026-09-09 — the first bullet is wrong on these panels, and was
> never measured.** `--incognito` was tried live and **improved** HMI
> responsiveness. The reasoning below is sound in general and is why it was
> written, but it weighs only one side: it counts the lost cache and ignores
> what the persistent profile *costs* on a Raspberry Pi. The profile lives on
> the SD card, and Chromium writes to it continuously — `Cookies`, `History`,
> `Favicons` and the cache index are SQLite databases, plus session-restore
> state and the dashboard's own `localStorage`. SD cards are poor at exactly
> that kind of small random write. On a panel that boots rarely and then runs
> for months, paying a one-off cold-cache cost at boot to avoid months of
> profile I/O is the better trade, and the panel's own measurement says so.
>
> Keep the reasoning in mind for the *shader* cache specifically: the first
> paint after a boot or a kiosk respawn is genuinely slower. If a panel
> respawns often that cost is paid often — which is an argument for fixing the
> respawns, not for the persistent profile.
>
> `--disable-gpu` (the second bullet) is untouched by this and remains a real
> problem when present.

- ~~**`--incognito`, or a throwaway `--user-data-dir`**~~ — see the correction
  above. The original reasoning, kept because the shader-cache half still
  applies: no disk cache and no GPU shader cache, so every dashboard asset
  re-fetches and the compositor recompiles shaders on each start.
- **`--disable-gpu`** (often with `--disable-software-rasterizer` or
  `--disable-gpu-compositing`) — all compositing falls to the CPU. On a Pi
  redrawing 70+ table rows that is a large hit, and it is a flag people add to
  silence an unrelated startup warning.

If either is present, switching to `--start-fullscreen` will be **exactly as
slow** — and would give up the kiosk lockdown for nothing (see §11: the
`BUSDUCT_KIOSK_PIN` exit gate only means anything while kiosk is the locked
state).

### 12a-bis. The actual panel script (2026-09-09) — neither usual suspect present

The launch script in service is:

```bash
/usr/bin/feh --fullscreen --auto-zoom --hide-pointer /home/pi/Desktop/GODREJ.png &
FEH_PID=$!
sleep 30
/usr/bin/chromium --no-sandbox --disable-pinch --noerrdialogs --disable-infobars \
  --kiosk --force-device-scale-factor=1 http://127.0.0.1:1880/ui
kill $FEH_PID
```

**No `--incognito`, no `--disable-gpu`** — so §12a does not explain this panel,
and the slowness has a different cause. Four findings, in order of confidence.

**1. `--force-device-scale-factor=1` is the leading suspect for the speed
difference, and it is testable in a minute.** Raspberry Pi OS sets a display
scale factor on many panels. Forcing it to 1 makes CSS pixels equal physical
pixels, so the dashboard lays out at the panel's full resolution instead of the
scaled one — a larger logical viewport, more paint area, and more of a 70-row
table on screen at once. A browser opened from the desktop menu carries no such
flag and gets the scaled viewport. **Check: is the kiosk's text visibly smaller
than the desktop browser's?** If yes, that is the mechanism. Drop the flag and
compare `chromium` in `top`.

**2. The comparison itself may not be measuring two browsers.** There is no
`--user-data-dir`, so the kiosk uses the **default profile** — and Chromium is
single-instance per profile. Opening the desktop browser while the kiosk is
running can hand the URL to the *existing* kiosk process rather than starting a
new one. Before trusting any kiosk-vs-browser comparison, confirm with
`pgrep -c chromium` that the kiosk process is actually stopped.

**3. `--no-sandbox` is a security hole and should go.** It disables the renderer
sandbox, so any browser-side compromise reaches the `pi` user directly. It is
almost always added to work around running Chromium as **root**; the fix is to
run the kiosk as the `pi` user and drop the flag, not to keep it. This sits
directly against Slice 8a (§11), which hardened this panel's access control.

**4. `feh` never exits during the session.** `kill $FEH_PID` runs only after
Chromium *exits*, so a fullscreen image viewer holds its decoded bitmap behind
the browser for the entire life of the panel. It should be killed once the
browser has painted.

Also: `sleep 30` is a fixed guess. If Node-RED has not finished starting,
Chromium loads an error page and stays on it until someone notices.

### 12b. A leaner launch line

```bash
chromium-browser --kiosk --noerrdialogs --disable-infobars   --user-data-dir=/home/pi/.config/chromium-kiosk   --disk-cache-dir=/dev/shm/chromium-cache --disk-cache-size=33554432   --enable-low-end-device-mode   --process-per-site --renderer-process-limit=2   --disable-background-networking --disable-component-update   --disable-default-apps --disable-extensions --disable-sync   --disable-session-crashed-bubble --no-first-run   --force-device-scale-factor=1   http://localhost:1880/ui
```

What each group is for:

| Flags | Why |
|---|---|
| persistent `--user-data-dir`, **no** `--incognito`, **no** `--disable-gpu` | the two causes above |
| `--disk-cache-dir=/dev/shm/...`, `--disk-cache-size=32M` | cache in RAM, not on the SD card. The card already carries the historian, the outbox and the context store; browser cache writes are pure wear for data that is cheap to refetch. Lost on reboot, which is rare |
| `--enable-low-end-device-mode` | Chromium's own reduced-memory profile — smaller caches, fewer background features |
| `--process-per-site`, `--renderer-process-limit=2` | the four Chromium processes seen in `ps` are per-renderer/utility; a single-page kiosk does not need them |
| `--disable-background-networking`, `--disable-component-update`, `--disable-sync`, `--disable-default-apps`, `--disable-extensions` | a panel HMI has no use for update checks, sync or the extension host |
| `--force-device-scale-factor=1` | avoids a scaling pass on every frame |

`--single-process` is deliberately **not** listed: it lowers memory but is the
least-tested Chromium path and a renderer crash takes the whole browser with it.
Not a trade to make on an HMI that must stay up. `--no-sandbox` is likewise
absent on purpose — see §12a-bis item 3.

### 12b-bis. The panel script, rewritten

```bash
#!/bin/bash
set -u
SPLASH=/home/pi/Desktop/GODREJ.png
URL=http://127.0.0.1:1880/ui

/usr/bin/feh --fullscreen --auto-zoom --hide-pointer "$SPLASH" &
FEH_PID=$!

# Wait for Node-RED to actually answer rather than guessing 30 s: too short
# loads an error page that stays there, too long is dead time on every boot.
for _ in $(seq 1 90); do
  curl -sf -o /dev/null "$URL" && break
  sleep 1
done

/usr/bin/chromium \
  --user-data-dir=/home/pi/.config/chromium-kiosk \
  --disk-cache-dir=/dev/shm/chromium-cache --disk-cache-size=33554432 \
  --enable-low-end-device-mode \
  --process-per-site --renderer-process-limit=2 \
  --disable-background-networking --disable-component-update \
  --disable-default-apps --disable-extensions --disable-sync \
  --disable-session-crashed-bubble --no-first-run \
  --disable-pinch --noerrdialogs --disable-infobars \
  --kiosk "$URL" &
CHROMIUM_PID=$!

# Drop the splash once the browser has painted, NOT when it exits.
sleep 8
kill "$FEH_PID" 2>/dev/null

wait "$CHROMIUM_PID"
```

Changed from the original: **`--no-sandbox` removed** (run this as `pi`, not
root, or it will not start), **`--force-device-scale-factor=1` removed** (test it
first — if the HMI is then too small for the panel, put it back and accept the
cost, or set the display scale properly instead), a **dedicated profile** so the
kiosk and any desktop browser are genuinely separate processes, the **cache in
`/dev/shm`** so browser writes stop adding SD wear, a **readiness poll** instead
of `sleep 30`, and **`feh` killed once the browser is up**.

Change one thing at a time and measure `chromium` in `top` between each —
this project has repeatedly found the obvious explanation to be the wrong one,
and a batch of five changes tells you nothing about which one mattered.


### 12c. Free wins outside the browser

`ps` on both panels showed a full LXDE desktop running behind the kiosk:

- **`orca`** — the GNOME screen reader, measured at **5.5 % CPU**. A panel HMI has
  no use for it: `sudo apt-get purge orca`, or disable it in the session.
- **`lxpanel-pi`**, `pcmanfm` desktop, and other session pieces — a kiosk needs an
  X server and a browser, not a desktop environment. Removing the panel and
  desktop from the session removes their CPU, their memory and their redraws.
- Check `dtoverlay=vc4-kms-v3d` is present in `/boot/firmware/config.txt`, or
  Chromium has no GL to accelerate with regardless of its flags.

### 12d. What has already been done on the page side

These are in the flow and need no Pi change — listed so the same ground is not
covered twice:

- the Diagnostics table is **not built at all** while its page is closed, and its
  rows carry ~4× fewer Angular watchers (no `ng-model` per cell, device state
  precomputed server-side);
- the audit viewers are capped at **20 rows**, sorted server-side rather than by
  an `orderBy` filter re-running on every digest;
- Node-RED itself went from ~106 % to ~23 % of a core.

---

### 12e. Step-by-step tuning runbook

Every step is one change with a measurement either side, and every step is
revertible. **Run these on the Pi.** Over SSH, export the display first or
nothing will launch:

```bash
export DISPLAY=:0
export XAUTHORITY=/home/pi/.Xauthority
```

#### Step 0 — a measurement you can repeat

```bash
cat >> ~/.bashrc <<'RC'
kiosk_cpu() {
  sudo top -b -n 4 -d 3 \
  | awk '/chromium/{c+=$9} /node-red/{n+=$9} END{printf "chromium %.1f%%  node-red %.1f%%\n", c/4, n/4}'
}
RC
source ~/.bashrc
kiosk_cpu          # <- write this number down. It is the baseline.
```

**Let a freshly-launched browser settle for three minutes before measuring.**
Measured 45 s after launch on ESBUSBBT06, Chromium read 122-127 % and Node-RED
70-76 %; the same panel's long-running kiosk read 62 % and 44 %. Nothing had
changed — 45 s in, the browser is still parsing and laying out the page and the
dashboard websocket is still replaying widget state, so the number is the
startup transient, not the cost you are trying to reduce. Comparing two cases
measured the same way is still valid, but the effect you are hunting can be
buried under a transient twice its size, and the absolute figure cannot be
compared with the baseline from Step 0.

Back the script up before touching it:

```bash
KIOSK=/home/pi/kiosk.sh                       # adjust to the real path
cp "$KIOSK" "$KIOSK.bak-$(date +%F)"
```

#### Step 1 — make sure the kiosk-vs-browser comparison is real

With no `--user-data-dir`, Chromium is single-instance per profile, so a
desktop browser can attach to the kiosk's process instead of starting its own.

```bash
pkill -f 'chromium.*--kiosk'
sleep 3

# 1a. anything still running on the kiosk command line?
pgrep -af 'chromium.*--kiosk'

# 1b. how many actual BROWSERS are up?
pgrep -af chromium | grep -v -- '--type='
```

**Both must print nothing.** Do not count processes with `pgrep -c chromium`:
one Chromium is normally 5-10 processes (browser, GPU, zygote, a renderer per
site), so a count can never tell one browser from two. Only the top-level
browser process lacks a `--type=` argument — that is the one to count, which is
what 1b does. An earlier revision of this runbook said `pgrep -c chromium`
"must print 0"; on a healthy panel it prints 9 and the check reads as a failure
when nothing is wrong.

If 1b lists a line, a browser is still up — usually the desktop one opened for
the comparison. Close it and re-check.

If 1a comes back populated a few seconds after the `pkill`, something is
respawning the kiosk, and that must be stopped first or every A/B below
measures a process you did not launch:

```bash
systemctl list-units --type=service | grep -i kiosk
ls /etc/xdg/autostart /home/pi/.config/autostart 2>/dev/null
grep -rl kiosk /etc/xdg/lxsession /home/pi/.config/lxsession* 2>/dev/null
```

#### Step 2 — test the scale factor (the hypothesis with a mechanism)

No file edits; run each by hand and measure.

```bash
# A: as it runs today
/usr/bin/chromium --no-sandbox --disable-pinch --noerrdialogs --disable-infobars \
  --kiosk --force-device-scale-factor=1 http://127.0.0.1:1880/ui &
sleep 180; kiosk_cpu
pkill -f 'chromium.*--kiosk'; sleep 3

# B: same, without the scale factor
/usr/bin/chromium --no-sandbox --disable-pinch --noerrdialogs --disable-infobars \
  --kiosk http://127.0.0.1:1880/ui &
sleep 180; kiosk_cpu
pkill -f 'chromium.*--kiosk'; sleep 3
```

**If B is materially lower, that is the answer.** If B's text is then too small
to read at the panel, set the display scale properly instead of forcing it in
the browser — that gets both. If A and B are the same, the scale factor is not
it: say so, and go to Step 3 without pretending otherwise.

**Result on ESBUSBBT06 (2026-09-09): no effect.** A 122.4 % / B 126.5 % —
B slightly *higher*, i.e. inside the noise of a 12-second sample. The flag was
the hypothesis with a plausible mechanism (forcing a non-native scale makes the
compositor rescale every frame, and with no GL acceleration that lands on the
CPU), and it was wrong. It is kept in the script, since removing it changes the
text size at the panel and buys nothing.

#### Step 3 — dedicated profile and a RAM cache

```bash
mkdir -p /home/pi/.config/chromium-kiosk
/usr/bin/chromium --no-sandbox --disable-pinch --noerrdialogs --disable-infobars --kiosk \
  --user-data-dir=/home/pi/.config/chromium-kiosk \
  --disk-cache-dir=/dev/shm/chromium-cache --disk-cache-size=33554432 \
  http://127.0.0.1:1880/ui &
sleep 180; kiosk_cpu
```

The first run is slower — the profile and cache are cold. **Measure the second
run**, and check the SD write rate has dropped: `vmstat 2 5`, `bo` column.

#### Step 4 — the lean flag set

```bash
pkill -f 'chromium.*--kiosk'; sleep 3
/usr/bin/chromium --no-sandbox --disable-pinch --noerrdialogs --disable-infobars --kiosk \
  --user-data-dir=/home/pi/.config/chromium-kiosk \
  --disk-cache-dir=/dev/shm/chromium-cache --disk-cache-size=33554432 \
  --enable-low-end-device-mode --process-per-site --renderer-process-limit=2 \
  --disable-background-networking --disable-component-update \
  --disable-default-apps --disable-extensions --disable-sync \
  --disable-session-crashed-bubble --no-first-run \
  http://127.0.0.1:1880/ui &
sleep 180; kiosk_cpu
pgrep -af chromium | grep -c -- '--type='   # helper count should fall too
```

#### Step 5 — drop `--no-sandbox` (security, not speed)

Find out why it is there:

```bash
ps -o user= -p "$(pgrep -f 'chromium.*--kiosk' | head -1)"
```

`root` means the flag is a workaround for running as root. Run the kiosk as
`pi` and remove the flag. If it prints `pi` already, just remove it — omit
`--no-sandbox` from the Step 4 line and confirm the browser still starts.

#### Step 6 — install the rewritten script

Take §12b-bis, keeping whichever flags Steps 2–5 actually justified, then:

```bash
sudo systemctl restart lightdm     # or reboot
sleep 180; kiosk_cpu
```

Revert at any point with `cp "$KIOSK.bak-<date>" "$KIOSK"`.

#### Step 7 — the desktop pieces behind the kiosk

```bash
ls /etc/xdg/autostart/ | grep -i orca
sudo mkdir -p /etc/xdg/autostart.disabled
sudo mv /etc/xdg/autostart/orca-autostart.desktop /etc/xdg/autostart.disabled/
```

Reversible by moving it back. Confirm GL is available while you are here:

```bash
grep -n vc4 /boot/firmware/config.txt
```

Then reboot and take a final `kiosk_cpu`. Compare against Step 0 — if the total
improvement is small, **say so and stop**; the remaining cost is the dashboard
itself, and §12d lists what has already been done there.

### 12f. Making the kiosk un-exitable (supervised launch)

Everything above is about making the kiosk *fast*. This section is about making
it **stay**, which is a different problem and, on the panels as shipped, a more
serious one.

**The hole.** The launcher in service ends when the browser ends — `kill
$FEH_PID` is the line after the `chromium` invocation, so it runs only once
Chromium has exited. Alt+F4, a renderer crash or the OOM killer therefore leaves
the operator on the LXDE desktop with `pcmanfm`, a terminal, and the Node-RED
editor on :1880. Note what this does to §11: the `BUSDUCT_KIOSK_PIN` exit gate
is not *defeated* here, it is **bypassed** — nobody guessed the PIN, the
application simply stopped existing. A PIN gate is only as good as the
guarantee that the gated thing is what is on screen.

**The fix is supervision, not a better browser flag.** Three files:

| file | installs to | does |
|---|---|---|
| `deploy/bin/busduct-kiosk` | `/usr/local/bin/` | launches the browser, waits for the dashboard to answer, drops the splash once painted |
| `deploy/busduct-kiosk.service` | `/etc/systemd/system/` | `Restart=always` — the part that matters |
| `deploy/xorg.conf.d/10-busduct-kiosk.conf` | `/etc/X11/xorg.conf.d/` | closes Ctrl+Alt+F1..F6 and Ctrl+Alt+Backspace |

```bash
sudo install -m 0755 deploy/bin/busduct-kiosk /usr/local/bin/busduct-kiosk
sudo cp deploy/busduct-kiosk.service /etc/systemd/system/
sudo install -d /etc/X11/xorg.conf.d
sudo cp deploy/xorg.conf.d/10-busduct-kiosk.conf /etc/X11/xorg.conf.d/

# REMOVE THE OLD AUTOSTART FIRST or two browsers race for the display:
grep -rl kiosk /etc/xdg/autostart /home/pi/.config/autostart \
               /etc/xdg/lxsession /home/pi/.config/lxsession* 2>/dev/null

sudo systemctl daemon-reload
sudo systemctl enable --now busduct-kiosk
```

**Test it the way an operator would attack it**, not by reading the unit file:

```bash
pkill -f 'chromium.*--kiosk'     # must come back within ~2 s
sudo systemctl status busduct-kiosk
```

**Four things the new launcher changes on purpose**, each reversible:

- **`--incognito` is on.** Measured live 2026-09-09 to improve responsiveness —
  the opposite of what §12a predicted, and the correction there explains why
  (the persistent profile's SD-card writes cost more than the cached assets
  save). `BUSDUCT_KIOSK_INCOGNITO=0` restores a persisting profile.

- **`--no-sandbox` is gone.** The unit runs as `pi`, and that flag is almost
  always a workaround for running Chromium as root. It disables the renderer
  sandbox, so a browser-side compromise reaches the account directly (§11).
- **`--force-device-scale-factor=1` is not passed.** §12a-bis finding 1 names it
  the leading suspect for the kiosk being slower than a desktop window. This is
  the one change that alters what the operator *sees* — text size changes. Set
  `BUSDUCT_KIOSK_SCALE=1` in `/etc/busduct/kiosk.env` to restore the old
  behaviour exactly.
- **The splash is killed once the browser paints**, not when it exits — §12a-bis
  finding 4. `feh` was holding a decoded fullscreen bitmap for the life of the
  panel.

**Before you install the Xorg file, confirm you can get in without the screen.**
With `DontVTSwitch` on and the kiosk respawning, a panel whose HMI is broken is
genuinely awkward to recover from the front. SSH is the normal route and
`sudo systemctl stop busduct-kiosk` drops you to the desktop — verify both
*first*. Also check the session is actually Xorg (`loginctl show-session
$XDG_SESSION_ID -p Type`); on a Wayland session the file does nothing.

**Stronger options, not adopted here.** If the lockdown needs to be structural
rather than configured, `cage` (a Wayland kiosk compositor) runs exactly one
application with no window manager and no key bindings to disable, and
`cog`/WPE WebKit renders straight to DRM/KMS with no desktop stack at all — the
latter is also the only option on this list that would meaningfully cut the
browser's ~125 % CPU. Both need evaluating against the AngularJS dashboard on a
real panel before they could be recommended. **And the strongest option remains
the cheapest: a panel with no keyboard attached has no Alt+F4 and no VT switch
to close in the first place.**

### 12g. `inter_frame_ms` — the biggest lever, and it is not a kiosk setting

Applies to **every** panel, new or existing, and it outweighs everything in §12.
On a panel whose HMI is slow, check this **before** touching the browser.

**The trap.** `poll_interval_s` is the number R10 validates and the Modbus
Settings dashboard displays — and it **never reaches the Nano**.
`compileNanoJob` emits `comm = [inter_frame_ms × 1000, baud, timeout_ms]` and
nothing else. So the value that looks like the poll interval does nothing to the
scan rate, and the value that actually sets it is presented as a link-layer
timing detail. Setting `inter_frame_ms` to 20 ms on an 88-device panel pegged
Node-RED's event loop at ~99 % of a core **with no dashboard client attached at
all** (2026-09-09).

Read the applied value, the resulting sweep and the R10 headroom:

```bash
sudo node -e '
const D={poll_interval_s:30,inter_frame_ms:20,temp_word_count:1,channels:1,timeout_ms:1000,retries:2};
const d=require("/var/busduct/cfg/modbus_joints.json");
const m=d.modbus||d, slaves=m.slaves||[], buses=m.buses||[];
const span=s=>{const w=s.registers?.temp_word_count??D.temp_word_count;const a=s.registers?.channel_addrs;
  return (Array.isArray(a)&&a.length)?Math.max(...a)-Math.min(...a)+w:(s.channels??D.channels)*w;};
const frame=(b,s)=>{const i=b.inter_frame_ms??D.inter_frame_ms;
  return (b.type!=="rtu"||!b.baud)?i:i+(13+2*span(s))*(11/b.baud)*1000;};
for(const b of buses){
  const bs=slaves.filter(s=>s.bus_id===b.bus_id); if(!bs.length) continue;
  const sum=bs.reduce((t,s)=>t+frame(b,s),0);
  const total=sum+(b.timeout_ms??D.timeout_ms)*(b.retries??D.retries);
  const minPoll=Math.min(...bs.map(s=>(s.poll_interval_s??D.poll_interval_s)*1000));
  console.log(`[${b.bus_id}] inter_frame_ms=${b.inter_frame_ms} slaves=${bs.length} `+
    `sweep=${(total/1000).toFixed(1)}s frames/s=${(1000/(sum/bs.length)).toFixed(1)} `+
    `R10=${total>minPoll?"FAIL":Math.round((1-total/minPoll)*100)+"% headroom"}`);
}'
```

**Choosing a value.** The per-frame cost is `inter_frame_ms + wire time`, and at
9600 baud a 1-register read is ~17 ms on the wire — so 250 → 20 ms is ~7× the
frame rate, not the ~12× the delay alone suggests. Node-RED's CPU scales with
frames/s, so this number sets the panel's whole load.

| devices | `inter_frame_ms` | sweep | verdict |
|---|---|---|---|
| 6 | 500 | ~3.1 s | fine |
| 71 | 250 | ~21.0 s | fine, 30 % R10 headroom |
| 88 | 250 | ~25.5 s | **15 % headroom — near the ceiling** |
| 110 | 250 | ~31.4 s | **fails R10**; needs ≤ 237 ms or a longer poll interval |

Faster than ~150 ms buys nothing physically: a busduct joint is a thermal mass,
the RoR EMA runs on a 20-minute tau and ΔT persistence is in minutes. A 21 s
sweep already gives ~60 samples per RoR window while clearing the constraints
that matter — ambient `maxAgeSec` 60 s, blacklist detection 3 sweeps.

**At ~90 devices on one bus you are near the wall**, and the fix is `bus2`, not a
smaller delay: two Nanos on two ports halve the sweep and restore headroom
(44 + 44 → 13.8 s, 54 %). See §5b. It does **not** cut CPU — two segments at
3.7 frames/s each is 7.4 frames/s of per-message work.

### 12h. Flow-side settings (come with the repo, no Pi change)

These ship in `flows_BBT.json`, so an old panel gets them from a `git pull` plus
a flow re-import (§6) — no configuration:

- **The 1 Hz clock is gone.** Two `ui_text` "Date:" widgets fed by
  `new Date().toLocaleString()` every second. Any push whose value is unchanged
  costs a digest but no repaint; a clock changes every second *by construction*,
  so an idle panel could never go static. Under VNC that was the whole cost —
  the server re-encodes and ships a framebuffer region every second regardless.
- **Six dashboard pushes moved 1 s → 10 s** (Alert list/table/target, download
  button, "Modbus Last Update"). Their data changes on operator edit, not on a
  timer. Sub-second dashboard pushes: ~9/s → 3/s.
- The Diagnostics table is not built while its page is closed, its rows carry
  ~4× fewer Angular watchers, and the audit viewers are capped at 20 rows
  (§12d).

---

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

### What a `git pull` never carries (host state)

A pull updates **one directory**: the clone at `~/busduct-cloud-edge`. Everything
the Pi actually boots from lives outside it, and several of those files have a
*source* in this repo under `deploy/` — so a pull updates the source and leaves
the installed copy exactly as it was. Nothing warns you; the panel keeps running
the old one.

The check to run after every pull, alongside "did `flows_BBT.json` change?":

```bash
cd ~/busduct-cloud-edge
git log --stat -1 -- deploy/ src/config-service/node-red/settings.js.example
```

Anything listed there means a host file below needs re-installing.

| Host file | Source in repo | Re-install with |
|---|---|---|
| `$NR_HOME/settings.js` (`/home/pi/…` or `/root/…` — see §4) | `src/config-service/node-red/settings.js.example` | **by hand** — it is an example, never copied over a live file |
| `/etc/busduct/nodered.env` | `deploy/nodered.env.example` | by hand (it holds this panel's real PINs) |
| `/etc/sudoers.d/busduct-nodered` | `deploy/sudoers.d/busduct-nodered` | `sudo install -m 0440 …` |
| `/etc/udev/rules.d/99-busduct-nano.rules` | `deploy/udev/99-busduct-nano.rules` | `sudo cp …` + `udevadm control --reload-rules` |
| `/usr/local/bin/busduct-kiosk` | `deploy/bin/busduct-kiosk` | `sudo install -m 0755 …` |
| `/etc/systemd/system/busduct-kiosk.service` | `deploy/busduct-kiosk.service` | `sudo cp …` + `daemon-reload` |
| `/etc/X11/xorg.conf.d/10-busduct-kiosk.conf` | `deploy/xorg.conf.d/10-busduct-kiosk.conf` | `sudo cp …` |
| `/usr/local/sbin/busduct-wifi` | `deploy/bin/busduct-wifi` | `sudo install -m 0755 …` (§5c — note `sbin`, and it is called through sudo) |

The whole set, safe to re-run on a panel that already has them:

```bash
cd ~/busduct-cloud-edge
sudo install -m 0755 deploy/bin/busduct-kiosk     /usr/local/bin/busduct-kiosk
sudo install -o root -g root -m 0755 deploy/bin/busduct-wifi /usr/local/sbin/busduct-wifi
sudo install -m 0440 deploy/sudoers.d/busduct-nodered /etc/sudoers.d/busduct-nodered
sudo install -d /etc/X11/xorg.conf.d
sudo cp deploy/xorg.conf.d/10-busduct-kiosk.conf  /etc/X11/xorg.conf.d/
sudo cp deploy/udev/99-busduct-nano.rules         /etc/udev/rules.d/
sudo cp deploy/busduct-kiosk.service              /etc/systemd/system/

sudo visudo -cf /etc/sudoers.d/busduct-nodered    # NEVER skip: a bad file locks out sudo
sudo udevadm control --reload-rules && sudo udevadm trigger
ls -l /dev/busduct-bus*                            # both symlinks must appear
sudo systemctl daemon-reload
sudo systemctl restart busduct-kiosk               # only if §12f is installed
```

#### State that has no file in this repo at all

None of this is recoverable from a pull — it is per-panel, and re-imaging a Pi
means recreating it from the sections above:

| What | Where it lives | Section |
|---|---|---|
| `functionGlobalContext` entries (4), `adminAuth`, `credentialSecret` | `$NR_HOME/settings.js` | §4, §11 |
| `EnvironmentFile=/etc/busduct/nodered.env` on the service | `systemctl edit nodered` drop-in | §11 |
| Dashboard/kiosk PINs, `BUSDUCT_UHUBCTL_BUS*`, `BUSDUCT_CERT_ROTATION` | `/etc/busduct/nodered.env` | §11 |
| Kiosk overrides (`BUSDUCT_KIOSK_SCALE`, `…_INCOGNITO`) | `/etc/busduct/kiosk.env` | §12f |
| The applied configuration — including **`inter_frame_ms`**, the single biggest HMI-speed lever | `/var/busduct/cfg/` | §12g |
| Node-RED's running flow | `$NR_HOME/flows_<hostname>.json` | §6 (re-import) |
| AWS operational cert + key | paths in `/etc/busduct/edge-config.yaml` | §8 |
| InfluxDB `busduct` database + retention policies + continuous queries | InfluxDB itself | §10 |
| npm dependencies, and optional `jsmodbus` | `node_modules/` | `npm ci` |
| Desktop pieces removed for speed (orca, LXDE autostart), `dtoverlay=vc4-kms-v3d` | `/etc/xdg/autostart`, `/boot/firmware/config.txt` | §12c, §12e step 7 |
| The old kiosk autostart entry, which must be **removed** or two browsers race | `/etc/xdg/autostart`, `~/.config/lxsession*` | §12f |

Two of these are easy to get wrong on an existing panel:

- **The kiosk-speed work was mostly not settings at all.** The 1 Hz clock removal
  and the six 1 s → 10 s dashboard pushes (§12h) ship *in the flow*, so they
  arrive with a pull **plus a re-import** — a pull alone changes nothing. The
  measured `inter_frame_ms` lever (§12g) is in the config store and is changed
  from the Modbus Settings screen, not from git.
- **`settings.js` is never copied over.** `settings.js.example` gains entries as
  slices land (`busductHistorian`, `busductIntegration`); a panel commissioned
  before one of those was added will not have it, and the symptom is a function
  node throwing *"Cannot read properties of undefined"* rather than anything
  naming the missing entry. Diff them after a pull:

  ```bash
  NR_USER=$(ps -o user= -C node-red | head -1)
  NR_HOME=$(getent passwd "$NR_USER" | cut -d: -f6)/.node-red
  sudo diff <(grep -o 'busduct[A-Za-z]*:' "$NR_HOME/settings.js" | sort -u) \
            <(grep -o 'busduct[A-Za-z]*:' ~/busduct-cloud-edge/src/config-service/node-red/settings.js.example | sort -u)
  ```

  `sudo` because on a root install the file is `0600 root:root` and the
  diff otherwise fails with *"No such file or directory"* — which reads
  like the entries are missing rather than unreadable.

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
