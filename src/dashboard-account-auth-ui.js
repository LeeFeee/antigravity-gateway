/* finesse · component: account-authorization · register=product · tokens: inherited */
(() => {
  'use strict';
  const $ = id => document.getElementById('antigravityAuth' + id);
  const dialog = $('Dialog'), entry = document.getElementById('addAntigravityAccount');
  const base = '/dashboard/accounts/antigravity/oauth', storageKey = 'antigravity-dashboard-oauth-id';
  const pending = new Set(['starting', 'waiting', 'processing']);
  let csrf = '', current = null, timer = null, busy = false, notified = '';
  const storeId = id => { try { if (id) sessionStorage.setItem(storageKey, id); else sessionStorage.removeItem(storageKey); } catch {} };
  const getId = () => { try { return sessionStorage.getItem(storageKey); } catch { return null; } };
  const expired = error => error.status === 404 || error.code === 'dashboard_csrf_invalid';
  function message(text, state = '') { $('Status').textContent = text; $('Status').dataset.state = state; }
  function lock(value) {
    busy = value;
    $('Submit').disabled = value || current?.status !== 'waiting';
    $('Close').disabled = value;
    $('Retry').disabled = value;
    $('Callback').disabled = value || current?.status !== 'waiting';
    $('Submit').textContent = value ? '提交中…' : '提交回调 URL';
    $('Submit').dataset.state = value ? 'loading' : '';
  }
  async function request(suffix = '', method = 'GET', body) {
    const response = await fetch(base + suffix, { method, credentials: 'same-origin', cache: 'no-store',
      headers: { ...(csrf ? { 'x-dashboard-csrf': csrf } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    let result;
    try { result = await response.json(); }
    catch { throw new Error('面板登录可能已过期，请刷新页面后重试。'); }
    if (!response.ok) throw Object.assign(new Error(result.error?.message || '请求失败，请稍后重试。'), { status: response.status, code: result.error?.type });
    return result;
  }
  function render(job) {
    current = job;
    const waiting = job.status === 'waiting', active = pending.has(job.status);
    $('Login').hidden = !waiting;
    $('Form').hidden = !waiting;
    $('Retry').hidden = active || job.status === 'completed';
    $('Close').textContent = active ? '取消授权' : '关闭';
    if (waiting) {
      // Do not turn an unexpected server value into a clickable navigation target.
      const url = new URL(job.url);
      if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth') throw new Error('授权链接无效，请重新授权。');
      $('Url').value = url.href;
      $('Open').href = url.href;
    } else { $('Url').value = ''; $('Open').removeAttribute('href'); }
    if (job.status !== 'waiting') $('Callback').value = '';
    const texts = { starting: '正在创建授权链接…', waiting: '等待 Google 授权，请在 5 分钟内完成。',
      processing: '正在验证授权并保存账号，请稍候…', cancelled: '本次授权已取消，未保存账号。' };
    const success = job.status === 'completed';
    message(success ? (job.account?.email ? job.account.email + '：' : '') + (job.message || '账号已加入账号池。')
      : job.message || texts[job.status] || '授权未完成，请重新添加。', success ? 'success' : job.status === 'failed' ? 'error' : '');
    if (!active) {
      storeId(null);
      clearTimeout(timer);
      if (success && notified !== job.id) { notified = job.id; document.getElementById('refresh').click(); }
    }
    lock(busy);
  }
  function schedule() {
    clearTimeout(timer);
    if (!dialog.open || !current || !pending.has(current.status)) return;
    timer = setTimeout(poll, 1500);
  }
  async function poll() {
    if (busy) { schedule(); return; }
    const id = current.id;
    try {
      const job = await request('/' + id);
      if (dialog.open && !busy && current?.id === id) render(job);
    }
    catch (error) {
      if (!dialog.open || busy || current?.id !== id) { schedule(); return; }
      if (expired(error)) render({ id, status: 'failed', message: error.message });
      else message('暂时无法读取授权状态，正在重试。也可以取消后重新授权。', 'error');
    }
    schedule();
  }
  async function begin(resume = false) {
    clearTimeout(timer);
    current = null;
    $('Error').textContent = '';
    $('Callback').removeAttribute('aria-invalid');
    $('Login').hidden = $('Form').hidden = $('Retry').hidden = true;
    message('正在创建授权链接…');
    lock(true);
    try {
      csrf = (await request()).csrfToken;
      let id = resume ? getId() : null;
      if (id && /^[a-f0-9]{48}$/.test(id)) {
        try { render(await request('/' + id)); return; }
        catch (error) { if (error.status !== 404) throw error; id = null; storeId(null); }
      } else id = null;
      id ||= [...crypto.getRandomValues(new Uint8Array(24))].map(n => n.toString(16).padStart(2, '0')).join('');
      storeId(id);
      current = { id, status: 'starting' };
      render(await request('', 'POST', { id }));
    } catch (error) {
      // Preserve the ID if a POST response was lost: reopening can recover its status.
      if (error.status) { current = null; storeId(null); }
      message(error.message || '创建授权失败，请重试。', 'error');
      $('Retry').hidden = false;
    } finally { lock(false); schedule(); }
  }
  async function close() {
    if (busy) return;
    lock(true);
    try {
      if (current && pending.has(current.status)) {
        try { render(await request('/' + current.id, 'DELETE')); }
        catch (error) { if (!expired(error)) throw error; }
      }
      clearTimeout(timer); storeId(null);
      $('Callback').value = $('Url').value = '';
      $('Open').removeAttribute('href');
      dialog.close(); entry.focus();
    } catch (error) { message(error.message || '取消失败，请重试。', 'error'); }
    finally { lock(false); }
  }
  entry.addEventListener('click', () => { if (dialog.open) return; dialog.showModal(); void begin(true); });
  $('Close').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); void close(); });
  $('Retry').addEventListener('click', async () => {
    if (busy) return;
    if (current && pending.has(current.status)) {
      lock(true);
      try { await request('/' + current.id, 'DELETE'); }
      catch (error) { if (!expired(error)) { message(error.message, 'error'); lock(false); return; } }
      lock(false);
    }
    storeId(null); void begin();
  });
  $('Form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || current?.status !== 'waiting') return;
    const value = $('Callback').value.trim();
    if (!value) return;
    lock(true); $('Error').textContent = ''; $('Callback').removeAttribute('aria-invalid');
    try { render(await request('/' + current.id + '/callback', 'POST', { callbackUrl: value })); }
    catch (error) {
      if (expired(error)) { render({ id: current.id, status: 'failed', message: error.message }); return; }
      $('Error').textContent = error.message || '回调提交失败，请检查完整 URL 后重试。';
      $('Callback').setAttribute('aria-invalid', 'true');
    } finally { lock(false); schedule(); }
  });
  $('Copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('Url').value); message('授权链接已复制，请在浏览器中打开并完成授权。'); }
    catch { $('Url').focus(); $('Url').select(); message('链接已选中，请使用系统复制功能，然后在浏览器中打开。'); }
  });
})();
