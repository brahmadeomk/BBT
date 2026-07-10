'use strict';

// Representative legacy Node-RED global-context shapes, matching the
// structure (and non-identifying engineering values) of a real
// exported production panel: 20 single-channel joint sensors + 1
// dedicated ambient probe on one RTU bus, 3 zones, one flat threshold
// config. Identity-ish fields (IP/MAC/project name) are deliberately
// excluded - they aren't part of cfg/modbus+joints/alarms and don't
// belong in this repo.

function legacySlaveIdList() {
  const list = [];
  for (let i = 1; i <= 20; i++) {
    list.push({ id: '6', parameterName: `Sensor${i}`, slaveID: i, registerAddress: 3, dataBits: 1, enabled: true });
  }
  list.push({ id: '6', parameterName: 'AmbientT', slaveID: 101, registerAddress: 3, dataBits: 1, enabled: true });
  return list;
}

function legacyJointMaster() {
  const zoneForSlave = (slaveID) => {
    if (slaveID <= 6) return { zone_id: 'Z1', zone_name: 'Zone1' };
    if (slaveID <= 12) return { zone_id: 'Z2', zone_name: 'Zone2' };
    return { zone_id: 'Z3', zone_name: 'Zone3' };
  };
  const joints = [];
  for (let i = 1; i <= 20; i++) {
    const jointId = `J${String(i).padStart(2, '0')}`;
    const zone = zoneForSlave(i);
    joints.push({
      joint_name: jointId,
      joint_id: jointId,
      slaveID: i,
      slaveName: `Sensor${i}`,
      slaveTooltip: `Slave ${i}\nSensor${i}`,
      editing: false,
      ambientSlaveID: 101,
      zone_id: zone.zone_id,
      zone_name: zone.zone_name,
    });
  }
  return joints;
}

function legacyZoneMaster() {
  return [
    { zone_id: 'Z1', zone_name: 'Zone1', editing: false },
    { zone_id: 'Z2', zone_name: 'Zone2', editing: false },
    { zone_id: 'Z3', zone_name: 'Zone3', editing: false },
  ];
}

function legacyAlarmsConfig() {
  return {
    deltaT: { watch: 15, warning: 25, critical: 35 },
    ror: { watch: 15, warning: 30, critical: 60, timeWindowMin: 20 },
    persistence: { watchMin: 1, warningMin: 1, criticalMin: 5 }, // A2-violating, as found in production
  };
}

function legacyContext() {
  return {
    SlaveIDList: legacySlaveIdList(),
    joint_master_zone_A: legacyJointMaster(),
    zone_master: legacyZoneMaster(),
    busbartherm_system_config: legacyAlarmsConfig(),
    port: '/dev/ttyUSB0',
    baudRate: 9600,
    parity: 'N',
    stopBits: 2,
    Polling: 10000, // microseconds
    Timeout: 1000, // ms
  };
}

module.exports = { legacyContext, legacySlaveIdList, legacyJointMaster, legacyZoneMaster, legacyAlarmsConfig };
