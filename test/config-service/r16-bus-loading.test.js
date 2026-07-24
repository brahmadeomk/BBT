'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { validateModbusJoints } = require('../../src/config-service/validate-modbus-joints.js');

/**
 * Builds a minimal but schema-shaped cfg/modbus+joints document with
 * `slaveCount` slaves on one RTU bus. Poll interval is set high enough
 * that R10 (scan-time) never fires, so these tests isolate R16.
 */
function buildDoc(slaveCount, { rs485MaxDevices, baud = 19200 } = {}) {
  const bus = {
    bus_id: 'bus1',
    type: 'rtu',
    port: '/dev/ttyS1',
    baud,
    parity: 'N',
    stop_bits: 1,
    timeout_ms: 300,
    retries: 2,
    inter_frame_ms: 20,
  };
  if (rs485MaxDevices != null) bus.rs485_max_devices = rs485MaxDevices;

  const slaves = [];
  const joints = [];
  for (let i = 1; i <= slaveCount; i++) {
    const id = `sl${String(i).padStart(2, '0')}`;
    slaves.push({
      slave_id: id,
      bus_id: 'bus1',
      unit_address: i,
      model: 'BT-SCM-4',
      channels: 1,
      poll_interval_s: 300,
      registers: {
        function_code: 3,
        temp_base_addr: 100,
        temp_word_count: 1,
        temp_scale: 0.1,
        byte_order: 'AB',
      },
    });
    joints.push({
      joint_id: `J${String(i).padStart(2, '0')}`,
      slave_id: id,
      channel: 1,
      zone_id: 'z1',
      enabled: true,
      threshold_profile: 'default',
    });
  }

  return {
    config_domain_versions: { modbus: 1, joints: 1 },
    modbus: { buses: [bus], slaves, ambient_sensor: { slave_id: 'sl01', channel: 1 } },
    joints,
    zones: [{ zone_id: 'z1', name: 'Zone-1' }],
  };
}

const r16 = (list) => list.filter((e) => e.rule === 'R16');

test('R16 - bus loading', async (t) => {
  await t.test('accepts a bus comfortably under the ceiling with no warning', () => {
    const res = validateModbusJoints(buildDoc(50));
    assert.deepStrictEqual(r16(res.errors), []);
    assert.deepStrictEqual(r16(res.warnings ?? []), []);
  });

  await t.test('warns above 80% of the default 128 unit-load ceiling', () => {
    // 110 slaves + 1 master = 111 unit loads = 87% of 128
    const res = validateModbusJoints(buildDoc(110));
    assert.deepStrictEqual(r16(res.errors), [], 'still valid, not an error');
    const warns = r16(res.warnings ?? []);
    assert.strictEqual(warns.length, 1);
    assert.match(warns[0].message, /111\/128/);
    assert.match(warns[0].message, /two segments/);
  });

  await t.test('rejects a bus over the ceiling', () => {
    const res = validateModbusJoints(buildDoc(128)); // 128 + master = 129
    const errs = r16(res.errors);
    assert.strictEqual(errs.length, 1);
    assert.match(errs[0].message, /exceeding rs485_max_devices 128/);
    assert.strictEqual(res.valid, false);
  });

  await t.test('honours a per-bus rs485_max_devices override (1 UL transceiver)', () => {
    const res = validateModbusJoints(buildDoc(40, { rs485MaxDevices: 32 }));
    const errs = r16(res.errors);
    assert.strictEqual(errs.length, 1);
    assert.match(errs[0].message, /exceeding rs485_max_devices 32/);
  });

  await t.test('counts the master as a unit load at the boundary', () => {
    // 127 slaves + master = 128 = exactly the ceiling: allowed, but warned
    const res = validateModbusJoints(buildDoc(127));
    assert.deepStrictEqual(r16(res.errors), []);
    assert.strictEqual(r16(res.warnings ?? []).length, 1);
  });

  await t.test('does not apply to TCP buses', () => {
    const doc = buildDoc(110);
    doc.modbus.buses[0] = {
      bus_id: 'bus1',
      type: 'tcp',
      host: '192.168.1.50',
      tcp_port: 502,
      timeout_ms: 300,
      retries: 2,
      inter_frame_ms: 20,
    };
    const res = validateModbusJoints(doc);
    assert.deepStrictEqual(r16(res.errors), []);
    assert.deepStrictEqual(r16(res.warnings ?? []), []);
  });
});
