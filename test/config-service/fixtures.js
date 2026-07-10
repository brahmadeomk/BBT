'use strict';

function validModbusJointsDoc() {
  return structuredClone({
    config_domain_versions: { modbus: 3, joints: 5 },
    modbus: {
      buses: [
        {
          bus_id: 'bus1',
          type: 'rtu',
          port: '/dev/ttyS1',
          baud: 19200,
          parity: 'N',
          stop_bits: 1,
          timeout_ms: 500,
          retries: 2,
          inter_frame_ms: 20,
        },
      ],
      slaves: [
        {
          slave_id: 'sl01',
          bus_id: 'bus1',
          unit_address: 1,
          model: 'BT-SCM-4',
          hw_serial: 'SCM26-0091',
          channels: 4,
          poll_interval_s: 30,
          registers: {
            function_code: 4,
            temp_base_addr: 100,
            temp_word_count: 1,
            temp_scale: 0.1,
            temp_offset: 0,
            byte_order: 'AB',
            status_addr: 199,
          },
        },
        {
          slave_id: 'sl02',
          bus_id: 'bus1',
          unit_address: 2,
          model: 'BT-SCM-4',
          hw_serial: 'SCM26-0092',
          channels: 4,
          poll_interval_s: 30,
          registers: {
            function_code: 4,
            temp_base_addr: 100,
            temp_word_count: 1,
            temp_scale: 0.1,
            byte_order: 'AB',
          },
        },
      ],
      ambient_sensor: { slave_id: 'sl02', channel: 4 },
    },
    joints: [
      { joint_id: 'J01', slave_id: 'sl01', channel: 1, zone_id: 'z1', label: 'Riser bend above ACB-8', enabled: true, threshold_profile: 'default' },
      { joint_id: 'J02', slave_id: 'sl01', channel: 2, zone_id: 'z1', label: 'Horizontal run joint 2', enabled: true, threshold_profile: 'default' },
      { joint_id: 'J03', slave_id: 'sl01', channel: 3, zone_id: 'z1', label: 'Tap-off box TB-3', enabled: true, threshold_profile: 'default' },
      { joint_id: 'J04', slave_id: 'sl02', channel: 1, zone_id: 'z1', label: 'Elbow near LT panel', enabled: true, threshold_profile: 'default' },
    ],
    zones: [{ zone_id: 'z1', name: 'Zone-1 Substation LT' }],
  });
}

function validAlarmsDoc() {
  return structuredClone({
    config_domain_versions: { alarms: 12 },
    profiles: {
      default: {
        description: 'Panel-wide defaults',
        deltaT: { watch: 15, warning: 25, critical: 35 },
        ror: { watch: 15, warning: 30, critical: 60, timeWindowMin: 20 },
        persistence: { watchMin: 30, warningMin: 15, criticalMin: 5 },
        clear_hysteresis_pct: 10,
        clear_persistence_min: 5,
      },
      hot_tapoff: {
        description: 'Known-hot tap-off boxes',
        deltaT: { watch: 20, warning: 30, critical: 40 },
        ror: { watch: 15, warning: 30, critical: 60, timeWindowMin: 20 },
        persistence: { watchMin: 30, warningMin: 15, criticalMin: 5 },
      },
    },
    sensor_fault: {
      comm_timeout_s: 300,
      sensor_error_above_c: 300,
      freeze_kpis_on_fault: true,
    },
    notifications: {
      email: {
        enabled: true,
        min_level: 'WARNING',
        on_clear: true,
        recipients: ['substation.team@example.com'],
        rate_limit_per_hour: 12,
      },
      sms: {
        enabled: true,
        min_level: 'CRITICAL',
        on_clear: false,
        recipients: ['+919800000000'],
        rate_limit_per_hour: 6,
      },
      cloud_alarm_publish: { enabled: true, min_level: 'WATCH' },
    },
  });
}

module.exports = { validModbusJointsDoc, validAlarmsDoc };
