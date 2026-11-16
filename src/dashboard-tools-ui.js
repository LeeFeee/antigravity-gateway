/* finesse · component: dashboard-tools · register=product · tokens: inherited */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const proxyTrigger = $('openProxySettings');
  const proxyDialog = $('proxyConfigDialog');
  const cockpitTrigger = $('importCockpitToolsBtn');
  const cockpitDialog = $('cockpitImportDialog');
  if (!proxyTrigger || !proxyDialog || !cockpitTrigger || !cockpitDialog) return;

  let csrf = '';
  let proxyBusy = false;
  let cockpitBusy = false;

  const esc = v => String(v ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

  async function api(url, method = 'GET', body) {
    const response = await fetch(url, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        ...(csrf ? { 'x-dashboard-csrf': csrf } : {}),
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000)
    });
    const payload = await response.json().catch(() => null);
    if (!payload) throw new Error('面板会话可能已过期，请刷新页面后重试。');
    if (payload.csrfToken) csrf = payload.csrfToken;
    if (!response.ok) {
      throw Object.assign(new Error(payload.error?.message || '操作失败，请稍后重试。'), {
        status: response.status,
        code: payload.error?.type
      });
    }
    return payload;
  }

  function showToast(text) {
    const node = $('toast');
    if (!node) return;
    node.textContent = text;
    node.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => node.classList.remove('show'), 3600);
  }

  // --- Proxy settings dialog ---
  function setProxyStatus(text, state = '') {
    $('proxyConfigStatus').textContent = text;
    $('proxyConfigStatus').dataset.state = state;
  }

  function updateProxyBadge(state) {
    proxyTrigger.dataset.enabled = state?.enabled ? 'true' : 'false';
    proxyTrigger.textContent = state?.enabled ? '网络代理 · 已开启' : '网络代理';
    proxyTrigger.title = state?.enabled && state.activeEffectiveProxy
      ? `当前代理：${state.activeEffectiveProxy}`
      : '配置全局网络代理 (HTTP / HTTPS / SOCKS5)';
  }

  function syncProxyInputs(state) {
    $('proxyEnabled').checked = Boolean(state.enabled);
    $('proxyUrlInput').value = state.proxyUrl || '';
    $('proxyNoProxyInput').value = state.noProxy || '127.0.0.1,localhost';
    $('proxyMediaUse').checked = Boolean(state.mediaUseProxy);
    $('proxyResetBtn').hidden = !state.configured;
    const sourceLabel = state.source === 'saved'
      ? (state.enabled ? `已启用面板代理：${state.activeEffectiveProxy}` : '已在面板禁用代理（忽略系统环境变量）')
      : state.source === 'environment'
        ? `当前继承系统环境变量代理：${state.activeEffectiveProxy}`
        : '当前未配置全局代理，上游直连 Google Antigravity API';
    setProxyStatus(sourceLabel, state.enabled ? 'success' : '');
    updateProxyBadge(state);
  }

  function setProxyBusy(value) {
    proxyBusy = value;
    $('proxySaveBtn').disabled = value;
    $('proxyResetBtn').disabled = value;
    $('proxyCloseBtn').disabled = value;
    $('proxySaveBtn').textContent = value ? '保存中…' : '保存并生效';
  }

  async function openProxyDialog() {
    $('proxyConfigError').textContent = '';
    setProxyStatus('正在读取代理配置…');
    proxyDialog.showModal();
    setProxyBusy(true);
    try {
      const state = await api('/dashboard/proxy');
      syncProxyInputs(state);
    } catch (error) {
      setProxyStatus(error.message, 'error');
    } finally {
      setProxyBusy(false);
    }
  }

  $('proxyConfigForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (proxyBusy) return;
    $('proxyConfigError').textContent = '';
    setProxyBusy(true);
    try {
      const state = await api('/dashboard/proxy', 'POST', {
        enabled: $('proxyEnabled').checked,
        proxyUrl: $('proxyUrlInput').value.trim(),
        noProxy: $('proxyNoProxyInput').value.trim(),
        mediaUseProxy: $('proxyMediaUse').checked
      });
      syncProxyInputs(state);
      showToast(state.enabled ? `代理已保存并立即生效：${state.activeEffectiveProxy}` : '代理已关闭并立即生效');
    } catch (error) {
      $('proxyConfigError').textContent = error.message || '保存代理失败。';
      setProxyStatus('代理配置未生效', 'error');
    } finally {
      setProxyBusy(false);
    }
  });

  $('proxyResetBtn').addEventListener('click', async () => {
    if (proxyBusy) return;
    $('proxyConfigError').textContent = '';
    setProxyBusy(true);
    try {
      const state = await api('/dashboard/proxy', 'DELETE');
      syncProxyInputs(state);
      showToast('已清除面板代理配置并恢复系统环境变量');
    } catch (error) {
      $('proxyConfigError').textContent = error.message || '恢复默认失败。';
    } finally {
      setProxyBusy(false);
    }
  });

  $('proxyCloseBtn').addEventListener('click', () => {
    if (!proxyBusy) { proxyDialog.close(); proxyTrigger.focus(); }
  });
  proxyTrigger.addEventListener('click', () => { if (!proxyDialog.open) void openProxyDialog(); });

  // --- Cockpit Tools import dialog ---
  function setCockpitStatus(text, state = '') {
    $('cockpitImportStatus').textContent = text;
    $('cockpitImportStatus').dataset.state = state;
  }

  function setCockpitBusy(value) {
    cockpitBusy = value;
    $('cockpitScanBtn').disabled = value;
    $('cockpitImportConfirmBtn').disabled = value;
    $('cockpitCloseBtn').disabled = value;
    $('cockpitImportConfirmBtn').textContent = value ? '导入中…' : '一键导入全部可用账号';
  }

  function renderCockpitPreview(preview) {
    const dirsText = preview.scannedDirs?.length ? `已扫描目录：${preview.scannedDirs.join('；')}` : '未发现 ~/.cockpit_tools 或 ~/.antigravity_cockpit 目录';
    const skippedTotal = (preview.skipped?.disabled || 0) + (preview.skipped?.pendingOauth || 0) + (preview.skipped?.missingTokens || 0);
    setCockpitStatus(
      `${dirsText} · 找到 ${preview.totalFound || 0} 个可用账号（新增 ${preview.newCount || 0} / 可更新 ${preview.updateCount || 0} / 已存在一致 ${preview.unchangedCount || 0}${skippedTotal ? ` / 忽略禁用或未授权 ${skippedTotal}` : ''}）`,
      preview.totalFound > 0 ? 'success' : ''
    );
    const list = $('cockpitImportPreview');
    if (!preview.accounts?.length) {
      list.innerHTML = '<div class="cockpit-preview-empty">未检测到可导入的有效 Antigravity 账号凭证。可尝试输入自定义的 Cockpit Tools 数据目录或导出的 JSON 文件路径后点击“重新扫描”。</div>';
    } else {
      const label = { new: '待新增', updatable: '有新凭证', unchanged: '已存在(一致)' };
      list.innerHTML = preview.accounts.map(item => (
        `<div class="cockpit-preview-row"><b>${esc(item.email)}</b><span>${esc(label[item.status] || item.status)}</span></div>`
      )).join('');
    }
    const errText = preview.errors?.length
      ? `部分文件未解析（${preview.errors.map(e => `${e.file}: ${e.message}`).join('；')}）`
      : '';
    $('cockpitImportError').textContent = errText;
  }

  async function scanCockpit() {
    $('cockpitImportError').textContent = '';
    setCockpitStatus('正在扫描 Cockpit Tools 数据目录…');
    setCockpitBusy(true);
    try {
      const dir = $('cockpitDataDirInput').value.trim();
      const query = dir ? `?dataDir=${encodeURIComponent(dir)}` : '';
      const preview = await api(`/dashboard/accounts/cockpit-tools/scan${query}`);
      renderCockpitPreview(preview);
    } catch (error) {
      $('cockpitImportError').textContent = error.message || '扫描失败。';
      setCockpitStatus('扫描失败', 'error');
    } finally {
      setCockpitBusy(false);
    }
  }

  $('cockpitScanBtn').addEventListener('click', () => { if (!cockpitBusy) void scanCockpit(); });

  $('cockpitImportConfirmBtn').addEventListener('click', async () => {
    if (cockpitBusy) return;
    $('cockpitImportError').textContent = '';
    setCockpitBusy(true);
    setCockpitStatus('正在解密并导入账号，请稍候…');
    try {
      const result = await api('/dashboard/accounts/cockpit-tools/import', 'POST', {
        dataDir: $('cockpitDataDirInput').value.trim(),
        overwrite: $('cockpitOverwrite').checked
      });
      setCockpitStatus(
        `导入完成：新增 ${result.imported} 个，更新 ${result.updated} 个，已一致跳过 ${result.unchanged} 个。`,
        'success'
      );
      showToast(`已从 Cockpit Tools 导入 ${result.imported} 个、更新 ${result.updated} 个账号`);
      document.getElementById('refresh')?.click();
      const preview = await api(`/dashboard/accounts/cockpit-tools/scan${$('cockpitDataDirInput').value.trim() ? `?dataDir=${encodeURIComponent($('cockpitDataDirInput').value.trim())}` : ''}`);
      renderCockpitPreview(preview);
      setCockpitStatus(
        `导入完成：新增 ${result.imported} 个，更新 ${result.updated} 个，已一致跳过 ${result.unchanged} 个。`,
        'success'
      );
    } catch (error) {
      $('cockpitImportError').textContent = error.message || '导入失败。';
      setCockpitStatus('导入失败', 'error');
    } finally {
      setCockpitBusy(false);
    }
  });

  $('cockpitCloseBtn').addEventListener('click', () => {
    if (!cockpitBusy) { cockpitDialog.close(); cockpitTrigger.focus(); }
  });
  cockpitTrigger.addEventListener('click', () => {
    if (cockpitDialog.open) return;
    cockpitDialog.showModal();
    void scanCockpit();
  });

  // Load initial proxy indicator badge silently on page load.
  void api('/dashboard/proxy').then(updateProxyBadge).catch(() => {});
})();
