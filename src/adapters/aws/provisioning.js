'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * AWS IoT Fleet Provisioning by claim (Slice 6): connect once with the
 * shared claim certificate, obtain this panel's own operational
 * certificate, and register the Thing through the provisioning
 * template - all over plain MQTT topics ($aws/certificates/...,
 * $aws/provisioning-templates/...), so no AWS SDK is needed here
 * either.
 *
 * Flow (AWS-documented):
 *   1. publish  $aws/certificates/create/json           {}
 *      accepted -> { certificateId, certificatePem, privateKey,
 *                    certificateOwnershipToken }
 *   2. publish  $aws/provisioning-templates/{t}/provision/json
 *               { certificateOwnershipToken, parameters }
 *      accepted -> { thingName, deviceConfiguration }
 *
 * The operational cert/key are written to the paths the edge config's
 * mqtt section points at (device.pem.crt / private.pem.key), key with
 * mode 0600. Identity parameters sent to the template are the panel's
 * immutable identity block - the template derives the Thing name
 * (bt-{customer_id}-{site_id}-{panel_id}) and attaches the per-device
 * policy (docs/aws/iot-policy-panel.template.json).
 */

const CREATE_TOPIC = '$aws/certificates/create/json';

/**
 * @param {object} opts
 * @param {object} opts.transport - a connected transport (AwsIotTransport dialed with the CLAIM certs)
 * @param {string} opts.templateName
 * @param {{customer_id, site_id, panel_id, hw_serial?, thing_name?}} opts.identity
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{thingName: string, certificateId: string, certificatePem: string, privateKey: string}>}
 */
function provisionOverMqtt({ transport, templateName, identity, timeoutMs = 30000 }) {
  const provisionTopic = `$aws/provisioning-templates/${templateName}/provision/json`;

  const waitFor = (acceptedTopic, rejectedTopic, publishTopic, payload, stage) =>
    new Promise((resolve, reject) => {
      // deliberately NOT unref'd: this timer is what keeps the short-lived
      // commissioning process alive until AWS answers or the timeout rejects
      const timer = setTimeout(
        () => reject(new Error(`${stage}: no response from AWS IoT within ${timeoutMs}ms`)),
        timeoutMs
      );
      transport.subscribe(acceptedTopic, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      transport.subscribe(rejectedTopic, (msg) => {
        clearTimeout(timer);
        reject(new Error(`${stage} rejected: ${JSON.stringify(msg)}`));
      });
      transport.publish(publishTopic, payload, 1).catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

  return waitFor(`${CREATE_TOPIC}/accepted`, `${CREATE_TOPIC}/rejected`, CREATE_TOPIC, {}, 'certificate create').then(
    (cert) =>
      waitFor(
        `${provisionTopic}/accepted`,
        `${provisionTopic}/rejected`,
        provisionTopic,
        {
          certificateOwnershipToken: cert.certificateOwnershipToken,
          parameters: {
            CustomerId: identity.customer_id,
            SiteId: identity.site_id,
            PanelId: identity.panel_id,
            ...(identity.hw_serial ? { SerialNumber: identity.hw_serial } : {}),
          },
        },
        'register thing'
      ).then((registered) => ({
        thingName: registered.thingName,
        certificateId: cert.certificateId,
        certificatePem: cert.certificatePem,
        privateKey: cert.privateKey,
      }))
  );
}

/** Writes the operational credentials where the edge config's mqtt section expects them. Key gets 0600. */
function writeCredentials({ certPath, keyPath, certificatePem, privateKey }) {
  for (const p of [certPath, keyPath]) fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(certPath, certificatePem, { mode: 0o644 });
  fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });
}

module.exports = { provisionOverMqtt, writeCredentials, CREATE_TOPIC };
