// 注册任务页逻辑。
(function () {
const { $, $$, esc, short, pill, showToast, confirmDialog, controlValue, formatDateTime, api, PAGERS, applyPagination, renderPager: _renderPager, registerPagerRenderer } = window.GFR;

let JOBS = [];
let jobsTotal = 0;
let runDefaults = {
  count: 1,
  workers: 3,
  mode: 'email',
  emailSource: 'outlook',
  phoneSmsSource: 'platform',
  proxyConfigured: null,
};
let BATCHES = [];
let statusCounts = { pending: 0, running: 0, success: 0, failed: 0, cancelled: 0 };
let allJobsTotal = 0;
let registerTab = 'jobs';
let pageActive = false;
let pollTimer = null;
let jobsRequest = null;
let jobsRefreshQueued = false;
let logsRequest = null;
let queuedLogOptions = null;
let logSignature = '';
let logAutoScroll = true;
let logRendering = false;
let selectedLogJob = null;
let lastLogEntries = [];
let lastLogMeta = {};
const LOG_MAX_LINES = 700;
const ACTIVE_POLL_INTERVAL_MS = 3000;
const IDLE_POLL_INTERVAL_MS = 10000;

function levelOf(line) {
  const m = String(line || '').match(/\[(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL)\]/i);
  if (!m) return 'info';
  const lv = m[1].toLowerCase();
  if (lv === 'warn') return 'warning';
  if (lv === 'critical') return 'error';
  return lv;
}

function setRegisterTab(tab) {
  registerTab = tab === 'jobs' ? 'jobs' : 'logs';
  $$('[data-register-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.registerTab === registerTab));
  $$('[data-register-panel]').forEach(panel => panel.classList.toggle('hidden', panel.dataset.registerPanel !== registerTab));
  if (registerTab === 'logs') refreshLogs({ force: true });
  if (registerTab === 'jobs') refreshJobs();
}

async function loadRunDefaults() {
  runDefaults.proxyConfigured = null;
  try {
    const r = await api('/api/jobs/defaults');
    runDefaults = {
      count: parseInt(r.count || 1, 10) || 1,
      workers: parseInt(r.workers || 3, 10) || 3,
      mode: r.mode === 'phone' ? 'phone' : 'email',
      emailSource: r.email_source || 'outlook',
      phoneSmsSource: r.phone_sms_source === 'api' ? 'api' : 'platform',
      proxyConfigured: typeof r.proxy_configured === 'boolean' ? r.proxy_configured : null,
    };
    const el = $('#runConfigSummary');
    const sourceLabels = {
      outlook: 'Outlook 邮箱池',
      buygptpuls_temp: 'buygptpuls 临时邮箱',
      api_otp_mail: '邮箱API接码',
    };
    const phoneSourceLabels = {
      platform: '接码平台',
      api: 'API接码',
    };
    const modeLabel = runDefaults.mode === 'phone'
      ? `手机号注册 / ${phoneSourceLabels[runDefaults.phoneSmsSource] || '接码平台'}`
      : `邮箱注册 / ${sourceLabels[runDefaults.emailSource] || runDefaults.emailSource || 'Outlook 邮箱池'}`;
    if (el) el.textContent = `模式 ${modeLabel} · 目标成功 ${runDefaults.count} 个账号 · 并发 ${runDefaults.workers} 线程`;
  } catch (e) {
    const el = $('#runConfigSummary');
    if (el) el.textContent = '默认参数读取失败，请检查运行配置';
  }
}

function statusCount(status) {
  return Math.max(0, Number(statusCounts[status]) || 0);
}

function activeJobCount() {
  return statusCount('pending') + statusCount('running');
}

function latestBatch() {
  return (BATCHES || []).slice().sort((a, b) => (b.batch_id || 0) - (a.batch_id || 0))[0] || null;
}

function renderRunTaskStats() {
  const pending = statusCount('pending');
  const running = statusCount('running');
  const el = $('#runTaskStats');
  if (!el) return;
  const batch = latestBatch();
  if (batch) {
    const target = batch.target_success || runDefaults.count || 0;
    const success = batch.success || 0;
    const failed = batch.failed || 0;
    const active = Math.max(0, (batch.submitted || 0) - (batch.completed || 0));
    const reason = batch.stop_reason ? ` · ${batch.stop_reason}` : '';
    el.textContent = `目标成功 ${success}/${target} · 失败尝试 ${failed} · 活跃 ${active} · 排队 ${pending} · 注册中 ${running}${reason}`;
  } else {
    el.textContent = `目标成功 -/${runDefaults.count || 0} · 排队 ${pending} · 注册中 ${running}`;
  }
}

function hasActiveRegistration() {
  const batch = latestBatch();
  return activeJobCount() > 0 || Boolean(batch && !batch.stopped);
}

function openProxyConfig() {
  localStorage.setItem('gfr.activeConfigTab', 'proxy');
  window.GFR.setActiveTab('config');
  window.GFR.pages?.config?.setActiveConfigTab?.('proxy', { reload: false });
}

async function confirmMissingRegistrationProxy() {
  if (runDefaults.proxyConfigured !== false) return true;
  const goToConfig = await confirmDialog({
    title: '当前没有配置代理',
    tone: 'warning',
    confirmText: '去配置',
    cancelText: '继续直连',
    message: '当前没有配置代理，注册风控可能无法通过。是否前往代理配置？',
  });
  if (!goToConfig) return true;
  openProxyConfig();
  return false;
}

async function startRegistration() {
  await loadRunDefaults();
  if (!await confirmMissingRegistrationProxy()) return;
  const count = runDefaults.count;
  const workers = runDefaults.workers;
  await refreshJobs();
  const activeCount = activeJobCount();
  if (activeCount > 0) {
    const ok = await confirmDialog({
      title: '追加注册批次？',
      tone: 'warning',
      confirmText: '继续启动',
      message: `当前任务表里已有 ${activeCount} 个尝试在跑或排队，` +
      `这次会启动一个目标成功 ${count} 个账号的新批次，确定继续？\n\n` +
      `如需修改目标成功数或并发线程数，请到「运行配置 → 注册配置」调整后保存。`,
    });
    if (!ok) return;
  }
  $('#btnStart').disabled = true;
  $('#regWarn').innerHTML = '';
  selectedLogJob = null;
  logSignature = '';
  $('#btnShowAllLogs')?.classList.add('hidden');
  refreshLogs({ force: true, feed: true });
  renderRunTaskStats();
  const restoreBtn = () => { $('#btnStart').disabled = false; };
  try {
    const r = await api('/api/jobs', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ count, workers }),
    });
    PAGERS.jobs.page = 1;
    selectedLogJob = null;
    logSignature = '';
    $('#btnShowAllLogs')?.classList.add('hidden');
    refreshJobs();
    refreshLogs({ force: true, feed: true });
    // 开始注册后不再显示启动提示，避免占用顶部空间；批次进度看 runTaskStats。
    $('#regWarn').innerHTML = '';
    renderRunTaskStats();
  } catch(e) {
    $('#regWarn').innerHTML = window.GFR.noticeHtml('error', e.message, '提交失败');
  } finally {
    setTimeout(restoreBtn, 3000);
  }
}

