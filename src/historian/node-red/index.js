'use strict';

const { toInfluxPoints } = require('../influx-points');
const {
  RANGES,
  DEFAULT_RANGE,
  CHART_GROUPS,
  buildTrendQuery,
  resultsToCharts,
  sensorOptionsFromTagValues,
} = require('../trend-query');

/**
 * Entry point exposed to Node-RED function nodes via
 * functionGlobalContext as `busductHistorian` (see
 * src/config-service/node-red/settings.js.example) so the Historian
 * and Trends tab function nodes stay thin one-liners:
 *   - toInfluxPoints  : write side (KPI tap -> bt_kpi points)
 *   - buildTrendQuery / resultsToCharts / sensorOptionsFromTagValues :
 *     read side for the in-HMI Trends screen.
 */
module.exports = {
  toInfluxPoints,
  RANGES,
  DEFAULT_RANGE,
  CHART_GROUPS,
  buildTrendQuery,
  resultsToCharts,
  sensorOptionsFromTagValues,
};
