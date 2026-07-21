'use strict';

const { toInfluxPoints } = require('../influx-points');

/**
 * Entry point exposed to Node-RED function nodes via
 * functionGlobalContext as `busductHistorian` (see
 * src/config-service/node-red/settings.js.example) so the Historian
 * tab's "Historian Points" function node stays a thin one-liner.
 */
module.exports = { toInfluxPoints };
