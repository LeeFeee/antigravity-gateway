'use strict';

const readline = require('node:readline');

function number(value) {
  return Math.max(0, Number(value) || 0).toLocaleString('en-US');
}

function chart(hourly, width = 80) {
  const values = (hourly || []).map((item) => Number(item.totalTokens) || 0);
  if (!values.length) return '暂无最近24小时用量';
  const bars = '▁▂▃▄▅▆▇█';
  const max = Math.max(...values, 1);
  const line = values.map((value) => bars[Math.min(bars.length - 1, Math.floor((value / max) * (bars.length - 1)))]).join('');
  const total = values.reduce((sum, value) => sum + value, 0);
  return width >= 72 ? `最近24小时：${line}  合计 ${number(total)} Token` : `${line}\n24小时合计 ${number(total)} Token`;
}

function dashboard(usageStore, accountPool, quotaManager, width = 80) {
  const usage = usageStore.summary();
  const totals = usage.lifetime;
  const cacheRate = totals.inputTokens > 0 ? `${((totals.cachedTokens / totals.inputTokens) * 100).toFixed(1)}%` : '--';
  const accounts = accountPool.status();
  const available = accounts.filter((account) => account.enabled && account.state === 'available').length;
  const quotas = quotaManager
    ? (accounts.length ? accounts.map((account) => quotaManager.get(account.id)).filter(Boolean) : [quotaManager.get('local-agy-session')].filter(Boolean))
    : [];
  const credits = quotas.filter((item) => item.available === true).length;
  return [
    '-----------------------------------------------------------------',
    ` 账号状态: ${accounts.length ? `${available}/${accounts.length} 可用` : '使用本地 agy 单账号'}${quotas.length ? `，${credits}/${quotas.length} 额度可用` : ''}`,
    ` 历史总量: ${number(totals.totalTokens)} Token  请求 ${number(totals.clientRequests)}  上游调用 ${number(totals.upstreamCalls)}`,
    ` 输入: ${number(totals.inputTokens)}  输出: ${number(totals.outputTokens)}  缓存: ${number(totals.cachedTokens)}  命中率: ${cacheRate}`,
    ` ${chart(usage.hourly, width)}`,
    ` 统计更新: ${usage.lifetimeUpdatedAt || '-'}（总量24小时、图表1小时、磁盘5分钟）`,
    '-----------------------------------------------------------------'
  ].join('\n');
}

class TerminalConsole {
  constructor({ input = process.stdin, output = process.stdout, usageStore, accountPool, quotaManager, oauthFlow, accountStore, commands = {} } = {}) {
    this.input = input;
    this.output = output;
    this.usageStore = usageStore;
    this.accountPool = accountPool;
    this.quotaManager = quotaManager;
    this.oauthFlow = oauthFlow;
    this.accountStore = accountStore;
    this.commands = commands;
    this.interactive = Boolean(input.isTTY && output.isTTY);
    this.rl = null;
    this.adding = false;
    this.dashboardTimer = null;
    this.handling = 0;
  }

  start() {
    if (!this.interactive || this.rl) return;
    this.rl = readline.createInterface({ input: this.input, output: this.output, terminal: true, historySize: 50 });
    this.rl.setPrompt('gateway> ');
    this.rl.on('line', (line) => { void this.handle(line); });
    this.rl.on('SIGINT', () => { void this.commands.quit?.(); });
    this.output.write('\n终端命令：输入 add 添加账号，输入 stats 打开看板，输入 help 查看帮助\n\n');
    this.rl.prompt();
    this.dashboardTimer = setInterval(() => this.showDashboard(), 60 * 60_000);
    this.dashboardTimer.unref?.();
  }

  stop() {
    if (!this.rl) return;
    if (this.dashboardTimer) clearInterval(this.dashboardTimer);
    this.dashboardTimer = null;
    this.rl.close();
    this.rl = null;
  }

  log(message = '', level = 'log') {
    const text = String(message);
    // In an interactive terminal stdout/stderr share one screen. Route both
    // through readline so an upstream error cannot overwrite a command the
    // user is currently typing. Background mode still keeps stderr separate.
    const target = this.rl ? this.output : level === 'error' ? process.stderr : this.output;
    if (this.rl && target === this.output) {
      readline.clearLine(this.output, 0);
      readline.cursorTo(this.output, 0);
      this.output.write(`${text}\n`);
      if (!this.handling) this.rl.prompt(true);
    } else {
      target.write(`${text}\n`);
    }
  }

  showDashboard() {
    this.log(dashboard(this.usageStore, this.accountPool, this.quotaManager, this.output.columns || 80));
  }

