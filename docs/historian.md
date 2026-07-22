# Local historian (InfluxDB 1.x)

A local, cloud-independent historian for absolute temperature and the
derived KPIs (ΔT, rate-of-rise, EMA temp, ambient) of every configured
sensor. Full resolution for 7 days, plus automatic daily/weekly/
monthly/yearly trend rollups. This is the "Local services / Historian"
layer of the Edge Cloud Readiness Workplan — zero cloud dependency; it
keeps working with the network unplugged.

The panel already runs **InfluxDB 1.x** (the legacy raw-value pipeline
writes to a `Mecha` database). This historian uses the same engine but
a dedicated **`busduct`** database, so the two never interfere.

## Data model

One measurement, `bt_kpi`, in database `busduct`:

| | |
|---|---|
| **tags** | `sensor_id` (joint id, or `AMBIENT_<n>` for ambient probes), `zone_id`, `slave_id`, `kind` (`joint`\|`ambient`) |
| **fields** | `temp_c` (absolute reading, always); joints also carry `ema_temp_c`, `delta_t_c`, `delta_t_raw_c`, `ror_c_hr`, `ambient_c` |
| **time** | the sample's edge-UTC timestamp |

Points come off the ProcessLogic KPI taps (the same internal bus the
Cloud Gateway consumes). Readings with `sensor_status != "OK"` are
**not** written — a gap marks the outage, and the fault itself is in
the alarm/audit trail — so trend aggregates never get poisoned by
stale/garbage values.

## Retention tiers (the 7-day + trend requirement)

Set up by `tools/influx-setup.influxql`:

| Retention policy | Duration | Granularity | Serves |
|---|---|---|---|
| `raw` (default) | 7 days | every sample | live/7-day view at highest resolution |
| `rollup_1h` | 90 days | 1-hour aggregates | daily & weekly trends |
| `rollup_1d` | ~5 years (1825d) | 1-day aggregates | monthly & yearly trends |

Two continuous queries do the downsampling automatically: `cq_1h`
(raw → `bt_kpi_1h`) and `cq_1d` (`bt_kpi_1h` → `bt_kpi_1d`). Both keep
all tags (`GROUP BY time(...), *`), so every trend can be filtered per
sensor/zone exactly like the raw data. Durations are engineering
defaults — adjust in the setup script if the design chat wants
different windows.

## One-time setup on the Pi

1. Ensure InfluxDB 1.x is installed and running (`sudo systemctl status influxdb`).
2. Create the database, retention policies and continuous queries:

   ```bash
   influx -host 127.0.0.1 -port 8086 < tools/influx-setup.influxql
   ```

3. Add the historian library to Node-RED's `settings.js`
   `functionGlobalContext` (see `settings.js.example`):

   ```js
   busductHistorian: require('/home/pi/busduct-cloud-edge/src/historian/node-red'),
   ```

4. Restart Node-RED and re-import the flow. The **Historian** tab taps
   the KPI stream and writes to `busduct`. Confirm data is landing:

   ```bash
   influx -database busduct -execute 'SELECT count(temp_c) FROM bt_kpi'
   ```

## Reading trends

Pick the retention policy that matches the window you're charting:

```sql
-- Live / last 7 days, full resolution (raw)
SELECT temp_c, delta_t_c, ror_c_hr FROM "raw"."bt_kpi"
WHERE sensor_id='J01' AND time > now() - 7d;

-- Daily / weekly trend (1-hour rollup)
SELECT temp_c_mean, temp_c_max, delta_t_c_max FROM "rollup_1h"."bt_kpi_1h"
WHERE sensor_id='J01' AND time > now() - 30d;

-- Monthly / yearly trend (1-day rollup)
SELECT temp_c_mean, temp_c_max, ror_c_hr_max FROM "rollup_1d"."bt_kpi_1d"
WHERE sensor_id='J01' AND time > now() - 365d;
```

## Visualisation

Two read layers ship, for two audiences:

### In-HMI Trends tab (operators)

A **Trends** dashboard tab in the existing Node-RED HMI — operators
stay in the same UI they use for config and alarms, no separate login.
Two dropdowns:

- **Sensor** — auto-populated from the historian's own `sensor_id` tag
  values (`SHOW TAG VALUES`), refreshed at boot and hourly, so it lists
  exactly what's actually been recorded.
- **Range** — `Live · 7 days (full)` / `Daily · 30 days` /
  `Weekly · 90 days` / `Monthly · 1 year` / `Yearly · 5 years`. Each
  range picks the matching retention tier automatically (raw for 7-day,
  `rollup_1h` for daily/weekly, `rollup_1d` for monthly/yearly).

Selecting either dropdown runs a single on-demand InfluxDB query and
loads the result into **three stacked charts**, grouped by unit so the
scales never fight:

- **Temperature + Ambient (°C)** — absolute joint temperature and its
  ambient reference on one axis;
- **ΔT (°C)** — delta-T (and raw ΔT) on its own chart;
- **Rate of rise (°C/hr)** — RoR on its own chart.

The query/transform logic is pure and unit-tested
(`src/historian/trend-query.js`, `resultsToCharts` splits one query's
rows into the three chart payloads); the
function nodes on the Historian flow tab are thin wrappers over the
`busductHistorian` global. Nothing new to install — it uses the
`influxdb in` (query) node from the `node-red-contrib-influxdb` package
already present for the batch writer.

### Grafana (analysis / engineering)

For rich trending, zoom, and export, **Grafana** pointed at the
`busduct` database is the recommended tool. This repo ships it as
provisioning-as-code (no click-configuration to reproduce), under
`tools/grafana/`:

| File | Copy to |
|---|---|
| `provisioning/datasources/busduct.yaml` | `/etc/grafana/provisioning/datasources/` |
| `provisioning/dashboards/busduct.yaml` | `/etc/grafana/provisioning/dashboards/` |
| `dashboards/busduct-historian.json` | `/var/lib/grafana/dashboards/busduct/` |

Then `sudo systemctl restart grafana-server`. The dashboard
(**BusductTherMo — Historian Trends**, in the *Busduct* folder) has a
`sensor_id` variable and three panels — one per retention tier
(7-day raw, 1-hour rollup, 1-day rollup) — so the daily/weekly/monthly/
yearly views come for free by moving the time picker. Install Grafana
with `sudo apt-get install grafana` if it isn't already on the Pi; it
reads the same InfluxDB the historian writes, no extra credentials on a
default 1.x install.

## Operational notes

- **Flash wear** (a Readiness-Workplan risk): InfluxDB batches writes,
  and the flow uses the *batch* node, so write amplification is modest
  (~10–20 points/s for this panel). For long-lived deployments prefer
  an external USB SSD for `/var/lib/influxdb`, or keep the SD card
  class-10/endurance-grade. The 7-day raw window bounds on-disk size to
  a few hundred MB.
- The historian is independent of the cloud gateway: telemetry to AWS
  is aggregated 10-min batches, while the historian keeps every sample
  locally. They read the same tap but serve different masters.
