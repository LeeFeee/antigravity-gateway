import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import catalogModule from './catalog.cjs';
const { Catalog, toDshModels } = catalogModule;
const options = JSON.parse(fs.readFileSync(new URL('./options.json', import.meta.url), 'utf8'));
const requireDsh = createRequire(path.join(options.dshPackage, 'package.json'));
const native = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-llm-pi-ai')).href);
const { Context } = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/cordis')).href);
const { launchEnvironmentOf } = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-launch-environment')).href);
export const Config = native.Config;
export const name = native.name;
export const inject = native.inject;

// A normal Cordis plugin delegates all request handling to the installed adapter.
// Only its in-memory providers snapshot gains a live catalogue; no settings writes.
export async function apply(ctx, config) {
  const catalog = new Catalog(path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'cache', 'antigravity-models'));
  let discovered, source, projected, fingerprint, running, timer, stopped = false;
  const controller = new AbortController();
  ctx.on('dispose', () => { stopped = true; controller.abort(); clearInterval(timer); });
  const get = () => {
    const raw = config.providers.get();
    if (source === raw && projected) return projected;
    source = raw;
    projected = structuredClone(raw);
    const profile = projected[options.dshProvider];
    if (profile && discovered && fingerprint === connectionKey(profile)) profile.models = toDshModels(discovered, profile);
    return projected;
  };
  function connectionKey(profile) { return JSON.stringify([profile.baseURL, profile.api, profile.apiKeyEnv, profile.headers]); }
  async function refresh() {
    if (running || stopped) return running;
    running = (async () => {
      const profile = config.providers.get()[options.dshProvider];
      if (!profile) return;
      const before = connectionKey(profile);
      try {
        const ref = profile.apiKeyEnv;
        const credentials = ctx.get('credentials');
        const key = ref ? (await credentials?.resolve(ref))?.value ?? launchEnvironmentOf(ctx).get(ref)?.value : undefined;
        if (ref && !key) throw new Error('网关目录未找到原有凭据');
        const result = await catalog.load({ baseUrl: profile.baseURL, api: profile.api, apiKey: key,
          headers: profile.headers, signal: controller.signal, force: true });
        if (stopped || before !== connectionKey(config.providers.get()[options.dshProvider] || {})) return;
        if (result.stale) ctx.logger.warn(`网关模型目录使用缓存：${result.error}`);
        if (result.cacheError) ctx.logger.warn(result.cacheError);
        const changed = fingerprint !== before || JSON.stringify(discovered) !== JSON.stringify(result.models);
        discovered = result.models; fingerprint = before;
        if (changed) {
          projected = undefined;
          // Match Cordis' scoped volatile notification: only this adapter observes it.
          const self = Object.create(ctx);
          self[Context.filter] = target => target.fiber === ctx.fiber;
          ctx.emit(self, 'loader/volatile-update', [['providers']]);
          // The native registration compares route facts, not catalogue membership.
          // Notify the GUI as well, so an already-open picker sees additions/removals.
          ctx.emit('llm/adapters-updated');
          ctx.logger.info(`网关模型目录已同步：${discovered.length} 个模型`);
        }
      } catch (error) {
        if (!stopped) ctx.logger.warn(`网关模型目录刷新失败，保留已有目录：${error.message}`);
      }
    })();
    try { await running; } finally { running = undefined; }
  }
  // Cordis awaits plugin activation before the headless entry point runs.
  // Publish the initial catalogue first, including a saved default that was
  // discovered dynamically and never existed in the original six-model list.
  await refresh();
  if (stopped) return;
  native.apply(ctx, { ...config, providers: { get } });
  timer = setInterval(() => { void refresh(); }, 60000);
  timer.unref?.();
}
