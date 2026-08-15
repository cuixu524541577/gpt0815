// 支付链接提取、扫码商与设置管理。
(function () {
const {
  $, $$, api, esc, formatDateTime, showToast, copyText, confirmDialog,
} = window.GFR;

const STATUS_LABELS = {
  local_queued: '等待提交', submitting: '提交中', queued: '上游排队',
  extracting: '提取中', done: '提取完成', available: '待领取', claimed: '扫码中',
  waiting: '待支付', processing: '支付处理中', succeeded: '支付成功',
  failed: '失败', canceled: '已取消', expired: '已过期', untrackable: '无法监听',
};
const CLAIM_STATUS_LABELS = {
  claimed: '等待扫码', release_pending: '正在核验', released: '未支付，已释放',
  succeeded: '已扫码并支付', failed: '扫码或支付失败', canceled: '已取消',
  expired: '未成功，二维码失效', untrackable: '无法监听支付状态',
};
const state = {
  activePanel: 'tasks', taskPage: 1, taskPages: 1, taskTotal: 0,
  scannerPage: 1, scannerPages: 1, scannerTotal: 0,
  tasks: [], scanners: [], pollTimer: null, searchTimer: null, initialized: false,
  extractStatuses: new Map(), audioContext: null,
};

function statusPill(status) {
  const tone = status === 'succeeded' ? 'success'
    : ['failed', 'canceled', 'expired', 'untrackable'].includes(status) ? 'failed'
      : ['extracting', 'queued', 'submitting', 'claimed'].includes(status) ? 'active' : '';
  return `<span class="upi-status ${tone}">${esc(STATUS_LABELS[status] || status || '-')}</span>`;
}

function bestLink(task) {
  return task.result_link || task.nicepay_checkout_url || task.kakao_pay_url
    || task.upi_instructions_url || task.provider_redirect_url
    || task.kakao_intermediate_url || task.kakao_qr_url || task.upi_qr_url || '';
}

function providerLabel(provider) {
  return String(provider || 'upi').toLowerCase() === 'kakao' ? 'Kakao' : 'UPI';
}

function elapsed(task) {
  const start = task.submitted_at || task.created_at;
  const end = task.extract_completed_at || task.updated_at;
  if (!start || !end) return '-';
  const seconds = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return '-';
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function remaining(value) {
  if (!value) return '-';
  const seconds = Math.floor((new Date(value).getTime() - Date.now()) / 1000);
  if (!Number.isFinite(seconds)) return '-';
  if (seconds <= 0) return '已过期';
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function taskRemaining(task) {
  if (task.payment_status === 'succeeded') return '已支付';
  if (task.payment_status === 'expired') return '已过期';
  return task.extract_status === 'done' ? remaining(task.qr_expires_at) : '-';
}

function updateTaskCountdowns() {
  if (document.hidden) return;  // 页面不可见时暂停倒计时刷新（恢复时按时间戳自动校正）
  $$('[data-upi-countdown]').forEach(element => {
    element.textContent = remaining(element.dataset.upiCountdown);
  });
}

function taskActions(task) {
  const actions = ['<button data-upi-task-action="logs">查看日志</button>'];
  if (task.extract_status === 'local_queued') {
    const label = Number(task.submit_attempts || 0) > 0 || task.error_code ? '重试' : '提交';
    actions.push(`<button data-upi-task-action="submit" title="提交当前本地待提交任务">${label}</button>`);
  }
  if (task.extract_status === 'failed' && task.upstream_job_id) actions.push('<button data-upi-task-action="retry" title="复用当前上游任务 ID 调用重试接口">重试</button>');
  if (['local_queued', 'queued'].includes(task.extract_status)) actions.push('<button class="danger" data-upi-task-action="cancel">取消</button>');
  const canReextract = task.source !== 'manual_token' && (
    ['failed', 'canceled'].includes(task.extract_status)
    || ['failed', 'canceled', 'expired', 'untrackable'].includes(task.payment_status)
  );
  if (canReextract) {
    actions.push('<button data-upi-task-action="reextract" title="保留本地任务 ID，清空旧结果并创建新的上游任务">重新提交</button>');
  }
  return actions.join('') || '<span class="muted">-</span>';
}

function unlockSuccessSound() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!state.audioContext) state.audioContext = new AudioContextClass();
  if (state.audioContext.state === 'suspended') state.audioContext.resume().catch(() => {});
  return state.audioContext;
}

function playExtractionSuccessSound() {
  const context = unlockSuccessSound();
  if (!context || context.state !== 'running') return;
  const start = context.currentTime + 0.02;
  [[659.25, 0], [880, 0.14]].forEach(([frequency, offset]) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, start + offset);
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(0.12, start + offset + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.12);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(start + offset);
    oscillator.stop(start + offset + 0.13);
  });
}

