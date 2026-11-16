'use strict';

const crypto = require('node:crypto');
const { DashboardAccountAuth } = require('./dashboard-account-auth');
const { accountGrantGeneration } = require('./account-store');
const { geminiAccountId } = require('./gemini-account-store');
const { GeminiProvider } = require('./gemini-provider');
const { probeAccountInference } = require('./account-recheck');
const { GEMINI_CLIENT_VERSION } = require('./gemini-request-profile');

const ROUTE = '/dashboard/accounts/gemini/oauth';
const PENDING = new Set(['starting', 'waiting', 'processing']);
const STAGES = Object.freeze({
  exchanging_code: '正在兑换 Google 授权…', verifying_identity: '正在核对 Google 账号身份…',
  checking_credentials: '正在读取 Gemini 服务配置…', checking_status: '正在检查首次使用状态…',
  checking_terms: '正在读取必要协议版本…', accepting_terms: '正在完成必要协议确认…',
  checking_preferences: '正在核验活动记录偏好…', setting_activity_opt_out: '正在关闭活动记录并重新核验…',
  initialized: '必要初始化已完成，正在检测可用模型…', checking_models: '正在读取该账号的可用模型…',
  checking_quota: '正在查询 Gemini 额度…', verifying_inference: '正在进行实际生成验证…'
});
function fail(message, status = 409, code = 'gemini_initialization_changed') {
  return Object.assign(new Error(message), { status, code });
}

class DashboardGeminiAuth extends DashboardAccountAuth {
  constructor(options) {
    super(options);
    this.route = ROUTE;
    this.usageStore = options.usageStore;
    this.initializationTimeoutMs = options.initializationTimeoutMs || 180000;
  }

  snapshot(job) {
    return { ...super.snapshot(job), ...(job.stage ? { stage: job.stage } : {}),
      ...(job.errorCode ? { errorCode: job.errorCode } : {}),
      ...(job.validation ? { validation: job.validation } : {}) };
  }

  async start(id = crypto.randomBytes(24).toString('hex'), { accountId = '', action = 'authorize' } = {}) {
    if (this.closed) throw fail('网关正在退出，请稍后重试。', 503, 'gateway_stopping');
    if (typeof id !== 'string' || !/^[a-f0-9]{48}$/.test(id)) throw fail('授权标识无效，请刷新面板。', 400);
    if (this.job?.id === id) return this.snapshot(this.get(id));
    if ((this.job && PENDING.has(this.job.status)) || this.flow.active || this.flow.starting) {
      throw fail('已有 Gemini 授权或初始化正在进行，请先完成或取消。', 409, 'account_authorization_busy');
    }
    if (!['authorize', 'resume'].includes(action) || (accountId && !/^gemini-account-[a-f0-9]{24}$/.test(accountId))) {
      throw fail('Gemini 账号操作无效。', 400, 'gemini_account_action_invalid');
    }
    const baseline = new Map(this.store.list().map(account => [account.id, accountGrantGeneration(account)]));
    if ((accountId || action === 'resume') && !baseline.has(accountId)) throw fail('Gemini 账号不存在或已删除。', 404, 'account_not_found');
    const controller = new AbortController();
    const job = { id, status: action === 'resume' ? 'processing' : 'starting', controller, targetId: accountId,
      expiresAt: new Date(this.now() + (action === 'resume' ? this.initializationTimeoutMs : this.flow.timeoutMs)).toISOString() };
    this.job = job;
    job.promise = Promise.resolve().then(async () => {
      let account;
      if (action === 'resume') {
        account = this.store.list().find(value => value.id === accountId);
        if (!account || account.providerMetadata.initialization?.complete) throw fail('该账号无需继续初始化，请使用重新检测或重新认证。');
      } else {
        account = await this.flow.start({ openBrowser: false, requireState: true, signal: controller.signal,
          onReady: ({ url }) => { job.url = url; job.status = 'waiting'; },
          onCode: () => { job.status = 'processing'; job.url = ''; },
          onStage: ({ stage }) => { job.stage = stage; job.message = STAGES[stage]; } });
      }
      controller.signal.throwIfAborted();
      const selectedId = geminiAccountId(account);
      if (accountId && selectedId !== accountId) throw fail('Google 登录账号与所选账号不一致，未替换任何凭据。', 400, 'gemini_oauth_wrong_account');
      const previous = this.store.list().find(value => value.id === selectedId);
      if ((baseline.has(selectedId) && (!previous || accountGrantGeneration(previous) !== baseline.get(selectedId)))
        || (!baseline.has(selectedId) && previous)) throw fail('授权期间账号已更换或删除，请重新发起。');
      const desiredEnabled = previous?.providerMetadata.initialization?.complete === false
        ? previous.providerMetadata.initialization.desiredEnabled !== false : previous?.enabled !== false;
      const saved = this.store.save({ ...previous, ...account, enabled: false, weight: previous?.weight || 1,
        providerMetadata: { ...previous?.providerMetadata, ...account.providerMetadata,
          ...(action === 'authorize' ? { serverToken: '', serverTokenFetchedAt: '' } : {}),
          initialization: { stage: 'checking_credentials', jobId: id, running: true, complete: false,
            desiredEnabled, protocolVersion: GEMINI_CLIENT_VERSION, startedAt: new Date(this.now()).toISOString() } }
      }, action === 'resume' ? { expectedGrant: baseline.get(selectedId) } : { newGrant: true });
      if (!saved) throw fail('账号已更换，未开始初始化。');
      job.grant = accountGrantGeneration(saved);
      job.account = { id: saved.id, email: saved.email, providerType: 'gemini' };
      job.status = 'processing';
      job.expiresAt = new Date(this.now() + this.initializationTimeoutMs).toISOString();
      this.pool.reload();
      const timer = setTimeout(() => controller.abort(fail('Gemini 初始化超时，可以从看板继续。', 504, 'gemini_initialization_timeout')), this.initializationTimeoutMs);
      timer.unref?.();
      try { await this.initialize(job); } finally { clearTimeout(timer); }
    }).catch(error => {
      job.errorCode = /^[a-z][a-z0-9_]{1,80}$/.test(error.code || '') ? error.code : 'gemini_initialization_failed';
      job.status = controller.signal.aborted ? 'cancelled' : 'failed';
      if (job.account) {
        // Do not resurrect a deleted account, overwrite a new grant, or roll
        // back completed server-side terms/preferences when cancelling.
        try { this.update(job, { running: false, complete: false, stage: job.status,
          failedStage: job.stage || 'checking_credentials', errorCode: job.errorCode }, { allowAborted: true, enabled: false }); } catch { /* superseded */ }
        job.message = controller.signal.aborted ? '初始化已停止。已授权账号保留为待初始化，未加入可用账号轮询。'
          : `${STAGES[job.stage]?.replace(/…$/, '') || '初始化'}未完成。账号凭据已保存，可继续初始化或重新认证。`;
      } else {
        job.message = controller.signal.aborted ? '本次授权已取消，未保存账号。'
          : job.errorCode === 'gemini_oauth_wrong_account' ? error.message
          : 'Google 授权或身份验证未完成，未保存账号，请重新添加。';
      }
    }).finally(() => {
      job.finishedAt = this.now(); job.url = '';
      this.pool.reload();
      this.onAdded();
    });
    return this.snapshot(job);
  }