function renderJobs() {
  const rows = JOBS;
  $('#jobsBody').innerHTML = rows.map(j => `
    <tr>
      <td class="muted">#${esc(j.id)}</td>
      <td>${pill(j.status)}</td>
      <td class="cell-account"><span class="clip" title="${esc(j.email || '-')}">${esc(j.email || '-')}</span></td>
      <td class="muted">${esc(formatDateTime(j.started_at))}</td>
      <td class="muted">${esc(formatDateTime(j.completed_at))}</td>
      <td class="muted" title="${esc(j.error_message || '')}">${esc(short(j.error_message || '', 40))}</td>
      <td class="actions-cell"><div class="actions"><button data-log-job="${esc(j.id)}">查看日志</button></div></td>
    </tr>`).join('') || '<tr><td colspan="7" class="muted">暂无任务</td></tr>';
  _renderPager('jobs', jobsTotal);
}

// 任务终态变化提示（completed/failed），仅页面可见时提示，防刷屏最多 3 条
let lastJobStates = new Map();

function notifyJobTransitions(jobs) {
  if (document.hidden) return;
  const msgs = [];
  for (const job of jobs || []) {
    const id = job.id;
    const prev = lastJobStates.get(id);
    const now = job.status;
    if (prev && prev !== now && (now === 'completed' || now === 'success')) {
      msgs.push({ text: `任务 #${id} 已完成${job.email ? `（${job.email}）` : ''}`, kind: 'success' });
    } else if (prev && prev !== now && (now === 'failed' || now === 'error')) {
      msgs.push({ text: `任务 #${id} 失败${job.email ? `（${job.email}）` : ''}`, kind: 'error' });
    }
    lastJobStates.set(id, now);
  }
  msgs.slice(-3).forEach(m => showToast(m.text, m.kind));
}

