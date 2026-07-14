'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { compileNanoJob, nanoJobsEqual } = require('../../src/config-service/nano-compiler');
const { validModbusJointsDoc } = require('./fixtures');
const migratedRealDoc = require('../../config/examples/migrated_modbus_joints.json');

describe('compileNanoJob - real production data regression', () => {
  test('matches the real 21-slave production panel byte-for-byte', () => {
    const { job } = compileNanoJob(migratedRealDoc);
    // read[0] is the packet count, matching the real legacy slaveLength global (21)
    assert.equal(job.read[0], 21);
    assert.equal(job.read.length, 22); // count + 21 tuples
    // every real slave: registerAddress 3, dataBits 1, channels 1 -> [unit_address, 3, 1]
    for (let i = 1; i <= 21; i++) {
      const tuple = job.read[i];
      assert.equal(tuple[1], 3);
      assert.equal(tuple[2], 1);
    }
    assert.deepEqual(job.read[1], [1, 3, 1]);
    assert.deepEqual(job.read[21], [101, 3, 1]); // the dedicated ambient slave, unit_address 101
    // comm matches the real legacy globals: Polling 10000us, baudRate 9600, Timeout 1000ms
    assert.deepEqual(job.comm, [10000, 9600, 1000]);
  });
});

describe('compileNanoJob - structure', () => {
  test('emits one read tuple per slave, in modbus.slaves[] order', () => {
    const doc = validModbusJointsDoc();
    const { job } = compileNanoJob(doc);
    assert.equal(job.read[0], doc.modbus.slaves.length);
    assert.equal(job.read.length, doc.modbus.slaves.length + 1);
    assert.deepEqual(
      job.read.slice(1).map((t) => t[0]),
      doc.modbus.slaves.map((s) => s.unit_address)
    );
  });

  test('read tuple length covers channels * temp_word_count', () => {
    const doc = validModbusJointsDoc();
    const { job } = compileNanoJob(doc);
    for (let i = 0; i < doc.modbus.slaves.length; i++) {
      const s = doc.modbus.slaves[i];
      const expectedLen = (s.channels ?? 4) * (s.registers.temp_word_count ?? 1);
      assert.deepEqual(job.read[i + 1], [s.unit_address, s.registers.temp_base_addr, expectedLen]);
    }
  });

  test('comm converts inter_frame_ms to microseconds and passes baud/timeout through', () => {
    const doc = validModbusJointsDoc();
    doc.modbus.buses[0].inter_frame_ms = 20;
    doc.modbus.buses[0].baud = 19200;
    doc.modbus.buses[0].timeout_ms = 500;
    const { job } = compileNanoJob(doc);
    assert.deepEqual(job.comm, [20000, 19200, 500]);
  });
});

describe('compileNanoJob - guardrails', () => {
  test('refuses to compile an invalid document', () => {
    const doc = validModbusJointsDoc();
    delete doc.modbus.slaves; // now schema-invalid
    const result = compileNanoJob(doc);
    assert.ok(result.error);
    assert.ok(!result.job);
  });

  test('refuses a document with more than one bus (firmware has one RS-485 port)', () => {
    const doc = validModbusJointsDoc();
    doc.modbus.buses.push({ bus_id: 'bus2', type: 'rtu', port: '/dev/ttyS2', baud: 9600 });
    // avoid tripping R8/other rules for the new bus's slaves - it has none, which is fine
    const result = compileNanoJob(doc);
    assert.ok(result.error.includes('single bus'));
  });

  test('refuses a TCP bus (firmware only speaks RTU)', () => {
    const doc = validModbusJointsDoc();
    doc.modbus.buses[0] = { bus_id: 'bus1', type: 'tcp', host: '10.0.0.5' };
    doc.modbus.slaves = []; // avoid other rule violations from the removed rtu fields; schema requires minItems 1 though
    // schema requires slaves minItems 1 and joints reference a slave - construct a fresh minimal doc instead
    const tcpDoc = {
      config_domain_versions: { modbus: 1, joints: 1 },
      modbus: {
        buses: [{ bus_id: 'bus1', type: 'tcp', host: '10.0.0.5' }],
        slaves: [
          {
            slave_id: 'sl01',
            bus_id: 'bus1',
            unit_address: 1,
            model: 'X',
            channels: 1,
            registers: { function_code: 3, temp_base_addr: 0, temp_word_count: 1, temp_scale: 0.1 },
          },
        ],
      },
      joints: [{ joint_id: 'J01', slave_id: 'sl01', channel: 1, zone_id: 'z1' }],
      zones: [{ zone_id: 'z1', name: 'Zone1' }],
    };
    const result = compileNanoJob(tcpDoc);
    assert.ok(result.error.includes('RTU'));
  });
});

describe('nanoJobsEqual', () => {
  test('true when modbus.slaves/buses are identical, even if joints/zones differ entirely', () => {
    const docA = validModbusJointsDoc();
    const docB = {
      ...docA,
      joints: [{ joint_id: 'J99', slave_id: docA.modbus.slaves[0].slave_id, channel: 1, zone_id: 'z9', enabled: true, threshold_profile: 'default' }],
      zones: [{ zone_id: 'z9', name: 'Somewhere else' }],
    };
    assert.ok(nanoJobsEqual(docA, docB));
  });

  test('false when a slave unit_address changes', () => {
    const docA = validModbusJointsDoc();
    const docB = JSON.parse(JSON.stringify(docA));
    docB.modbus.slaves[0].unit_address += 1;
    assert.ok(!nanoJobsEqual(docA, docB));
  });

  test('false when a bus comm parameter changes (baud/timeout/inter_frame_ms)', () => {
    const docA = validModbusJointsDoc();
    const docB = JSON.parse(JSON.stringify(docA));
    docB.modbus.buses[0].baud = 9600;
    assert.ok(!nanoJobsEqual(docA, docB));
  });

  test('false when either document fails to compile', () => {
    const docA = validModbusJointsDoc();
    const docB = validModbusJointsDoc();
    delete docB.modbus.slaves;
    assert.ok(!nanoJobsEqual(docA, docB));
  });
});
