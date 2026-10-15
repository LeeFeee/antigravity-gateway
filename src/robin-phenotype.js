'use strict';

const {
  concatFields,
  decodeFields,
  intField,
  messageField,
  stringField
} = require('./robin-proto');

const PHENOTYPE_ENDPOINT = 'https://www.googleapis.com/experimentsandconfigs/v1/getExperimentsAndConfigs';
const ROBIN_BUNDLE_ID = 'com.google.GeminiMacOS';
const ROBIN_PHENOTYPE_PACKAGE = `com.google.gemini.macos.user#@${ROBIN_BUNDLE_ID}`;
const ROBIN_CLIENT_VERSION = '1.128.14.1166';

function phenotypeVersion(clientVersion = ROBIN_CLIENT_VERSION) {
  const [major = 0, minor = 0, patch = 0] = String(clientVersion).split('.').map((value) => Number(value) || 0);
  return BigInt(major) * 1_000_000_000_000n
    + BigInt(minor) * 1_000_000n
    + BigInt(patch);
}

function phenotypeRequest({
  packageName = ROBIN_PHENOTYPE_PACKAGE,
  clientVersion = ROBIN_CLIENT_VERSION
} = {}) {
  const packageDetails = concatFields([
    stringField(1, packageName),
    intField(2, phenotypeVersion(clientVersion)),
    messageField(3, intField(1, 0))
  ]);
  return concatFields([
    messageField(2, messageField(1, packageDetails)),
    intField(4, 1),
    stringField(7, ROBIN_BUNDLE_ID)
  ]);
}

function phenotypeServerToken(input, packageName = ROBIN_PHENOTYPE_PACKAGE) {
  let response;
  try { response = decodeFields(input); }
  catch { return ''; }
  for (const field of response) {
    if (field.number !== 1 || field.wireType !== 2) continue;
    let config;
    try { config = decodeFields(field.value); }
    catch { continue; }
    const details = config.find((item) => item.number === 1 && item.wireType === 2);
    let returnedPackage = '';
    if (details) {
      try {
        returnedPackage = decodeFields(details.value)
          .find((item) => item.number === 1 && item.wireType === 2)
          ?.value.toString('utf8') || '';
      } catch { /* tolerate unknown response additions */ }
    }
    const token = config.find((item) => item.number === 4 && item.wireType === 2)
      ?.value.toString('utf8') || '';
    if (token && (!returnedPackage || returnedPackage === packageName)) return token;
  }
  return '';
}

async function fetchRobinServerToken(accessToken, {
  fetchImpl = globalThis.fetch,
  signal,
  packageName = ROBIN_PHENOTYPE_PACKAGE,
  clientVersion = ROBIN_CLIENT_VERSION
} = {}) {
  if (!accessToken) throw new Error('Gemini OAuth access token 为空，无法读取 Robin 配置。');
  const response = await fetchImpl(PHENOTYPE_ENDPOINT, {
    method: 'POST',
    signal,
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/x-protobuf',
      'x-ios-bundle-identifier': ROBIN_BUNDLE_ID
    },
    body: phenotypeRequest({ packageName, clientVersion })
  });
  const body = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    let detail = '';
    if (contentType.includes('application/json')) {
      try {
        const parsed = JSON.parse(body.toString('utf8'));
        detail = String(parsed?.error?.message || parsed?.error_description || parsed?.message || '').trim();
      } catch { /* return the status without reflecting an untrusted body */ }
    }
    const error = new Error(`Gemini Robin 配置读取失败：${detail.slice(0, 240) || `HTTP ${response.status}`}`);
    error.status = response.status;
    error.code = response.status === 401 || response.status === 403
      ? 'robin_reauthorization_required'
      : 'robin_phenotype_error';
    throw error;
  }
  const serverToken = phenotypeServerToken(body, packageName);
  if (!serverToken) {
    const error = new Error('Gemini Robin 配置中没有服务令牌，请重新授权账号。');
    error.status = 401;
    error.code = 'robin_reauthorization_required';
    throw error;
  }
  return serverToken;
}

module.exports = {
  PHENOTYPE_ENDPOINT,
  ROBIN_BUNDLE_ID,
  ROBIN_CLIENT_VERSION,
  ROBIN_PHENOTYPE_PACKAGE,
  fetchRobinServerToken,
  phenotypeRequest,
  phenotypeServerToken,
  phenotypeVersion
};
