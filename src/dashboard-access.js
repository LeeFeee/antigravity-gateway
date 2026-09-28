'use strict';

const net = require('node:net');

function normalizedAddress(address) {
  const value = String(address || '').trim().toLowerCase();
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return mapped ? mapped[1] : value;
}

function isLoopbackAddress(address) {
  const value = normalizedAddress(address);
  return value === '127.0.0.1' || value === '::1';
}

function createDashboardAccessPolicy(source = '', { warn = () => {} } = {}) {
  const blockList = new net.BlockList();
  const accepted = [];
  let allowAny = false;

  for (const entry of String(source || '').split(',').map((item) => item.trim()).filter(Boolean)) {
    if (entry === '*') {
      allowAny = true;
      if (!accepted.includes(entry)) accepted.push(entry);
      continue;
    }

    const pieces = entry.split('/');
    const address = pieces[0];
    const family = net.isIP(address);
    const prefixSource = pieces[1];
    const prefix = prefixSource === undefined ? null : Number(prefixSource);
    const maxPrefix = family === 6 ? 128 : 32;
    const validPrefix = prefix === null
      || (/^\d+$/.test(prefixSource) && prefix >= 0 && prefix <= maxPrefix);

    if (!family || pieces.length > 2 || !validPrefix) {
      warn(`ANTIGRAVITY_GATEWAY_DASHBOARD_ALLOW 忽略无效项：${entry}`);
      continue;
    }

    try {
      const type = family === 6 ? 'ipv6' : 'ipv4';
      if (prefix === null) blockList.addAddress(address, type);
      else blockList.addSubnet(address, prefix, type);
      if (!accepted.includes(entry)) accepted.push(entry);
    } catch {
      warn(`ANTIGRAVITY_GATEWAY_DASHBOARD_ALLOW 忽略无效项：${entry}`);
    }
  }

  const acceptedSources = Object.freeze([...accepted]);
  return Object.freeze({
    accepted: acceptedSources,
    allowAny,
    allows(address) {
      if (allowAny || isLoopbackAddress(address)) return true;
      const value = normalizedAddress(address);
      const family = net.isIP(value);
      return Boolean(family && blockList.check(value, family === 6 ? 'ipv6' : 'ipv4'));
    },
    description: acceptedSources.length ? `本机 + ${acceptedSources.join(', ')}` : '仅本机'
  });
}

module.exports = { createDashboardAccessPolicy, isLoopbackAddress, normalizedAddress };
