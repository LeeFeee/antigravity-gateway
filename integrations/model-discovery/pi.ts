import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getAgentDir, getPackageDir } from '@earendil-works/pi-coding-agent';
import catalogModule from './catalog.cjs';
const { Catalog, toPiModels } = catalogModule;

export default async function (pi) {
  const dir = getAgentDir();
  const options = JSON.parse(fs.readFileSync(new URL('./options.json', import.meta.url), 'utf8'));
  const readConfig = () => JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8')).providers?.[options.piProvider];
  const catalog = new Catalog(path.join(dir, 'cache', 'antigravity-models'));
  // Reuse this installed Pi's exact literal/env/command resolution semantics.
  const { resolveConfigValueOrThrow, resolveHeadersOrThrow } = await import(pathToFileURL(path.join(getPackageDir(), 'dist/core/resolve-config-value.js')).href);
  let current = readConfig();
  if (!current) throw new Error('动态目录找不到原有 Pi provider');
  let models = current.models || [];
  let warning = '';
  async function refresh(context = {}) {
    current = readConfig();
    if (!current) throw new Error('原有 Pi provider 已移除');
    const env = context.credential?.env;
    const apiKey = current.apiKey ? resolveConfigValueOrThrow(current.apiKey, 'gateway discovery', env)
      : context.credential?.key || context.credential?.access;
    const result = await catalog.load({ baseUrl: current.baseUrl, api: current.api, apiKey,
      headers: resolveHeadersOrThrow(current.headers, 'gateway discovery', env), signal: context.signal,
      force: context.force ?? true, allowNetwork: context.allowNetwork ?? true });
    warning = result.stale ? `网关目录刷新失败，沿用上次目录：${result.error || '离线模式'}` : result.cacheError || '';
    models = toPiModels(result.models, current);
    return models;
  }
  try { await refresh(); }
  catch (error) { warning = `网关目录刷新失败，沿用原有配置：${error.message}`; }
  pi.registerProvider(options.piProvider, { models, refreshModels: refresh });
  let timer, refreshing = false, controller;
  pi.on('session_start', async (_event, ctx) => {
    if (warning && ctx.hasUI) ctx.ui.notify(warning, 'warning');
    clearInterval(timer);
    controller?.abort();
    controller = new AbortController();
    timer = setInterval(async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const result = await ctx.modelRegistry.refresh({ providers: [options.piProvider], signal: controller.signal });
        if (result.errors.size && ctx.hasUI) ctx.ui.setStatus('gateway-catalog', '网关目录刷新失败');
        else if (ctx.hasUI) ctx.ui.setStatus('gateway-catalog', warning ? '网关目录使用缓存' : undefined);
      } catch {
        if (!controller.signal.aborted && ctx.hasUI) ctx.ui.setStatus('gateway-catalog', '网关目录刷新失败');
      } finally { refreshing = false; }
    }, 60000);
    timer.unref?.();
  });
  pi.on('session_shutdown', () => { clearInterval(timer); controller?.abort(); });
}
