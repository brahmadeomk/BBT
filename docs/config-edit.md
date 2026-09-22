# `config-edit` — editing the panel's configuration from the command line

A testing aid for driving configuration changes without clicking through the
HMI. It reads and writes the same applied configuration the dashboard does.

```bash
cd ~/busduct-cloud-edge
sudo node tools/config-edit.js help
sudo node tools/config-edit.js show
```

`sudo` because `/var/busduct/cfg` is root-owned on most panels. Add
`--root=<dir>` to point at a different store (a copy, or a test panel's).

## The one thing to understand first

**It is not a second way into the configuration.** Every change loads the
applied document, edits it in memory and pushes it through the same
`validateModbusJoints` + `ConfigStore.applyIfValid` the dashboard calls. A
rejection here is the rejection the dashboard would give, with the same rule id,
and it writes the same audit entry and last-known-good snapshot.

That matters because the panel has been here before: the legacy commissioning
screens were removed in July 2026 for being a second, unvalidated pipeline into
the same hardware. Editing `/var/busduct/cfg/*.json` by hand would recreate that
and would be worse, because it bypasses the schema as well as R1–R17.

## Reading

```bash
sudo node tools/config-edit.js show          # everything applied, as tables
sudo node tools/config-edit.js show --json   # the raw document
```

`show` prints each joint's **effective** alarm profile beside the one stored on
it, so a joint inheriting from its zone does not read as unconfigured:

```
joint  label    slave  ch  zone  profile    effective  ambient  enabled
J01    Riser A  sl01   1   z1    (inherit)  hot_riser           yes
J02             sl02   1   z1    default    default             yes
```

## Changing things

```bash
# joints
joint add J07 --slave=sl03 --channel=2 --zone=z1 --label="Riser bend, above ACB-8"
joint set J07 --zone=z2 --profile=hot_riser
joint del J07

# zones, slaves, buses, the panel ambient
zone set z1 --profile=hot_riser
slave add --unit=12 --bus=bus1 --label=Sensor12
slave set unit:6 --channels=4 --addrs=3,4,5,6
bus  set bus1 --inter-frame=250
ambient set unit:101

# alarm profiles (cfg/alarms), so joints have something to point at
profile set hot_riser --dt=8,12,18 --ror=5,10,20,10 --persist=10,5,2
```

**References.** A slave is `sl06`, `unit:6` or `6`. A sensor (for `--ambient`)
is `sl06:3` or `unit:6:3`; the channel defaults to 1.

**Clearing a field** is `-`: `--profile=-`, `--ambient=-`, `--label=-`.

**Three states, not two**, on a joint's `--profile`:

| | |
|---|---|
| flag omitted, or `--profile=-` | inherit from the joint's zone |
| `--profile=default` | pin the panel-wide set, **overriding** the zone |
| `--profile=hot_riser` | that profile |

## Bigger edits

`export` / `import` is the general escape hatch — dump, edit in an editor, apply
back with full validation. Versions are rewritten on import, so a file exported
at v7 does not fail R11 for not advancing.

```bash
sudo node tools/config-edit.js export /tmp/cfg.json
sudo nano /tmp/cfg.json
sudo node tools/config-edit.js import /tmp/cfg.json
```

## Before you apply

`--dry-run` validates and reports without writing anything — including whether
the change would need a Nano resend:

```bash
sudo node tools/config-edit.js bus set bus1 --inter-frame=250 --dry-run
```

Exit codes: **0** applied, **1** rejected by a rule, **2** a mistake in the
command itself (unknown joint, bad reference).

## What converges by itself, and what does not

A separate process cannot write Node-RED's globals, so three of the dashboard's
side effects do not happen. The tool says which apply to each change.

| | |
|---|---|
| joints, zones, effective profiles | **automatic**, within 10 s ("Publish Applied Joints") |
| the Nano read job | **needs a resend** — the tool tells you, and only when the *compiled* job actually changed |
| legacy decode globals (`SlaveIDList`, `parameterName{i}`) | re-apply the **Modbus Settings** screen once after adding or renaming a slave |
| live alarm thresholds | press **SAVE** on Alarm Config once after a `profile set` |

So a joint, zone or threshold edit is complete when the command returns; a bus
or slave edit is not complete until the flow resends. The dashboard drafts are
not rewritten either, so the **Configuration Status** banner will report drift
against what you changed until the operator next applies that table — expected,
not a fault.

## Deleting things

Deletes refuse by name rather than by rule id, because that tells you what to go
and change first:

```
error: slave sl01 is still mapped to joint(s) J01 - reassign or delete those first
error: slave sl21 is the ambient reference for the panel default - repoint those first
```

The same applies to an alarm profile a zone or joint still uses.
