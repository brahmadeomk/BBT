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

**Visualisation** (the read layer) is deliberately not built here yet.
The recommended path is Grafana pointed at the `busduct` database (one
dashboard, a variable for `sensor_id`, and a panel per retention
policy), which gives the daily/weekly/monthly/yearly views for free. A
Node-RED `ui_chart` trend screen is the alternative if you want it in
the existing HMI — say the word and it's a small follow-up.

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