function detectExtractionSuccess(tasks) {
  let completed = false;
  tasks.forEach(task => {
    const key = String(task.id);
    const current = String(task.extract_status || '');
    const previous = state.extractStatuses.get(key);
    if (previous && previous !== 'done' && current === 'done') completed = true;
    state.extractStatuses.set(key, current);
  });
  if (completed) playExtractionSuccessSound();
}

function renderPager(selector, page, pages, total, kind) {
  $(selector).innerHTML = `
    <button type="button" data-upi-page="${kind}:prev" ${page <= 1 ? 'disabled' : ''}>上一页</button>
    <span class="pager-info">共 ${total} 条（第 ${page} / ${pages} 页）</span>
    <button type="button" data-upi-page="${kind}:next" ${page >= pages ? 'disabled' : ''}>下一页</button>`;
}

function renderTasks(payload) {
  state.tasks = payload.items || [];
  detectExtractionSuccess(state.tasks);
  state.taskPage = Number(payload.pagination?.page || 1);
  state.taskPages = Number(payload.pagination?.pages || 1);
  state.taskTotal = Number(payload.pagination?.total || 0);
  $('#upiOccupiedCount').textContent = String(payload.occupied_capacity || 0);
  $('#upiAvailableCount').textContent = String(payload.available_scan_tasks || 0);
  $('#upiTaskBody').innerHTML = state.tasks.map(task => {
    const link = bestLink(task);
    const result = link
      ? `<div class="upi-result-cell"><a href="${esc(link)}" target="_blank" rel="noopener noreferrer" title="${esc(link)}">${esc(link)}</a><div class="upi-row-actions"><button data-upi-copy-link>复制</button></div></div>`
      : `<span class="muted">${esc(task.error_message || '-')}</span>`;
    const countdown = task.extract_status === 'done'
      && !['succeeded', 'expired'].includes(task.payment_status)
      && task.qr_expires_at
      ? ` data-upi-countdown="${esc(task.qr_expires_at)}"`
      : '';
    return `<tr data-upi-task-id="${task.id}">
      <td class="muted">#${task.id}</td>
      <td><div class="main-cell">${esc(task.email_snapshot || '-')}</div></td>
      <td><span class="upi-status">${esc(providerLabel(task.provider))}</span></td>
      <td>${statusPill(task.status)}</td>
      <td>${result}</td>
      <td class="cell-time">${esc(formatDateTime(task.submitted_at || task.created_at))}</td>
      <td class="upi-countdown"${countdown}>${esc(taskRemaining(task))}</td>
      <td>${esc(elapsed(task))}</td>
      <td><div class="upi-row-actions">${taskActions(task)}</div></td>
    </tr>`;
  }).join('') || '<tr><td colspan="9" class="muted">暂无支付链接提取任务</td></tr>';
  renderPager('#upiTaskPager', state.taskPage, state.taskPages, state.taskTotal, 'task');
}

function scheduleTasks() {
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
  if (window.GFR.activeTab !== 'upi' || state.activePanel !== 'tasks') return;
  state.pollTimer = setTimeout(() => loadTasks({ quiet: true }), 5000);
}

