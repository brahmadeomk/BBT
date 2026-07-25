'use strict';

/** A minimal, schema-valid cfg/integration doc; overrides merge shallowly. */
function validIntegrationDoc(overrides = {}) {
  return structuredClone({
    config_domain_versions: { integration: 1 },
    modbus_tcp: { enabled: true, port: 1502, unit_id: 1, bind_host: '0.0.0.0', max_connections: 4 },
    exposure_tier: 3,
    point_map_version: 1,
    severity_bitmap: { enabled: false },
    zone_rollup: { worst_joint_tiebreak: 'first_raised', include_ambient_zone: false },
    ...overrides,
  });
}

/** A cfg/joints doc with two real zones and 3 joints, for BMS tier tests. */
function jointsDocTwoZones() {
  return structuredClone({
    config_domain_versions: { modbus: 1, joints: 1 },
    modbus: {
      buses: [{ bus_id: 'bus1', type: 'rtu', port: '/dev/ttyACM0', baud: 19200, parity: 'N', stop_bits: 1, timeout_ms: 500, retries: 2, inter_frame_ms: 20 }],
      slaves: [
        { slave_id: 'sl01', bus_id: 'bus1', unit_address: 1, model: 'X', channels: 2, registers: { function_code: 3, temp_base_addr: 0, temp_word_count: 1, temp_scale: 0.1 } },
        { slave_id: 'sl02', bus_id: 'bus1', unit_address: 2, model: 'X', channels: 1, registers: { function_code: 3, temp_base_addr: 0, temp_word_count: 1, temp_scale: 0.1 } },
      ],
      ambient_sensor: { slave_id: 'sl02', channel: 1 },
    },
    joints: [
      { joint_id: 'J01', slave_id: 'sl01', channel: 1, zone_id: 'Z1', enabled: true, threshold_profile: 'default' },
      { joint_id: 'J02', slave_id: 'sl01', channel: 2, zone_id: 'Z1', enabled: true, threshold_profile: 'default' },
      { joint_id: 'J03', slave_id: 'sl02', channel: 1, zone_id: 'Z2', enabled: true, threshold_profile: 'default' },
    ],
    zones: [{ zone_id: 'Z1', name: 'Zone One' }, { zone_id: 'Z2', name: 'Zone Two' }],
  });
}

function activeAlarm(overrides = {}) {
  return {
    instanceId: 'PROCESS|J01|DELTA_T|WARNING',
    category: 'PROCESS',
    joint_id: 'J01',
    zone_id: 'Z1',
    alarm_type: 'DELTA_T',
    level: 'WARNING',
    status: 'ACTIVE_NACK',
    raisedTs: '2026-07-25T10:00:00.000Z',
    value: 27.5,
    threshold: 25,
    ...overrides,
  };
}

module.exports = { validIntegrationDoc, jointsDocTwoZones, activeAlarm };
