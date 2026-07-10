'use strict';

const path = require('node:path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const modbusJointSchema = require(
  path.join(__dirname, '..', '..', 'config', 'schemas', 'busduct_modbus_joint_config.schema.json')
);
const alarmsSchema = require(
  path.join(__dirname, '..', '..', 'config', 'schemas', 'busduct_alarms_config.schema.json')
);

const validateModbusJointSchema = ajv.compile(modbusJointSchema);
const validateAlarmsSchema = ajv.compile(alarmsSchema);

function formatAjvErrors(ajvErrors) {
  return (ajvErrors || []).map((e) => ({
    rule: 'schema',
    message: `${e.instancePath || '(root)'} ${e.message}`.trim(),
  }));
}

module.exports = {
  modbusJointSchema,
  alarmsSchema,
  validateModbusJointSchema,
  validateAlarmsSchema,
  formatAjvErrors,
};
