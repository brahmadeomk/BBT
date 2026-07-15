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

If the repo is private, `git clone` over HTTPS will prompt for
credentials - use a GitHub Personal Access Token as the password (GitHub
no longer accepts account passwords for this). Generate one at
https://github.com/settings/tokens with at least `repo` read access, or
set up an SSH deploy key instead if you prefer `git@github.com:...`
URLs.

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

You should see all tests pass (123 at last count) and the
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

## Updating later

Whenever this repo changes (new commits pushed):

```bash
cd ~/busduct-cloud-edge
git pull
npm ci   # only needed if package.json/package-lock.json changed
sudo systemctl restart nodered
```

Then re-import `flows/flows_BBT.json` in the editor if it changed too
(check `git log --stat -1` after pulling to see which files changed).
