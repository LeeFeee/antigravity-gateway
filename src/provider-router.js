'use strict';

class ProviderRouterError extends Error {
  constructor(message, { code = 'provider_routing_error', status = 503 } = {}) {
    super(message);
    this.name = 'ProviderRouterError';
    this.code = code;
    this.status = status;
  }
}

class ProviderRouter {
  constructor({ cloudcodePool, robinPool } = {}) {
    if (!cloudcodePool || !robinPool) throw new Error('ProviderRouter requires cloudcodePool and robinPool');
    this.cloudcodePool = cloudcodePool;
    this.robinPool = robinPool;
    this.catalog = { cloudcode: new Set(), robin: new Set() };
  }

  async refreshModels(signal, { cloudcodeDiscovery } = {}) {
    const [cloudcode, robin] = await Promise.allSettled([
      cloudcodeDiscovery
        ? cloudcodeDiscovery(signal)
        : this.cloudcodePool.listModels(signal, { force: true }),
      this.robinPool.listModels(signal, { force: true })
    ]);
    if (cloudcode.status === 'fulfilled') this.catalog.cloudcode = new Set(cloudcode.value);
    if (robin.status === 'fulfilled') this.catalog.robin = new Set(robin.value);
    if (!this.catalog.cloudcode.size && !this.catalog.robin.size) {
      throw cloudcode.reason || robin.reason || new ProviderRouterError('没有发现任何可用模型。');
    }
    return this.models();
  }

  models() {
    return [...new Set([...this.catalog.cloudcode, ...this.catalog.robin])].sort();
  }

  providerForModel(model) {
    const inRobin = this.catalog.robin.has(model)
      || this.robinPool.ownsModel?.(model)
      || this.robinPool.supportsModel(model);
    const inCloudCode = this.catalog.cloudcode.has(model);
    if (inRobin && !inCloudCode) return 'robin';
    if (inCloudCode && !inRobin) return 'cloudcode';
    if (inRobin && inCloudCode) {
      throw new ProviderRouterError(`模型 ${model} 同时出现在两个 Provider，必须配置唯一能力归属。`, {
        code: 'ambiguous_model_provider', status: 500
      });
    }
    // Preserve the existing Cloud Code forward-compatibility contract: clients
    // may request a newly released model before the local catalog refresh has
    // observed it. Robin-owned IDs never enter this branch because they are
    // registered by the Robin account capabilities above.
    return 'cloudcode';
  }

  async resolveProvider(model, signal) {
    signal?.throwIfAborted();
    // An explicitly Robin-owned request must not wait on Cloud Code auth or
    // catalog discovery. The two providers have independent failure domains.
    if (this.catalog.robin.has(model) || this.robinPool.ownsModel?.(model) || this.robinPool.supportsModel(model)) {
      if (!this.catalog.robin.has(model)) {
        this.catalog.robin = new Set(await this.robinPool.listModels(signal));
      }
      return this.providerForModel(model);
    }
    // Union discovery belongs to the explicit model-catalog operation, not
    // the inference hot path. Cloud Code already discovers account abilities
    // inside its own pool. An unrelated Robin refresh must never delay its
    // first request or newly released model IDs forwarded unchanged.
    return this.providerForModel(model);
  }

  async send(normalized, model, options = {}) {
    const providerType = await this.resolveProvider(model, options.signal);
    const scoped = {
      ...options,
      providerType
    };
    if (providerType === 'robin') return this.robinPool.send(normalized, model, scoped);
    return this.cloudcodePool.send(normalized, model, scoped);
  }

  cancelTask(providerType, normalized, options = {}) {
    // Cloud Code's stateless tool protocol has no retained task to cancel.
    return providerType === 'robin' ? this.robinPool.cancelTask(normalized, options) : false;
  }
}

module.exports = { ProviderRouter, ProviderRouterError };