async function loadTasks(opts = {}) {
  const params = new URLSearchParams({
    page: String(state.taskPage), page_size: '20',
    status: $('#upiTaskStatus')?.value || '', q: $('#upiTaskSearch')?.value.trim() || '',
  });
  try {
    renderTasks(await api(`/api/upi/tasks?${params.toString()}`));
  } catch (error) {
    if (!opts.quiet) showToast(`加载支付链接任务失败：${error.message}`, 'error');
  } finally {
    scheduleTasks();
  }
}

function money(cents) { return (Number(cents || 0) / 100).toFixed(2); }

function renderScanners(payload) {
  state.scanners = payload.items || [];
  state.scannerPage = Number(payload.pagination?.page || 1);
  state.scannerPages = Number(payload.pagination?.pages || 1);
  state.scannerTotal = Number(payload.pagination?.total || 0);
  $('#upiScannerBody').innerHTML = state.scanners.map(scanner => {
    const expiredCount = Number(scanner.consecutive_expired_count || 0);
    const guard = expiredCount > 0
      ? `<small title="${esc(scanner.blocked_reason || '连续二维码过期次数')}">连续过期 ${expiredCount}/2</small>`
      : '';
    return `<tr data-upi-scanner-id="${scanner.id}">
    <td>${esc(scanner.note || '-')}</td>
    <td><div class="upi-scanner-status-cell"><span class="upi-status ${scanner.status === 'active' ? 'active' : 'paused'}">${scanner.status === 'active' ? '启用' : '暂停'}</span>${guard}</div></td>
    <td>$${money(scanner.reward_cents)}</td>
    <td>$${money(scanner.balance_cents)}</td>
    <td>${scanner.active_claim_count || 0}</td>
    <td>${scanner.success_count || 0}</td>
    <td class="upi-link-cell"><code title="${esc(scanner.link)}">${esc(scanner.link)}</code><div class="upi-row-actions"><button data-upi-scanner-action="copy">复制</button><button data-upi-scanner-action="open">打开</button></div></td>
    <td><div class="upi-row-actions">
      <button data-upi-scanner-action="edit">修改</button>
      <button data-upi-scanner-action="toggle">${scanner.status === 'active' ? '暂停' : '启用'}</button>
      <button data-upi-scanner-action="ledger">流水</button>
      <button class="danger" data-upi-scanner-action="reset">重置链接</button>
    </div></td>
  </tr>`;
  }).join('') || '<tr><td colspan="8" class="muted">暂无扫码商</td></tr>';
  renderPager('#upiScannerPager', state.scannerPage, state.scannerPages, state.scannerTotal, 'scanner');
}

async function loadScanners(opts = {}) {
  try {
    const params = new URLSearchParams({ page: String(state.scannerPage), page_size: '20' });
    renderScanners(await api(`/api/upi/scanners?${params.toString()}`));
  } catch (error) {
    if (!opts.quiet) showToast(`加载扫码商失败：${error.message}`, 'error');
  }
}

function openScannerModal(scanner = null) {
  $('#upiScannerModalTitle').textContent = scanner ? '修改扫码商' : '创建扫码商';
  $('#upiScannerId').value = scanner?.id || '';
  $('#upiScannerNote').value = scanner?.note || '';
  $('#upiScannerReward').value = scanner ? money(scanner.reward_cents) : '0.50';
  const modal = $('#upiScannerModal');
  modal.classList.remove('hidden');
  requestAnimationFrame(() => modal.classList.add('show'));
  $('#upiScannerNote').focus();
}

function closeModal(selector) {
  const modal = $(selector);
  modal.classList.remove('show');
  setTimeout(() => modal.classList.add('hidden'), 170);
}

function openManualSubmitModal() {
  const modal = $('#upiManualSubmitModal');
  modal.classList.remove('hidden');
  requestAnimationFrame(() => modal.classList.add('show'));
  $('#upiManualAccessToken').focus();
}

