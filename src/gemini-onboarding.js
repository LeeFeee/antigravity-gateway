'use strict';

const { messageField: m, stringField: s, intField: i, boolField: b, concatFields: c, decodeFields, field } = require('./gemini-wire');

class GeminiInitializationError extends Error {
  constructor(message, code, stage, details = {}) {
    super(message);
    this.name = 'GeminiInitializationError';
    this.code = code;
    this.stage = stage;
    this.status = 409;
    this.details = details;
  }
}

// request(method, protobuf, {signal}) returns the decoded unary message bytes
// only after validating HTTP, gRPC status and the complete response framing.
class GeminiOnboarding {
  constructor({ request, metadata, clientType = 21, languageCode = 'zh-CN', onStage = () => {} }) {
    if (typeof request !== 'function' || typeof metadata !== 'function') throw new TypeError('GeminiOnboarding requires request and metadata functions');
    this.request = request;
    this.metadata = metadata;
    this.clientType = clientType;
    this.languageCode = languageCode;
    this.onStage = onStage;
  }

  async rpc(method, body, signal) {
    signal?.throwIfAborted();
    const result = await this.request(method, body, { signal });
    signal?.throwIfAborted();
    if (!(result instanceof Uint8Array)) throw new TypeError('Gemini unary RPC did not return message bytes');
    return result;
  }

  async status(signal) {
    const response = await this.rpc('GetUserStatus', m(1, this.metadata()), signal);
    const status = field(response, 1, 0);
    if (status === undefined) throw new GeminiInitializationError('Gemini 未返回首次初始化状态。', 'gemini_initialization_state_unknown', 'checking_status');
    return { onboardingStatus: Number(status), response };
  }

  async preferences(signal) {
    const response = await this.rpc('ReadUserPreferences', m(2, this.metadata()), signal);
    const preferences = field(response, 1, 2);
    const value = preferences && field(preferences, 5, 0);
    // This API has returned explicit 0 and 1. Do not treat an absent field as
    // verified opt-out when an account/profile may expose a different contract.
    if (value !== 0n && value !== 1n) throw new GeminiInitializationError('Gemini 未返回可核验的活动记录偏好。', 'gemini_activity_preference_unknown', 'checking_preferences');
    return { activityEnabled: value === 1n, response };
  }

  async ensureActivityOptOut(signal) {
    await this.onStage({ stage: 'checking_preferences' });
    const before = await this.preferences(signal);
    if (before.activityEnabled) {
      await this.onStage({ stage: 'setting_activity_opt_out' });
      await this.rpc('UpdateUserPreferences', c([
        m(1, b(5, false)), m(2, s(1, 'bard_activity_enabled')), m(3, this.metadata())
      ]), signal);
    }
    const after = await this.preferences(signal);
    if (after.activityEnabled) throw new GeminiInitializationError('Gemini 活动记录仍为开启，账号尚不能完成初始化。', 'gemini_activity_opt_out_failed', 'checking_preferences');
    return { activityOptOutVerified: true, changed: before.activityEnabled };
  }

  async initialize({ signal } = {}) {
    await this.onStage({ stage: 'checking_status' });
    const before = await this.status(signal);
    let acceptedTermsVersion = null;
    if (before.onboardingStatus === 7 || before.onboardingStatus === 8) {
      await this.onStage({ stage: 'checking_terms' });
      const response = await this.rpc('GetTermsOfServiceVersion', c([s(1, this.languageCode), m(2, this.metadata())]), signal);
      const terms = decodeFields(response);
      const version = field(terms, 1, 0), versionNo = field(terms, 2, 0);
      if (version === undefined || versionNo === undefined || version <= 0n || versionNo <= 0n || version > 0x7fffffffn || versionNo > 0x7fffffffn) {
        throw new GeminiInitializationError('Gemini 未返回有效的必要条款版本。', 'gemini_terms_version_unknown', 'checking_terms');
      }
      await this.onStage({ stage: 'accepting_terms', termsVersion: Number(versionNo) });
      await this.rpc('AcceptTermsOfService', c([
        i(1, version), s(2, this.languageCode), i(5, this.clientType), i(6, versionNo), m(7, this.metadata())
      ]), signal);
      acceptedTermsVersion = Number(versionNo);
    } else if (before.onboardingStatus !== 1) {
      throw new GeminiInitializationError('Gemini 账号尚不具备当前客户端的使用资格。', 'gemini_onboarding_unavailable', 'checking_status', { onboardingStatus: before.onboardingStatus });
    }

    // Acceptance can ENABLE activity even if the account was previously opted
    // out. Always verify after acceptance, before any validation generation.
    const privacy = await this.ensureActivityOptOut(signal);
    const after = await this.status(signal);
    if (after.onboardingStatus !== 1) throw new GeminiInitializationError('Gemini 必要初始化尚未完成。', 'gemini_initialization_incomplete', 'checking_status', { onboardingStatus: after.onboardingStatus });
    const result = {
      initialized: true, acceptedTermsVersion, activityOptOutVerified: privacy.activityOptOutVerified,
      activityPreferenceChanged: privacy.changed, verifiedAt: new Date().toISOString()
    };
    // This stage is not model/usage validation and must not mark an account
    // routable by itself. Other optional improvement settings need their own
    // evidence before a broader privacy-compliance state may be reported.
    await this.onStage({ stage: 'initialized', ...result });
    return result;
  }
}

module.exports = { GeminiOnboarding, GeminiInitializationError };