  async handle(raw) {
    this.handling += 1;
    const line = String(raw || '').trim();
    if (this.adding && this.oauthFlow.active) {
      if (/^https?:\/\//i.test(line) || line.length > 20) {
        this.oauthFlow.submit(line);
        this.log('已收到授权结果，正在完成账号添加……');
      } else {
        this.log('正在等待账号授权。请完成浏览器授权，或粘贴完整回调链接。');
      }
      this.handling -= 1;
      if (!this.handling) this.rl?.prompt();
      return;
    }
    const [command] = line.toLowerCase().split(/\s+/);
    try {
      if (/^https?:\/\/localhost(?::\d+)?\/oauth-callback\?/i.test(line)) {
        this.log('当前没有正在等待的账号授权。该回调地址可能已被处理或授权流程已经失败；请重新输入 add 发起授权，不要重复使用旧授权码。');
        return;
      }
      switch (command) {
        case '': break;
        case 'add': await this.addAccount(); break;
        case 'acc':
        case 'accounts': this.showAccounts(); break;
        case 'models': this.log((await this.commands.models?.() || []).join('\n')); break;
        case 'status': await this.commands.status?.(); this.showDashboard(); break;
        case 'usage': this.showUsage(); break;
        case 'stats': this.log(await this.commands.stats?.() || ''); break;
        case 'reload':
          this.accountPool.reload();
          await this.quotaManager?.refresh().catch(() => {});
          this.log('✅ 已重新加载账号、模型和额度状态。');
          break;
        case 'config': this.log(await this.commands.config?.() || ''); break;
        case 'logs': this.log(await this.commands.logs?.() || '当前为前台模式，日志显示在本终端。'); break;
        case 'clear': this.output.write('\x1b[2J\x1b[H'); this.showDashboard(); break;
        case 'version': this.log(await this.commands.version?.() || ''); break;
        case 'help': this.showHelp(); break;
        case 'quit': await this.commands.quit?.(); break;
        default: this.log(`未知终端命令：${line}。输入 help 查看帮助。`);
      }
    } catch (error) {
      this.log(`[Antigravity Gateway Error] ${error.message}`, 'error');
    } finally {
      this.handling -= 1;
      if (!this.handling) this.rl?.prompt();
    }
  }

  async addAccount() {
    if (this.adding) { this.log('已有账号授权正在进行，请先完成或取消当前授权。'); return; }
    this.adding = true;
    this.log('正在创建新的 Antigravity 账号授权……');
    try {
      const account = await this.oauthFlow.start({ onReady: ({ url, browserOpened }) => {
        this.log(browserOpened ? '已尝试自动打开默认浏览器。' : '默认浏览器未能自动打开。');
        this.log('\n如果浏览器没有自动打开网页，请复制下面的完整链接到浏览器中，然后完成账号授权添加：\n');
        this.log(url);
        this.log('\n正在等待授权完成……');
        this.log('本机浏览器能访问回调地址时会自动继续；如果无法自动返回终端，请复制地址栏中的完整 localhost 回调链接，粘贴到 gateway> 后回车。');
      } });
      const saved = this.accountStore.save(account);
      this.accountPool.reload();
      void this.quotaManager?.refresh().catch(() => {});
      this.log(`✅ 账号授权成功：${saved.email || saved.id}`);
      this.log('✅ 凭据已保存，账号池已重新加载。');
      this.log(`✅ 当前共有 ${this.accountPool.status().length} 个账号。`);
    } finally {
      this.adding = false;
    }
  }

  showAccounts() {
    const accounts = this.accountPool.status();
    if (!accounts.length) { this.log('账号池尚未添加账号，当前使用本地 agy 登录态。'); return; }
    const lines = ['账号池：'];
    accounts.forEach((account, index) => {
      const quota = this.quotaManager?.get(account.id);
      lines.push(`${index + 1}. ${account.email || account.id}`);
      lines.push(`   状态：${account.enabled ? account.state : 'disabled'}${quota?.available === false ? '，当前模型额度均不可用' : ''}`);
      if (account.modelCooldowns.length) lines.push(`   模型冷却：${account.modelCooldowns.map((item) => item.model).join(', ')}`);
      if (account.lastSuccessAt) lines.push(`   最后成功：${account.lastSuccessAt}`);
      if (account.lastError) lines.push(`   最近错误：${account.lastError}`);
    });
    this.log(lines.join('\n'));
  }

  showUsage() {
    const value = this.usageStore.summary({ live: true });
    const totals = value.lifetime;
    this.log([
      '实时详细用量：',
      `  客户端请求：${number(totals.clientRequests)}`,
      `  上游调用：${number(totals.upstreamCalls)}（成功 ${number(totals.successfulUpstreamCalls)}，失败 ${number(totals.failedUpstreamCalls)}）`,
      `  输入 Token：${number(totals.inputTokens)}`,
      `  输出 Token：${number(totals.outputTokens)}`,
      `  思考 Token：${number(totals.thinkingTokens)}`,
      `  缓存 Token：${number(totals.cachedTokens)}`,
      `  总 Token：${number(totals.totalTokens)}`,
      `  ${chart(value.hourly, this.output.columns || 80)}`
    ].join('\n'));
  }

  showHelp() {
    this.log(`可用终端命令：

  add        添加 Antigravity 账号
  acc        查看账号池和账号状态
  models     查看当前发现的模型
  status     查看网关及统计状态
  usage      查看实时详细用量
  stats      在默认浏览器打开 Token 用量看板
  reload     重新加载账号和额度
  config     查看客户端配置
  logs       查看日志说明
  clear      清理终端显示
  version    查看网关版本
  help       查看帮助
  quit       保存状态并关闭网关`);
  }
}

module.exports = { TerminalConsole, chart, dashboard };
