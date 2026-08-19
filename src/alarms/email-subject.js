'use strict';

/**
 * Subject lines for alarm emails.
 *
 * Why this exists: every alarm mail this panel has ever sent arrived with the
 * identical subject - `"<project_name> Alerts"` - because the Email function
 * node overwrote `msg.topic` with a constant. The Alarm Manager was already
 * building a per-alarm subject and it was being discarded. On a phone, and in a
 * threaded mail client, that made a CRITICAL joint alarm indistinguishable from
 * a routine clear without opening it.
 *
 * The subject now answers, in order: which panel, how bad, which device, what
 * happened.
 *
 *   BusductTherMo S0001 | P0001 | CRITICAL | J01 - deltaT 29.48 >= 25
 *   BusductTherMo S0001 | P0001 | CLEARED | J01 - deltaT 29.48 >= 25
 *   BusductTherMo S0001 | P0001 | CRITICAL | Slave 101 (AMBIENT_101) - ambient reference for J01, J02
 *
 * Site before panel: a reader scanning an inbox narrows by location first, and
 * one site holds many panels. Both come from the edge config identity block and
 * either may be absent (an unprovisioned panel) - the subject drops what it does
 * not have rather than emitting a placeholder or an empty ` |  | ` gap.
 *
 * Kept deliberately free of the alarm's raw `instanceId`
 * (`PROCESS|J01|DELTA_T|CRITICAL`): that is a machine key, and the pipe-heavy
 * form reads badly in a notification. The device and level are lifted out of it
 * instead.
 */

/** Mail clients truncate long subjects; keep the useful part in the first glance. */
const MAX_DESCRIPTION = 70;
const MAX_SUBJECT = 160;

/**
 * `instanceId` is `PROCESS|<joint_id>|<alarm_type>|<level>` or
 * `SYSTEM|<device>|<type>` (docs/internal-message-contracts.md). The device is
 * always segment 1, which is what makes a single parse work for both a joint
 * alarm and a slave/system alarm.
 */
function parseInstanceId(instanceId) {
  const parts = String(instanceId == null ? '' : instanceId).split('|');
  return {
    category: parts[0] || '',
    device: parts[1] || '',
    type: parts[2] || '',
    level: parts[3] || '',
  };
}

/** Alarm descriptions are multi-line; a subject is one line. */
function oneLine(text, max = MAX_DESCRIPTION) {
  if (text == null) return '';
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * @param {object} meta - what the Alarm Manager stamps on each queued email
 * @param {string} [meta.instanceId] - e.g. "PROCESS|J01|DELTA_T|CRITICAL"
 * @param {'RAISE'|'CLEAR'} [meta.kind='RAISE']
 * @param {string} [meta.level] - overrides the level parsed from instanceId
 * @param {string} [meta.description] - the human sentence; first line is used
 * @param {string} [meta.deviceLabel] - overrides the device parsed from instanceId
 *   (used by SYSTEM alarms that know the commissioned name, e.g. "Slave 101 (AMBIENT_101)")
 * @param {object} [ctx]
 * @param {string} [ctx.projectName]
 * @param {string} [ctx.siteId] - from the edge config identity block
 * @param {string} [ctx.panelId] - likewise. Several sites, each with several
 *   panels, report into one mailbox during the pilot, so the subject has to say
 *   which one without the reader opening it. Site precedes panel because a
 *   reader narrows by location first.
 * @returns {string}
 */
function buildAlarmSubject(meta = {}, ctx = {}) {
  const parsed = parseInstanceId(meta.instanceId);

  const device = meta.deviceLabel || parsed.device || 'panel';
  const level = String(meta.level || parsed.level || '').toUpperCase();
  const kind = meta.kind === 'CLEAR' ? 'CLEAR' : 'RAISE';

  // A cleared alarm says CLEARED, not its old severity: the severity is no
  // longer true, and "CRITICAL" in a clear notification reads as a new alarm.
  const state = kind === 'CLEAR' ? 'CLEARED' : (level || 'ALARM');

  const description = oneLine(meta.description) || parsed.type || '';
  const who = description ? `${device} - ${description}` : device;

  // "<project> <site> | <panel> | <LEVEL> | <device> - <what happened>".
  // Project and site ride together as the leading "where"; everything after is
  // pipe-separated. Any missing part is dropped rather than leaving an empty
  // segment, so an unprovisioned panel still reads cleanly.
  const where = [ctx.projectName, ctx.siteId].filter(Boolean).join(' ').trim();
  const subject = [where, ctx.panelId, state, who].filter(Boolean).join(' | ');

  return subject.length <= MAX_SUBJECT ? subject : `${subject.slice(0, MAX_SUBJECT - 1).trimEnd()}…`;
}

/**
 * Turns one queued email into the msg an `e-mail` node sends.
 * `msg.topic` IS the subject for that node.
 */
function toMailMessage(email, ctx = {}) {
  return {
    topic: buildAlarmSubject(email && email.meta, ctx),
    payload: (email && email.body) || '',
    ...(email && email.attachments ? { attachments: email.attachments } : {}),
    ...(ctx.to ? { to: ctx.to } : {}),
  };
}

module.exports = { buildAlarmSubject, toMailMessage, parseInstanceId, oneLine, MAX_SUBJECT, MAX_DESCRIPTION };