async function performJobsRefresh() {
  const p = PAGERS.jobs;
  const q = $('#qJobs')?.value.trim() || '';
  const status = controlValue('#statusJobs') || '';
  const params = new URLSearchParams({ page: String(p.page), page_size: String(p.size) });
  if (q) params.set('q', q);
  if (status) params.set('status', status);

  try {
    const r = await api(`/api/jobs?${params.toString()}`);
    JOBS = r.items || r.jobs || [];
    notifyJobTransitions(JOBS);
    jobsTotal = r.pagination?.total ?? JOBS.length;
    statusCounts = { ...statusCounts, ...(r.status_counts || {}) };
    allJobsTotal = Math.max(0, Number(r.all_total) || 0);
    BATCHES = Array.isArray(r.batches) ? r.batches : [];
    applyPagination('jobs', r.pagination);
    renderJobs();
    renderRunTaskStats();
    return r;
  } catch(e) {
    showToast('加载任务失败: ' + e.message, 'error');
    return null;
  }
}

async function refreshJobs({ queue = true } = {}) {
  if (jobsRequest) {
    if (queue) jobsRefreshQueued = true;
    return jobsRequest;
  }
  jobsRequest = performJobsRefresh();
  try {
    return await jobsRequest;
  } finally {
    jobsRequest = null;
    if (jobsRefreshQueued) {
      jobsRefreshQueued = false;
      Promise.resolve().then(refreshJobs);
    }
  }
}

function shouldStickToBottom(el) {
  return logAutoScroll || (el.scrollTop + el.clientHeight >= el.scrollHeight - 40);
}

function syncLogAutoState() {
  const layer = $('#logColorLayer');
  if (!layer) return;
  const atBottom = layer.scrollTop + layer.clientHeight >= layer.scrollHeight - 40;
  if (!atBottom && logAutoScroll) {
    logAutoScroll = false;
    updateLogAutoButton();
  }
}

function updateLogAutoButton() {
  const btn = $('#btnToggleLogAuto');
  if (btn) btn.textContent = logAutoScroll ? '暂停滚动' : '恢复滚动';
}

function renderLogEntries(entries, meta = {}) {
  if (logRendering) return;
  lastLogEntries = Array.isArray(entries) ? entries : [];
  lastLogMeta = meta || {};
  logRendering = true;
  window.requestAnimationFrame(() => {
    const layer = $('#logColorLayer');
    if (!layer) { logRendering = false; return; }
    const lines = (entries || []).slice(-LOG_MAX_LINES);
    const stick = shouldStickToBottom(layer);
    const colored = lines.map(item => {
      const line = window.GFR.renderLogEventText(item);
      const level = item.level || levelOf(line);
      const jobTag = item.job_id ? `<span class="log-job-tag">#${esc(item.job_id)}</span>` : '';
      const rawAttr = item.legacy ? ' data-i18n-raw="true"' : '';
      return `<span class="log-line ${esc(level)}"${rawAttr}>${jobTag}${esc(line)}</span>`;
    }).join('') || '<span class="log-line info">(暂无日志)</span>';
    layer.innerHTML = colored;
    const lineCount = $('#logLineCount');
    if (lineCount) lineCount.textContent = `${lines.length} 行${meta.truncated ? ' · 已截断' : ''}`;
    const metaEl = $('#logFeedMeta');
    if (metaEl) {
      metaEl.textContent = selectedLogJob
        ? `正在查看任务 #${selectedLogJob} 日志；自动刷新，最多显示最近 ${meta.line_limit || LOG_MAX_LINES} 行。`
        : `自动刷新，最多显示最近 ${meta.line_limit || LOG_MAX_LINES} 行；聚合最近 ${meta.job_count || 0} 个任务。`;
    }
    if (stick) {
      layer.scrollTop = layer.scrollHeight;
    }
    logRendering = false;
  });
}

