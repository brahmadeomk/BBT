#!/usr/bin/env node
'use strict';

/**
 * Edit the applied configuration from the command line (testing aid).
 *
 * WHY THIS GOES THROUGH THE SAME VALIDATORS AS THE DASHBOARD, AND WHY THAT IS
 * NOT NEGOTIABLE. The legacy "Parameter - Modbus Configuration" screens were
 * removed in 2026-07-14 for being a second, complete, UNVALIDATED pipeline into
 * the same serial-out node: two ways to build a job, only one of which enforced
 * R1-R17. A CLI that wrote /var/busduct/cfg directly would recreate exactly that
 * mistake, and would be worse, because a hand-written file bypasses the schema
 * too. So every mutation here loads the applied document, edits it in memory,
 * and pushes it through `validateModbusJoints` + `ConfigStore.applyIfValid` -
 * the same call the dashboard makes, with the same rule ids in the same errors,
 * the same audit entry and the same LKG snapshot.
 *
 * WHAT IT DOES NOT DO, which matters on a live panel. The dashboard apply has
 * three side effects beyond the store, and a separate process cannot reproduce
 * any of them - Node-RED's globals live in that process's memory:
 *
 *   1. the Nano job resend (per changed bus)
 *   2. the legacy decode-pipeline globals (SlaveIDList, parameterName{i}, ...)
 *   3. the dashboard drafts the tables render from
 *
 * Only the joint stream converges on its own: "Publish Applied Joints" re-reads
 * the applied document every 10 s, so ProcessLogic, the alarm raise path and
 * the config-drift banner all follow a CLI edit with no help. Everything the
 * NANO needs does not. `--after` prints what to do about it; `--resend` will do
 * the Node-RED half over the admin API when it is reachable.
 *
 * That asymmetry is the reason this is labelled a testing aid rather than a
 * second commissioning path: a joint/zone/threshold edit is complete here, a
 * bus or slave edit is not complete until the flow resends.
 *
 * Usage:  node tools/config-edit.js <command> [args] [--root=DIR] [--dry-run]
 *         node tools/config-edit.js help
 */

const fs = require('node:fs');

const { ConfigStore } = require('../src/config-service/store');
const { validateModbusJoints } = require('../src/config-service/validate-modbus-joints');
const { validateAlarms } = require('../src/config-service/validate-alarms');
const { precheckProfiles, buildProfilesDoc } = require('../src/config-service/profile-manager');
const { buildProcessLogicJoints } = require('../src/config-service/process-logic-joints');
const { nanoJobsEqual } = require('../src/config-service/nano-compiler');

const DEFAULT_ROOT = '/var/busduct/cfg';

// ---------------------------------------------------------------- arg parsing
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) flags[a.slice(2)] = true;
      else flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else positional.push(a);
  }
  return { flags, positional };
}

class UserError extends Error {}
const fail = (msg) => { throw new UserError(msg); };

/** `--flag=-` clears a field; absent leaves it alone; anything else sets it. */
const CLEAR = Symbol('clear');
function opt(flags, name) {
  if (!(name in flags)) return undefined;
  const v = flags[name];
  if (v === '-' || v === '' || v === true) return CLEAR;
  return v;
}
function num(flags, name) {
  const v = opt(flags, name);
  if (v === undefined || v === CLEAR) return v;
  const n = Number(v);
  if (!Number.isFinite(n)) fail(`--${name} must be a number, got '${v}'`);
  return n;
}
function list(flags, name, cast = (x) => x) {
  const v = opt(flags, name);
  if (v === undefined || v === CLEAR) return v;
  return String(v).split(',').map((s) => s.trim()).filter(Boolean).map(cast);
}

