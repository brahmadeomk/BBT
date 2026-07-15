# AWS IoT setup (Slice 6)

Cloud-side steps to bring a panel online. Everything device-side is in
this repo; these are the one-time account-level steps an AWS admin
performs, then the per-panel commissioning procedure.

## One-time account setup

1. **Register the per-device policy** (`iot-policy-panel.template.json`):
   replace `REGION`/`ACCOUNT_ID`, then create it as `bt-panel-policy`.
   It locks every panel to its own namespace: client ID must equal its
   thing name, and it can only publish/subscribe on topics derived from
   its own `customer_id/site_id/panel_id` thing attributes.
2. **Register the provisioning template**
   (`provisioning-template.json`) as e.g. `bt-panel-provisioning`,
   with a provisioning role that allows thing/cert/policy attachment.
   Optionally add a pre-provisioning Lambda hook to allow-list
   `SerialNumber` values.
3. **Create a claim certificate**: one cert+key pair authorized ONLY
   for Fleet Provisioning (connect + the `$aws/certificates/create/*`
   and `$aws/provisioning-templates/bt-panel-provisioning/provision/*`
   topics). This claim pair is what commissioning technicians carry;
   it cannot publish telemetry.
4. Note the account's **ATS endpoint**
   (`xxxxxxxx-ats.iot.<region>.amazonaws.com`, IoT Core → Settings).
5. *(Later, optional)* Create the `btTelemetry` IoT Rule and flip
   `topics.use_basic_ingest: true` in the edge config to bypass
   broker fan-out cost for telemetry.

## Per-panel commissioning (on the Pi)

1. Write the panel's edge config (see `docs/busduct_edge_config.yaml`
   for the spec) to `/etc/busduct/edge-config.yaml`, filling in the
   `identity` block (immutable afterwards) and the account's
   `mqtt.endpoint`. Download `AmazonRootCA1.pem` to
   `mqtt.root_ca_path`.
2. Copy the claim cert/key to the panel (e.g. `/etc/busduct/claim/`).
3. Run the commissioning helper:

   ```bash
   node tools/provision-panel.js \
     --template=bt-panel-provisioning \
     --claim-cert=/etc/busduct/claim/claim.pem.crt \
     --claim-key=/etc/busduct/claim/claim.pem.key
   ```

   It connects with the claim cert, obtains this panel's operational
   certificate, registers the Thing
   (`bt-<customer>-<site>-<panel>`), and writes the credentials to the
   paths `mqtt.cert_path`/`mqtt.key_path` point at (key mode 0600).
4. Delete the claim material from the panel, then **restart
   Node-RED**. The Cloud Gateway's `getGateway()` detects the
   provisioned config + certs at startup and comes up on the AWS
   transport instead of the loopback - the "gateway telemetry" debug
   shows `transport_mode: "aws"` and `connected: true`.

If the edge config or certs are missing/invalid, the gateway falls
back to the loopback and the debug's status says why - the panel keeps
running locally exactly as in Slice 5, so a provisioning problem never
takes down monitoring.
