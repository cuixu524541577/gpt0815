// 账号页逻辑。
(function () {
const {
  $, esc, escRaw, showToast, copyText, confirmDialog,
  controlValue, formatDateTime, api, t, PAGERS, applyPagination, renderPager: _renderPager, registerPagerRenderer,
} = window.GFR;

let ACCOUNTS = [];
let accountTotal = 0;
let rtExtractEnabled = false;
let accountLoadController = null;
let accountLoadSequence = 0;
let retryLogIdentity = null, retryLogTimer = null;
let retryLogEvents = [], retryLogRaw = '', retryLogLegacy = true;
let ARCHIVE_CATEGORIES = [];
let archiveTotalCount = 0;
let archiveUnarchivedCount = 0;
const selectedIdentities = new Set();
const freePlanRefreshTasks = new Map();
const AUTOMATION_TASK_TERMINAL_STATUSES = new Set([
  'completed', 'partial', 'failed', 'stopped', 'cancelled', 'interrupted',
]);
const FREE_PLAN_REFRESH_POLL_MS = 1500;
const ACCOUNT_EXPORT_FIELDS = [
  { value: 'email', label: '邮箱' },
  { value: 'phone_number', label: '手机号' },
  { value: 'email_password', label: '邮箱密码' },
  { value: 'password', label: 'GPT密码' },
  { value: 'access_token', label: 'Token' },
  { value: 'totp_secret', label: '2FA' },
  { value: 'client_id', label: 'Client ID' },
  { value: 'refresh_token', label: '邮箱 Refresh Token' },
  { value: 'codex_refresh_token', label: 'Codex Refresh Token' },
  { value: 'plan_type', label: 'Plan' },
  { value: 'user_id', label: 'User ID' },
  { value: 'user_name', label: '用户名' },
  { value: 'otp_api_url', label: '邮箱接码API' },
];
const ACCOUNT_IMPORT_FIELDS = ACCOUNT_EXPORT_FIELDS
  .filter(({ value }) => value !== 'codex_refresh_token');
ACCOUNT_IMPORT_FIELDS.push(
  { value: 'mailbox_token', label: '临时邮箱Token' },
  { value: 'mailbox_api_base', label: '临时邮箱API' },
);
const ACCOUNT_EXPORT_PRESETS = {
  email_mailbox_password_client_rt: ['email', 'email_password', 'client_id', 'refresh_token'],
  email_mailbox_password_client_rt_token: ['email', 'email_password', 'client_id', 'refresh_token', 'access_token'],
  email_gpt_password: ['email', 'password', 'totp_secret'],
};
let customExportFields = ['email', 'email_password', 'client_id', 'refresh_token'];
let accountImportFields = ['email', 'email_password', 'client_id', 'refresh_token'];

function accountIdentity(r) {
  return String(r.login_identifier || r.email || r.phone_number || '').trim();
}

function accountLabel(r) {
  return r.display_identity || r.login_identifier || r.email || r.phone_number || '-';
}

function getAccountFilters() {
  return {
    q: $('#qAccounts')?.value.trim() || '',
    source: controlValue('#filterAccountSource') || 'all',
    twofa: controlValue('#filterAccount2fa') || 'all',
    password_status: controlValue('#filterAccountPassword') || 'all',
    codex: controlValue('#filterAccountCodex') || 'all',
    plan_type: controlValue('#filterAccountPlan') || 'all',
    archive: controlValue('#filterAccountArchive') || 'all',
    trial: controlValue('#filterAccountTrial') || 'all',
  };
}

function currentBulkScope() {
  const identities = Array.from(selectedIdentities);
  if (identities.length) {
    return {
      scope: 'selected',
      identities,
      filters: {},
      count: identities.length,
      label: '选中',
      targetText: `勾选 ${identities.length} 个账号`,
    };
  }
  return {
    scope: 'filtered',
    identities: [],
    filters: getAccountFilters(),
    count: accountTotal,
    label: '全部',
    targetText: `当前筛选结果 ${accountTotal} 个账号`,
  };
}

// ---------- 账号 ----------
async function loadAccounts() {
  accountLoadController?.abort();
  const controller = new AbortController();
  accountLoadController = controller;
  const sequence = ++accountLoadSequence;
  $('#accountsTableWrap')?.classList.add('is-loading');
  const p = PAGERS.accounts;
  const filters = getAccountFilters();
  const params = new URLSearchParams({ page: String(p.page), page_size: String(p.size) });
  Object.entries(filters).forEach(([key, value]) => {
    if (value && value !== 'all') params.set(key, value);
  });
  try {
    const r = await api(`/api/accounts?${params.toString()}`, { signal: controller.signal });
    if (sequence !== accountLoadSequence) return;
    ACCOUNTS = r.items || r.accounts || [];
    accountTotal = r.pagination?.total ?? ACCOUNTS.length;
    rtExtractEnabled = !!r.features?.rt_extract_no_sms;
    window.GFR.trialCheckEnabled = !!r.features?.trial_check_enabled;
    window.GFR.pages?.automationTasks?.setTrialCheckEnabled(window.GFR.trialCheckEnabled);
    applyPagination('accounts', r.pagination);
    renderAccounts();
  } catch(e) {
    if (e?.name === 'AbortError') return;
    if (sequence !== accountLoadSequence) return;
    showToast('加载账号失败: ' + e.message, 'error');
  } finally {
    if (sequence === accountLoadSequence) {
      $('#accountsTableWrap')?.classList.remove('is-loading');
      if (accountLoadController === controller) accountLoadController = null;
    }
  }
}

async function loadAccountFilters() {
  const sourceSelect = $('#filterAccountSource');
  if (!sourceSelect) return;
  try {
    const r = await api('/api/accounts/filters');
    const sources = r.sources || [];
    if (r.features) {
      rtExtractEnabled = !!r.features.rt_extract_no_sms;
      window.GFR.trialCheckEnabled = !!r.features.trial_check_enabled;
      window.GFR.pages?.automationTasks?.setTrialCheckEnabled(window.GFR.trialCheckEnabled);
    }
    const current = controlValue(sourceSelect) || 'all';
    const labels = {
      outlook: 'Outlook',
      buygptpuls_temp: 'buygptpuls 临时邮箱',
      api_otp_mail: '邮箱API接码',
      phone: '手机号',
      fixed: '固定邮箱',
    };
    const enabledSources = ['outlook', 'buygptpuls_temp', 'api_otp_mail', 'phone'];
    const allowedSources = new Set(enabledSources);
    const unique = Array.from(new Set([...enabledSources, ...sources.filter(value => allowedSources.has(value))]));
    const options = [
      { value: 'all', label: '全部来源' },
      ...unique.map(value => ({ value, label: labels[value] || value })),
    ];
    sourceSelect.outerHTML = window.GFR.customSelectHtml({
      id: 'filterAccountSource',
      value: options.some(x => x.value === current) ? current : 'all',
      options,
      className: 'filter-select account-source-filter',
      shellClassName: 'filter-select-shell account-source-filter-shell',
      title: '按来源筛选',
    });
    $('#filterAccountSource')?.addEventListener('change', () => {
      PAGERS.accounts.page = 1;
      loadAccounts();
    });
  } catch(e) {
    // 筛选项失败不影响主列表。
  }
  await loadArchiveCategories({ quiet: true });
}

function renderArchiveFilter() {
  const currentElement = $('#filterAccountArchive');
  if (!currentElement) return 'all';
  const current = controlValue(currentElement) || 'all';
  const validValues = new Set(['all', 'unarchived', ...ARCHIVE_CATEGORIES.map(item => String(item.id))]);
  const value = validValues.has(current) ? current : 'all';
  const options = [
    { value: 'all', label: t('accounts.archive.filter_all', null, '全部归档') },
    { value: 'unarchived', label: t('accounts.archive.unarchived', null, '未归档') },
    ...ARCHIVE_CATEGORIES.map(item => ({ value: String(item.id), label: item.name })),
  ];
  currentElement.outerHTML = window.GFR.customSelectHtml({
    id: 'filterAccountArchive',
    value,
    options,
    className: 'filter-select account-archive-filter',
    shellClassName: 'filter-select-shell account-archive-filter-shell',
    title: t('accounts.archive.filter_title', null, '按归档分类筛选'),
  });
  $('#filterAccountArchive')?.addEventListener('change', scheduleAccountReload);
  return value;
}

async function loadArchiveCategories({ quiet = false } = {}) {
  try {
    const result = await api('/api/account-archive-categories');
    ARCHIVE_CATEGORIES = Array.isArray(result.items) ? result.items : [];
    archiveTotalCount = Number(result.total_count || 0);
    archiveUnarchivedCount = Number(result.unarchived_count || 0);
    renderArchiveFilter();
    renderArchiveCategoryList();
    return result;
  } catch (err) {
    if (!quiet) {
      showToast(t('accounts.archive.load_failed', { detail: err.message }, `加载归档分类失败：${err.message}`), 'error');
    }
    return null;
  }
}

function _codexCell(r) {
  const s = r.codex_status || '';
  const err = r.codex_error || '';
  const titleAttr = err ? ` title="${esc(err)}"` : '';
  if (s === 'success') return '<span class="account-state-token ok">成功</span>';
  if (s === 'retrying') return '<span class="account-state-token warning">补跑中</span>';
  if (s === 'failed') return `<span class="account-state-token error"${titleAttr}>失败</span>`;
  if (s === 'skipped') return '<span class="account-state-token muted">已跳过</span>';
  if (s === 'deactivated') {
    const deactivatedTitle = titleAttr || ' title="权益接口返回 401，账号已失效"';
    return `<span class="account-state-token error"${deactivatedTitle}>已废号</span>`;
  }
  return `<span class="muted">-</span>`;
}

function _twofaCell(r) {
  if (!r.has_twofa) {
    return '<span class="twofa-empty" title="未启用 2FA">-</span>';
  }
  return `
    <span class="twofa-shield" title="已启用 2FA" aria-label="已启用 2FA">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 2.7 19 5.6v5.3c0 4.7-2.8 8.8-7 10.4-4.2-1.6-7-5.7-7-10.4V5.6l7-2.9Z"></path>
        <path d="m9.2 12 1.9 1.9 3.9-4.3"></path>
      </svg>
    </span>`;
}

function _accountTypeCell(r) {
  const isPhone = String(r.login_type || '').toLowerCase() === 'phone';
  const label = isPhone ? '手机号' : '邮箱';
  const source = r.email_source || '-';
  return `<div class="account-type-cell"><span class="account-state-token ${isPhone ? 'warning' : 'muted'}">${label}</span><small title="${esc(source)}">${esc(source)}</small></div>`;
}

function _trialTags(r) {
  const eligibility = String(r.trial_eligibility_status || 'unchecked').toLowerCase();
  const failed = String(r.trial_check_status || '').toLowerCase() === 'failed';
  const tags = [];
  if (eligibility === 'eligible') {
    tags.push('<span class="account-state-token ok" title="0 元试用资格已确认" aria-label="有 0 元试用资格">有资格</span>');
  } else if (eligibility === 'not_eligible') {
    tags.push('<span class="account-state-token error" title="当前没有 0 元试用资格" aria-label="无 0 元试用资格">无资格</span>');
  } else if (!failed) {
    tags.push('<span class="account-state-token muted" title="尚未确认 0 元试用资格" aria-label="0 元试用资格未检测">未检测</span>');
  }
  if (failed) {
    const error = r.trial_check_error ? ` title="${esc(r.trial_check_error)}"` : ' title="最近一次试用资格检测失败"';
    tags.push(`<span class="account-state-token error"${error} aria-label="0 元试用资格检测失败">检测失败</span>`);
  }
  return tags.join('');
}

function _accountStatusCell(r) {
  const codexLabel = r.codex_status === 'deactivated' ? '' : '<small>Codex</small>';
  const password = r.has_password
    ? '<span class="account-state-token ok">已设密码</span>'
    : '<span class="account-state-token muted">未设密码</span>';
  const twofa = r.has_twofa
    ? '<span class="account-state-token ok">2FA</span>'
    : '<span class="account-state-token muted">无 2FA</span>';
  return `<div class="account-state-stack"><div class="account-status-line">${codexLabel}${_codexCell(r)}</div><div class="account-status-line"><small>安全</small>${password}${twofa}</div></div>`;
}

function _accountPlanCell(r) {
  const value = String(r.plan_type || '').trim();
  const tone = value.toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'unknown';
  const supported = new Set(['free', 'plus', 'team', 'k12']);
  const identity = accountIdentity(r);
  const refreshing = Boolean(identity && freePlanRefreshTasks.has(identity));
  const refreshButton = tone === 'free' && identity
    ? `<button type="button" class="account-plan-refresh-btn${refreshing ? ' is-refreshing' : ''}" data-plan-refresh="${escRaw(identity)}" title="刷新 AccessToken" aria-label="刷新 AccessToken" aria-busy="${refreshing ? 'true' : 'false'}" ${refreshing ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-4M4 4v5h5M4 13a8 8 0 0 0 14.9 4M20 20v-5h-5"/></svg>
      </button>`
    : '';
  return `<div class="account-plan-cell"><span class="account-plan-label ${supported.has(tone) ? `plan-${tone}` : 'plan-unknown'}">${esc(value || '未知')}</span>${refreshButton}</div>`;
}

function clearFreePlanRefresh(identity) {
  const state = freePlanRefreshTasks.get(identity);
  if (state?.timer) clearTimeout(state.timer);
  freePlanRefreshTasks.delete(identity);
}

function scheduleFreePlanRefreshPoll(identity, delay = FREE_PLAN_REFRESH_POLL_MS) {
  const state = freePlanRefreshTasks.get(identity);
  if (!state?.taskId) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => pollFreePlanRefresh(identity), delay);
}

async function pollFreePlanRefresh(identity) {
  const state = freePlanRefreshTasks.get(identity);
  if (!state?.taskId) return;
  try {
    const result = await api(`/api/automation-tasks/${state.taskId}`);
    const task = result.task || {};
    const status = String(task.status || '').trim().toLowerCase();
    if (!AUTOMATION_TASK_TERMINAL_STATUSES.has(status)) {
      scheduleFreePlanRefreshPoll(identity);
      return;
    }
    clearFreePlanRefresh(identity);
    await loadAccounts();
    if (status === 'completed') {
      showToast(`AccessToken 刷新完成：${identity}`, 'success');
      return;
    }
    showToast(`AccessToken 刷新未完成：${task.error || status || '未知错误'}`, 'error');
  } catch (err) {
    clearFreePlanRefresh(identity);
    renderAccounts();
    showToast('读取 AccessToken 刷新任务失败: ' + err.message, 'error');
  }
}

async function startFreePlanRefresh(identity) {
  if (!identity || freePlanRefreshTasks.has(identity)) return;
  freePlanRefreshTasks.set(identity, { taskId: null, timer: null });
  renderAccounts();
  try {
    const result = await api('/api/accounts/access-token/relogin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'selected',
        identities: [identity],
        filters: {},
      }),
    });
    const taskId = Number(result.task?.id || 0);
    if (!taskId) throw new Error('刷新任务未返回 task ID');
    freePlanRefreshTasks.set(identity, { taskId, timer: null });
    renderAccounts();
    showToast('已创建 AccessToken 刷新任务', 'success');
    scheduleFreePlanRefreshPoll(identity, 500);
  } catch (err) {
    clearFreePlanRefresh(identity);
    renderAccounts();
    showToast('创建 AccessToken 刷新任务失败: ' + err.message, 'error');
  }
}

