#!/usr/bin/env node
'use strict';

/**
 * One-time commissioning helper (Slice 6): performs AWS IoT Fleet
 * Provisioning by claim for this panel, writing the operational
 * certificate/key to the paths the edge config points at.
 *
 * Prerequisites (cloud side - see docs/aws/README.md):
 *   - a provisioning template with the per-device policy attached
 *   - a claim certificate + key authorized for that template
 *   - the panel's edge config yaml written (identity block filled in)
 *
 * Usage:
 *   node tools/provision-panel.js \
 *     --config=/etc/busduct/edge-config.yaml \
 *     --template=bt-panel-provisioning \
 *     --claim-cert=/etc/busduct/claim/claim.pem.crt \
 *     --claim-key=/etc/busduct/claim/claim.pem.key
 *
 * Refuses to run if the operational cert already exists (a panel is
 * provisioned once; re-provisioning is a deliberate cloud-side action,
 * not something to trip over twice) - pass --force to override.
 */

const fs = require('node:fs');
const { loadEdgeConfig } = require('../src/adapters/aws/edge-config');
const { AwsIotTransport } = require('../src/adapters/aws/aws-iot-transport');
const { provisionOverMqtt, writeCredentials } = require('../src/adapters/aws/provisioning');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

async function main() {
  const configPath = arg('config', undefined);
  const templateName = arg('template');
  const claimCert = arg('claim-cert');
  const claimKey = arg('claim-key');
  const force = process.argv.includes('--force');

  if (!templateName || !claimCert || !claimKey) {
    console.error('required: --template=<provisioning template name> --claim-cert=<pem> --claim-key=<pem>');
    process.exit(2);
  }

  const cfg = loadEdgeConfig(configPath);

  if (!force && fs.existsSync(cfg.mqtt.cert_path)) {
    console.error(`${cfg.mqtt.cert_path} already exists - this panel looks provisioned. Pass --force to re-provision.`);
    process.exit(1);
  }

  console.log(`Provisioning ${cfg.identity.thing_name} against ${cfg.mqtt.endpoint} (template: ${templateName})...`);

  const claimTransport = new AwsIotTransport({
    endpoint: cfg.mqtt.endpoint,
    port: cfg.mqtt.port,
    certPath: claimCert,
    keyPath: claimKey,
    caPath: cfg.mqtt.root_ca_path,
    clientId: `provision-${cfg.identity.panel_id}-${Date.now()}`,
    keepAliveSec: 60,
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('could not connect with the claim certificate within 30s')), 30000);
    claimTransport.onConnectionChange((connected) => {
      if (connected) {
        clearTimeout(timer);
        resolve();
      }
    });
    claimTransport.connect();
  });

  try {
    const result = await provisionOverMqtt({
      transport: claimTransport,
      templateName,
      identity: cfg.identity,
    });

    writeCredentials({
      certPath: cfg.mqtt.cert_path,
      keyPath: cfg.mqtt.key_path,
      certificatePem: result.certificatePem,
      privateKey: result.privateKey,
    });

    console.log(`Thing registered: ${result.thingName} (certificate ${result.certificateId})`);
    if (result.thingName !== cfg.identity.thing_name) {
      console.warn(
        `WARNING: template returned thing name '${result.thingName}' but edge config says '${cfg.identity.thing_name}' - align the template or the config before connecting.`
      );
    }
    console.log(`Credentials written: ${cfg.mqtt.cert_path}, ${cfg.mqtt.key_path} (0600)`);
    console.log('Restart Node-RED to bring the gateway up on the AWS transport.');
  } finally {
    claimTransport.close();
  }
}

main().catch((err) => {
  console.error('Provisioning FAILED:', err.message);
  process.exit(1);
});
