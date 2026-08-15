// 账号自动化任务中心。
(function () {
const {
  $, esc, escRaw, api, showToast, confirmDialog, controlValue, setControlValue, formatDateTime,
} = window.GFR;

const TASK_LABELS = {
  codex_retry: '提取Codex',
  access_token_relogin: '测活',
  password_setup: '设置密码',
  twofa_setup: '设置2FA',
  trial_check: '0元试用检测',
};
const STATUS_LABELS = {
  pending: '排队中',
  running: '运行中',
  stopping: '停止中',
  completed: '已完成',
  partial: '部分成功',
  failed: '失败',
  stopped: '已停止',
  cancelled: '已取消',
  interrupted: '已中断',
  success: '成功',
};
const ACTIVE_STATUSES = new Set(['pending', 'running', 'stopping']);
const TERMINAL_STATUSES = new Set(['completed', 'partial', 'failed', 'stopped', 'cancelled', 'interrupted']);
const state = {
  page: 1,
  pageSize: 20,
  total: 0,
  pages: 1,
  tasks: [],
  currentTask: null,
  itemPage: 1,
  itemPageSize: 50,
  itemTotal: 0,
  itemPages: 1,
  pollTimer: null,
  logPollTimer: null,
  searchTimer: null,
  composerPreviewSeq: 0,
  composerPreviewTimer: null,
  selectedTaskIds: new Set(),
  openLog: null,
  composer: { scope: 'filtered', identities: [], filters: {}, count: 0, targetText: '全部账号' },
  trialCheckEnabled: !!window.GFR.trialCheckEnabled,
};

function syncTrialTaskOption() {
  const option = document.querySelector('#automationComposerType-menu [data-value="trial_check"]');
  if (!option) return;
  option.disabled = !state.trialCheckEnabled;
  option.classList.toggle('hidden', !state.trialCheckEnabled);
  option.setAttribute('aria-disabled', state.trialCheckEnabled ? 'false' : 'true');
  if (!state.trialCheckEnabled && controlValue('#automationComposerType') === 'trial_check') {
    setControlValue('#automationComposerType', 'codex_retry');
  }
}

function setTrialCheckEnabled(enabled) {
  state.trialCheckEnabled = !!enabled;
  syncTrialTaskOption();
}

function taskStatusPill(status) {
  const tone = {
    pending: 'status-pending', running: 'status-running', stopping: 'status-running',
    completed: 'status-success', partial: 'status-warning', failed: 'status-failed',
    stopped: 'status-cancelled', cancelled: 'status-cancelled', interrupted: 'status-failed',
    success: 'status-success',
  }[status] || 'status-used';
  return `<span class="pill ${tone}">${esc(STATUS_LABELS[status] || status || '-')}</span>`;
}

function taskProgress(task) {
  const total = Number(task.total_count || 0);
  const done = Number(task.success_count || 0) + Number(task.failed_count || 0)
    + Number(task.cancelled_count || 0) + Number(task.interrupted_count || 0);
  const pct = total ? Math.min(100, Math.round(done * 100 / total)) : 0;
  return `
    <div class="automation-progress" title="成功 ${task.success_count || 0} / 失败 ${task.failed_count || 0} / 取消 ${task.cancelled_count || 0}">
      <div><span style="width:${pct}%"></span></div><small>${done} / ${total}</small>
    </div>`;
}

function renderSummary(summary) {
  $('#automationRunningCount').textContent = String(summary.running || 0);
  $('#automationPendingCount').textContent = String(summary.pending || 0);
  $('#automationCompletedCount').textContent = String(summary.today_completed || 0);
  $('#automationFailedCount').textContent = String(summary.today_failed || 0);
}

function renderTaskPager() {
  const el = $('#pager-automation-tasks');
  if (!el) return;
  el.innerHTML = `
    <button data-task-page="prev" ${state.page <= 1 ? 'disabled' : ''}>← 上一页</button>
    <span class="pager-info">共 ${state.total} 条（第 ${state.page} / ${state.pages} 页）</span>
    <button data-task-page="next" ${state.page >= state.pages ? 'disabled' : ''}>下一页 →</button>`;
}

function renderTasks() {
  const body = $('#automationTasksBody');
  body.innerHTML = state.tasks.map(task => {
    const active = ACTIVE_STATUSES.has(task.status);
    return `<tr data-task-id="${task.id}">
      <td><input type="checkbox" class="automation-task-check" ${state.selectedTaskIds.has(Number(task.id)) ? 'checked' : ''} ${active ? 'disabled' : ''}></td>
      <td class="muted">#${task.id}</td>
      <td><div class="main-cell">${esc(TASK_LABELS[task.task_type] || task.task_type)}</div><div class="sub-cell">${esc(task.task_uuid || '')}</div></td>
      <td>${taskStatusPill(task.status)}</td>
      <td>${taskProgress(task)}</td>
      <td>${esc(task.workers || 1)}</td>
      <td class="muted cell-time">${esc(formatDateTime(task.created_at))}</td>
      <td class="actions-cell"><div class="actions">
        <button data-task-action="detail">详情</button>
        ${active ? '<button class="danger" data-task-action="stop">停止</button>' : '<button data-task-action="retry">重试</button><button class="danger" data-task-action="delete">删除</button>'}
      </div></td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" class="muted">暂无自动化任务</td></tr>';
  const selectable = state.tasks.filter(task => TERMINAL_STATUSES.has(task.status)).map(task => Number(task.id));
  const selectedOnPage = selectable.filter(id => state.selectedTaskIds.has(id)).length;
  const selectAll = $('#automationTaskSelectAll');
  selectAll.checked = selectable.length > 0 && selectedOnPage === selectable.length;
  selectAll.indeterminate = selectedOnPage > 0 && selectedOnPage < selectable.length;
  const deleteSelected = $('#btnDeleteSelectedAutomationTasks');
  deleteSelected.disabled = state.selectedTaskIds.size === 0;
  deleteSelected.textContent = state.selectedTaskIds.size ? `删除选中 · ${state.selectedTaskIds.size}` : '删除选中';
  renderTaskPager();
}

function schedulePoll(hasActiveTasks) {
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
  if (!hasActiveTasks || window.GFR.activeTab !== 'automation-tasks') return;
  state.pollTimer = setTimeout(() => load({ quiet: true }), 2000);
}

function routeTaskId() {
  const match = String(location.hash || '').match(/^#automation-tasks\/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

async function load(opts = {}) {
  const params = new URLSearchParams({
    page: String(state.page),
    page_size: String(state.pageSize),
    group: controlValue('#automationTaskGroup') || 'all',
    status: controlValue('#automationTaskStatus') || '',
    q: $('#qAutomationTasks')?.value.trim() || '',
  });
  try {
    const result = await api(`/api/automation-tasks?${params.toString()}`);
    state.tasks = result.items || [];
    state.total = Number(result.pagination?.total || 0);
    state.page = Number(result.pagination?.page || 1);
    state.pages = Number(result.pagination?.pages || 1);
    renderSummary(result.summary || {});
    setTrialCheckEnabled(result.features?.trial_check_enabled);
    renderTasks();
    if (state.currentTask) await loadDetails(state.currentTask.id, { quiet: true, keepLog: true });
    else if (routeTaskId()) await loadDetails(routeTaskId(), { quiet: true, keepLog: true });
    schedulePoll(!!result.summary?.has_active_tasks);
  } catch (error) {
    schedulePoll(false);
    if (!opts.quiet) showToast('加载自动化任务失败: ' + error.message, 'error');
  }
}

function resultSummary(item) {
  const value = item.result_summary;
  if (!value || typeof value !== 'object') return item.error || '-';
  return Object.entries(value).map(([key, val]) => `${key}: ${val}`).join(' · ') || '-';
}

function renderItemPager() {
  const el = $('#pager-automation-items');
  if (!el) return;
  el.innerHTML = `
    <button data-item-page="prev" ${state.itemPage <= 1 ? 'disabled' : ''}>← 上一页</button>
    <span class="pager-info">共 ${state.itemTotal} 个账号（第 ${state.itemPage} / ${state.itemPages} 页）</span>
    <button data-item-page="next" ${state.itemPage >= state.itemPages ? 'disabled' : ''}>下一页 →</button>`;
}

function closeItemLog() {
  clearTimeout(state.logPollTimer);
  state.logPollTimer = null;
  state.openLog = null;
  const log = $('#automationItemLog');
  log.classList.add('hidden');
  log.textContent = '';
}

function logIsNearBottom(log) {
  return log.scrollHeight - log.scrollTop - log.clientHeight <= 28;
}

function scheduleLogPoll() {
  clearTimeout(state.logPollTimer);
  state.logPollTimer = null;
  if (!state.openLog || window.GFR.activeTab !== 'automation-tasks') return;
  state.logPollTimer = setTimeout(() => {
    state.logPollTimer = null;
    refreshOpenItemLog({ quiet: true });
  }, 2000);
}

function renderOpenLogContent(openLog) {
  const log = $('#automationItemLog');
  if (!log || !openLog) return;
  if (Array.isArray(openLog.events) && openLog.events.length) {
    log.removeAttribute('data-i18n-raw');
    log.textContent = openLog.events.map(window.GFR.renderLogEventText).join('\n');
  } else {
    if (openLog.legacy) log.setAttribute('data-i18n-raw', 'true');
    else log.removeAttribute('data-i18n-raw');
    log.textContent = openLog.log || (openLog.expired ? '任务日志不存在或已清理。' : '暂无日志。');
  }
}

async function refreshOpenItemLog({ reveal = false, quiet = true } = {}) {
  const openLog = state.openLog;
  if (!openLog || openLog.loading || !state.currentTask || Number(state.currentTask.id) !== openLog.taskId) return;
  openLog.loading = true;
  const signatureQuery = openLog.signature ? `?signature=${encodeURIComponent(openLog.signature)}` : '';
  try {
    const result = await api(`/api/automation-tasks/${openLog.taskId}/items/${openLog.itemId}/log${signatureQuery}`);
    if (state.openLog !== openLog) return;
    const log = $('#automationItemLog');
    if (!result.not_modified) {
      openLog.events = result.events || [];
      openLog.log = result.log || '';
      openLog.legacy = Boolean(result.legacy);
      openLog.expired = Boolean(result.expired);
      renderOpenLogContent(openLog);
      openLog.signature = result.signature || '';
    }
    log.classList.remove('hidden');
    if (openLog.followTail) log.scrollTop = log.scrollHeight;
    if (reveal) log.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    if (!quiet) showToast('读取任务日志失败: ' + error.message, 'error');
  } finally {
    if (state.openLog === openLog) openLog.loading = false;
    scheduleLogPoll();
  }
}

function renderDetail(task, items) {
  state.currentTask = task;
  $('#automationTaskDetail').classList.remove('hidden');
  $('#automationTaskDetailTitle').textContent = `#${task.id} · ${TASK_LABELS[task.task_type] || task.task_type}`;
  $('#automationTaskDetailMeta').innerHTML = `
    <div><span>状态</span><strong>${taskStatusPill(task.status)}</strong></div>
    <div><span>账号总数</span><strong>${task.total_count || 0}</strong></div>
    <div><span>成功 / 失败</span><strong>${task.success_count || 0} / ${task.failed_count || 0}</strong></div>
    <div><span>并发线程</span><strong>${task.workers || 1}</strong></div>
    <div><span>创建时间</span><strong>${esc(formatDateTime(task.created_at))}</strong></div>`;
  const active = ACTIVE_STATUSES.has(task.status);
  $('#btnStopAutomationDetail').classList.toggle('hidden', !active);
  $('#btnRetryAutomationDetail').classList.toggle('hidden', active);
  $('#btnDeleteAutomationDetail').classList.toggle('hidden', active);
  $('#btnRetryAutomationDetail').textContent = ['stopped', 'cancelled', 'interrupted'].includes(task.status) ? '重试未完成项' : '重试失败项';
  $('#automationTaskItemsBody').innerHTML = items.map(item => `
    <tr data-task-item-id="${item.id}">
      <td><div class="main-cell clip" title="${escRaw(item.identity_snapshot)}">${esc(item.identity_snapshot)}</div></td>
      <td>${taskStatusPill(item.status)}</td>
      <td class="automation-result-cell" title="${escRaw(resultSummary(item))}">${esc(resultSummary(item))}</td>
      <td class="muted cell-time">${esc(formatDateTime(item.updated_at))}</td>
      <td><button class="btn automation-log-btn" data-item-log="${item.id}">查看</button></td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted">暂无任务明细</td></tr>';
  renderItemPager();
}

async function loadDetails(taskId, opts = {}) {
  try {
    const [detail, itemResult] = await Promise.all([
      api(`/api/automation-tasks/${taskId}`),
      api(`/api/automation-tasks/${taskId}/items?page=${state.itemPage}&page_size=${state.itemPageSize}`),
    ]);
    state.itemTotal = Number(itemResult.pagination?.total || 0);
    state.itemPage = Number(itemResult.pagination?.page || 1);
    state.itemPages = Number(itemResult.pagination?.pages || 1);
    renderDetail(detail.task, itemResult.items || []);
    const sameOpenLog = state.openLog && Number(state.openLog.taskId) === Number(detail.task.id);
    if (!opts.keepLog || !sameOpenLog) closeItemLog();
    else await refreshOpenItemLog({ quiet: true });
    if (!opts.quiet) {
      history.replaceState(null, '', `#automation-tasks/${taskId}`);
      $('#automationTaskDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch (error) {
    if (!opts.quiet) showToast('加载任务详情失败: ' + error.message, 'error');
  }
}

async function stopTask(taskId) {
  if (!await confirmDialog({ title: '停止自动化任务？', tone: 'warning', confirmText: '请求停止', message: '停止后不会再派发新账号；正在执行的账号会在安全检查点退出。' })) return;
  try {
    await api(`/api/automation-tasks/${taskId}/stop`, { method: 'POST' });
    showToast('已提交停止请求', 'success');
    await load();
  } catch (error) { showToast('停止任务失败: ' + error.message, 'error'); }
}

async function retryTask(task) {
  const mode = ['stopped', 'cancelled', 'interrupted'].includes(task.status) ? 'unfinished' : 'failed';
  const label = mode === 'unfinished' ? '未完成项' : '失败项';
  try {
    await api(`/api/automation-tasks/${task.id}/resume`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, workers: task.workers || 3 }),
    });
    closeItemLog();
    showToast(`任务 #${task.id} 的${label}已重新排队`, 'success');
    await load();
  } catch (error) { showToast('重试任务失败: ' + error.message, 'error'); }
}

async function deleteTask(taskId) {
  if (!await confirmDialog({ title: '删除任务历史？', tone: 'error', confirmText: '确认删除', message: '只删除任务记录和任务日志，不会删除账号、Token 或 Codex 凭证。' })) return;
  try {
    await api(`/api/automation-tasks/${taskId}`, { method: 'DELETE' });
    if (state.currentTask?.id === taskId) closeDetails();
    showToast('任务历史已删除', 'success');
    await load();
  } catch (error) { showToast('删除任务失败: ' + error.message, 'error'); }
}

function closeDetails() {
  state.currentTask = null;
  closeItemLog();
  $('#automationTaskDetail').classList.add('hidden');
  if (window.GFR.activeTab === 'automation-tasks') history.replaceState(null, '', '#automation-tasks');
}

function setComposerVisible(visible) {
  const modal = $('#automationTaskComposer');
  if (visible) {
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => modal.classList.add('show'));
  } else {
    modal.classList.remove('show');
    setTimeout(() => { modal.classList.add('hidden'); modal.setAttribute('aria-hidden', 'true'); }, 150);
  }
}

function composerScope() {
  return controlValue('#automationComposerScope') || 'filtered';
}

function setComposerScopeLocked(locked) {
  const select = $('#automationComposerScope');
  select.classList.toggle('is-disabled', locked);
  select.querySelector('.custom-select-trigger').disabled = locked;
}

async function refreshComposerPreview() {
  const scope = composerScope();
  const seq = ++state.composerPreviewSeq;
  const textarea = $('#automationComposerIdentities');
  const hint = $('#automationComposerHint');
  const submit = $('#btnSubmitAutomationComposer');
  const sourceIdentities = scope === 'selected'
    ? (state.composer.manualIdentities || []).slice()
    : [];
  submit.disabled = true;
  textarea.value = '';
  textarea.placeholder = '正在检查账号范围…';
  hint.textContent = `范围：${state.composer.targetText || '当前筛选结果'}，正在检查可执行账号…`;
  try {
    const result = await api('/api/automation-tasks/scope-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task_type: controlValue('#automationComposerType') || 'codex_retry',
        scope,
        identities: sourceIdentities,
        filters: scope === 'filtered' ? (state.composer.filters || {}) : {},
      }),
    });
    if (seq !== state.composerPreviewSeq || composerScope() !== scope) return;
    textarea.value = (result.identities || []).join('\n');
    textarea.placeholder = '当前范围没有可执行账号';
    const skipped = Number(result.skipped || 0);
    const reasonText = Object.entries(result.skipped_reasons || {}).map(([key, count]) => {
      const label = result.skipped_reason_labels?.[key] || key;
      return `${label} ${count}`;
    }).join('，');
    hint.textContent = `请求 ${result.requested || 0} 个，可执行 ${result.account_total || 0} 个${skipped ? `，跳过 ${skipped} 个${reasonText ? `（${reasonText}）` : ''}` : ''}；创建后清单将被冻结。`;
    state.composer.previewEligible = Number(result.account_total || 0);
    submit.disabled = state.composer.previewEligible <= 0;
  } catch (error) {
    if (seq !== state.composerPreviewSeq || composerScope() !== scope) return;
    textarea.value = '';
    textarea.placeholder = '未读取到账号主体';
    hint.textContent = `范围预览失败：${error.message}`;
    state.composer.previewEligible = 0;
    submit.disabled = true;
  }
}