async function performLogRefresh(options = {}) {
  if (registerTab !== 'logs' && !options.force) return;
  if (selectedLogJob && !options.feed) {
    try {
      const r = await api(`/api/jobs/${selectedLogJob}/log?max_lines=${LOG_MAX_LINES}`);
      const nextSig = `job-${selectedLogJob}:${r.signature || ''}`;
      if (!options.force && nextSig === logSignature) return;
      logSignature = nextSig;
      renderLogEntries(r.entries || [], { ...r, job_count: 1 });
    } catch(e) {
      if (options.force) showToast('加载任务日志失败: ' + e.message, 'error');
    }
    return;
  }
  const params = new URLSearchParams({
    job_limit: '40',
    max_lines: String(LOG_MAX_LINES),
  });
  try {
    const r = await api(`/api/jobs/logs?${params.toString()}`);
    if (!options.force && r.signature === logSignature) return;
    logSignature = r.signature || '';
    renderLogEntries(r.entries || [], r);
  } catch(e) {
    if (options.force) showToast('加载日志失败: ' + e.message, 'error');
  }
}

async function refreshLogs(options = {}) {
  if (registerTab !== 'logs' && !options.force) return null;
  if (logsRequest) {
    if (options.queue !== false) {
      queuedLogOptions = { ...(queuedLogOptions || {}), ...options };
    }
    return logsRequest;
  }
  logsRequest = performLogRefresh(options);
  try {
    return await logsRequest;
  } finally {
    logsRequest = null;
    if (queuedLogOptions) {
      const nextOptions = queuedLogOptions;
      queuedLogOptions = null;
      Promise.resolve().then(() => refreshLogs(nextOptions));
    }
  }
}