  current(job, allowAborted = false) {
    if (!allowAborted) job.controller.signal.throwIfAborted();
    const current = this.store.list().find(account => account.id === job.account.id);
    if (!current || accountGrantGeneration(current) !== job.grant
      || current.providerMetadata.initialization?.jobId !== job.id) throw fail('账号已删除或授权已更新。');
    return current;
  }

  update(job, values, { allowAborted = false, enabled } = {}) {
    const current = this.current(job, allowAborted);
    const saved = this.store.save({ ...current, ...(enabled === undefined ? {} : { enabled }),
      providerMetadata: { ...current.providerMetadata, initialization: {
        ...current.providerMetadata.initialization, ...values, updatedAt: new Date(this.now()).toISOString()
      } } }, { expectedGrant: job.grant });
    if (!saved) throw fail('账号授权已更新，旧初始化结果已丢弃。');
    return saved;
  }

  async initialize(job) {
    const signal = job.controller.signal;
    const stage = value => {
      if (!STAGES[value.stage]) throw fail('Gemini 返回了未识别的初始化阶段。', 502);
      this.update(job, { stage: value.stage });
      job.stage = value.stage; job.message = STAGES[value.stage];
    };
    stage({ stage: 'checking_credentials' });
    const provider = new GeminiProvider({ account: this.current(job), store: this.store,
      initializationId: job.id, timeoutMs: this.initializationTimeoutMs });
    provider.onboarding.onStage = stage;
    try {
      const initialization = await provider.onboarding.initialize({ signal });
      this.update(job, { ...initialization, privacy: { activityOptOutVerified: true,
        optionalClientTelemetry: 'not_sent_by_gateway', coverage: 'observed_activity_preference_and_client_telemetry' } });
      stage({ stage: 'checking_models' });
      const models = await provider.listModels(signal, { force: true });
      if (!models.length) throw fail('Gemini 初始化完成，但该账号没有可用模型。', 403, 'gemini_models_unavailable');
      this.update(job, { availableModels: models });
      stage({ stage: 'checking_quota' });
      let quotaVerified = false;
      try { await provider.getQuota(signal); quotaVerified = true; }
      catch { signal.throwIfAborted(); /* optional quota query must not invent inference denial */ }
      stage({ stage: 'verifying_inference' });
      const probe = { send: (normalized, model, options) => provider.send(normalized, model, {
        ...options, onUpstreamAttempt: event => {
          if (event.phase === 'response' && event.count === true) this.usageStore?.recordUpstream({
            accountId: job.account.id, model, success: event.success, count: true
          });
        }
      }), cancelTask: () => provider.dispose() };
      const validation = await probeAccountInference(probe, models, signal);
      const current = this.current(job);
      this.update(job, { stage: 'completed', running: false, complete: true, inferenceModel: validation.model,
        inferenceVerifiedAt: new Date(this.now()).toISOString(), quotaVerified },
      { enabled: current.providerMetadata.initialization.desiredEnabled !== false });
      job.validation = { model: validation.model, inferenceVerified: true, activityOptOutVerified: true, quotaVerified };
      job.status = 'completed';
      job.message = '必要初始化与实际生成验证已完成，活动记录已关闭。网关不上传可选使用统计和崩溃报告。';
      this.pool.reload();
      void this.quotaManager?.refreshAccount(job.account.id, { force: true, summaryOnly: false }).catch(() => {});
    } finally { provider.localAuth.disable(); }
  }
}

module.exports = { DashboardGeminiAuth, ROUTE, STAGES };