function syncComposerScopeUi() {
  const scope = composerScope();
  const textarea = $('#automationComposerIdentities');
  const label = $('#automationComposerIdentitiesLabel');
  state.composer.scope = scope;
  label.textContent = scope === 'filtered' ? '账号主体预览' : '账号主体（每行一个）';
  textarea.readOnly = scope === 'filtered' || !!state.composer.lockedScope;
  textarea.placeholder = scope === 'filtered' ? '正在读取筛选结果…' : '每行填写一个邮箱或手机号';
  if (scope === 'selected') textarea.value = (state.composer.manualIdentities || []).join('\n');
  refreshComposerPreview();
}

function openComposer(scopeData) {
  const source = scopeData || { scope: 'filtered', identities: [], filters: {}, count: 0, targetText: '全部账号' };
  state.composer = {
    ...source,
    scope: source.scope || 'filtered',
    identities: Array.isArray(source.identities) ? source.identities.slice() : [],
    manualIdentities: Array.isArray(source.identities) ? source.identities.slice() : [],
    filters: source.filters && typeof source.filters === 'object' ? { ...source.filters } : {},
    lockedScope: !!scopeData,
    previewEligible: 0,
  };
  syncTrialTaskOption();
  setControlValue('#automationComposerScope', state.composer.scope);
  setComposerScopeLocked(state.composer.lockedScope);
  syncComposerScopeUi();
  setComposerVisible(true);
}