function _codexAction(r) {
  const s = r.codex_status || '';
  const identity = accountIdentity(r);
  if (!identity) return '';
  const actions = [];
  if (s !== 'success' && s !== 'retrying' && s !== 'deactivated') {
    const title = r.login_type === 'phone'
      ? '跑一次 Codex 授权：手机号登录，必要时按邮箱配置绑定邮箱'
      : '跑一次 Codex 授权：邮箱登录，必要时消耗接码短信绑定手机号';
    actions.push(`<button data-codex-retry="${escRaw(identity)}" title="${escRaw(title)}">跑Codex</button>`);
  }
  actions.push(`<button data-account-log="${escRaw(identity)}" title="查看该账号的 Codex 运行详细日志">日志</button>`);
  return actions.join(' ');
}

function updateSelectionUi() {
  const rows = ACCOUNTS.map(accountIdentity).filter(Boolean);
  const selectedOnPage = rows.filter(id => selectedIdentities.has(id)).length;
  const bulkScope = currentBulkScope();
  const hint = $('#accountsSelectedHint');
  if (hint) hint.textContent = `已选 ${selectedIdentities.size} / 当前 ${accountTotal}`;
  const customExport = $('#btnCustomExportAccounts');
  if (customExport) {
    customExport.disabled = bulkScope.count <= 0;
    customExport.textContent = `自定义导出 · ${bulkScope.count}`;
    customExport.title = `${bulkScope.targetText}；可设置 TXT/JSON、字段和顺序`;
  }
  const archiveButton = $('#btnArchiveAccounts');
  if (archiveButton) {
    archiveButton.disabled = bulkScope.count <= 0;
    archiveButton.textContent = `${t('accounts.archive.action', null, '归档')} · ${bulkScope.count}`;
    archiveButton.title = bulkScope.targetText;
  }
  const rtExtract = $('#btnRtExtractAccounts');
  if (rtExtract) {
    rtExtract.disabled = !rtExtractEnabled || bulkScope.count <= 0;
    rtExtract.textContent = `提RT${bulkScope.label}导出 · ${bulkScope.count}`;
    rtExtract.title = selectedIdentities.size
      ? `选择 CPA / Sub2API，把已勾选 ${bulkScope.count} 个账号转为导入 JSON 下载`
      : `选择 CPA / Sub2API，把当前筛选结果 ${bulkScope.count} 个账号转为导入 JSON 下载；不是无视筛选的全库操作`;
  }
  const reloginAt = $('#btnReloginAccessTokenAccounts');
  if (reloginAt) {
    reloginAt.disabled = bulkScope.count <= 0;
    reloginAt.textContent = `跑AT${bulkScope.label} · ${bulkScope.count}`;
    reloginAt.title = selectedIdentities.size
      ? `重新登录已勾选 ${bulkScope.count} 个账号，获取并写回 ChatGPT Web accessToken`
      : `重新登录当前筛选结果 ${bulkScope.count} 个账号，获取并写回 ChatGPT Web accessToken；不是无视筛选的全库操作`;
  }
  const bulk = $('#btnRetrySelectedCodex');
  if (bulk) bulk.disabled = selectedIdentities.size === 0;
  const createTask = $('#btnCreateAutomationTask');
  if (createTask) {
    createTask.disabled = bulkScope.count <= 0;
    createTask.textContent = `创建任务 · ${bulkScope.count}`;
    createTask.title = `${bulkScope.targetText}；设置任务类型和线程后进入自动化任务中心`;
  }
  const deleteSelected = $('#btnDeleteSelectedAccounts');
  if (deleteSelected) deleteSelected.disabled = selectedIdentities.size === 0;
  const all = $('#accountSelectAll');
  if (all) {
    all.checked = rows.length > 0 && selectedOnPage === rows.length;
    all.indeterminate = selectedOnPage > 0 && selectedOnPage < rows.length;
  }
}

