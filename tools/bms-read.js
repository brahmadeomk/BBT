#!/usr/bin/env node
'use strict';

// Reads the panel's own Modbus TCP registers over a real socket and prints them
// decoded — the wire-level counterpart to the Diagnostics "BMS Registers" card.
//
// Why this exists: the dashboard card shows what the SERVICE believes it is
// serving. This goes out through TCP and reads back what a gateway would
// actually receive, so a mismatch (or a socket that isn't reachable at all)
// shows up immediately. Run it ON THE PI first: if it works there but not from
// a BMS/laptop, the problem is the network or the master's settings, not us.
//
// Uses the jsmodbus CLIENT — already installed as the server's dependency, so
// there is nothing extra to install (no pymodbus, no modpoll).
//
// Usage:
//   node tools/bms-read.js                    # Tier 1 from the applied config's port
//   node tools/bms-read.js --all              # every mapped register
//   node tools/bms-read.js --start=500 --count=8
//   node tools/bms-read.js --host=192.168.1.110 --port=1502 --unit=1
//   node tools/bms-read.js --watch            # re-read every 2s (heartbeat should tick)
//   node tools/bms-read.js --ack=1            # WRITE 1 to the ACK register (acks all active)

const path = require('node:path');
const { ConfigStore } = require('../src/config-service/store');
const { validateModbusJoints } = require('../src/config-service/validate-modbus-joints');
const { validateAlarms } = require('../src/config-service/validate-alarms');
const { validateIntegration } = require('../src/config-service/validate-integration');
const { buildRegisterMap } = require('../src/integration/register-map');
const { describeImage } = require('../src/integration/describe-image');

function parseArgs(argv) {
  const o = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    o[k] = v === undefined ? true : v;
  }
  return o;
}

/** Modbus reads are unsigned 16-bit; our points are signed. */
const toSigned = (v) => (v > 32767 ? v - 65536 : v);

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = opts.root || '/var/busduct/cfg';

  const store = new ConfigStore({
    root,
    validators: { modbus_joints: validateModbusJoints, alarms: validateAlarms, integration: validateIntegration },
  });
  const integrationDoc = store.readDomain('integration').doc;
  const jointsDoc = store.readDomain('modbus_joints').doc;

  if (!integrationDoc) {
    console.error(`No cfg/integration applied at ${root} - run tools/apply-integration-config.js first.`);
    process.exit(1);
  }
  const map = buildRegisterMap(integrationDoc, jointsDoc);
  if (map.error) {
    console.error(`Cannot build register map: ${map.error}`);
    process.exit(1);
  }

  const host = opts.host || '127.0.0.1';
  const port = Number(opts.port || integrationDoc.modbus_tcp.port);
  const unit = Number(opts.unit || integrationDoc.modbus_tcp.unit_id);

  let modbus, net;
  try {
    net = require('node:net');
    // Resolved from THIS repo's node_modules regardless of the caller's cwd -
    // running `node -e "require('jsmodbus')"` from ~ is the classic false alarm.
    modbus = require(path.join(__dirname, '..', 'node_modules', 'jsmodbus'));
  } catch {
    try { modbus = require('jsmodbus'); } catch {
      console.error('jsmodbus is not installed. On the Pi: cd /home/pi/busduct-cloud-edge && npm i jsmodbus');
      process.exit(1);
    }
  }

  const start = opts.start != null ? Number(opts.start) : 0;
  const count = opts.count != null ? Number(opts.count) : (opts.all ? map.extent : 12);

  console.log(`Reading ${host}:${port} unit ${unit} - registers ${start}..${start + count - 1} (map extent ${map.extent}, tier ${map.exposure_tier})\n`);

  const socket = new net.Socket();
  const client = new modbus.client.TCP(socket, unit);

  const readOnce = async () => {
    // Modbus caps a single read at 125 registers; chunk so --all works.
    const image = {};
    for (let off = 0; off < count; off += 125) {
      const n = Math.min(125, count - off);
      const resp = await client.readHoldingRegisters(start + off, n);
      const values = resp.response.body.values ?? resp.response.body.valuesAsArray ?? [];
      values.forEach((v, i) => { image[start + off + i] = toSigned(v); });
    }
    return image;
  };

  const render = (image) => {
    const d = describeImage(map, image);
    const rows = d.rows.filter((r) => r.addr >= start && r.addr < start + count);
    console.log('  addr  block    point                    raw  value');
    for (const r of rows) {
      console.log(
        `${String(r.addr).padStart(6)}  ${r.block.padEnd(8)} ${r.point.padEnd(20)} ${String(r.raw).padStart(7)}  ${r.value}${r.label ? `   [${r.label}]` : ''}`
      );
    }
  };

  socket.on('error', (e) => {
    console.error(`\nSocket error: ${e.message}`);
    console.error(host === '127.0.0.1'
      ? 'The server is not listening locally. Check: ss -tlnp | grep ' + port
      : 'Cannot reach the panel. Check the IP, the port, and any firewall between the hosts.');
    process.exit(1);
  });

  socket.on('connect', async () => {
    try {
      if (opts.ack != null && opts.ack !== true) {
        const val = Number(opts.ack);
        await client.writeSingleRegister(map.control.ack, val);
        console.log(`Wrote ${val} to the ACK register (${map.control.ack}). ` +
          `Check the HMI Audit page for an entry attributed to BMS.\n`);
      }

      const first = await readOnce();
      render(first);

      const hbAddr = map.tier1.points.find((p) => p.key === 'heartbeat').addr;
      if (hbAddr >= start && hbAddr < start + count) {
        console.log(`\nHeartbeat = ${first[hbAddr]}. Re-reading in 6s to confirm it advances...`);
        await new Promise((r) => setTimeout(r, 6000));
        const second = await readOnce();
        const moved = second[hbAddr] !== first[hbAddr];
        console.log(`Heartbeat = ${second[hbAddr]}  ->  ${moved ? 'OK, the panel is alive' : 'FROZEN - the BMS Refresh tick is not running'}`);
      }

      if (opts.watch) {
        setInterval(async () => {
          const img = await readOnce();
          console.log(`\n--- ${new Date().toISOString()} ---`);
          render(img);
        }, 2000);
        return;
      }
      socket.end();
    } catch (e) {
      console.error(`\nModbus error: ${e.message || JSON.stringify(e)}`);
      socket.end();
      process.exit(1);
    }
  });

  socket.connect({ host, port });
}

main();