async function submitManualAccessToken(event) {
  event.preventDefault();
  const input = $('#upiManualAccessToken');
  const button = $('#upiManualSubmitConfirm');
  const accessToken = input.value.trim();
  if (!accessToken) {
    showToast('请输入 AccessToken', 'error');
    return;
  }
  button.disabled = true;
  try {
    const result = await api('/api/upi/tasks/manual', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: accessToken }),
    });
    input.value = '';
    closeModal('#upiManualSubmitModal');
    showToast(`${result.task?.email_snapshot || '支付链接任务'} 已加入等待提交队列`, 'success');
    state.taskPage = 1;
    await loadTasks({ quiet: true });
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function saveScanner(event) {
  event.preventDefault();
  const id = Number($('#upiScannerId').value || 0);
  const body = { note: $('#upiScannerNote').value.trim(), reward: $('#upiScannerReward').value };
  try {
    await api(id ? `/api/upi/scanners/${id}` : '/api/upi/scanners', {
      method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    closeModal('#upiScannerModal');
    showToast(id ? '扫码商信息已更新' : '扫码商已创建', 'success');
    await loadScanners();
  } catch (error) { showToast(error.message, 'error'); }
}

async function scannerAction(scanner, action) {
  if (action === 'copy') return copyText(scanner.link, '专属链接已复制');
  if (action === 'open') return window.open(scanner.link, '_blank', 'noopener');
  if (action === 'edit') return openScannerModal(scanner);
  if (action === 'ledger') return loadLedger(scanner);
  if (action === 'toggle') {
    try {
      await api(`/api/upi/scanners/${scanner.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: scanner.status === 'active' ? 'paused' : 'active' }),
      });
      await loadScanners();
    } catch (error) { showToast(error.message, 'error'); }
    return;
  }
  if (action === 'reset') {
    if (!await confirmDialog({ title: '重置专属链接', message: '旧链接会立即失效，确认继续？', confirmText: '重置' })) return;
    try {
      const result = await api(`/api/upi/scanners/${scanner.id}/reset-link`, { method: 'POST' });
      await copyText(result.link, '新专属链接已复制');
      await loadScanners({ quiet: true });
    } catch (error) { showToast(error.message, 'error'); }
  }
}

async function loadLedger(scanner) {
  try {
    const result = await api(`/api/upi/scanners/${scanner.id}/ledger?page=1&page_size=50`);
    $('#upiLedgerTitle').textContent = `${scanner.note || '扫码商'} · 余额流水`;
    $('#upiLedgerBody').innerHTML = (result.items || []).map(item => `<tr>
      <td>${esc(formatDateTime(item.created_at))}</td><td>${item.entry_type === 'scan_reward' ? '扫码奖励' : esc(item.entry_type)}</td>
      <td>+$${money(item.delta_cents)}</td><td>$${money(item.balance_after_cents)}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="muted">暂无流水</td></tr>';
    const modal = $('#upiLedgerModal');
    modal.classList.remove('hidden');
    requestAnimationFrame(() => modal.classList.add('show'));
  } catch (error) { showToast(error.message, 'error'); }
}

function claimScanText(item, task) {
  if (task.payment_status === 'processing' && ['claimed', 'release_pending'].includes(item.status)) {
    return '已扫码，支付处理中';
  }
  if (CLAIM_STATUS_LABELS[item.status]) return CLAIM_STATUS_LABELS[item.status];
  return item.status || '-';
}

async function loadTaskLogs(task) {
  try {
    const result = await api(`/api/upi/tasks/${task.id}/logs`);
    const detail = result.task || {};
    $('#upiTaskLogTitle').textContent = `任务 #${detail.id || task.id} · ${detail.email || task.email_snapshot || '-'}`;
    $('#upiTaskLogSummary').textContent = `提取状态：${STATUS_LABELS[detail.extract_status] || detail.extract_status || '-'} · 支付状态：${STATUS_LABELS[detail.payment_status] || detail.payment_status || '-'}`;
    $('#upiTaskLogBody').innerHTML = (result.items || []).map(item => `<tr>
      <td>${esc(formatDateTime(item.claimed_at))}</td>
      <td title="扫码商 #${item.scanner_id}">${esc(item.scanner_note || `扫码商 #${item.scanner_id}`)}</td>
      <td>${esc(claimScanText(item, detail))}</td>
      <td>${item.success ? '<span class="upi-status success">是</span>' : '<span class="upi-status failed">否</span>'}</td>
      <td>${esc(formatDateTime(item.completed_at || item.released_at))}</td>
      <td>$${money(item.credited_cents)}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="muted">该邮箱尚未被扫码商领取</td></tr>';
    const modal = $('#upiTaskLogModal');
    modal.classList.remove('hidden');
    requestAnimationFrame(() => modal.classList.add('show'));
  } catch (error) {
    showToast(`加载任务日志失败：${error.message}`, 'error');
  }
}

async function taskAction(task, action) {
  const verb = action === 'submit' ? (Number(task.submit_attempts || 0) > 0 ? '重试提交' : '提交')
    : action === 'retry' ? '重试' : action === 'cancel' ? '取消' : '重新提交';
  const message = action === 'retry'
    ? `将复用当前上游任务 ID 调用重试接口，确认重试任务 #${task.id}？`
    : action === 'reextract'
      ? `将保留本地任务 #${task.id}，清空旧结果并创建新的上游任务，确认继续？`
      : `确认${verb}任务 #${task.id}？`;
  if (!await confirmDialog({ title: '确认操作', message })) return;
  try {
    await api(`/api/upi/tasks/${task.id}/${action}`, { method: 'POST' });
    showToast('操作已提交', 'success');
    await loadTasks({ quiet: true });
  } catch (error) { showToast(error.message, 'error'); }
}

async function loadSettings(opts = {}) {
  try {
    const result = await api('/api/upi/settings');
    const fields = Object.fromEntries((result.fields || []).map(item => [item.key, item]));
    $('#upiSettingCard').value = fields.UPI_CARD?.value || '';
    $('#upiSettingMaxPending').value = fields.UPI_MAX_PENDING_SCAN_TASKS?.value || 20;
    $('#upiSettingClaimCount').value = fields.UPI_DEFAULT_CLAIM_COUNT?.value || 1;
  } catch (error) {
    if (!opts.quiet) showToast(`加载支付链接设置失败：${error.message}`, 'error');
  }
}

async function saveSettings(event) {
  event.preventDefault();
  try {
    await api('/api/upi/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: {
        UPI_CARD: $('#upiSettingCard').value,
        UPI_MAX_PENDING_SCAN_TASKS: Number($('#upiSettingMaxPending').value),
        UPI_DEFAULT_CLAIM_COUNT: Number($('#upiSettingClaimCount').value),
      } }),
    });
    showToast('支付链接设置已保存', 'success');
    await loadSettings({ quiet: true });
  } catch (error) { showToast(error.message, 'error'); }
}

async function queryCardSummary() {
  const button = $('#upiQueryCard');
  const output = $('#upiCardSummary');
  const card = $('#upiSettingCard').value.trim();
  if (!card) {
    output.textContent = '';
    showToast('请先填写支付链接卡密', 'error');
    return;
  }
  button.disabled = true;
  output.textContent = '正在查询卡密…';
  try {
    const result = await api('/api/upi/settings/card-summary', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ card }),
    });
    const summary = result.summary || {};
    output.textContent = `卡密已保存 · 剩余次数 ${summary.remaining ?? '-'} · 已预占 ${summary.reserved ?? '-'} · 可提交 ${summary.available_to_submit ?? '-'} · 排队 ${summary.queued ?? '-'} · 提取中 ${summary.extracting ?? '-'}`;
    showToast('卡密验证成功并已保存', 'success');
  } catch (error) {
    output.textContent = '';
    showToast(`卡密查询失败：${error.message}`, 'error');
  } finally {
    button.disabled = false;
  }
}