// ------------------------------------------------------------------ resolving
/** Accepts a slave_id ('sl06') or a unit address ('unit:6' / '6'). */
function resolveSlave(doc, ref) {
  if (!ref) fail('expected a slave reference (sl06, unit:6 or 6)');
  const slaves = doc.modbus.slaves;
  const direct = slaves.find((s) => s.slave_id === ref);
  if (direct) return direct;
  const m = /^(?:unit:)?(\d+)$/.exec(String(ref));
  if (m) {
    const unit = Number(m[1]);
    const hits = slaves.filter((s) => s.unit_address === unit);
    if (hits.length === 1) return hits[0];
    // Unit addresses are unique panel-wide (deliberately stricter than Modbus),
    // so more than one hit means the document is already inconsistent.
    if (hits.length > 1) fail(`unit ${unit} appears on ${hits.length} slaves - the applied document is inconsistent`);
  }
  fail(`no slave '${ref}' - known: ${slaves.map((s) => `${s.slave_id}(u${s.unit_address})`).join(', ') || 'none'}`);
  return null;
}

/** "sl06:2", "unit:6:2" or "sl06" (channel defaults to 1) -> {slave_id, channel}. */
function parseSensorRef(doc, ref) {
  const str = String(ref);
  const m = /^(.*?):(\d+)$/.exec(str.startsWith('unit:') ? str.slice(5) : str);
  const base = m ? (str.startsWith('unit:') ? `unit:${m[1]}` : m[1]) : str;
  const channel = m ? Number(m[2]) : 1;
  return { slave_id: resolveSlave(doc, base).slave_id, channel };
}

