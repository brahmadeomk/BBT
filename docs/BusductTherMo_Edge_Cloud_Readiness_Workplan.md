# (Extracted text of the Edge Cloud Readiness Workplan)

> Source of truth is the `.docx` alongside this file; this is a plain-text
> extraction for grep/diff convenience.

BusductTherMo — Edge Readiness for Cloud Integration
Detailed Work Steps for AWS Integration with a Cloud-Agnostic Architecture
Prepared for: Brahmadeo Kamble, Head of Digital & Industry 4.0, Godrej  |  Version 1.0 (Draft)  |  July 2026
1. Purpose and Scope
This document defines the engineering work required to prepare the BusductTherMo edge node (currently a self-contained system performing data collection, KPI computation, alarming, notification and historian functions) for integration with a cloud platform. The initial target platform is AWS; however, every design decision below is made so that the edge software can be repointed to Azure, GCP, or a private MQTT broker with configuration changes and a thin adapter swap — not a rewrite.
In scope: edge software restructuring, device identity, MQTT topic design, publish policy, offline buffering, remote configuration, and over-the-air (OTA) update readiness. Out of scope: cloud-side services (rules, storage tiering, dashboards), which are covered separately.
2. Cloud-Agnostic Design Principles
The following principles govern all work steps. They ensure AWS is a deployment choice, not an architectural dependency.
Standards only at the wire level: MQTT 3.1.1/5.0 over TLS 1.2+ with X.509 client certificates. Every major cloud IoT platform and every self-hosted broker (EMQX, HiveMQ, Mosquitto) supports this profile.
Provider adapter pattern: all cloud-specific behaviour (endpoints, provisioning API, shadow/twin semantics, OTA job APIs) is isolated in one replaceable module behind an internal interface. Core logic never imports a cloud SDK directly.
Configuration over code: endpoints, topic templates, batch intervals and buffer limits live in the edge configuration file (busduct_edge_config.yaml), never hardcoded.
Neutral payloads: JSON (optionally CBOR later) with self-describing fields and ISO-8601/epoch UTC timestamps generated at the edge. No provider-specific envelope formats in the payload.
Generic config channel first: remote configuration is implemented as a plain cmd/ack topic pair. The AWS Device Shadow is supported as an optional optimisation inside the AWS adapter — the device twin concept exists on Azure too, but the generic channel is what guarantees portability.
Edge autonomy is preserved: alarming, persistence logic and local historian continue to work with zero cloud connectivity. The cloud is an observer and configurator, never in the safety loop.
3. Target Edge Software Architecture
Restructure the edge application into the following layers before any cloud connectivity is added:
Layer
Responsibility
Cloud dependency
Acquisition & KPI engine
Sensor polling, ΔT and Rate-of-Rise computation, threshold and persistence evaluation, alarm state machine (Raise/Clear/ACK).
None
Local services
Historian (full resolution), alarm history, audit trail, local HMI/dashboard.
None
Message composer
Builds neutral JSON payloads: batched telemetry aggregates, alarm event snapshots, heartbeats. Applies size budget (<5 KB).
None
Store-and-forward queue
Disk-backed outbox with priority classes (alarms never dropped) and drain control.
None
Transport abstraction (interface)
publish(topic, payload, qos), subscribe(topic, handler), connection state events.
None
Provider adapter (AWS first)
Implements the transport interface: endpoint, TLS/cert handling, Basic Ingest topic mapping, optional Shadow sync, Fleet Provisioning, IoT Jobs for OTA.
Isolated here only
The provider adapter is the only component replaced when changing cloud vendors. Everything above it is provider-neutral by construction.
4. Detailed Work Steps
Phase 0 — Baseline Assessment and Refactoring (Week 1)
Inventory the current edge codebase: identify where acquisition, alarm logic, notification, and historian functions are coupled. Document all points that would need to publish or receive data externally.
Define the internal transport interface (publish/subscribe/connection-state) and refactor existing internal messaging to use it, with a loopback implementation so behaviour is unchanged.
Freeze a regression baseline: record 1–2 weeks of alarm behaviour, KPI values and historian output from a reference panel. This becomes the acceptance benchmark for every later phase.
Confirm hardware headroom on the edge device (CPU, RAM, flash endurance) for TLS, queueing and OTA. Define minimum spec for future units.
Phase 1 — Device Identity and Provisioning (Weeks 1–2)
Define the identity model: customer_id, site_id, panel_id (short immutable codes) plus hardware serial. Bake into the edge config at commissioning; treat as immutable thereafter.
Generate a unique X.509 device certificate and private key per panel. Keys are generated on-device where hardware allows (never leave the device); otherwise use a controlled provisioning station.
Implement certificate storage with restricted file permissions; plan for a secure element (ATECC608 or TPM) on future hardware revisions.
Build the commissioning workflow for field technicians: enter identifiers, trigger provisioning, verify connectivity — one guided procedure, no manual cloud console steps.
AWS adapter task: implement Fleet Provisioning (claim certificate exchanged for a unique operational certificate). Keep this entirely inside the adapter — Azure DPS or a custom PKI enrolment can replace it later.
Implement certificate rotation support from day one: the device must accept a new certificate pushed via the config/OTA channel and switch atomically with rollback.
Phase 2 — MQTT Client and Topic Structure (Weeks 2–3)
Integrate a standards-based MQTT client library (e.g., Eclipse Paho or equivalent for your runtime). Do not use the AWS IoT Device SDK in core code; if used at all, wrap it inside the AWS adapter.
Implement the topic hierarchy from configuration templates: dt/{customer}/{site}/{panel}/tel, .../alarm, and cmd/{customer}/{site}/{panel}/config with /ack. Resolve identifiers at startup.
Configure TLS 1.2+ mutual authentication, long keep-alive (300 s) and jittered exponential reconnect backoff (2 s to 300 s).
Implement Last Will and Testament (LWT) on the connection so the cloud can mark a panel offline immediately on ungraceful disconnect — this is standard MQTT and fully portable.
AWS adapter task: optional mapping of the telemetry topic onto Basic Ingest ($aws/rules/...) for messaging-cost savings. The core code publishes to the logical topic; the adapter rewrites it. On another provider the adapter simply passes the topic through.
Phase 3 — Publish Policy: Batching and Alarm Events (Weeks 3–4)
Implement telemetry aggregation: per configurable interval (default 10 min), compute min/max/avg ΔT, max RoR and max temperature per joint, plus ambient, and publish one JSON message per panel at QoS 0.
Enforce a payload size budget (default 4,800 bytes) with automatic key-shortening; log a warning if a payload ever exceeds the budget.
Implement alarm event publishing on state transition only (RAISE, CLEAR, ACK) at QoS 1, carrying joint, level, KPI, value, threshold and persistence context.
Implement a lightweight heartbeat (hourly) so the cloud distinguishes a quiet panel from a dead one.
Validate against the Phase 0 baseline: cloud-received alarm sequence must match local alarm history exactly; aggregate telemetry must reconcile with the local historian.
Phase 4 — Store-and-Forward Resilience (Weeks 4–5)
Implement a disk-backed outbox with two priority classes: alarms (never dropped) and telemetry (drop-oldest on overflow). Default cap 200 MB.
Stamp every payload with edge UTC event time; the cloud must never rely on broker receive time.
Implement controlled drain on reconnect (default 5 msg/s) to avoid reconnection storms after a site-wide outage.
Test systematically: pull the network for 1 hour, 24 hours, and 7 days; verify ordering, no alarm loss, correct timestamps, and graceful queue overflow behaviour.
Phase 5 — Remote Configuration with Local Validation (Weeks 5–6)
Implement the generic config channel: subscribe to cmd/.../config, apply, and respond on cmd/.../config/ack with applied version or rejection reason.
Enforce local validation before apply: threshold ranges and ordering (Watch < Warning < Critical), RoR time-window limits, persistence-time ordering. The edge is the final authority on safety-relevant limits.
Apply configuration atomically with a version number; reject stale or duplicate versions; keep last-known-good for corrupt-config recovery at boot.
Write every remote change into the existing BusbarTherm audit trail (before/after, source, timestamp) so the current audit capability extends seamlessly to remote changes.
AWS adapter task (optional): mirror the same config state through the Device Shadow for offline-sync convenience. The shadow is an optimisation; the cmd/ack channel remains the portable contract.
Phase 6 — OTA Update Readiness (Weeks 6–8)
Implement an A/B (dual-bank) update scheme or equivalent with automatic rollback on failed boot or failed health check.
Require signed update packages; verify the signature on-device before applying. Keep the signing infrastructure provider-neutral (plain code-signing keys, not a cloud-proprietary format).
Define the update trigger as a generic job message on the cmd channel (package URL + hash + signature). AWS adapter maps this to AWS IoT Jobs; other providers map to their equivalent or a plain HTTPS pull.
Stagger rollouts: never update all panels of a site simultaneously; verify one panel's health before proceeding.
Phase 7 — Pilot, Parallel Run and Rollout (Weeks 8–12)
Retrofit one production panel end-to-end (Phases 1–5) and run it in parallel with the unchanged local system for at least 3–4 weeks.
Compare daily: alarm-for-alarm parity with local history, telemetry reconciliation, MQTT message counts versus cost model, buffer behaviour during real network events.
Run a portability drill before scaling: point the pilot panel at a local Mosquitto/EMQX broker using only configuration changes and the generic adapter. If anything breaks, a hidden AWS dependency has leaked into core code — fix it now, not after 50 sites.
Template the validated configuration and commissioning procedure; then scale site by site.
5. Portability Decision Summary
Capability
Portable mechanism (core)
AWS-specific optimisation (adapter only)
Connectivity
MQTT 3.1.1/5.0 + TLS 1.2 + X.509 mutual auth
AWS IoT Core endpoint
Telemetry ingest
Plain topic dt/{c}/{s}/{p}/tel
Basic Ingest topic rewrite for cost
Offline detection
MQTT LWT + hourly heartbeat
AWS lifecycle events
Remote config
cmd/config + cmd/config/ack with versioning
Device Shadow mirror
Provisioning
X.509 enrolment workflow (PKI)
Fleet Provisioning API
OTA updates
Signed package + generic job message
AWS IoT Jobs orchestration
Payload format
Neutral JSON, edge UTC timestamps
None required
Rule of thumb: if a feature appears in the right-hand column, it must live only inside the provider adapter and be removable without touching core logic.
6. Acceptance Criteria (Exit Checklist)
Alarm parity: 100% match between cloud-received alarm events and local alarm history over the full pilot period.
Autonomy: with the network disconnected for 7 days, local alarming, HMI and historian operate unaffected; on reconnect, all alarm events arrive with correct edge timestamps.
Cost: measured MQTT message volume per panel per day is within the agreed budget (batched telemetry + event-driven alarms + heartbeat only).
Safety of remote config: invalid or mis-ordered thresholds pushed from the cloud are rejected by the edge and reported on the ack channel; audit trail records every accepted change.
Portability drill passed: the panel connects and operates against a non-AWS broker via configuration change only.
OTA: a signed update applies successfully and a corrupted update rolls back automatically.
7. Key Risks and Mitigations
Risk
Impact
Mitigation
Cloud SDK usage leaks into core code
Vendor lock-in; costly rework at provider change
Adapter-only rule enforced in code review; portability drill in Phase 7
Certificate/key compromise at commissioning
Device impersonation
On-device key generation, rotation support, per-device least-privilege policy
Reconnection storms after site outage
Broker throttling, delayed alarms
Jittered backoff + controlled outbox drain rate
Bad config push weakens alarm thresholds
Missed thermal faults
Edge-side validation rules and atomic apply; audit trail
Flash wear from queue writes on long outages
Edge hardware failure
Size-capped outbox, wear-aware write strategy, hardware headroom check in Phase 0

