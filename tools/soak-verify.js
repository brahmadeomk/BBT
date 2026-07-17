#!/usr/bin/env node
'use strict';

/**
 * Verifies a recorded soak run (combined Slice 5+6 acceptance).
 *
 * Usage:
 *   node tools/soak-verify.js /var/busduct/soak
 *
 * The directory is the one BUSDUCT_SOAK_LOG pointed at during the run
 * (see docs/aws/README.md, "Running the combined 24h soak"). Exits 0
 * when telemetry aggregates and alarm parity both check out.
 *
 * Lives in /tools (not /test) because `node --test` executes
 * everything under /test - the verification logic itself is
 * src/cloud-gateway/soak-verify.js with unit tests in /test.
 */

const { loadSoakDir, verifySoak } = require('../src/cloud-gateway/soak-verify');

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node tools/soak-verify.js <soak log dir>');
  process.exit(2);
}

const report = verifySoak(loadSoakDir(dir));

console.log('=== Soak verification report ===');
console.log(`Telemetry: ${report.telemetry.intervals} interval(s), ${report.telemetry.joints_checked} joint-aggregate(s) checked -> ${report.telemetry.ok ? 'OK' : `${report.telemetry.mismatches.length} MISMATCH(ES)`}`);
for (const m of report.telemetry.mismatches.slice(0, 10)) {
  console.log(`  MISMATCH ${m.interval} ${m.joint_id}: ${m.diffs.map((d) => `${d.field} expected ${d.expected} got ${d.published}`).join(', ')}`);
}
if (report.telemetry.mismatches.length > 10) console.log(`  ... and ${report.telemetry.mismatches.length - 10} more`);

console.log(`Alarms: ${report.alarms.published}/${report.alarms.expected} transition(s) published in order -> ${report.alarms.ok ? 'OK' : 'FAIL'}`);
if (report.alarms.first_divergence) {
  const d = report.alarms.first_divergence;
  console.log(`  DIVERGENCE at #${d.index}: expected ${d.expected.action} ${d.expected.instanceId}, published ${d.published.action} ${d.published.instanceId}`);
}

console.log(`Link: ${report.link.offline_windows.length} offline window(s); max hold ${Math.round(report.link.max_hold_ms / 1000)}s; ${report.link.held_over_60s} message(s) held >60s then drained`);
for (const w of report.link.offline_windows) console.log(`  offline ${w.from} -> ${w.to} (${w.seconds}s)`);

console.log(`Heartbeats published: ${report.heartbeats}`);
for (const note of report.notes) console.log(`NOTE: ${note}`);

console.log(report.ok ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(report.ok ? 0 : 1);