function clearPollTimer() {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function pollingAllowed() {
  return pageActive && !document.hidden && window.GFR.activeTab === 'register';
}

function schedulePoll(delay) {
  clearPollTimer();
  if (!pollingAllowed()) return;
  pollTimer = setTimeout(runPollCycle, delay);
}

async function runPollCycle() {
  pollTimer = null;
  if (!pollingAllowed()) return;
  await Promise.all([refreshJobs({ queue: false }), refreshLogs({ queue: false })]);
  schedulePoll(hasActiveRegistration() ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS);
}

function setPageActive(active) {
  pageActive = Boolean(active);
  clearPollTimer();
  if (pageActive) schedulePoll(0);
}

function handleVisibilityChange() {
  clearPollTimer();
  if (!document.hidden && pageActive) schedulePoll(0);
}

async function stopRegistration() {
  await refreshJobs();
  const activeCount = activeJobCount();
  if (activeCount === 0 && !(latestBatch() && !latestBatch().stopped)) {
    showToast('当前没有正在注册或排队的任务', 'warning');
    return;
  }
  const ok = await confirmDialog({
    title: '停止注册？',
    tone: 'warning',
    confirmText: '确认停止',
    message: '将停止当前注册批次继续补位，并取消所有排队任务。\n\n已经进入运行中的任务不会被强制中断，会在当前尝试结束后自然停止。',
  });
  if (!ok) return;
  const btn = $('#btnStopRegister');
  if (btn) btn.disabled = true;
  try {
    const r = await api('/api/jobs/stop', { method:'POST', headers:{'Content-Type':'application/json'}, body: '{}' });
    showToast(`已停止注册：停止批次 ${r.stopped_batches || 0} 个，取消排队 ${r.cancelled_pending || 0} 个`, 'success');
    selectedLogJob = null;
    logSignature = '';
    $('#btnShowAllLogs')?.classList.add('hidden');
    refreshJobs();
    refreshLogs({ force: true, feed: true });
  } catch(e) {
    showToast('停止注册失败: ' + e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function cancelPendingJobs() {
  await refreshJobs();
  const pendingCount = statusCount('pending');
  if (pendingCount === 0) { showToast('当前没有排队任务', 'warning'); return; }
  if (!await confirmDialog({
    title: '取消排队任务',
    tone: 'warning',
    confirmText: '确认取消',
    message: `确定取消 ${pendingCount} 个排队中的任务吗？已运行中的任务不受影响。`,
  })) return;
  $('#btnCancelPending').disabled = true;
  try {
    const r = await api('/api/jobs/cancel-pending', { method:'POST', headers:{'Content-Type':'application/json'}, body: '{}' });
    showToast(`已取消 ${r.cancelled} 个排队任务`, 'success');
    refreshJobs();
    refreshLogs({ force: true });
  } catch(e) {
    showToast('取消失败: ' + e.message, 'error');
  } finally {
    $('#btnCancelPending').disabled = false;
  }
}

async function resumePendingJobs() {
  await refreshJobs();
  const pendingCount = statusCount('pending');
  if (pendingCount === 0) { showToast('当前没有排队任务', 'warning'); return; }
  if (!await confirmDialog({
    title: '恢复排队任务',
    tone: 'warning',
    confirmText: '确认恢复',
    message: `将把 ${pendingCount} 个仍处于排队状态的任务重新提交到当前服务线程池继续执行。\n\n` +
      `只恢复未开始的排队任务；已运行中但因重启中断的任务不会从中间步骤恢复。`,
  })) return;
  $('#btnResumePending').disabled = true;
  try {
    const r = await api('/api/jobs/resume-pending', { method:'POST', headers:{'Content-Type':'application/json'}, body: '{}' });
    showToast(`已恢复提交 ${r.submitted || 0} 个排队任务`, 'success');
    refreshJobs();
    refreshLogs({ force: true, feed: true });
  } catch(e) {
    showToast('恢复排队任务失败: ' + e.message, 'error');
  } finally {
    $('#btnResumePending').disabled = false;
  }
}

async function markRunningFailed() {
  await refreshJobs();
  const runningCount = statusCount('running');
  if (runningCount === 0) { showToast('当前没有运行中任务', 'warning'); return; }
  if (!await confirmDialog({
    title: '运行中转失败',
    tone: 'warning',
    confirmText: '确认转失败',
    message: `确定把 ${runningCount} 个运行中任务全部改为失败吗？\n\n` +
      `这些任务来自旧进程，重启后已经无法继续执行。`,
  })) return;
  $('#btnMarkRunningFailed').disabled = true;
  try {
    const r = await api('/api/jobs/mark-running-failed', { method:'POST', headers:{'Content-Type':'application/json'}, body: '{}' });
    showToast(`已标记 ${r.marked || 0} 个运行中任务为失败`, 'success');
    refreshJobs();
    refreshLogs({ force: true });
  } catch(e) {
    showToast('标记运行中任务失败: ' + e.message, 'error');
  } finally {
    $('#btnMarkRunningFailed').disabled = false;
  }
}

async function deleteFailedJobs() {
  await refreshJobs();
  const failedCount = statusCount('failed');
  if (failedCount === 0) { showToast('当前没有失败任务', 'warning'); return; }
  if (!await confirmDialog({
    title: '删除失败任务',
    tone: 'error',
    confirmText: '确认删除',
    message: `确定删除 ${failedCount} 个失败任务吗？会同步清理这些任务的日志文件，成功/运行/排队任务不受影响。`,
  })) return;
  $('#btnDeleteFailedJobs').disabled = true;
  try {
    const r = await api('/api/jobs/delete-failed', { method:'POST', headers:{'Content-Type':'application/json'}, body: '{}' });
    showToast(`已删除 ${r.deleted} 个失败任务`, 'success');
    if (selectedLogJob && !JOBS.some(j => j.id === selectedLogJob && j.status !== 'failed')) {
      selectedLogJob = null;
      $('#btnShowAllLogs')?.classList.add('hidden');
      logSignature = '';
    }
    refreshJobs();
    refreshLogs({ force: true, feed: true });
  } catch(e) {
    showToast('删除失败任务失败: ' + e.message, 'error');
  } finally {
    $('#btnDeleteFailedJobs').disabled = false;
  }
}

async function clearAllJobs() {
  await refreshJobs();
  const totalCount = allJobsTotal;
  if (totalCount === 0) { showToast('当前没有任务', 'warning'); return; }
  if (!await confirmDialog({
    title: '清空所有任务',
    tone: 'error',
    confirmText: '确认清空',
    message: `确定清空全部 ${totalCount} 个任务吗？这会删除任务记录和对应日志文件，无法恢复。`,
  })) return;
  $('#btnClearAllJobs').disabled = true;
  try {
    const r = await api('/api/jobs/clear-all', { method:'POST', headers:{'Content-Type':'application/json'}, body: '{}' });
    showToast(`已清空 ${r.deleted || 0} 个任务`, 'success');
    selectedLogJob = null;
    logSignature = '';
    $('#btnShowAllLogs')?.classList.add('hidden');
    PAGERS.jobs.page = 1;
    refreshJobs();
    refreshLogs({ force: true, feed: true });
  } catch(e) {
    showToast('清空任务失败: ' + e.message, 'error');
  } finally {
    $('#btnClearAllJobs').disabled = false;
  }
}

function initEvents() {
  $('#btnStart')?.addEventListener('click', startRegistration);
  $('#btnStopRegister')?.addEventListener('click', stopRegistration);
  $('#btnRefreshJobs')?.addEventListener('click', refreshJobs);
  $('#btnResumePending')?.addEventListener('click', resumePendingJobs);
  $('#btnCancelPending')?.addEventListener('click', cancelPendingJobs);
  $('#btnMarkRunningFailed')?.addEventListener('click', markRunningFailed);
  $('#btnDeleteFailedJobs')?.addEventListener('click', deleteFailedJobs);
  $('#btnClearAllJobs')?.addEventListener('click', clearAllJobs);
  $('#btnRefreshLogs')?.addEventListener('click', () => refreshLogs({ force: true }));
  $('#btnShowAllLogs')?.addEventListener('click', () => {
    selectedLogJob = null;
    logSignature = '';
    $('#btnShowAllLogs')?.classList.add('hidden');
    refreshLogs({ force: true, feed: true });
  });
  $('#btnToggleLogAuto')?.addEventListener('click', () => {
    logAutoScroll = !logAutoScroll;
    updateLogAutoButton();
    if (logAutoScroll) {
      const layer = $('#logColorLayer');
      if (layer) layer.scrollTop = layer.scrollHeight;
    }
  });
  $('#logColorLayer')?.addEventListener('scroll', syncLogAutoState, { passive: true });
  $$('[data-register-tab]').forEach(btn => btn.addEventListener('click', () => setRegisterTab(btn.dataset.registerTab)));

  $('#jobsBody')?.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-log-job]');
    if (!t) return;
    const jobId = parseInt(t.dataset.logJob, 10);
    selectedLogJob = jobId;
    $('#btnShowAllLogs')?.classList.remove('hidden');
    setRegisterTab('logs');
  });

  let jobSearchTimer = null;
  $('#qJobs')?.addEventListener('input', () => {
    PAGERS.jobs.page = 1;
    clearTimeout(jobSearchTimer);
    jobSearchTimer = setTimeout(refreshJobs, 220);
  });
  $('#statusJobs')?.addEventListener('change', () => {
    PAGERS.jobs.page = 1;
    refreshJobs();
  });
}

function initRegisterPage() {
  document.addEventListener('visibilitychange', handleVisibilityChange);
}

initEvents();
registerPagerRenderer('jobs', refreshJobs);
window.GFR.pages = window.GFR.pages || {};
window.GFR.pages.register = {
  refreshJobs,
  renderJobs,
  refreshLogs,
  loadRunDefaults,
  initRegisterPage,
  setPageActive,
  setRegisterTab,
  rerenderLocale: () => {
    renderJobs();
    renderLogEntries(lastLogEntries, lastLogMeta);
    renderRunTaskStats();
    updateLogAutoButton();
  },
};
})();
