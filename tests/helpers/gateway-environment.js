'use strict';

// Import before the gateway module in unit/protocol tests. Production
// credentials (including Robin accounts) must never leak into fake upstream
// tests, model catalogs, health state, or usage persistence.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-unit-config-'));
process.env.ANTIGRAVITY_GATEWAY_CONFIG_DIR = directory;
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

module.exports = { directory };
