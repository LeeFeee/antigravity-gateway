'use strict';

// Fresh CLI captures confirmed that these historical framework and tool
// declarations still match the current adapter after projecting the build
// marker. Keep the original request archives intact for wire comparisons.
function withClaude322Billing(payload) {
  const [first, ...rest] = Array.isArray(payload.system) ? payload.system : [];
  if (first?.type !== 'text') return payload;
  const text = first.text.replace(/^x-anthropic-billing-header: cc_version=2\.1\.318(?=\.|;)/,
    'x-anthropic-billing-header: cc_version=2.1.322');
  return { ...payload, system: [{ ...first, text }, ...rest] };
}

module.exports = { withClaude322Billing };
