'use strict';

const { parentPort } = require('node:worker_threads');
const { compileSchema } = require('./schema-engine');

parentPort.on('message', ({ schema, value, operation }) => {
  try {
    const validate = compileSchema(JSON.parse(schema));
    if (operation === 'compile') parentPort.postMessage({ valid: true });
    else {
      parentPort.postMessage({ phase: 'validation' });
      const valid = validate(JSON.parse(value)) === true;
      parentPort.postMessage({ valid, errors: valid ? null : validate.errors });
    }
  } catch (error) {
    parentPort.postMessage({ error: { message: error.message, code: error.code || 'invalid_tool_schema', status: error.status || 400 } });
  }
});
parentPort.postMessage({ ready: true });