// ------------------------------------------------------------------- printing
function pad(s, w) { return String(s ?? '').padEnd(w); }
function table(rows, headers) {
  if (rows.length === 0) return '  (none)';
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (cells) => '  ' + cells.map((c, i) => pad(c, widths[i])).join('  ').trimEnd();
  return [line(headers), '  ' + widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

function showAll(store) {
  const { doc } = store.readDomain('modbus_joints');
  if (!doc) fail(`no applied cfg/modbus+joints at ${store.root} - run tools/apply-migrated-config.js first`);
  const { doc: alarms } = store.readDomain('alarms');

  console.log(`store: ${store.root}`);
  console.log(`versions: modbus v${doc.config_domain_versions.modbus}  joints v${doc.config_domain_versions.joints}` +
    (alarms ? `  alarms v${alarms.config_domain_versions?.alarms}` : '  alarms (none applied)'));

  const amb = doc.modbus.ambient_sensor;
  console.log(`\npanel ambient: ${amb ? `${amb.slave_id}:${amb.channel ?? 1}` : '(none)'}`);

  console.log('\nBUSES');
  console.log(table(doc.modbus.buses.map((b) => [
    b.bus_id, b.type, b.port ?? '', b.baud ?? '', b.parity ?? '', b.stop_bits ?? '',
    b.timeout_ms ?? '', b.retries ?? '', b.inter_frame_ms ?? '',
  ]), ['bus', 'type', 'port', 'baud', 'par', 'stop', 'timeout', 'retry', 'interframe']));

  console.log('\nSLAVES');
  console.log(table(doc.modbus.slaves.map((s) => [
    s.slave_id, s.unit_address, s.bus_id, s.label ?? '', s.model, s.channels ?? 1,
    s.registers.temp_base_addr, (s.registers.channel_addrs ?? []).join('/') || '-',
    s.registers.temp_scale, s.poll_interval_s ?? '',
  ]), ['slave', 'unit', 'bus', 'label', 'model', 'ch', 'base', 'addrs', 'scale', 'poll']));

  console.log('\nZONES');
  console.log(table((doc.zones ?? []).map((z) => [
    z.zone_id, z.name, z.threshold_profile ?? '(none)',
    z.ambient_sensor ? `${z.ambient_sensor.slave_id}:${z.ambient_sensor.channel ?? 1}` : '',
  ]), ['zone', 'name', 'profile', 'ambient']));

  // The effective profile is what actually decides a joint's thresholds, and it
  // is NOT the column the operator edits - so print both, or a joint inheriting
  // from its zone looks unconfigured.
  const effective = new Map((buildProcessLogicJoints(doc).joints ?? []).map((j) => [j.joint_id, j.threshold_profile]));
  console.log('\nJOINTS');
  console.log(table((doc.joints ?? []).map((j) => [
    j.joint_id, j.label ?? '', j.slave_id, j.channel, j.zone_id,
    j.threshold_profile ?? '(inherit)', effective.get(j.joint_id) ?? '(default)',
    j.ambient_sensor ? `${j.ambient_sensor.slave_id}:${j.ambient_sensor.channel ?? 1}` : '',
    j.enabled === false ? 'NO' : 'yes',
  ]), ['joint', 'label', 'slave', 'ch', 'zone', 'profile', 'effective', 'ambient', 'enabled']));

  if (alarms?.profiles) {
    console.log('\nALARM PROFILES');
    console.log(table(Object.entries(alarms.profiles).map(([n, p]) => [
      n, `${p.deltaT?.watch}/${p.deltaT?.warning}/${p.deltaT?.critical}`,
      `${p.ror?.watch}/${p.ror?.warning}/${p.ror?.critical}@${p.ror?.timeWindowMin}m`,
      `${p.persistence?.watchMin}/${p.persistence?.warningMin}/${p.persistence?.criticalMin}m`,
    ]), ['profile', 'deltaT w/w/c', 'ror w/w/c@win', 'persist w/w/c']));
  }
}

// ---------------------------------------------------------------- apply spine
/**
 * The one write path. Loads, hands the caller a mutable copy, bumps both domain
 * versions (R11) and applies. Nothing else in this file touches the store.
 */
function mutate(store, flags, describe, fn) {
  const { doc: current } = store.readDomain('modbus_joints');
  if (!current) fail(`no applied cfg/modbus+joints at ${store.root} - run tools/apply-migrated-config.js first`);
  const { doc: alarmsDoc } = store.readDomain('alarms');

  const next = JSON.parse(JSON.stringify(current));
  fn(next);

  // Both bump: it is one atomic document (same convention as both dashboards).
  next.config_domain_versions = {
    modbus: current.config_domain_versions.modbus + 1,
    joints: current.config_domain_versions.joints + 1,
  };

  const context = { alarmsDoc: alarmsDoc ?? undefined };

  if (flags['dry-run']) {
    const result = validateModbusJoints(next, { applying: true, appliedVersions: current.config_domain_versions, ...context });
    reportValidation(result, describe, true);
    if (result.valid) reportConvergence(current, next, true);
    return result.valid;
  }

  const result = store.applyIfValid('modbus_joints', next, context, flags.user || 'cli');
  if (!result.applied) { reportValidation(result, describe, false); return false; }
  console.log(`APPLIED  ${describe}`);
  console.log(`  versions: modbus v${result.appliedVersions.modbus}  joints v${result.appliedVersions.joints}`);
  for (const w of result.warnings ?? []) console.log(`  WARNING  ${w.rule ?? ''} ${w.message ?? w}`.trim());
  reportConvergence(current, next, false);
  return true;
}

function reportValidation(result, describe, dry) {
  if (result.valid || result.applied) { console.log(`${dry ? 'WOULD APPLY' : 'APPLIED'}  ${describe}`); }
  else {
    console.error(`REJECTED  ${describe}`);
    for (const e of result.errors) console.error(`  ${e.rule}: ${e.message}`);
  }
  for (const w of result.warnings ?? []) console.log(`  WARNING  ${w.rule ?? ''} ${w.message ?? w}`.trim());
}

/** What the running flow will and will not notice. */
function reportConvergence(before, after, dry) {
  const buses = after.modbus.buses.map((b) => b.bus_id);
  const changed = buses.filter((busId) => {
    try { return !nanoJobsEqual(before, after, busId); } catch { return true; }
  });
  const verb = dry ? 'would need' : 'needs';
  if (changed.length === 0) {
    console.log('  the Nano job is unchanged - nothing to resend');
  } else {
    console.log(`  the compiled Nano job CHANGED on ${changed.join(', ')} - this ${verb} a resend:`);
    console.log('    Node-RED editor -> modbusMaster_V2 tab -> click the "Resend Nano Job On Boot" inject');
    console.log('    (and the legacy decode globals - SlaveIDList/parameterName{i} - only rewrite on a');
    console.log('     Modbus Settings APPLY, so re-apply that screen once if you added or renamed a slave)');
  }
  console.log('  joints/zones/profiles converge on their own within 10 s ("Publish Applied Joints").');
}

// ------------------------------------------------------------------- commands
const COMMANDS = {};

COMMANDS['show'] = (store, { flags }) => {
  if (flags.json) {
    const { doc } = store.readDomain('modbus_joints');
    console.log(JSON.stringify(doc, null, 2));
    return true;
  }
  showAll(store);
  return true;
};

COMMANDS['export'] = (store, { positional }) => {
  const [file] = positional;
  if (!file) fail('usage: export <file>');
  const { doc } = store.readDomain('modbus_joints');
  if (!doc) fail('nothing applied to export');
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  console.log(`wrote ${file} (modbus v${doc.config_domain_versions.modbus}, joints v${doc.config_domain_versions.joints})`);
  console.log('edit it, then: node tools/config-edit.js import ' + file);
  return true;
};

COMMANDS['import'] = (store, { positional, flags }) => {
  const [file] = positional;
  if (!file) fail('usage: import <file>');
  const incoming = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Versions are rewritten rather than trusted: an exported file carries the
  // versions it was exported at, and R11 would reject it for not advancing.
  return mutate(store, flags, `import ${file}`, (doc) => {
    for (const k of Object.keys(doc)) delete doc[k];
    Object.assign(doc, incoming);
  });
};

COMMANDS['joint'] = (store, { positional, flags }) => {
  const [sub, id] = positional;
  const findJoint = (doc) => {
    const j = (doc.joints ?? []).find((x) => x.joint_id === id);
    if (!j) fail(`no joint '${id}' - known: ${(doc.joints ?? []).map((x) => x.joint_id).join(', ') || 'none'}`);
    return j;
  };

  if (sub === 'list') { showAll(store); return true; }

  if (sub === 'add') {
    if (!id) fail('usage: joint add <joint_id> --slave=<ref> --channel=N --zone=<zone_id> [--label=] [--profile=]');
    return mutate(store, flags, `add joint ${id}`, (doc) => {
      if ((doc.joints ?? []).some((x) => x.joint_id === id)) fail(`joint '${id}' already exists`);
      const j = {
        joint_id: id,
        slave_id: resolveSlave(doc, flags.slave).slave_id,
        channel: num(flags, 'channel') ?? 1,
        zone_id: flags.zone ?? fail('--zone is required'),
        enabled: true,
      };
      applyJointFlags(doc, j, flags);
      doc.joints = [...(doc.joints ?? []), j];
    });
  }

  if (sub === 'set') {
    if (!id) fail('usage: joint set <joint_id> [--slave=] [--channel=] [--zone=] [--label=] [--profile=|-] [--ambient=|-] [--enabled=]');
    return mutate(store, flags, `set joint ${id}`, (doc) => {
      const j = findJoint(doc);
      if (flags.slave) j.slave_id = resolveSlave(doc, flags.slave).slave_id;
      const ch = num(flags, 'channel'); if (ch !== undefined && ch !== CLEAR) j.channel = ch;
      if (flags.zone) j.zone_id = flags.zone;
      const en = opt(flags, 'enabled');
      if (en !== undefined) j.enabled = !(en === CLEAR || en === 'false' || en === '0');
      applyJointFlags(doc, j, flags);
    });
  }

  if (sub === 'del') {
    if (!id) fail('usage: joint del <joint_id>');
    return mutate(store, flags, `delete joint ${id}`, (doc) => {
      findJoint(doc);
      doc.joints = doc.joints.filter((x) => x.joint_id !== id);
    });
  }

  fail('usage: joint list|add|set|del');
  return false;
};

function applyJointFlags(doc, j, flags) {
  const label = opt(flags, 'label');
  if (label === CLEAR) delete j.label; else if (label !== undefined) j.label = label;

  // Blank/'-' means INHERIT (omit the key). Writing 'default' here is an
  // explicit override that beats the joint's zone - the three-state distinction
  // the dashboard dropdown exposes.
  const profile = opt(flags, 'profile');
  if (profile === CLEAR) delete j.threshold_profile; else if (profile !== undefined) j.threshold_profile = profile;

  const ambient = opt(flags, 'ambient');
  if (ambient === CLEAR) delete j.ambient_sensor;
  else if (ambient !== undefined) j.ambient_sensor = parseSensorRef(doc, ambient);
}

COMMANDS['zone'] = (store, { positional, flags }) => {
  const [sub, id] = positional;
  const findZone = (doc) => {
    const z = (doc.zones ?? []).find((x) => x.zone_id === id);
    if (!z) fail(`no zone '${id}' - known: ${(doc.zones ?? []).map((x) => x.zone_id).join(', ') || 'none'}`);
    return z;
  };
  const applyZoneFlags = (doc, z) => {
    if (flags.name) z.name = flags.name;
    const profile = opt(flags, 'profile');
    if (profile === CLEAR) delete z.threshold_profile; else if (profile !== undefined) z.threshold_profile = profile;
    const ambient = opt(flags, 'ambient');
    if (ambient === CLEAR) delete z.ambient_sensor;
    else if (ambient !== undefined) z.ambient_sensor = parseSensorRef(doc, ambient);
  };

  if (sub === 'list') { showAll(store); return true; }
  if (sub === 'add') {
    if (!id) fail('usage: zone add <zone_id> --name=<name> [--profile=] [--ambient=]');
    return mutate(store, flags, `add zone ${id}`, (doc) => {
      if ((doc.zones ?? []).some((x) => x.zone_id === id)) fail(`zone '${id}' already exists`);
      const z = { zone_id: id, name: flags.name ?? id };
      applyZoneFlags(doc, z);
      doc.zones = [...(doc.zones ?? []), z];
    });
  }
  if (sub === 'set') {
    if (!id) fail('usage: zone set <zone_id> [--name=] [--profile=|-] [--ambient=|-]');
    return mutate(store, flags, `set zone ${id}`, (doc) => applyZoneFlags(doc, findZone(doc)));
  }
  if (sub === 'del') {
    if (!id) fail('usage: zone del <zone_id>');
    return mutate(store, flags, `delete zone ${id}`, (doc) => {
      findZone(doc);
      doc.zones = doc.zones.filter((x) => x.zone_id !== id);
    });
  }
  fail('usage: zone list|add|set|del');
  return false;
};

COMMANDS['slave'] = (store, { positional, flags }) => {
  const [sub, ref] = positional;
  const applySlaveFlags = (doc, s) => {
    const unit = num(flags, 'unit'); if (unit !== undefined && unit !== CLEAR) s.unit_address = unit;
    if (flags.bus) s.bus_id = flags.bus;
    if (flags.model) s.model = flags.model;
    const label = opt(flags, 'label');
    if (label === CLEAR) delete s.label; else if (label !== undefined) s.label = label;
    const ch = num(flags, 'channels'); if (ch !== undefined && ch !== CLEAR) s.channels = ch;
    const poll = num(flags, 'poll'); if (poll !== undefined && poll !== CLEAR) s.poll_interval_s = poll;

    const base = num(flags, 'base'); if (base !== undefined && base !== CLEAR) s.registers.temp_base_addr = base;
    const words = num(flags, 'words'); if (words !== undefined && words !== CLEAR) s.registers.temp_word_count = words;
    const scale = num(flags, 'scale'); if (scale !== undefined && scale !== CLEAR) s.registers.temp_scale = scale;

    const addrs = list(flags, 'addrs', Number);
    if (addrs === CLEAR) delete s.registers.channel_addrs; else if (addrs !== undefined) s.registers.channel_addrs = addrs;
    const labels = list(flags, 'labels');
    if (labels === CLEAR) delete s.registers.channel_labels; else if (labels !== undefined) s.registers.channel_labels = labels;
  };

  if (sub === 'list') { showAll(store); return true; }

  if (sub === 'add') {
    return mutate(store, flags, `add slave unit ${flags.unit}`, (doc) => {
      const used = new Set(doc.modbus.slaves.map((s) => s.slave_id));
      let slaveId = null;
      for (let i = 1; i <= 128 && !slaveId; i += 1) {
        const c = `sl${String(i).padStart(2, '0')}`;
        if (!used.has(c)) slaveId = c;
      }
      if (!slaveId) fail('no free slave_id below sl128');
      const template = doc.modbus.slaves[0];
      const s = {
        slave_id: slaveId,
        bus_id: flags.bus ?? doc.modbus.buses[0].bus_id,
        unit_address: num(flags, 'unit') ?? fail('--unit is required'),
        model: flags.model ?? template?.model ?? 'GENERIC',
        channels: 1,
        poll_interval_s: template?.poll_interval_s ?? 30,
        // function_code is always 3 - the firmware only implements holding-register reads.
        registers: {
          function_code: 3,
          temp_base_addr: template?.registers?.temp_base_addr ?? 3,
          temp_word_count: template?.registers?.temp_word_count ?? 1,
          temp_scale: template?.registers?.temp_scale ?? 0.1,
        },
      };
      applySlaveFlags(doc, s);
      doc.modbus.slaves = [...doc.modbus.slaves, s];
      console.log(`  allocated slave_id ${slaveId}`);
    });
  }

  if (sub === 'set') {
    if (!ref) fail('usage: slave set <sl06|unit:6> [--unit=] [--bus=] [--channels=] [--base=] [--addrs=3,4] [--scale=] [--poll=] [--label=]');
    return mutate(store, flags, `set slave ${ref}`, (doc) => applySlaveFlags(doc, resolveSlave(doc, ref)));
  }

  if (sub === 'del') {
    if (!ref) fail('usage: slave del <sl06|unit:6>');
    return mutate(store, flags, `delete slave ${ref}`, (doc) => {
      const s = resolveSlave(doc, ref);
      // R6/R14 would catch these at validation, but by slave_id; naming the
      // joint or the zone is what tells you where to go and change it first.
      const usedBy = (doc.joints ?? []).filter((j) => j.slave_id === s.slave_id).map((j) => j.joint_id);
      if (usedBy.length) fail(`slave ${s.slave_id} is still mapped to joint(s) ${usedBy.join(', ')} - reassign or delete those first`);
      const ambientUsers = [
        ...(doc.modbus.ambient_sensor?.slave_id === s.slave_id ? ['the panel default'] : []),
        ...(doc.zones ?? []).filter((z) => z.ambient_sensor?.slave_id === s.slave_id).map((z) => `zone '${z.zone_id}'`),
        ...(doc.joints ?? []).filter((j) => j.ambient_sensor?.slave_id === s.slave_id).map((j) => `joint '${j.joint_id}'`),
      ];
      if (ambientUsers.length) fail(`slave ${s.slave_id} is the ambient reference for ${ambientUsers.join(', ')} - repoint those first`);
      doc.modbus.slaves = doc.modbus.slaves.filter((x) => x.slave_id !== s.slave_id);
    });
  }

  fail('usage: slave list|add|set|del');
  return false;
};

COMMANDS['bus'] = (store, { positional, flags }) => {
  const [sub, id] = positional;
  if (sub === 'list') { showAll(store); return true; }
  if (sub !== 'set' || !id) fail('usage: bus set <bus_id> [--baud=] [--parity=] [--stop-bits=] [--timeout=] [--retries=] [--inter-frame=] [--port=]');
  return mutate(store, flags, `set bus ${id}`, (doc) => {
    const b = doc.modbus.buses.find((x) => x.bus_id === id);
    if (!b) fail(`no bus '${id}' - known: ${doc.modbus.buses.map((x) => x.bus_id).join(', ')}`);
    if (flags.port) b.port = flags.port;
    if (flags.parity) b.parity = flags.parity;
    const set = (flag, key) => { const v = num(flags, flag); if (v !== undefined && v !== CLEAR) b[key] = v; };
    set('baud', 'baud'); set('stop-bits', 'stop_bits'); set('timeout', 'timeout_ms');
    set('retries', 'retries'); set('inter-frame', 'inter_frame_ms');
  });
};

COMMANDS['ambient'] = (store, { positional, flags }) => {
  const [sub, ref] = positional;
  if (sub === 'clear') {
    return mutate(store, flags, 'clear the panel ambient default', (doc) => { delete doc.modbus.ambient_sensor; });
  }
  if (sub !== 'set' || !ref) fail('usage: ambient set <sl21|unit:101|sl06:3> | ambient clear');
  return mutate(store, flags, `set panel ambient to ${ref}`, (doc) => {
    doc.modbus.ambient_sensor = parseSensorRef(doc, ref);
  });
};

// Alarm profiles live in cfg/alarms, not cfg/modbus+joints - a different domain
// with its own validator and version. Included because --profile above is
// untestable without a second profile to point at, and creating one otherwise
// means the dashboard.
COMMANDS['profile'] = (store, { positional, flags }) => {
  const [sub, name] = positional;
  const { doc: current } = store.readDomain('alarms');
  if (!current) fail(`no applied cfg/alarms at ${store.root} - run tools/apply-migrated-config.js first`);
  const { doc: jointsDoc } = store.readDomain('modbus_joints');

  if (sub === 'list') {
    showAll(store);
    return true;
  }

  const profiles = JSON.parse(JSON.stringify(current.profiles ?? {}));

  if (sub === 'set') {
    if (!name) fail('usage: profile set <name> --dt=8,12,18 [--ror=5,10,20,10] [--persist=10,5,2]');
    const src = profiles[name] ?? profiles.default ?? fail('no default profile to copy from');
    const p = JSON.parse(JSON.stringify(src));
    const dt = list(flags, 'dt', Number);
    if (dt && dt !== CLEAR) {
      if (dt.length !== 3) fail('--dt takes three numbers: watch,warning,critical');
      p.deltaT = { watch: dt[0], warning: dt[1], critical: dt[2] };
    }
    const ror = list(flags, 'ror', Number);
    if (ror && ror !== CLEAR) {
      if (ror.length !== 4) fail('--ror takes four numbers: watch,warning,critical,timeWindowMin');
      p.ror = { watch: ror[0], warning: ror[1], critical: ror[2], timeWindowMin: ror[3] };
    }
    const per = list(flags, 'persist', Number);
    if (per && per !== CLEAR) {
      if (per.length !== 3) fail('--persist takes three numbers: watchMin,warningMin,criticalMin');
      p.persistence = { watchMin: per[0], warningMin: per[1], criticalMin: per[2] };
    }
    if (flags.description) p.description = flags.description;
    profiles[name] = p;
  } else if (sub === 'del') {
    if (!name) fail('usage: profile del <name>');
    if (!(name in profiles)) fail(`no profile '${name}'`);
    delete profiles[name];
  } else {
    fail('usage: profile list|set|del');
  }

  // Same friendly checks the editor runs (A4, the in-use check, MAX_PROFILES),
  // before the schema sees it.
  const problems = precheckProfiles(profiles, jointsDoc, current);
  if (problems.length) {
    console.error(`REJECTED  profile ${sub} ${name}`);
    for (const p of problems) console.error(`  ${p}`);
    return false;
  }

  const newDoc = buildProfilesDoc(current, profiles);
  const describe = `profile ${sub} ${name}`;

  if (flags['dry-run']) {
    const result = validateAlarms(newDoc, { applying: true, appliedVersion: current.config_domain_versions?.alarms, jointsDoc });
    reportValidation(result, describe, true);
    return result.valid;
  }

  const result = store.applyIfValid('alarms', newDoc, { jointsDoc, modbusDoc: jointsDoc }, flags.user || 'cli');
  if (!result.applied) { reportValidation(result, describe, false); return false; }
  console.log(`APPLIED  ${describe}`);
  console.log(`  profiles now: ${Object.keys(newDoc.profiles).sort().join(', ')}`);
  console.log('  NOTE: the running Alarm Manager reads thresholds from the `busbartherm_system_config`');
  console.log('  global, which only a dashboard/remote apply rewrites. Open Alarm Config and press');
  console.log('  SAVE once to publish these to the live engine.');
  return true;
};

COMMANDS['help'] = () => { console.log(HELP); return true; };

const HELP = `
config-edit - edit the applied configuration from the command line (testing aid)

  node tools/config-edit.js <command> [--root=${DEFAULT_ROOT}] [--dry-run] [--user=NAME]

Every change goes through the same validators (R1-R17, A1-A10) and the same
ConfigStore.applyIfValid the dashboard uses, so a rejection here is the exact
rejection the dashboard would give, with the same rule ids.

READ
  show [--json]                 everything applied, incl. each joint's EFFECTIVE profile
  export <file>                 dump the applied cfg/modbus+joints to a file
  import <file>                 validate and apply a file (versions are rewritten for you)

JOINTS
  joint add <id> --slave=<ref> --channel=N --zone=<zone> [--label=] [--profile=] [--ambient=<ref>]
  joint set <id> [--slave=] [--channel=] [--zone=] [--label=] [--profile=] [--ambient=] [--enabled=false]
  joint del <id>

ZONES
  zone add <id> --name=<name> [--profile=] [--ambient=<ref>]
  zone set <id> [--name=] [--profile=] [--ambient=]
  zone del <id>

SLAVES / BUSES
  slave add --unit=N [--bus=] [--channels=] [--base=] [--addrs=3,4,5] [--scale=] [--poll=] [--label=]
  slave set <sl06|unit:6> [same flags]
  slave del <sl06|unit:6>
  bus set <bus_id> [--baud=] [--parity=] [--stop-bits=] [--timeout=] [--retries=] [--inter-frame=] [--port=]
  ambient set <sl21|unit:101|sl06:3> | ambient clear

ALARM PROFILES (cfg/alarms - so joints have something to point at)
  profile set <name> --dt=8,12,18 [--ror=5,10,20,10] [--persist=10,5,2] [--description=]
  profile del <name>

REFERENCES
  a slave is  sl06  or  unit:6  or  6
  a sensor is sl06:3  or  unit:6:3  (channel defaults to 1)
  --profile=-  --ambient=-  --label=-   clear the field ("-" means unset)
  on a joint, NO --profile means inherit from its zone; --profile=default is an
  explicit override that BEATS the zone. They are different states.

WHAT CONVERGES BY ITSELF
  joints, zones and effective profiles       within 10 s (Publish Applied Joints)
  the Nano read job (bus/slave changes)      needs a resend - the tool tells you when
  legacy decode globals (SlaveIDList etc.)   only a Modbus Settings APPLY rewrites these
  live alarm thresholds                      only an Alarm Config SAVE publishes these

EXAMPLES
  node tools/config-edit.js show
  node tools/config-edit.js profile set hot_riser --dt=8,12,18 --persist=10,5,2
  node tools/config-edit.js zone set z1 --profile=hot_riser
  node tools/config-edit.js joint set J01 --profile=-        # inherit the zone
  node tools/config-edit.js joint set J02 --profile=default  # pin, ignoring the zone
  node tools/config-edit.js bus set bus1 --inter-frame=250 --dry-run
`;

// ----------------------------------------------------------------------- main
function main(argv) {
  const { flags, positional } = parseArgs(argv);
  const command = positional.shift();
  if (!command || command === 'help' || flags.help) { console.log(HELP); return 0; }

  const handler = COMMANDS[command];
  if (!handler) { console.error(`unknown command '${command}' - try: node tools/config-edit.js help`); return 2; }

  const store = new ConfigStore({
    root: flags.root || DEFAULT_ROOT,
    validators: { modbus_joints: validateModbusJoints, alarms: validateAlarms },
  });

  try {
    return handler(store, { flags, positional }) ? 0 : 1;
  } catch (e) {
    if (e instanceof UserError) { console.error(`error: ${e.message}`); return 2; }
    throw e;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, parseArgs, resolveSlave, parseSensorRef };
