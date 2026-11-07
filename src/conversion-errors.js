'use strict';

const { SchemaContractError } = require('./schema-contract');
const { ToolContractError } = require('./antigravity-tool-contract');
const { ToolReceiptError } = require('./agy-tool-results');
const { ModelCapabilityError } = require('./antigravity-model-config');
const { ImageModelError } = require('./image-model-config');
const { GatewayError } = require('./protocol');
const { ServerSearchContractError } = require('./server-search-contract');

// These errors describe a request/response conversion, not an account fault.
// Recognize our own classes; do not expose arbitrary error.status/message.
function isConversionError(error) {
  return error instanceof GatewayError || error instanceof SchemaContractError || error instanceof ToolContractError
    || error instanceof ToolReceiptError || error instanceof ModelCapabilityError || error instanceof ImageModelError
    || error instanceof ServerSearchContractError;
}

module.exports = { isConversionError };