function setPanel(panel) {
  state.activePanel = panel;
  $$('[data-upi-tab]').forEach(button => {
    const active = button.dataset.upiTab === panel;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $$('[data-upi-panel]').forEach(item => item.classList.toggle('hidden', item.dataset.upiPanel !== panel));
  clearTimeout(state.pollTimer);
  if (panel === 'tasks') loadTasks();
  else if (panel === 'scanners') loadScanners();
  else loadSettings();
}

function init() {
  if (state.initialized) return;
  state.initialized = true;
  document.addEventListener('pointerdown', unlockSuccessSound, { capture: true });
  document.addEventListener('keydown', unlockSuccessSound, { capture: true });
  setInterval(updateTaskCountdowns, 1000);
  $$('[data-upi-tab]').forEach(button => button.addEventListener('click', () => setPanel(button.dataset.upiTab)));
  $('#upiRefreshTasks')?.addEventListener('click', () => loadTasks());
  $('#upiManualSubmit')?.addEventListener('click', openManualSubmitModal);
  $('#upiManualSubmitForm')?.addEventListener('submit', submitManualAccessToken);
  $('#upiManualSubmitCancel')?.addEventListener('click', () => closeModal('#upiManualSubmitModal'));
  $('#upiTaskStatus')?.addEventListener('change', () => { state.taskPage = 1; loadTasks(); });
  $('#upiTaskSearch')?.addEventListener('input', () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => { state.taskPage = 1; loadTasks(); }, 300);
  });
  $('#upiCreateScanner')?.addEventListener('click', () => openScannerModal());
  $('#upiScannerForm')?.addEventListener('submit', saveScanner);
  $('#upiScannerModalCancel')?.addEventListener('click', () => closeModal('#upiScannerModal'));
  $('#upiLedgerClose')?.addEventListener('click', () => closeModal('#upiLedgerModal'));
  $('#upiTaskLogClose')?.addEventListener('click', () => closeModal('#upiTaskLogModal'));
  $('#upiSettingsForm')?.addEventListener('submit', saveSettings);
  $('#upiQueryCard')?.addEventListener('click', queryCardSummary);
  $('#tab-upi')?.addEventListener('click', event => {
    const pageButton = event.target.closest('[data-upi-page]');
    if (pageButton) {
      const [kind, direction] = pageButton.dataset.upiPage.split(':');
      if (kind === 'task') { state.taskPage += direction === 'next' ? 1 : -1; loadTasks(); }
      else { state.scannerPage += direction === 'next' ? 1 : -1; loadScanners(); }
      return;
    }
    const taskRow = event.target.closest('[data-upi-task-id]');
    if (taskRow) {
      const task = state.tasks.find(item => Number(item.id) === Number(taskRow.dataset.upiTaskId));
      if (!task) return;
      if (event.target.closest('[data-upi-copy-link]')) copyText(bestLink(task), '支付链接已复制');
      const action = event.target.closest('[data-upi-task-action]')?.dataset.upiTaskAction;
      if (action === 'logs') loadTaskLogs(task);
      else if (action) taskAction(task, action);
      return;
    }
    const scannerRow = event.target.closest('[data-upi-scanner-id]');
    if (scannerRow) {
      const scanner = state.scanners.find(item => Number(item.id) === Number(scannerRow.dataset.upiScannerId));
      const action = event.target.closest('[data-upi-scanner-action]')?.dataset.upiScannerAction;
      if (scanner && action) scannerAction(scanner, action);
    }
  });
}

function load() {
  if (state.activePanel === 'tasks') return loadTasks();
  if (state.activePanel === 'scanners') return loadScanners();
  return loadSettings();
}

window.GFR.pages = window.GFR.pages || {};
window.GFR.pages.upi = { init, load, rerenderLocale: load };
})();