function renderAccounts() {
  const rows = ACCOUNTS;
  $('#accountsBody').innerHTML = rows.map(r => {
    const identity = accountIdentity(r);
    const label = accountLabel(r);
    const createdAt = formatDateTime(r.created_at || r.updated_at);
    const updatedAt = formatDateTime(r.updated_at || r.created_at);
    const accountMeta = [r.email, r.phone_number].filter(Boolean).join(' · ') || '-';
    return `
    <tr data-identity="${escRaw(identity)}">
      <td><input type="checkbox" class="account-row-check" ${selectedIdentities.has(identity) ? 'checked' : ''} ${identity ? '' : 'disabled'}></td>
      <td class="cell-account">
        <div class="main-cell account-login-subject" title="${esc(label)}"><span class="account-login-identity">${esc(label)}</span><span class="account-inline-state">${_trialTags(r)}</span></div>
        <div class="sub-cell clip" title="${esc(accountMeta)}">#${esc(r.id)} · ${esc(accountMeta)}</div>
      </td>
      <td>${_accountTypeCell(r)}</td>
      <td>${_accountStatusCell(r)}</td>
      <td>${_accountPlanCell(r)}</td>
      <td class="account-archive-cell"><span title="${esc(r.archive_category_name || '-')}">${esc(r.archive_category_name || '-')}</span></td>
      <td class="cell-time" title="${esc(`注册：${createdAt}；更新：${updatedAt}`)}">
        <div class="cell-time-stack">
          <div class="cell-time-line"><span class="cell-time-label">注册</span><span>${esc(createdAt)}</span></div>
          <div class="cell-time-line"><span class="cell-time-label">更新</span><span>${esc(updatedAt)}</span></div>
        </div>
      </td>
      <td class="actions-cell"><div class="actions">
        <button type="button" class="primary" data-account-copy="token" data-identity="${escRaw(identity)}" ${r.has_access_token ? '' : 'disabled'}>Token</button>
        <button type="button" class="good" data-account-copy="full_row" data-identity="${escRaw(identity)}" ${r.has_copy_line ? '' : 'disabled'}>整行</button>
      </div></td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" class="muted">暂无账号</td></tr>';
  _renderPager('accounts', accountTotal);
  updateSelectionUi();
}

// ---------- 补跑日志面板 ----------
function openRetryLog(identity) {
  retryLogIdentity = identity;
  $('#retryLogEmail').textContent = identity;
  $('#retryLogPanel').classList.remove('hidden');
  $('#retryLogContent').textContent = '加载中…';
  retryLogEvents = [];
  retryLogRaw = '';
  retryLogLegacy = true;
  pollRetryLog();
  clearInterval(retryLogTimer);
  retryLogTimer = setInterval(pollRetryLog, 2000);
}

function renderRetryLogContent() {
  const content = $('#retryLogContent');
  if (!content) return;
  if (retryLogEvents.length) {
    content.removeAttribute('data-i18n-raw');
    content.textContent = retryLogEvents.map(window.GFR.renderLogEventText).join('\n');
    return;
  }
  if (retryLogLegacy) content.setAttribute('data-i18n-raw', 'true');
  else content.removeAttribute('data-i18n-raw');
  content.textContent = retryLogRaw || '(暂无账号日志；如果刚开始跑Codex，请等待后台写入…)';
}

async function pollRetryLog() {
  if (document.hidden) return;  // 页面不可见时暂停轮询
  if (!retryLogIdentity) return;
  try {
    const r = await api(`/api/codex/retry-log?identity=${encodeURIComponent(retryLogIdentity)}&max_bytes=160000`);
    const c = $('#retryLogContent');
    const atBottom = c.scrollTop + c.clientHeight >= c.scrollHeight - 30;
    retryLogEvents = r.events || [];
    retryLogRaw = r.log || '';
    retryLogLegacy = Boolean(r.legacy);
    renderRetryLogContent();
    if (atBottom) c.scrollTop = c.scrollHeight;
    if (!r.running) {
      clearInterval(retryLogTimer);
      loadAccounts();
    }
  } catch(e) {}
}

$('#btnCloseRetryLog').addEventListener('click', () => {
  retryLogIdentity = null;
  clearInterval(retryLogTimer);
  $('#retryLogPanel').classList.add('hidden');
});

async function enqueueCodexRetry(identity, label) {
  const display = label || identity;
  if (!await confirmDialog({
    title: '跑Codex授权？',
    tone: 'warning',
    confirmText: '开始跑Codex',
    message: `${display}\n\n邮箱账号会走邮箱 OTP，必要时消耗接码短信；手机号账号会用手机号密码登录，必要时按当前邮箱配置绑定邮箱。\n\n跑Codex会在后台进行，详细过程会写入该账号日志。`,
  })) return false;
  const r = await api('/api/codex/retry', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({identity}),
  });
  showToast(r.message || '已开始跑Codex', 'success');
  loadAccounts();
  openRetryLog(r.identity || identity);
  return true;
}

async function deleteSelectedAccounts() {
  const identities = Array.from(selectedIdentities);
  if (!identities.length) return;
  if (!await confirmDialog({
    title: '删除勾选账号？',
    tone: 'error',
    confirmText: '确认删除',
    message: `将删除 ${identities.length} 个已勾选账号资产。\n\n注意：这不会把已用邮箱重新放回可用池，避免误复用注册过的邮箱。`,
  })) return;
  $('#btnDeleteSelectedAccounts').disabled = true;
  try {
    const r = await api('/api/accounts/delete-selected', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identities }),
    });
    showToast(`已删除 ${r.deleted || 0} 个账号`, 'success');
    selectedIdentities.clear();
    loadAccounts();
  } catch (err) {
    showToast('删除勾选账号失败: ' + err.message, 'error');
  } finally {
    updateSelectionUi();
  }
}

async function deleteFailedAccounts() {
  const failedCount = await (async () => {
    const params = new URLSearchParams({ page: '1', page_size: '1', codex: 'failed' });
    const r = await api(`/api/accounts?${params.toString()}`);
    return r.pagination?.total ?? 0;
  })().catch(() => ACCOUNTS.filter(r => r.codex_status === 'failed').length);
  if (failedCount === 0) {
    showToast('当前没有失败账号', 'warning');
    return;
  }
  if (!await confirmDialog({
    title: '删除失败账号？',
    tone: 'error',
    confirmText: '确认删除',
    message: `将删除所有 Codex 状态为失败的账号资产（共 ${failedCount} 个）。\n\n删除后会同步更新导出文件。`,
  })) return;
  $('#btnDeleteFailedAccounts').disabled = true;
  try {
    const r = await api('/api/accounts/delete-failed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    showToast(`已删除 ${r.deleted || 0} 个失败账号`, 'success');
    selectedIdentities.clear();
    loadAccounts();
  } catch (err) {
    showToast('删除失败账号失败: ' + err.message, 'error');
  } finally {
    updateSelectionUi();
  }
}

async function deleteAllAccounts() {
  const button = $('#btnDeleteAllAccounts');
  if (button) button.disabled = true;
  try {
    const countResult = await api('/api/accounts/count');
    const total = Number(countResult.total || 0);
    if (total <= 0) {
      showToast('当前没有账号可删除', 'warning');
      return;
    }
    if (!await confirmDialog({
      title: '删除全部账号？',
      tone: 'error',
      confirmText: '继续',
      message: `将删除账号资产表中的全部 ${total} 个账号，当前搜索和筛选条件会被忽略。\n\n邮箱池状态、注册任务和自动化任务历史不会删除。`,
    })) return;
    if (!await confirmDialog({
      title: '再次确认永久删除',
      tone: 'error',
      confirmText: '永久删除全部账号',
      message: `此操作不可恢复，将永久删除 ${total} 个账号资产。\n\n运行中的任务仍可能在删除后写入新账号。`,
    })) return;
    const result = await api('/api/accounts/delete-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    selectedIdentities.clear();
    PAGERS.accounts.page = 1;
    await Promise.all([
      loadAccounts(),
      window.GFR.pages.dashboard?.loadSummary?.(),
    ]);
    showToast(`已删除全部 ${result.deleted || 0} 个账号`, 'success');
  } catch (err) {
    showToast('删除全部账号失败: ' + err.message, 'error');
  } finally {
    if (button) button.disabled = false;
    updateSelectionUi();
  }
}

function filenameFromDisposition(cd, fallback) {
  const text = cd || '';
  let m = text.match(/filename\*=UTF-8''([^;]+)/i);
  if (m) return decodeURIComponent(m[1].replace(/"/g, ''));
  m = text.match(/filename="([^"]+)"/i) || text.match(/filename=([^;]+)/i);
  return m ? m[1].replace(/"/g, '').trim() : fallback;
}

function fieldLabel(field, pool = ACCOUNT_EXPORT_FIELDS) {
  return pool.find(item => item.value === field)?.label || field;
}

function uniqueFields(fields, pool) {
  const allowed = new Set(pool.map(item => item.value));
  const seen = new Set();
  const out = [];
  (fields || []).forEach(field => {
    if (!allowed.has(field) || seen.has(field)) return;
    seen.add(field);
    out.push(field);
  });
  return out;
}

function fillFieldSelect(selector, pool, selectedFields) {
  const select = $(selector);
  if (!select) return 0;
  const selected = new Set(selectedFields || []);
  const options = pool.filter(item => !selected.has(item.value));
  const id = select.id || selector.replace(/^#/, '');
  const current = controlValue(select);
  const value = options.some(item => item.value === current) ? current : (options[0]?.value || '');
  select.outerHTML = window.GFR.customSelectHtml({
    id,
    value,
    options: options.length
      ? options.map(item => ({ value: item.value, label: `${item.label} (${item.value})` }))
      : [{ value: '', label: '没有可添加字段' }],
    className: 'filter-select account-io-select',
    shellClassName: 'filter-select-shell account-io-select-shell',
    title: '选择要添加的字段',
  });
  return options.length;
}

function fieldActionIcon(kind) {
  const icons = {
    up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5l-7 7m7-7 7 7M12 6v13"/></svg>',
    down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19l7-7m-7 7-7-7M12 18V5"/></svg>',
    delete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M9 7l1-2h4l1 2m-8 0 1 13h8l1-13"/></svg>',
  };
  return icons[kind] || '';
}

function renderFieldList({ listSelector, addSelector, fields, pool, onChange }) {
  const list = $(listSelector);
  if (!list) return;
  list.innerHTML = fields.map((field, index) => `
    <div class="account-io-field-item" data-field="${escRaw(field)}">
      <strong>${esc(fieldLabel(field, pool))}<small>${esc(field)}</small></strong>
      <button type="button" class="btn account-io-icon-btn" data-field-move="up" title="上移" aria-label="上移" ${index === 0 ? 'disabled' : ''}>${fieldActionIcon('up')}</button>
      <button type="button" class="btn account-io-icon-btn" data-field-move="down" title="下移" aria-label="下移" ${index === fields.length - 1 ? 'disabled' : ''}>${fieldActionIcon('down')}</button>
      <button type="button" class="btn danger account-io-icon-btn" data-field-remove="${escRaw(field)}" title="删除" aria-label="删除" ${fields.length <= 1 ? 'disabled' : ''}>${fieldActionIcon('delete')}</button>
    </div>`).join('') || '<div class="muted">请至少添加一个字段</div>';
  const availableCount = fillFieldSelect(addSelector, pool, fields);
  const addButtonMap = {
    '#customExportAddField': '#btnCustomExportAddField',
    '#accountImportAddField': '#btnAccountImportAddField',
  };
  const addBtn = $(addButtonMap[addSelector]);
  if (addBtn) addBtn.disabled = availableCount === 0;
  list.querySelectorAll('[data-field-move]').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.account-io-field-item');
      const field = item?.dataset.field || '';
      const idx = fields.indexOf(field);
      if (idx < 0) return;
      const dir = btn.dataset.fieldMove === 'up' ? -1 : 1;
      const next = idx + dir;
      if (next < 0 || next >= fields.length) return;
      const copy = fields.slice();
      [copy[idx], copy[next]] = [copy[next], copy[idx]];
      onChange(copy);
    });
  });
  list.querySelectorAll('[data-field-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const field = btn.dataset.fieldRemove || '';
      if (!field || fields.length <= 1) return;
      onChange(fields.filter(item => item !== field));
    });
  });
}

function setModalVisible(selector, visible) {
  const modal = $(selector);
  if (!modal) return;
  if (visible) {
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => modal.classList.add('show'));
  } else {
    modal.classList.remove('show');
    setTimeout(() => {
      modal.classList.add('hidden');
      modal.setAttribute('aria-hidden', 'true');
    }, 150);
  }
}

function renderCustomExportFields() {
  customExportFields = uniqueFields(customExportFields, ACCOUNT_EXPORT_FIELDS);
  renderFieldList({
    listSelector: '#customExportFieldList',
    addSelector: '#customExportAddField',
    fields: customExportFields,
    pool: ACCOUNT_EXPORT_FIELDS,
    onChange: fields => {
      customExportFields = fields;
      renderCustomExportFields();
    },
  });
}

function renderAccountImportFields() {
  accountImportFields = uniqueFields(accountImportFields, ACCOUNT_IMPORT_FIELDS);
  renderFieldList({
    listSelector: '#accountImportFieldList',
    addSelector: '#accountImportAddField',
    fields: accountImportFields,
    pool: ACCOUNT_IMPORT_FIELDS,
    onChange: fields => {
      accountImportFields = fields;
      renderAccountImportFields();
    },
  });
}

function addSelectedField(selectSelector, fields, pool, onChange) {
  const select = $(selectSelector);
  const field = controlValue(select) || '';
  if (!field) return;
  const allowed = new Set(pool.map(item => item.value));
  if (!allowed.has(field) || fields.includes(field)) return;
  onChange([...fields, field]);
}

function syncCustomExportFormatUi() {
  const isJson = (controlValue('#customExportFormat') || 'txt') === 'json';
  $('#customExportDelimiterWrap')?.classList.toggle('hidden', isJson);
}

function syncAccountImportFormatUi() {
  const isJson = (controlValue('#accountImportFormat') || 'txt') === 'json';
  $('#accountImportFieldWrap')?.classList.toggle('hidden', isJson);
  $('#accountImportDelimiterWrap')?.classList.toggle('hidden', isJson);
}

function openCustomExportModal() {
  const bulkScope = currentBulkScope();
  if (bulkScope.count <= 0) {
    showToast('当前没有可导出的账号', 'warning');
    return;
  }
  const hint = $('#customExportScopeHint');
  if (hint) hint.textContent = `当前范围：${bulkScope.targetText}。未勾选时只导出当前筛选结果，不会无视筛选导全库。`;
  syncCustomExportFormatUi();
  renderCustomExportFields();
  setModalVisible('#customExportModal', true);
  setTimeout(() => $('#customExportFormat .custom-select-trigger')?.focus(), 0);
}

function closeCustomExportModal() {
  setModalVisible('#customExportModal', false);
}

async function startCustomExport() {
  const bulkScope = currentBulkScope();
  if (bulkScope.count <= 0) {
    showToast('当前没有可导出的账号', 'warning');
    return;
  }
  const fmt = (controlValue('#customExportFormat') || 'txt').trim();
  const delimiter = $('#customExportDelimiter')?.value || '----';
  const fields = uniqueFields(customExportFields, ACCOUNT_EXPORT_FIELDS);
  if (!fields.length) {
    showToast('请至少选择一个导出字段', 'warning');
    return;
  }
  const btn = $('#btnStartCustomExport');
  if (btn) btn.disabled = true;
  try {
    const resp = await fetch('/api/accounts/custom-export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        format: fmt,
        fields,
        delimiter,
        include_header: false,
        scope: bulkScope.scope,
        identities: bulkScope.identities,
        filters: bulkScope.filters || {},
      }),
    });
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      throw new Error(e.error || ('HTTP ' + resp.status));
    }
    const dlname = filenameFromDisposition(resp.headers.get('Content-Disposition'), `accounts-custom-${Date.now()}.${fmt}`);
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = dlname;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 800);
    closeCustomExportModal();
    showToast(`自定义导出已开始下载：${bulkScope.targetText}`, 'success');
  } catch (err) {
    showToast('自定义导出失败: ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
    updateSelectionUi();
  }
}

function openAccountImportModal() {
  syncAccountImportFormatUi();
  renderAccountImportFields();
  const result = $('#accountImportResult');
  if (result) {
    result.classList.add('hidden');
    result.textContent = '';
  }
  setModalVisible('#accountImportModal', true);
  setTimeout(() => $('#accountImportText')?.focus(), 0);
}

function closeAccountImportModal() {
  $('#btnImportAccounts')?.focus({ preventScroll: true });
  setModalVisible('#accountImportModal', false);
}

function openRtExtractModal() {
  if (!rtExtractEnabled) {
    showToast('提RT不接码功能当前不可用，请刷新页面后重试', 'warning');
    return;
  }
  const bulkScope = currentBulkScope();
  if (bulkScope.count <= 0) {
    showToast('当前没有可提取的账号', 'warning');
    return;
  }
  const hint = $('#rtExtractModalHint');
  if (hint) hint.textContent = `当前范围：${bulkScope.targetText}。未勾选时只处理当前筛选结果，不会无视筛选扫全库。`;
  setModalVisible('#rtExtractModal', true);
  setTimeout(() => $('#btnRtExtractChooseCpa')?.focus(), 0);
}

function closeRtExtractModal() {
  setModalVisible('#rtExtractModal', false);
}

async function chooseRtExtractTarget(target) {
  closeRtExtractModal();
  await downloadRtExtract(target);
}

function renderAccountImportResult(result) {
  const panel = $('#accountImportResult');
  if (!panel) return;
  const lines = [];
  lines.push(`解析 ${result.parsed || 0} 条；新增 ${result.inserted || 0}，更新 ${result.updated || 0}，跳过 ${result.skipped || 0}`);
  if (result.overwrite) lines.push('覆盖模式：已启用（只用导入的非空值覆盖）');
  const poolSync = (result.items || []).flatMap(item => item.email_pool_sync || []);
  const synced = poolSync.filter(item => item.action !== 'conflict');
  const conflicts = poolSync.filter(item => item.action === 'conflict');
  if (synced.length) {
    const outlookCount = synced.filter(item => item.pool === 'outlook').length;
    const apiCount = synced.filter(item => item.pool === 'api_otp_mail').length;
    lines.push(`邮箱池同步：Outlook ${outlookCount}，API 接码 ${apiCount}（均标记为已使用）`);
  }
  if (conflicts.length) {
    lines.push('');
    lines.push(`邮箱池关联冲突（${conflicts.length}）：`);
    conflicts.slice(0, 20).forEach(item => {
      const poolLabel = item.pool === 'api_otp_mail' ? 'API 接码' : 'Outlook';
      lines.push(`- ${item.email || '-'}：${poolLabel} 已关联账号 ${item.conflict_account_id || '-'}`);
    });
    if (conflicts.length > 20) lines.push(`... 还有 ${conflicts.length - 20} 条`);
  }
  const errors = result.errors || [];
  if (errors.length) {
    lines.push('');
    lines.push(`错误/跳过明细（${errors.length}）：`);
    errors.slice(0, 20).forEach(item => {
      const pos = item.line ? `第${item.line}行` : (item.index ? `第${item.index}条` : '-');
      lines.push(`- ${pos}: ${item.error || '未知错误'}${item.identity ? ` (${item.identity})` : ''}`);
    });
    if (errors.length > 20) lines.push(`... 还有 ${errors.length - 20} 条`);
  }
  panel.textContent = lines.join('\n');
  panel.classList.remove('hidden');
}

async function startAccountImport() {
  const fmt = (controlValue('#accountImportFormat') || 'txt').trim();
  const delimiter = $('#accountImportDelimiter')?.value || '----';
  const overwrite = !!$('#accountImportOverwrite')?.checked;
  const text = $('#accountImportText')?.value || '';
  const fields = uniqueFields(accountImportFields, ACCOUNT_IMPORT_FIELDS);
  if (!text.trim()) {
    showToast('请先粘贴导入内容', 'warning');
    return;
  }
  if (fmt === 'txt' && !fields.length) {
    showToast('请至少选择一个 TXT 字段', 'warning');
    return;
  }
  const btn = $('#btnStartAccountImport');
  if (btn) btn.disabled = true;
  try {
    const result = await api('/api/accounts/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        format: fmt,
        text,
        delimiter,
        fields,
        overwrite,
      }),
    });
    renderAccountImportResult(result);
    showToast(`导入完成：新增 ${result.inserted || 0}，更新 ${result.updated || 0}，跳过 ${result.skipped || 0}`, result.ok ? 'success' : 'warning');
    selectedIdentities.clear();
    loadAccounts();
  } catch (err) {
    showToast('导入账号失败: ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function downloadRtExtract(target) {
  if (!rtExtractEnabled) {
    showToast('提RT不接码功能当前不可用，请刷新页面后重试', 'warning');
    return;
  }
  const bulkScope = currentBulkScope();
  if (bulkScope.count <= 0) {
    showToast('当前没有可提取的账号', 'warning');
    return;
  }
  const targetLabel = target === 'cpa' ? 'CPA' : 'Sub2API';
  const scopeHint = bulkScope.scope === 'selected'
    ? `勾选 ${bulkScope.count} 个账号`
    : `当前筛选结果 ${bulkScope.count} 个账号`;
  if (!await confirmDialog({
    title: `提RT不接码 → ${targetLabel}`,
    tone: 'warning',
    confirmText: '开始提取',
    message: `将把${scopeHint}的 ChatGPT Web session/accessToken 转成 ${targetLabel} 导入 JSON 并下载。\n\n未勾选时只处理当前筛选结果，不会无视筛选扫全库。\n不会执行 Codex OAuth，也不会触发手机接码。Web session 通常没有真实 refresh_token，转换结果是否可长期使用取决于目标工具和 token 有效期。`,
  })) return;

  const btn = $('#btnRtExtractAccounts');
  const chooseBtn = target === 'cpa' ? $('#btnRtExtractChooseCpa') : $('#btnRtExtractChooseSub2api');
  if (btn) btn.disabled = true;
  if (chooseBtn) chooseBtn.disabled = true;
  try {
    const resp = await fetch('/api/accounts/rt-extract/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target,
        scope: bulkScope.scope,
        identities: bulkScope.identities,
        filters: bulkScope.filters || {},
      }),
    });
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      throw new Error(e.error || ('HTTP ' + resp.status));
    }
    const dlname = filenameFromDisposition(resp.headers.get('Content-Disposition'), `accounts-rt-${target}-${Date.now()}.json`);
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = dlname;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 800);
    showToast(`${targetLabel} 提取文件已开始下载：${scopeHint}`, 'success');
  } catch (err) {
    showToast(`提取 ${targetLabel} 失败: ${err.message}`, 'error');
  } finally {
    if (chooseBtn) chooseBtn.disabled = false;
    updateSelectionUi();
  }
}

function renderAccountBulkResult(title, result) {
  const panel = $('#accountBulkResultPanel');
  const titleEl = $('#accountBulkResultTitle');
  const summaryEl = $('#accountBulkResultSummary');
  const contentEl = $('#accountBulkResultContent');
  if (!panel || !titleEl || !summaryEl || !contentEl) return;
  const success = result?.success || 0;
  const failed = result?.failed || 0;
  titleEl.textContent = title || '账号批量操作结果';
  summaryEl.textContent = `成功 ${success} / 失败 ${failed}`;
  const lines = [];
  lines.push(`范围：${result?.scope || '-'}；请求 ${result?.requested ?? '-'}；实际账号 ${result?.account_total ?? '-'}`);
  lines.push(`结果：成功 ${success}，失败 ${failed}`);
  lines.push('');
  (result?.items || []).forEach((item, idx) => {
    const flag = item.ok ? 'OK' : 'FAIL';
    const identity = item.identity || '-';
    const source = item.source ? ` source=${item.source}` : '';
    const token = item.access_token_preview ? ` AT=${item.access_token_preview}...` : '';
    const msg = item.message ? ` ${item.message}` : '';
    lines.push(`${idx + 1}. [${flag}] ${identity} status=${item.status || '-'}${source}${token}${msg}`);
  });
  if (!(result?.items || []).length) {
    lines.push('(暂无明细)');
  }
  contentEl.textContent = lines.join('\n');
  panel.classList.remove('hidden');
}

async function reloginAccessTokens() {
  const bulkScope = currentBulkScope();
  if (bulkScope.count <= 0) {
    showToast('当前没有可跑AT的账号', 'warning');
    return;
  }
  const scopeHint = bulkScope.scope === 'selected'
    ? `勾选 ${bulkScope.count} 个账号`
    : `当前筛选结果 ${bulkScope.count} 个账号`;
  if (!await confirmDialog({
    title: '重新登录跑AT？',
    tone: 'warning',
    confirmText: '开始跑AT',
    message: `将对${scopeHint}重新登录 ChatGPT Web，获取新的 accessToken 并写回账号资产。\n\n手机号账号需要手机号+密码；邮箱账号需要可用邮箱 OTP 素材（Outlook client_id/refresh_token、API 接码地址或本地邮箱上下文）。\n\n不会跑 Codex OAuth，也不会更新 Codex 凭证文件。`,
  })) return;

  const btn = $('#btnReloginAccessTokenAccounts');
  if (btn) btn.disabled = true;
  try {
    const result = await api('/api/accounts/access-token/relogin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: bulkScope.scope,
        identities: bulkScope.identities,
        filters: bulkScope.filters || {},
      }),
    });
    renderAccountBulkResult('跑AT结果', result);
    const failed = result.failed || 0;
    showToast(`跑AT完成：成功 ${result.success || 0}，失败 ${failed}`, failed ? 'warning' : 'success');
    loadAccounts();
  } catch (err) {
    showToast('跑AT失败: ' + err.message, 'error');
  } finally {
    updateSelectionUi();
  }
}

// 跑 Codex 按钮（事件委托）
$('#accountsBody').addEventListener('click', async (e) => {
  const copyBtn = e.target.closest('[data-account-copy]');
  if (copyBtn) {
    const identity = copyBtn.dataset.identity || '';
    const kind = copyBtn.dataset.accountCopy || '';
    copyBtn.disabled = true;
    try {
      const result = await api('/api/accounts/copy-value', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity, kind }),
      });
      await copyText(result.value || '');
    } catch (err) {
      showToast('复制账号数据失败: ' + err.message, 'error');
    } finally {
      if (copyBtn.isConnected) copyBtn.disabled = false;
    }
    return;
  }
  const refreshBtn = e.target.closest('[data-plan-refresh]');
  if (refreshBtn) {
    await startFreePlanRefresh(refreshBtn.dataset.planRefresh || '');
    return;
  }
  const logBtn = e.target.closest('[data-account-log]');
  if (logBtn) {
    openRetryLog(logBtn.dataset.accountLog);
    return;
  }
  const btn = e.target.closest('[data-codex-retry]');
  if (!btn) return;
  const identity = btn.dataset.codexRetry;
  btn.disabled = true;
  try {
    await enqueueCodexRetry(identity, identity);
  } catch(err) {
    showToast('触发跑Codex失败: ' + err.message, 'error');
    btn.disabled = false;
  }
});

$('#accountsBody').addEventListener('change', (e) => {
  const chk = e.target.closest('.account-row-check');
  if (!chk) return;
  const identity = chk.closest('tr')?.dataset.identity || '';
  if (!identity) return;
  if (chk.checked) selectedIdentities.add(identity);
  else selectedIdentities.delete(identity);
  updateSelectionUi();
});

$('#accountSelectAll')?.addEventListener('change', (e) => {
  const checked = !!e.target.checked;
  ACCOUNTS.map(accountIdentity).filter(Boolean).forEach(identity => {
    if (checked) selectedIdentities.add(identity);
    else selectedIdentities.delete(identity);
  });
  renderAccounts();
});

$('#btnRetrySelectedCodex')?.addEventListener('click', async () => {
  const identities = Array.from(selectedIdentities);
  if (!identities.length) return;
  if (!await confirmDialog({
    title: '批量跑Codex？',
    tone: 'warning',
    confirmText: '开始跑Codex',
    message: `将对 ${identities.length} 个账号提交后台跑Codex。邮箱/手机号账号都会按最新 Codex 授权流程执行，详细过程会分别写入账号日志。`,
  })) return;
  $('#btnRetrySelectedCodex').disabled = true;
  try {
    const r = await api('/api/codex/retry-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identities }),
    });
    showToast(`已排队 ${r.queued || 0} 个跑Codex任务${r.errors?.length ? `，失败 ${r.errors.length} 个` : ''}`, r.errors?.length ? 'warning' : 'success');
    loadAccounts();
    if (r.items?.[0]?.identity) openRetryLog(r.items[0].identity);
  } catch (err) {
    showToast('批量跑Codex失败: ' + err.message, 'error');
  } finally {
    updateSelectionUi();
  }
});

$('#btnDeleteSelectedAccounts')?.addEventListener('click', deleteSelectedAccounts);
$('#btnDeleteFailedAccounts')?.addEventListener('click', deleteFailedAccounts);
$('#btnDeleteAllAccounts')?.addEventListener('click', deleteAllAccounts);
$('#btnArchiveAccounts')?.addEventListener('click', openAccountArchiveModal);
$('#btnCancelAccountArchive')?.addEventListener('click', closeAccountArchiveModal);
$('#btnApplyAccountArchive')?.addEventListener('click', applyAccountArchive);
$('#btnManageArchiveCategories')?.addEventListener('click', () => setArchiveModalView('manage'));
$('#btnBackToArchiveAssign')?.addEventListener('click', () => setArchiveModalView('assign'));
$('#btnCloseArchiveManage')?.addEventListener('click', closeAccountArchiveModal);
$('#btnCreateArchiveCategory')?.addEventListener('click', createArchiveCategory);
$('#accountArchiveCategoryName')?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  createArchiveCategory();
});
$('#accountArchiveCategoryList')?.addEventListener('click', (event) => {
  const save = event.target.closest('[data-archive-category-save]');
  if (save) {
    const row = save.closest('[data-archive-category-row]');
    renameArchiveCategory(save.dataset.archiveCategorySave, row);
    return;
  }
  const remove = event.target.closest('[data-archive-category-delete]');
  if (remove) deleteArchiveCategory(remove.dataset.archiveCategoryDelete);
});
$('#accountArchiveModal')?.addEventListener('click', (event) => {
  if (event.target?.id === 'accountArchiveModal') closeAccountArchiveModal();
});
$('#btnCustomExportAccounts')?.addEventListener('click', openCustomExportModal);
$('#btnCreateAutomationTask')?.addEventListener('click', () => {
  window.GFR.pages.automationTasks?.openComposer(currentBulkScope());
});
$('#btnImportAccounts')?.addEventListener('click', openAccountImportModal);
$('#btnRtExtractAccounts')?.addEventListener('click', openRtExtractModal);
$('#btnReloginAccessTokenAccounts')?.addEventListener('click', reloginAccessTokens);
$('#btnCloseAccountBulkResult')?.addEventListener('click', () => $('#accountBulkResultPanel')?.classList.add('hidden'));
$('#btnCancelRtExtractModal')?.addEventListener('click', closeRtExtractModal);
$('#rtExtractModal')?.addEventListener('click', (e) => {
  if (e.target?.id === 'rtExtractModal') closeRtExtractModal();
});
$('#btnRtExtractChooseCpa')?.addEventListener('click', () => chooseRtExtractTarget('cpa'));
$('#btnRtExtractChooseSub2api')?.addEventListener('click', () => chooseRtExtractTarget('sub2api'));
$('#btnCancelCustomExport')?.addEventListener('click', closeCustomExportModal);
$('#btnStartCustomExport')?.addEventListener('click', startCustomExport);
$('#customExportModal')?.addEventListener('click', (e) => {
  if (e.target?.id === 'customExportModal') closeCustomExportModal();
});
$('#customExportFormat')?.addEventListener('change', syncCustomExportFormatUi);
$('#customExportPreset')?.addEventListener('change', (e) => {
  const preset = controlValue(e.target) || 'email_mailbox_password_client_rt';
  customExportFields = (ACCOUNT_EXPORT_PRESETS[preset] || ACCOUNT_EXPORT_PRESETS.email_mailbox_password_client_rt).slice();
  renderCustomExportFields();
});
$('#btnCustomExportAddField')?.addEventListener('click', () => {
  addSelectedField('#customExportAddField', customExportFields, ACCOUNT_EXPORT_FIELDS, fields => {
    customExportFields = fields;
    renderCustomExportFields();
  });
});
$('#btnCancelAccountImport')?.addEventListener('click', closeAccountImportModal);
$('#btnStartAccountImport')?.addEventListener('click', startAccountImport);
$('#accountImportModal')?.addEventListener('click', (e) => {
  if (e.target?.id === 'accountImportModal') closeAccountImportModal();
});
$('#btnAccountImportAddField')?.addEventListener('click', () => {
  addSelectedField('#accountImportAddField', accountImportFields, ACCOUNT_IMPORT_FIELDS, fields => {
    accountImportFields = fields;
    renderAccountImportFields();
  });
});
$('#accountImportFormat')?.addEventListener('change', syncAccountImportFormatUi);
let accountSearchTimer = null;
function scheduleAccountReload() {
  PAGERS.accounts.page = 1;
  clearTimeout(accountSearchTimer);
  accountSearchTimer = setTimeout(loadAccounts, 220);
}

async function copyCurrentPageLines() {
  const identities = ACCOUNTS.map(accountIdentity).filter(Boolean);
  if (!identities.length) {
    showToast('当前页没有可复制的账号', 'warning');
    return;
  }
  const button = $('#copyAllLines');
  if (button) button.disabled = true;
  try {
    const result = await api('/api/accounts/copy-values', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identities }),
    });
    const values = result.values || [];
    if (!values.length) {
      showToast('当前页没有可复制的整行数据', 'warning');
      return;
    }
    await copyText(values.join('\n'));
  } catch (err) {
    showToast('复制当前页失败: ' + err.message, 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

function renderArchiveTargetSelect() {
  const host = $('#accountArchiveTargetHost');
  if (!host) return;
  const options = [
    { value: '', label: t('accounts.archive.choose', null, '请选择归档分类') },
    { value: 'unarchived', label: t('accounts.archive.unarchived', null, '未归档') },
    ...ARCHIVE_CATEGORIES.map(item => ({ value: String(item.id), label: item.name })),
  ];
  host.innerHTML = window.GFR.customSelectHtml({
    id: 'accountArchiveTarget',
    value: '',
    options,
    className: 'filter-select account-archive-target',
    shellClassName: 'filter-select-shell account-archive-target-shell',
    title: t('accounts.archive.target', null, '目标分类'),
  });
}

function renderArchiveCategoryList() {
  const list = $('#accountArchiveCategoryList');
  if (!list) return;
  if (!ARCHIVE_CATEGORIES.length) {
    list.innerHTML = `<div class="account-archive-empty">${esc(t('accounts.archive.empty', null, '暂无归档分类'))}</div>`;
    return;
  }
  list.innerHTML = ARCHIVE_CATEGORIES.map(item => {
    const count = Number(item.account_count || 0);
    return `
      <div class="account-archive-category-row" data-archive-category-row="${escRaw(item.id)}">
        <input class="ui-control" data-archive-category-name value="${escRaw(item.name)}" maxlength="32" aria-label="${escRaw(t('accounts.archive.category_name', null, '分类名称'))}">
        <span class="account-archive-category-count">${esc(t('accounts.archive.category_count', { count }, `${count} 个账号`))}</span>
        <button type="button" class="btn" data-archive-category-save="${escRaw(item.id)}" title="${escRaw(t('accounts.archive.save', null, '保存'))}">${esc(t('accounts.archive.save', null, '保存'))}</button>
        <button type="button" class="btn danger" data-archive-category-delete="${escRaw(item.id)}" title="${escRaw(t('accounts.archive.delete', null, '删除'))}">${esc(t('accounts.archive.delete', null, '删除'))}</button>
      </div>`;
  }).join('');
}

function setArchiveModalView(mode) {
  const managing = mode === 'manage';
  $('#accountArchiveAssignView')?.classList.toggle('hidden', managing);
  $('#accountArchiveManageView')?.classList.toggle('hidden', !managing);
  if (managing) {
    renderArchiveCategoryList();
    setTimeout(() => $('#accountArchiveCategoryName')?.focus(), 0);
  } else {
    renderArchiveTargetSelect();
    setTimeout(() => $('#accountArchiveTarget .custom-select-trigger')?.focus(), 0);
  }
}

function archiveScopeText(scope) {
  if (scope.scope === 'selected') {
    return t('accounts.archive.scope_selected', { count: scope.count }, `已勾选 ${scope.count} 个账号`);
  }
  return t('accounts.archive.scope_filtered', { count: scope.count }, `当前筛选结果 ${scope.count} 个账号`);
}

async function openAccountArchiveModal() {
  const scope = currentBulkScope();
  if (scope.count <= 0) {
    showToast(t('accounts.archive.no_accounts', null, '当前没有可归档账号'), 'warning');
    return;
  }
  const loaded = await loadArchiveCategories();
  if (!loaded) return;
  const hint = $('#accountArchiveScopeHint');
  if (hint) hint.textContent = archiveScopeText(scope);
  setArchiveModalView('assign');
  setModalVisible('#accountArchiveModal', true);
}

function closeAccountArchiveModal() {
  setModalVisible('#accountArchiveModal', false);
}

async function applyAccountArchive() {
  const scope = currentBulkScope();
  if (scope.count <= 0) {
    showToast(t('accounts.archive.no_accounts', null, '当前没有可归档账号'), 'warning');
    return;
  }
  const selectedTarget = controlValue('#accountArchiveTarget');
  if (!selectedTarget) {
    showToast(t('accounts.archive.choose', null, '请选择归档分类'), 'warning');
    return;
  }
  const button = $('#btnApplyAccountArchive');
  if (button) button.disabled = true;
  try {
    const response = await api('/api/accounts/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: scope.scope,
        identities: scope.identities,
        filters: scope.filters || {},
        target_category_id: selectedTarget === 'unarchived' ? null : Number(selectedTarget),
      }),
    });
    const result = response.result || {};
    selectedIdentities.clear();
    closeAccountArchiveModal();
    await loadArchiveCategories({ quiet: true });
    await loadAccounts();
    showToast(t('accounts.archive.assign_success', {
      moved: Number(result.moved || 0),
      unchanged: Number(result.unchanged || 0),
      not_found: Number(result.not_found || 0),
    }, `归档完成：移动 ${result.moved || 0} 个，未变化 ${result.unchanged || 0} 个，未找到 ${result.not_found || 0} 个`), 'success');
  } catch (err) {
    showToast(t('accounts.archive.assign_failed', { detail: err.message }, `归档账号失败：${err.message}`), 'error');
  } finally {
    if (button) button.disabled = false;
    updateSelectionUi();
  }
}

async function createArchiveCategory() {
  const input = $('#accountArchiveCategoryName');
  const name = input?.value.trim() || '';
  if (!name) {
    showToast(t('accounts.archive.name_required', null, '请输入分类名称'), 'warning');
    input?.focus();
    return;
  }
  const button = $('#btnCreateArchiveCategory');
  if (button) button.disabled = true;
  try {
    const response = await api('/api/account-archive-categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (input) input.value = '';
    await loadArchiveCategories({ quiet: true });
    showToast(t('accounts.archive.create_success', { name: response.item?.name || name }, `已创建归档分类：${response.item?.name || name}`), 'success');
    input?.focus();
  } catch (err) {
    showToast(t('accounts.archive.save_failed', { detail: err.message }, `保存归档分类失败：${err.message}`), 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

async function renameArchiveCategory(categoryId, row) {
  const input = row?.querySelector('[data-archive-category-name]');
  const name = input?.value.trim() || '';
  if (!name) {
    showToast(t('accounts.archive.name_required', null, '请输入分类名称'), 'warning');
    input?.focus();
    return;
  }
  try {
    const response = await api(`/api/account-archive-categories/${encodeURIComponent(categoryId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    await loadArchiveCategories({ quiet: true });
    showToast(t('accounts.archive.rename_success', { name: response.item?.name || name }, `已更新归档分类：${response.item?.name || name}`), 'success');
  } catch (err) {
    showToast(t('accounts.archive.save_failed', { detail: err.message }, `保存归档分类失败：${err.message}`), 'error');
  }
}

async function deleteArchiveCategory(categoryId) {
  const category = ARCHIVE_CATEGORIES.find(item => String(item.id) === String(categoryId));
  if (!category) return;
  const count = Number(category.account_count || 0);
  if (!await confirmDialog({
    title: t('accounts.archive.delete_title', null, '删除归档分类？'),
    tone: 'error',
    confirmText: t('accounts.archive.delete', null, '删除'),
    message: t('accounts.archive.delete_message', { name: category.name, count }, `分类“${category.name}”下有 ${count} 个账号。删除分类后，这些账号将恢复为未归档。`),
  })) return;
  try {
    const response = await api(`/api/account-archive-categories/${encodeURIComponent(categoryId)}`, {
      method: 'DELETE',
    });
    await loadArchiveCategories({ quiet: true });
    PAGERS.accounts.page = 1;
    await loadAccounts();
    const resetCount = Number(response.result?.reset_count || 0);
    showToast(t('accounts.archive.delete_success', { count: resetCount }, `已删除归档分类，${resetCount} 个账号恢复为未归档`), 'success');
  } catch (err) {
    showToast(t('accounts.archive.delete_failed', { detail: err.message }, `删除归档分类失败：${err.message}`), 'error');
  }
}

['#qAccounts'].forEach(sel => {
  $(sel)?.addEventListener('input', scheduleAccountReload);
});
['#filterAccountSource', '#filterAccount2fa', '#filterAccountPassword', '#filterAccountCodex', '#filterAccountPlan', '#filterAccountArchive', '#filterAccountTrial'].forEach(sel => {
  $(sel)?.addEventListener('change', scheduleAccountReload);
});
$('#copyAllLines').addEventListener('click', copyCurrentPageLines);

registerPagerRenderer('accounts', loadAccounts);
window.GFR.pages = window.GFR.pages || {};
window.GFR.pages.accounts = {
  loadAccounts,
  renderAccounts,
  loadAccountFilters,
  rerenderLocale: () => {
    renderArchiveFilter();
    renderArchiveCategoryList();
    renderArchiveTargetSelect();
    renderAccounts();
    renderRetryLogContent();
  },
};
loadAccountFilters();
})();