async function submitComposer() {
  const scope = composerScope();
  const identities = $('#automationComposerIdentities').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const workers = Number($('#automationComposerWorkers').value || 5);
  const btn = $('#btnSubmitAutomationComposer');
  btn.disabled = true;
  try {
    const result = await api('/api/automation-tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task_type: controlValue('#automationComposerType') || 'codex_retry',
        scope,
        identities: scope === 'selected' ? identities : [],
        filters: scope === 'filtered' ? (state.composer.filters || {}) : {},
        workers,
      }),
    });
    setComposerVisible(false);
    showToast(`任务 #${result.task.id} 已创建，账号 ${result.account_total} 个${result.skipped ? `，跳过 ${result.skipped} 个` : ''}`, 'success');
    window.GFR.setActiveTab('automation-tasks');
    state.page = 1;
    await load();
    await loadDetails(result.task.id);
  } catch (error) { showToast('创建任务失败: ' + error.message, 'error'); }
  finally { btn.disabled = Number(state.composer.previewEligible || 0) <= 0; }
}

$('#automationTasksBody')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-task-action]');
  if (!button) return;
  const taskId = Number(button.closest('tr')?.dataset.taskId || 0);
  const task = state.tasks.find(item => Number(item.id) === taskId);
  if (!task) return;
  if (button.dataset.taskAction === 'detail') loadDetails(taskId);
  if (button.dataset.taskAction === 'stop') stopTask(taskId);
  if (button.dataset.taskAction === 'retry') retryTask(task);
  if (button.dataset.taskAction === 'delete') deleteTask(taskId);
});
$('#automationTasksBody')?.addEventListener('change', event => {
  const checkbox = event.target.closest('.automation-task-check');
  if (!checkbox) return;
  const taskId = Number(checkbox.closest('tr')?.dataset.taskId || 0);
  if (checkbox.checked) state.selectedTaskIds.add(taskId);
  else state.selectedTaskIds.delete(taskId);
  renderTasks();
});
$('#automationTaskSelectAll')?.addEventListener('change', event => {
  state.tasks.filter(task => TERMINAL_STATUSES.has(task.status)).forEach(task => {
    if (event.target.checked) state.selectedTaskIds.add(Number(task.id));
    else state.selectedTaskIds.delete(Number(task.id));
  });
  renderTasks();
});

