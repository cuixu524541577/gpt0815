// 卡池支付：虚拟信用卡池 / PayPal 池 / 支付任务 / 设置。
(function () {
const {
  $, $$, api, esc, formatDateTime, showToast, confirmDialog,
} = window.GFR;

const STATUS_LABELS = {
  active: '可用', in_use: '租约中', locked: '已锁定', scrapped: '已报废',
};
const JOB_STATUS_LABELS = {
  queued: '排队中', running: '执行中', succeeded: '成功', failed: '失败', canceled: '已取消',
};
const METHOD_LABELS = { card: '银行卡', paypal: 'PayPal' };

const state = {
  activePanel: 'cards',
  cards: [], paypal: [], jobs: [],
  settingsFields: [],
  pollTimer: null,
  enabled: false,
};

function statusPill(status) {
  const tone = status === 'active' || status === 'succeeded' ? 'success'
    : (status === 'scrapped' || status === 'failed' ? 'failed'
      : (status === 'in_use' || status === 'running' || status === 'queued' ? 'active' : ''));
  return `<span class="upi-status ${tone}">${esc(STATUS_LABELS[status] || JOB_STATUS_LABELS[status] || status || '-')}</span>`;
}

function assetLabel(job) {
  if (job.asset) return esc(job.asset);
  if (job.card_id) return `卡 #${job.card_id}`;
  if (job.paypal_id) return `PayPal #${job.paypal_id}`;
  return '-';
}

function jobResult(job) {
  if (job.status === 'succeeded') return `<span class="muted">${esc(job.result || '')}</span>`;
  if (job.status === 'failed') return `<span title="${esc(job.error || '')}">${esc((job.error || job.result || '').slice(0, 60))}</span>`;
  return '<span class="muted">-</span>';
}

function cardActions(card) {
  const acts = [];
  if (card.status === 'active' || card.status === 'in_use') {
    acts.push(`<button data-cardpool-card-action="lock">锁定</button>`);
  } else if (card.status === 'locked' || card.status === 'scrapped') {
    acts.push(`<button data-cardpool-card-action="activate">恢复</button>`);
  }
  if (card.status !== 'scrapped') acts.push(`<button data-cardpool-card-action="scrap">报废</button>`);
  acts.push(`<button data-cardpool-card-action="delete" class="danger">删除</button>`);
  return acts.join(' ');
}

function paypalActions(item) {
  const acts = [];
  if (item.status === 'active' || item.status === 'in_use') {
    acts.push(`<button data-cardpool-paypal-action="lock">锁定</button>`);
  } else if (item.status === 'locked' || item.status === 'scrapped') {
    acts.push(`<button data-cardpool-paypal-action="activate">恢复</button>`);
  }
  if (item.status !== 'scrapped') acts.push(`<button data-cardpool-paypal-action="scrap">报废</button>`);
  acts.push(`<button data-cardpool-paypal-action="delete" class="danger">删除</button>`);
  return acts.join(' ');
}

function jobActions(job) {
  const acts = [];
  if (job.status === 'queued') acts.push(`<button data-cardpool-job-action="cancel">取消</button>`);
  if (job.status === 'failed' || job.status === 'canceled') acts.push(`<button data-cardpool-job-action="retry">重试</button>`);
  acts.push(`<button data-cardpool-job-action="logs">日志</button>`);
  return acts.join(' ');
}

function renderCards() {
  const rows = state.cards.map(card => `
    <tr>
      <td>${card.id}</td>
      <td>${esc(card.card_type || '-')}</td>
      <td class="mono">${esc(card.bin || '-')}</td>
      <td class="mono">${esc(card.card_number_masked || '-')}</td>
      <td class="mono">${esc(card.expires || '-')}</td>
      <td>${statusPill(card.status)}</td>
      <td class="mono">${card.use_count || 0} / ${card.success_count || 0} / ${card.fail_count || 0}</td>
      <td class="mono" title="${esc(card.last_result || '')}">${esc((card.last_result || '-').slice(0, 24))}</td>
      <td>${esc(card.notes || '')}</td>
      <td class="table-actions">${cardActions(card)}</td>
    </tr>`).join('');
  $('#cardPoolCardBody').innerHTML = rows || '<tr><td colspan="10" class="muted">暂无卡片，点击右上角「+ 添加卡片」或「批量导入」</td></tr>';
}

function renderPaypal() {
  const rows = state.paypal.map(item => `
    <tr>
      <td>${item.id}</td>
      <td class="mono">${esc(item.phone || '-')}</td>
      <td class="mono" title="${esc(item.sms_api_url || '')}">${esc((item.sms_api_url || '-').slice(0, 48))}</td>
      <td>${statusPill(item.status)}</td>
      <td class="mono">${item.use_count || 0} / ${item.success_count || 0} / ${item.fail_count || 0}</td>
      <td class="mono">${esc(item.last_otp_status || '-')}</td>
      <td>${esc(item.notes || '')}</td>
      <td class="table-actions">${paypalActions(item)}</td>
    </tr>`).join('');
  $('#cardPoolPaypalBody').innerHTML = rows || '<tr><td colspan="8" class="muted">暂无 PayPal 账号</td></tr>';
}

function renderJobs() {
  const rows = state.jobs.map(job => `
    <tr>
      <td>${job.id}</td>
      <td>${esc(METHOD_LABELS[job.method] || job.method)}</td>
      <td class="mono" title="${esc(job.link)}">${esc((job.link || '').slice(0, 44))}</td>
      <td>${esc(job.email || '-')}</td>
      <td>${esc(job.source || '-')}</td>
      <td>${statusPill(job.status)}</td>
      <td>${assetLabel(job)}</td>
      <td>${jobResult(job)}</td>
      <td class="mono">${formatDateTime(job.created_at)}</td>
      <td class="table-actions">${jobActions(job)}</td>
    </tr>`).join('');
  $('#cardPoolJobBody').innerHTML = rows || '<tr><td colspan="10" class="muted">暂无支付任务</td></tr>';
}

function renderSummary(summary) {
  const c = summary.cards || {};
  const j = summary.jobs || {};
  $('#cardPoolCardTotal').textContent = c.total || 0;
  $('#cardPoolCardActive').textContent = c.active || 0;
  $('#cardPoolCardInUse').textContent = c.in_use || 0;
  $('#cardPoolCardScrapped').textContent = c.scrapped || 0;
  $('#cardPoolJobQueued').textContent = j.queued || 0;
  $('#cardPoolJobRunning').textContent = j.running || 0;
  $('#cardPoolJobSucceeded').textContent = j.succeeded || 0;
  $('#cardPoolJobFailed').textContent = j.failed || 0;
}

function renderSettings() {
  const grid = $('#cardPoolSettingsFields');
  if (!state.settingsFields.length) {
    grid.innerHTML = '<span class="muted">暂无配置项</span>';
    return;
  }
  grid.innerHTML = state.settingsFields.map(f => {
    const value = f.value === true ? 'true' : (f.value === false ? 'false' : (f.value ?? ''));
    const control = f.type === 'bool'
      ? `<select data-key="${esc(f.key)}"><option value="true"${value === 'true' ? ' selected' : ''}>启用</option><option value="false"${value !== 'true' ? ' selected' : ''}>关闭</option></select>`
      : `<input data-key="${esc(f.key)}" type="${f.type === 'int' ? 'number' : 'text'}" value="${esc(value)}">`;
    return `<label class="cardpool-setting"><span>${esc(f.label)}</span>${control}<small class="muted">${esc(f.help || '')}</small></label>`;
  }).join('');
}

// ------------------------------------------------------------
// 加载
// ------------------------------------------------------------
async function loadStatus() {
  try {
    const r = await api('/api/card-pool/status');
    state.enabled = !!r.enabled;
    if (r.summary) renderSummary(r.summary);
    if (!state.enabled) {
      $('#cardPoolCardBody').innerHTML = '<tr><td colspan="10" class="muted">卡池未启用：请在「运行配置 → 卡池支付」打开「启用卡池」，或在本页「设置」中启用。</td></tr>';
      $('#cardPoolPaypalBody').innerHTML = '<tr><td colspan="8" class="muted">卡池未启用</td></tr>';
      $('#cardPoolJobBody').innerHTML = '<tr><td colspan="10" class="muted">卡池未启用</td></tr>';
    }
  } catch (e) {
    showToast(`加载卡池状态失败：${e.message}`, 'error');
  }
}

async function loadCards() {
  try {
    const r = await api('/api/card-pool/cards');
    state.cards = r.items || [];
    renderCards();
  } catch (e) {
    showToast(`加载卡片失败：${e.message}`, 'error');
  }
}

async function loadPaypal() {
  try {
    const r = await api('/api/card-pool/paypal');
    state.paypal = r.items || [];
    renderPaypal();
  } catch (e) {
    showToast(`加载 PayPal 池失败：${e.message}`, 'error');
  }
}

async function loadJobs() {
  try {
    const r = await api('/api/card-pool/jobs');
    state.jobs = r.items || [];
    renderJobs();
  } catch (e) {
    showToast(`加载支付任务失败：${e.message}`, 'error');
  }
}

async function loadSettings() {
  try {
    const r = await api('/api/card-pool/settings');
    state.settingsFields = r.fields || [];
    if (r.summary) renderSummary(r.summary);
    renderSettings();
  } catch (e) {
    showToast(`加载卡池设置失败：${e.message}`, 'error');
  }
}

function load() {
  loadStatus();
  if (state.activePanel === 'cards') return loadCards();
  if (state.activePanel === 'paypal') return loadPaypal();
  if (state.activePanel === 'jobs') return loadJobs();
  return loadSettings();
}

// ------------------------------------------------------------
// 弹窗
// 注意：modal-backdrop 默认 opacity:0 + pointer-events:none，
// 必须加 .show 才可见可交互（与 upi.js / credentials.js 一致）。
// ------------------------------------------------------------
function openModal(id) {
  const el = $(id);
  if (!el) return;
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('show'));
}
function closeModal(id) {
  const el = $(id);
  if (!el) return;
  el.classList.remove('show');
  el.classList.add('hidden');
}

async function saveCard() {
  const cardNumber = $('#cardPoolCardNumber').value.trim();
  const expires = $('#cardPoolCardExpires').value.trim();
  const cvv = $('#cardPoolCardCvv').value.trim();
  // 必填校验（字段级提示）
  if (!cardNumber) { showToast('卡号不能为空', 'error'); $('#cardPoolCardNumber').focus(); return; }
  if (!expires) { showToast('有效期不能为空（MM/YY 或 MM/YYYY）', 'error'); $('#cardPoolCardExpires').focus(); return; }
  if (!cvv) { showToast('CVV 不能为空', 'error'); $('#cardPoolCardCvv').focus(); return; }
  const payload = {
    card_number: cardNumber,
    expires: expires,
    cvv: cvv,
    billing_zip: $('#cardPoolCardZip').value.trim(),
    billing_country: $('#cardPoolCardCountry').value.trim() || 'US',
    notes: $('#cardPoolCardNotes').value.trim(),
  };
  try {
    await api('/api/card-pool/cards', { method: 'POST', body: payload });
    showToast('卡片已添加', 'success');
    closeModal('#cardPoolCardModal');
    $('#cardPoolCardForm').reset();
    loadCards();
    loadStatus();
  } catch (e) {
    showToast(`添加失败：${e.message}`, 'error');
  }
}

async function savePaypal() {
  const payload = {
    phone: $('#cardPoolPaypalPhone').value.trim(),
    sms_api_url: $('#cardPoolPaypalSmsUrl').value.trim(),
    notes: $('#cardPoolPaypalNotes').value.trim(),
  };
  try {
    await api('/api/card-pool/paypal', { method: 'POST', body: payload });
    showToast('PayPal 账号已添加', 'success');
    closeModal('#cardPoolPaypalModal');
    $('#cardPoolPaypalForm').reset();
    loadPaypal();
    loadStatus();
  } catch (e) {
    showToast(`添加失败：${e.message}`, 'error');
  }
}

async function doImport(kind) {
  const text = $('#cardPoolImportText').value;
  if (!text.trim()) {
    showToast('请粘贴导入内容', 'error');
    return;
  }
  try {
    const r = await api(`/api/card-pool/${kind}/import`, { method: 'POST', body: { text } });
    const msg = `导入成功 ${r.imported} 条${r.failed && r.failed.length ? `，失败 ${r.failed.length} 条` : ''}`;
    showToast(msg, r.failed && r.failed.length ? 'warning' : 'success');
    if (r.failed && r.failed.length) console.warn('导入失败明细', r.failed);
    closeModal('#cardPoolImportModal');
    $('#cardPoolImportText').value = '';
    if (kind === 'cards') loadCards(); else loadPaypal();
    loadStatus();
  } catch (e) {
    showToast(`导入失败：${e.message}`, 'error');
  }
}

async function manualPay() {
  const payload = {
    link: $('#cardPoolManualPayLink').value.trim(),
    method: $('#cardPoolManualPayMethod').value,
    email: $('#cardPoolManualPayEmail').value.trim(),
  };
  if (!payload.link) {
    showToast('请填写支付链接', 'error');
    return;
  }
  try {
    const r = await api('/api/card-pool/jobs', { method: 'POST', body: payload });
    showToast(`已提交任务 #${r.job.id}，稍后刷新查看结果`, 'success');
    closeModal('#cardPoolManualPayModal');
    $('#cardPoolManualPayForm').reset();
    loadJobs();
    loadStatus();
  } catch (e) {
    showToast(`提交失败：${e.message}`, 'error');
  }
}

async function cardAction(card, action) {
  const id = card.id;
  const statusMap = { lock: 'locked', activate: 'active', scrap: 'scrapped' };
  try {
    if (action === 'delete') {
      if (!await confirmDialog('删除这张卡片？', `卡 ${card.card_number_masked}`)) return;
      await api(`/api/card-pool/cards/${id}`, { method: 'DELETE' });
      showToast('卡片已删除', 'success');
    } else {
      await api(`/api/card-pool/cards/${id}`, { method: 'PATCH', body: { status: statusMap[action] } });
      showToast(`已${action === 'lock' ? '锁定' : (action === 'activate' ? '恢复' : '报废')}`, 'success');
    }
    loadCards();
    loadStatus();
  } catch (e) {
    showToast(`操作失败：${e.message}`, 'error');
  }
}

async function paypalAction(item, action) {
  const id = item.id;
  const statusMap = { lock: 'locked', activate: 'active', scrap: 'scrapped' };
  try {
    if (action === 'delete') {
      if (!await confirmDialog('删除这个 PayPal 账号？', item.phone)) return;
      await api(`/api/card-pool/paypal/${id}`, { method: 'DELETE' });
      showToast('账号已删除', 'success');
    } else {
      await api(`/api/card-pool/paypal/${id}`, { method: 'PATCH', body: { status: statusMap[action] } });
      showToast(`已${action === 'lock' ? '锁定' : (action === 'activate' ? '恢复' : '报废')}`, 'success');
    }
    loadPaypal();
    loadStatus();
  } catch (e) {
    showToast(`操作失败：${e.message}`, 'error');
  }
}

async function jobAction(job, action) {
  try {
    if (action === 'logs') {
      const r = await api(`/api/card-pool/jobs/${job.id}`);
      $('#cardPoolJobLogBody').textContent = (r.job?.logs || []).join('\n') || '（暂无日志）';
      openModal('#cardPoolJobLogModal');
      return;
    }
    if (action === 'cancel') {
      if (!await confirmDialog('取消这个排队任务？', `#${job.id}`)) return;
      await api(`/api/card-pool/jobs/${job.id}/cancel`, { method: 'POST' });
      showToast('任务已取消', 'success');
    } else if (action === 'retry') {
      await api(`/api/card-pool/jobs/${job.id}/retry`, { method: 'POST' });
      showToast('任务已重新提交', 'success');
    }
    loadJobs();
    loadStatus();
  } catch (e) {
    showToast(`操作失败：${e.message}`, 'error');
  }
}

async function saveSettings() {
  const updates = {};
  $$('#cardPoolSettingsFields [data-key]').forEach(el => {
    const key = el.dataset.key;
    const field = state.settingsFields.find(f => f.key === key);
    if (!field) return;
    if (field.type === 'bool') updates[key] = el.value === 'true';
    else if (field.type === 'int') updates[key] = Number(el.value);
    else updates[key] = el.value;
  });
  try {
    const r = await api('/api/card-pool/settings', { method: 'POST', body: updates });
    showToast(`设置已保存：${(r.updated || []).join(', ')}`, 'success');
    loadStatus();
    loadSettings();
  } catch (e) {
    showToast(`保存失败：${e.message}`, 'error');
  }
}

// ------------------------------------------------------------
// 事件绑定
// ------------------------------------------------------------
function bind() {
  $$('[data-cardpool-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.cardpoolTab;
      state.activePanel = tab;
      $$('[data-cardpool-tab]').forEach(x => x.classList.toggle('active', x === btn));
      $$('[data-cardpool-panel]').forEach(p => p.classList.toggle('hidden', p.dataset.cardpoolPanel !== tab));
      load();
    });
  });

  $('#cardPoolAddCard')?.addEventListener('click', () => openModal('#cardPoolCardModal'));
  $('#cardPoolCardModalCancel')?.addEventListener('click', () => closeModal('#cardPoolCardModal'));
  $('#cardPoolCardForm')?.addEventListener('submit', e => { e.preventDefault(); saveCard(); });

  $('#cardPoolAddPaypal')?.addEventListener('click', () => openModal('#cardPoolPaypalModal'));
  $('#cardPoolPaypalModalCancel')?.addEventListener('click', () => closeModal('#cardPoolPaypalModal'));
  $('#cardPoolPaypalForm')?.addEventListener('submit', e => { e.preventDefault(); savePaypal(); });

  $('#cardPoolImportCards')?.addEventListener('click', () => {
    $('#cardPoolImportTitle').textContent = '批量导入卡片';
    $('#cardPoolImportHint').textContent = '每行一个，格式：卡号,有效期[,CVV[,邮编]]，分隔符 | 或 ,（# 开头为注释）';
    $('#cardPoolImportModal').dataset.kind = 'cards';
    openModal('#cardPoolImportModal');
  });
  $('#cardPoolImportPaypal')?.addEventListener('click', () => {
    $('#cardPoolImportTitle').textContent = '批量导入 PayPal 账号';
    $('#cardPoolImportHint').textContent = '每行一个，格式：手机号|OTP-API地址[|备注]，分隔符 | 或 ,';
    $('#cardPoolImportModal').dataset.kind = 'paypal';
    openModal('#cardPoolImportModal');
  });
  $('#cardPoolImportClose')?.addEventListener('click', () => closeModal('#cardPoolImportModal'));
  $('#cardPoolImportCancel')?.addEventListener('click', () => closeModal('#cardPoolImportModal'));
  $('#cardPoolImportConfirm')?.addEventListener('click', () => doImport($('#cardPoolImportModal').dataset.kind || 'cards'));

  $('#cardPoolManualPay')?.addEventListener('click', () => openModal('#cardPoolManualPayModal'));
  $('#cardPoolManualPayCancel')?.addEventListener('click', () => closeModal('#cardPoolManualPayModal'));
  $('#cardPoolManualPayForm')?.addEventListener('submit', e => { e.preventDefault(); manualPay(); });

  $('#cardPoolJobLogClose')?.addEventListener('click', () => closeModal('#cardPoolJobLogModal'));
  $('#cardPoolProcessQueued')?.addEventListener('click', async () => {
    try {
      const r = await api('/api/card-pool/process-queued', { method: 'POST' });
      showToast(`已提交 ${r.submitted} 个排队任务`, 'success');
      loadJobs();
    } catch (e) {
      showToast(`执行失败：${e.message}`, 'error');
    }
  });

  $('#cardPoolRefreshCards')?.addEventListener('click', () => { loadCards(); loadStatus(); });
  $('#cardPoolRefreshJobs')?.addEventListener('click', () => { loadJobs(); loadStatus(); });

  $('#cardPoolCardBody')?.addEventListener('click', e => {
    const row = e.target.closest('[data-cardpool-card-action]');
    if (!row) return;
    const id = Number(row.closest('tr').querySelector('td').textContent);
    const card = state.cards.find(c => Number(c.id) === id);
    if (card) cardAction(card, row.dataset.cardpoolCardAction);
  });
  $('#cardPoolPaypalBody')?.addEventListener('click', e => {
    const row = e.target.closest('[data-cardpool-paypal-action]');
    if (!row) return;
    const id = Number(row.closest('tr').querySelector('td').textContent);
    const item = state.paypal.find(c => Number(c.id) === id);
    if (item) paypalAction(item, row.dataset.cardpoolPaypalAction);
  });
  $('#cardPoolJobBody')?.addEventListener('click', e => {
    const row = e.target.closest('[data-cardpool-job-action]');
    if (!row) return;
    const id = Number(row.closest('tr').querySelector('td').textContent);
    const job = state.jobs.find(j => Number(j.id) === id);
    if (job) jobAction(job, row.dataset.cardpoolJobAction);
  });

  $('#cardPoolSettingsForm')?.addEventListener('submit', e => { e.preventDefault(); saveSettings(); });

  // 页面可见时轮询，隐藏时暂停（恢复时按事件驱动重新加载）
  const startPoll = () => {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(() => {
      if (document.hidden || window.GFR.activeTab !== 'cardpool') return;
      loadStatus();
      if (state.activePanel === 'jobs') loadJobs();
      else if (state.activePanel === 'cards') loadCards();
      else if (state.activePanel === 'paypal') loadPaypal();
    }, 15000);
  };
  startPoll();
}

function init() {
  bind();
}

window.GFR.pages = window.GFR.pages || {};
window.GFR.pages.cardpool = { init, load, rerenderLocale: load };
})();