$('#automationTaskItemsBody')?.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-item-log]');
  if (!button || !state.currentTask) return;
  state.openLog = {
    taskId: Number(state.currentTask.id),
    itemId: Number(button.dataset.itemLog),
    signature: '',
    followTail: true,
    loading: false,
    events: [],
    log: '',
    legacy: true,
    expired: false,
  };
  await refreshOpenItemLog({ reveal: true, quiet: false });
});

$('#automationItemLog')?.addEventListener('scroll', event => {
  if (state.openLog) state.openLog.followTail = logIsNearBottom(event.currentTarget);
});

$('#pager-automation-tasks')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-task-page]');
  if (!button) return;
  state.page += button.dataset.taskPage === 'next' ? 1 : -1;
  load();
});
$('#pager-automation-items')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-item-page]');
  if (!button || !state.currentTask) return;
  state.itemPage += button.dataset.itemPage === 'next' ? 1 : -1;
  loadDetails(state.currentTask.id, { keepLog: true });
});
$('#btnRefreshAutomationTasks')?.addEventListener('click', () => load());
$('#btnCancelAutomationComposer')?.addEventListener('click', () => setComposerVisible(false));
$('#btnSubmitAutomationComposer')?.addEventListener('click', submitComposer);
$('#automationTaskComposer')?.addEventListener('click', event => { if (event.target?.id === 'automationTaskComposer') setComposerVisible(false); });
$('#automationComposerScope')?.addEventListener('change', syncComposerScopeUi);
$('#automationComposerType')?.addEventListener('change', () => {
  syncTrialTaskOption();
  refreshComposerPreview();
});
$('#automationComposerIdentities')?.addEventListener('input', event => {
  if (composerScope() !== 'selected' || event.target.readOnly) return;
  state.composer.manualIdentities = event.target.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  state.composerPreviewSeq += 1;
  clearTimeout(state.composerPreviewTimer);
  state.composerPreviewTimer = setTimeout(refreshComposerPreview, 280);
});
$('#btnCloseAutomationDetail')?.addEventListener('click', closeDetails);
$('#btnStopAutomationDetail')?.addEventListener('click', () => state.currentTask && stopTask(state.currentTask.id));
$('#btnRetryAutomationDetail')?.addEventListener('click', () => state.currentTask && retryTask(state.currentTask));
$('#btnDeleteAutomationDetail')?.addEventListener('click', () => state.currentTask && deleteTask(state.currentTask.id));
$('#btnClearAutomationTasks')?.addEventListener('click', async () => {
  if (!await confirmDialog({ title: '清理全部终态历史？', tone: 'error', confirmText: '确认清理', message: '将删除所有已完成、失败、停止、取消和中断任务的记录及任务日志。活动任务不会受影响。' })) return;
  try {
    const result = await api('/api/automation-tasks/clear-completed', { method: 'POST' });
    closeDetails();
    showToast(`已清理 ${result.deleted || 0} 条任务历史`, 'success');
    await load();
  } catch (error) { showToast('清理任务历史失败: ' + error.message, 'error'); }
});
$('#btnDeleteSelectedAutomationTasks')?.addEventListener('click', async () => {
  const taskIds = Array.from(state.selectedTaskIds);
  if (!taskIds.length) return;
  if (!await confirmDialog({ title: '删除选中任务历史？', tone: 'error', confirmText: '确认删除', message: `将删除 ${taskIds.length} 条终态任务及任务日志，不影响账号和凭证。` })) return;
  try {
    const result = await api('/api/automation-tasks/delete-selected', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task_ids: taskIds }),
    });
    state.selectedTaskIds.clear();
    if (state.currentTask && taskIds.includes(Number(state.currentTask.id))) closeDetails();
    showToast(`已删除 ${result.deleted || 0} 条任务历史`, 'success');
    await load();
  } catch (error) { showToast('批量删除任务失败: ' + error.message, 'error'); }
});

['#automationTaskGroup', '#automationTaskStatus'].forEach(selector => $(selector)?.addEventListener('change', () => { state.page = 1; load(); }));
$('#qAutomationTasks')?.addEventListener('input', () => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => { state.page = 1; load(); }, 220);
});

window.GFR.pages = window.GFR.pages || {};
window.GFR.pages.automationTasks = {
  load,
  openComposer,
  setTrialCheckEnabled,
  loadDetails,
  rerenderLocale: () => renderOpenLogContent(state.openLog),
};
syncTrialTaskOption();
})();
