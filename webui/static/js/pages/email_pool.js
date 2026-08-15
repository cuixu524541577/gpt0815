// 邮箱池页逻辑。
(function () {
const { $, $$, esc, middleShort, cbtn, showToast, copyText, confirmDialog, noticeHtml, formatDateTime, formatShanghaiDate, controlValue, api, PAGERS, applyPagination, renderPager: _renderPager, registerPagerRenderer } = window.GFR;

let OUTLOOK = [];
let APIOTP = [];
let outlookFailureLimit = 3;
let outlookSummary = { total: 0, available: 0, copy_bytes: 0 };
let outlookPagination = { page: 1, page_size: 20, total: 0, pages: 1 };
let outlookRequestId = 0;
let outlookSearchTimer = null;
let apiOtpFailureLimit = 3;
let apiOtpSummary = { total: 0, available: 0, copy_bytes: 0 };
let apiOtpPagination = { page: 1, page_size: 20, total: 0, pages: 1 };
let apiOtpRequestId = 0;
let apiOtpSearchTimer = null;
const OUTLOOK_SELECTED_ROWS = new Map();
const APIOTP_SELECTED_ROWS = new Map();
const COPY_ALL_MAX_BYTES = 2 * 1024 * 1024;
let activePoolTab = localStorage.getItem('gfr.activeEmailPoolTab') || 'outlook';

function poolListUrl(baseUrl, pagerKey, searchId, statusId) {
  const p = PAGERS[pagerKey];
  const params = new URLSearchParams({
    page: String(p.page),
    page_size: String(p.size),
  });
  const q = ($(searchId)?.value || '').trim();
  const status = controlValue(statusId) || 'all';
  if (q) params.set('q', q);
  if (status !== 'all') params.set('status', status);
  return `${baseUrl}?${params.toString()}`;
}

function refreshSelectedRows(selectedRows, rows) {
  rows.forEach(row => {
    const email = String(row?.email || '');
    if (email && selectedRows.has(email)) selectedRows.set(email, row);
  });
}

function setRowSelected(selectedRows, row, selected) {
  const email = String(row?.email || '');
  if (!email) return;
  if (selected) selectedRows.set(email, row);
  else selectedRows.delete(email);
}

function rowByEmail(rows, email) {
  return rows.find(row => String(row?.email || '') === String(email || ''));
}

function updateSelectionControls(prefix, selected) {
  const hint = $(`#${prefix}SelectedHint`);
  const exportButton = $(`#btnExport${prefix}`);
  const deleteButton = $(`#btnDelete${prefix}`);
  const count = selected.size;
  if (hint) hint.textContent = `已选 ${count}`;
  if (exportButton) exportButton.disabled = count === 0;
  if (deleteButton) deleteButton.disabled = count === 0;
}

function syncPageSelectAll(id, rows, selected, key) {
  const checkbox = $(`#${id}`);
  if (!checkbox) return;
  const keys = rows.map(row => String(row[key] || ''));
  const checkedCount = keys.filter(value => selected.has(value)).length;
  checkbox.checked = keys.length > 0 && checkedCount === keys.length;
  checkbox.indeterminate = checkedCount > 0 && checkedCount < keys.length;
}

function downloadSelected(filename, lines) {
  const content = lines.filter(Boolean).join('\n');
  if (!content) {
    showToast('没有可导出的选中记录', 'warning');
    return;
  }
  const blob = new Blob([`\uFEFF${content}\n`], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    anchor.remove();
  }, 800);
  showToast(`已导出 ${lines.length} 条记录`, 'success');
}

async function copyOrDownloadAllPool({ button, label, summary, exportUrl }) {
  const total = Number(summary?.total || 0);
  const copyBytes = Number(summary?.copy_bytes || 0);
  if (!total) {
    showToast(`${label}池为空`, 'warning');
    return;
  }
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try {
    if (copyBytes > COPY_ALL_MAX_BYTES) {
      const separator = exportUrl.includes('?') ? '&' : '?';
      const anchor = document.createElement('a');
      anchor.href = `${exportUrl}${separator}download=1`;
      anchor.download = '';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      showToast(`完整${label}素材共 ${total} 条，数据较大，已导出 TXT`, 'success');
      return;
    }

    const response = await fetch(exportUrl, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (!text) {
      showToast(`${label}池没有可复制的素材`, 'warning');
      return;
    }
    await copyText(text, `已复制全部 ${total} 条${label}素材`);
  } catch (err) {
    showToast(`处理全部${label}素材失败: ${err.message}`, 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

function loadActivePool() {
  // 进入邮箱池时两套池子都刷新一次，避免未激活 tab 上的数量徽标显示旧值。
  return activePoolTab === 'api-otp-mail'
    ? Promise.all([loadApiOtpMail(), loadOutlook()])
    : Promise.all([loadOutlook(), loadApiOtpMail()]);
}

function setActivePoolTab(tab) {
  activePoolTab = tab === 'api-otp-mail' ? 'api-otp-mail' : 'outlook';
  localStorage.setItem('gfr.activeEmailPoolTab', activePoolTab);
  $$('.email-pool-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.poolTab === activePoolTab));
  $$('.email-pool-panel').forEach(panel => panel.classList.toggle('hidden', panel.dataset.poolPanel !== activePoolTab));
}

function poolStatusActions(email, status) {
  const safeEmail = esc(email);
  const actions = [];
  if (status !== 'available') {
    actions.push(`<button class="good" data-pool-act="available" data-email="${safeEmail}" title="把该邮箱恢复到可用状态，并清空已用时间">恢复</button>`);
  }
  if (status !== 'failed') {
    actions.push(`<button class="warning" data-pool-act="failed" data-email="${safeEmail}" title="把该邮箱标记为失败，后续注册不再自动领取">标失败</button>`);
  }
  actions.push(`<button class="danger" data-pool-act="delete" data-email="${safeEmail}">删除</button>`);
  return actions.join(' ');
}

function mailboxFailureInfo(row, failureLimit) {
  const count = Number(row?.failure_count || 0);
  if (!count) return '';
  const limit = Math.max(1, Number(failureLimit || 3));
  const when = formatDateTime(row?.last_failure_at);
  const note = row?.note || '';
  const title = [note, when ? `最近失败：${when}` : ''].filter(Boolean).join('\n');
  return `<div class="sub-cell muted" title="${esc(title)}">注册失败 ${count}/${limit}</div>`;
}

// ---------- Outlook ----------
function outlookListUrl() {
  return poolListUrl('/api/outlook', 'outlook', '#qOutlook', '#filterOutlookStatus');
}

async function loadOutlook() {
  const requestId = ++outlookRequestId;
  try {
    const payload = await api(outlookListUrl());
    if (requestId !== outlookRequestId) return;
    OUTLOOK = payload.items || [];
    applyPagination('outlook', payload.pagination);
    outlookPagination = payload.pagination || {
      page: PAGERS.outlook.page,
      page_size: PAGERS.outlook.size,
      total: OUTLOOK.length,
      pages: 1,
    };
    const summary = payload.summary || {};
    outlookSummary = {
      total: Number(summary.total ?? OUTLOOK.length),
      available: Number(summary.available ?? OUTLOOK.filter(row => row.status === 'available').length),
      copy_bytes: Number(summary.copy_bytes || 0),
    };
    outlookFailureLimit = Number(payload.failure_limit || 3);
    refreshSelectedRows(OUTLOOK_SELECTED_ROWS, OUTLOOK);
    renderOutlook();
  } catch(e) {
    if (requestId === outlookRequestId) showToast('加载 Outlook 邮箱池失败: ' + e.message, 'error');
  }
}

function renderOutlook() {
  const body = $('#outlookBody');
  if (!body) return;
  const totalCount = Number(outlookSummary.total || 0);
  const availableCount = Number(outlookSummary.available || 0);
  const tabCount = $('#outlookPoolCount');
  const badge = $('#outlookPoolBadge');
  if (tabCount) tabCount.textContent = String(totalCount);
  if (badge) badge.textContent = `共 ${totalCount} · 可用 ${availableCount}`;
  const total = Number(outlookPagination.total || 0);
  const rows = OUTLOOK;
  const emptyMessage = totalCount > 0 ? '当前筛选无结果' : '邮箱池为空';
  body.innerHTML = rows.map(r => `
    <tr>
      <td><input type="checkbox" data-pool-select="outlook" data-email="${esc(r.email)}" ${OUTLOOK_SELECTED_ROWS.has(String(r.email)) ? 'checked' : ''} aria-label="选择 ${esc(r.email)}"></td>
      <td class="cell-account"><div class="main-cell clip" title="${esc(r.email)}">${esc(r.email)}</div><div class="sub-cell mono clip" title="${esc(middleShort(r.copy_line || '', 24, 12))}">${esc(middleShort(r.copy_line || '', 24, 12))}</div></td>
      <td>${window.GFR.pill(r.status)}${mailboxFailureInfo(r, outlookFailureLimit)}</td>
      <td class="cell-token"><span class="mono token-preview" title="${esc(r.access_token || '')}">${esc(middleShort(r.access_token || '', 12, 6) || '未生成')}</span></td>
      <td class="muted">${esc(formatDateTime(r.used_at))}</td>
      <td class="actions-cell">
        <div class="actions">
          ${cbtn('复制邮箱', r.copy_line)} ${cbtn('复制Token', r.access_token, 'primary')} ${cbtn('复制整行', r.account_copy_line, 'good')}
          ${poolStatusActions(r.email, r.status)}
        </div>
      </td>
    </tr>`).join('') || `<tr><td colspan="6" class="muted">${emptyMessage}</td></tr>`;
  syncPageSelectAll('outlookSelectAll', rows, OUTLOOK_SELECTED_ROWS, 'email');
  updateSelectionControls('Outlook', OUTLOOK_SELECTED_ROWS);
  _renderPager('outlook', total);
}

$('#qOutlook')?.addEventListener('input', () => {
  clearTimeout(outlookSearchTimer);
  outlookSearchTimer = setTimeout(() => {
    OUTLOOK_SELECTED_ROWS.clear();
    updateSelectionControls('Outlook', OUTLOOK_SELECTED_ROWS);
    PAGERS.outlook.page = 1;
    loadOutlook();
  }, 250);
});
$('#filterOutlookStatus')?.addEventListener('change', () => {
  clearTimeout(outlookSearchTimer);
  OUTLOOK_SELECTED_ROWS.clear();
  updateSelectionControls('Outlook', OUTLOOK_SELECTED_ROWS);
  PAGERS.outlook.page = 1;
  loadOutlook();
});
$('#outlookSelectAll')?.addEventListener('change', (e) => {
  OUTLOOK.forEach(row => setRowSelected(OUTLOOK_SELECTED_ROWS, row, e.target.checked));
  renderOutlook();
});
$('#outlookBody')?.addEventListener('change', (e) => {
  const checkbox = e.target.closest('[data-pool-select="outlook"]');
  if (!checkbox) return;
  const row = rowByEmail(OUTLOOK, checkbox.dataset.email);
  if (!row) return;
  setRowSelected(OUTLOOK_SELECTED_ROWS, row, checkbox.checked);
  renderOutlook();
});
$('#copyAllEmails')?.addEventListener('click', (event) => copyOrDownloadAllPool({
  button: event.currentTarget,
  label: 'Outlook',
  summary: outlookSummary,
  exportUrl: '/api/outlook/export',
}));
$('#btnSplitOutlook')?.addEventListener('click', async () => {
  const poolTotal = Number(outlookSummary.total || 0);
  const selectedEmails = Array.from(OUTLOOK_SELECTED_ROWS.keys());
  if (!poolTotal) {
    showToast('邮箱池已经为空', 'warning');
    return;
  }
  if (!await confirmDialog({
    title: selectedEmails.length ? '分裂选中的 Outlook 邮箱？' : '分裂全部原始 Outlook 邮箱？',
    tone: 'warning',
    confirmText: '确认分裂',
    message: `${selectedEmails.length ? `将处理当前选中的 ${selectedEmails.length} 个 Outlook 邮箱。` : `当前未选择邮箱，将检查整个 Outlook 邮箱池（共 ${poolTotal} 条）。`}每个尚未分裂的原邮箱生成 5 个“原地址+随机7位”别名。\n\n注册成功的原邮箱会保留；其他原邮箱会在 5 个别名全部创建成功后删除。新别名均重置为可用，邮箱密码、Client ID 和 Refresh Token 保持不变。系统生成的分裂邮箱不会再次分裂。\n\n此操作不可撤销。`,
  })) return;

  const button = $('#btnSplitOutlook');
  if (button) button.disabled = true;
  try {
    const requestOptions = { method: 'POST' };
    if (selectedEmails.length) {
      requestOptions.headers = { 'Content-Type': 'application/json' };
      requestOptions.body = JSON.stringify({ emails: selectedEmails });
    }
    const result = await api('/api/outlook/split', requestOptions);
    OUTLOOK_SELECTED_ROWS.clear();
    PAGERS.outlook.page = 1;
    showToast(
      `分裂完成：处理 ${result.processed_sources || 0} 个原邮箱，新增 ${result.created_aliases || 0} 个别名，保留 ${result.kept_registered_originals || 0} 个已注册原邮箱，跳过 ${result.skipped_sources || 0} 个`,
      'success',
    );
    await loadOutlook();
    window.GFR.pages.dashboard.loadSummary();
  } catch (err) {
    showToast('分裂邮箱失败: ' + err.message, 'error');
  } finally {
    if (button) button.disabled = false;
  }
});
$('#btnExportOutlook')?.addEventListener('click', () => {
  const selected = Array.from(OUTLOOK_SELECTED_ROWS.values());
  downloadSelected(
    `outlook-mailbox-${formatShanghaiDate(new Date())}.txt`,
    selected.map(row => row.account_copy_line || row.copy_line),
  );
});
$('#btnDeleteOutlook')?.addEventListener('click', async () => {
  const emails = Array.from(OUTLOOK_SELECTED_ROWS.keys());
  if (!emails.length) return;
  if (!await confirmDialog({
    title: '删除选中 Outlook 邮箱？',
    tone: 'error',
    confirmText: '确认删除',
    message: `将删除已勾选的 ${emails.length} 条 Outlook 邮箱记录。此操作不可撤销。`,
  })) return;
  try {
    const result = await api('/api/outlook/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails }),
    });
    OUTLOOK_SELECTED_ROWS.clear();
    showToast(`已删除 ${result.deleted || 0} 条 Outlook 邮箱`, 'success');
    await loadOutlook();
    window.GFR.pages.dashboard.loadSummary();
  } catch (err) {
    showToast('批量删除失败: ' + err.message, 'error');
  }
});
$('#btnClearOutlook')?.addEventListener('click', async () => {
  const poolTotal = Number(outlookSummary.total || 0);
  if (!poolTotal) {
    showToast('邮箱池已经为空', 'warning');
    return;
  }
  const confirmed = await confirmDialog({
    title: '清空邮箱池？',
    tone: 'error',
    confirmText: '确认清空',
    message: `将删除全部 ${poolTotal} 条 Outlook 邮箱记录，包含已用/失败状态。此操作不可撤销。`,
  });
  if (!confirmed) return;
  try {
    await api('/api/outlook/clear', { method:'POST' });
    showToast('邮箱池已清空', 'success');
    OUTLOOK_SELECTED_ROWS.clear();
    PAGERS.outlook.page = 1;
    loadOutlook();
    window.GFR.pages.dashboard.loadSummary();
  } catch (err) {
    showToast('清空失败: ' + err.message, 'error');
  }
});
$('#outlookBody')?.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-pool-act]');
  if (!t) return;
  const { poolAct, email } = t.dataset;
  try {
    if (poolAct === 'delete') {
      if (!await confirmDialog({
        title: '删除邮箱素材？',
        tone: 'error',
        confirmText: '确认删除',
        message: `确定从邮箱池删除 ${email}？此操作不可撤销。`,
      })) return;
      await api('/api/outlook/delete', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email}) });
      showToast('已删除', 'success');
    } else {
      await api('/api/outlook/status', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email, status: poolAct, note: poolAct==='failed'?'手动标记失败':'手动恢复可用'}) });
      showToast(poolAct === 'failed' ? '已标失败' : '已恢复到可用状态', poolAct === 'failed' ? 'warning' : 'success');
    }
    OUTLOOK_SELECTED_ROWS.delete(String(email || ''));
    loadOutlook(); window.GFR.pages.dashboard.loadSummary();
  } catch(err) { showToast('操作失败: ' + err.message, 'error'); }
});
$('#btnImport')?.addEventListener('click', async () => {
  const text = $('#importText')?.value || '';
  if (!text.trim()) { showToast('请粘贴邮箱素材', 'warning'); return; }
  $('#btnImport').disabled = true;
  try {
    const r = await api('/api/outlook/import', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({text}) });
    $('#importResult').innerHTML = noticeHtml('success', `解析 ${r.parsed} 行，新增 ${r.inserted}，跳过 ${r.skipped}`, '导入完成');
    $('#importText').value = '';
    PAGERS.outlook.page = 1;
    loadOutlook(); window.GFR.pages.dashboard.loadSummary();
  } catch(e) { $('#importResult').innerHTML = noticeHtml('error', e.message, '导入失败'); }
  finally { $('#btnImport').disabled = false; }
});

// ---------- API 接码邮箱 ----------
function apiOtpMailListUrl() {
  return poolListUrl('/api/api-otp-mail', 'apiOtpMail', '#qApiOtpMail', '#filterApiOtpMailStatus');
}

async function loadApiOtpMail() {
  const requestId = ++apiOtpRequestId;
  try {
    const payload = await api(apiOtpMailListUrl());
    if (requestId !== apiOtpRequestId) return;
    APIOTP = payload.items || [];
    applyPagination('apiOtpMail', payload.pagination);
    apiOtpPagination = payload.pagination || {
      page: PAGERS.apiOtpMail.page,
      page_size: PAGERS.apiOtpMail.size,
      total: APIOTP.length,
      pages: 1,
    };
    const summary = payload.summary || {};
    apiOtpSummary = {
      total: Number(summary.total ?? APIOTP.length),
      available: Number(summary.available ?? APIOTP.filter(row => row.status === 'available').length),
      copy_bytes: Number(summary.copy_bytes || 0),
    };
    apiOtpFailureLimit = Number(payload.failure_limit || 3);
    refreshSelectedRows(APIOTP_SELECTED_ROWS, APIOTP);
    renderApiOtpMail();
  } catch(e) {
    if (requestId === apiOtpRequestId) showToast('加载 API 接码邮箱池失败: ' + e.message, 'error');
  }
}

function renderApiOtpMail() {
  const body = $('#apiOtpMailBody');
  if (!body) return;
  const totalCount = Number(apiOtpSummary.total || 0);
  const availableCount = Number(apiOtpSummary.available || 0);
  const tabCount = $('#apiOtpMailPoolCount');
  const badge = $('#apiOtpMailPoolBadge');
  if (tabCount) tabCount.textContent = String(totalCount);
  if (badge) badge.textContent = `共 ${totalCount} · 可用 ${availableCount}`;
  const total = Number(apiOtpPagination.total || 0);
  const rows = APIOTP;
  const emptyMessage = totalCount > 0 ? '当前筛选无结果' : '邮箱池为空';
  body.innerHTML = rows.map(r => `
    <tr>
      <td><input type="checkbox" data-pool-select="api-otp-mail" data-email="${esc(r.email)}" ${APIOTP_SELECTED_ROWS.has(String(r.email)) ? 'checked' : ''} aria-label="选择 ${esc(r.email)}"></td>
      <td class="cell-account"><div class="main-cell clip" title="${esc(r.email)}">${esc(r.email)}</div><div class="sub-cell mono clip" title="${esc(middleShort(r.api_url || '', 28, 14))}">${esc(middleShort(r.api_url || '', 28, 14))}</div></td>
      <td>${window.GFR.pill(r.status)}${mailboxFailureInfo(r, apiOtpFailureLimit)}</td>
      <td class="muted">${esc(formatDateTime(r.used_at))}</td>
      <td class="actions-cell">
        <div class="actions">
          ${cbtn('复制邮箱', r.copy_line || `${r.email || ''}----${r.api_url || ''}`)}
          ${poolStatusActions(r.email, r.status)}
        </div>
      </td>
    </tr>`).join('') || `<tr><td colspan="5" class="muted">${emptyMessage}</td></tr>`;
  syncPageSelectAll('apiOtpMailSelectAll', rows, APIOTP_SELECTED_ROWS, 'email');
  updateSelectionControls('ApiOtpMail', APIOTP_SELECTED_ROWS);
  _renderPager('apiOtpMail', total);
}

$('#qApiOtpMail')?.addEventListener('input', () => {
  clearTimeout(apiOtpSearchTimer);
  apiOtpSearchTimer = setTimeout(() => {
    APIOTP_SELECTED_ROWS.clear();
    updateSelectionControls('ApiOtpMail', APIOTP_SELECTED_ROWS);
    PAGERS.apiOtpMail.page = 1;
    loadApiOtpMail();
  }, 250);
});
$('#filterApiOtpMailStatus')?.addEventListener('change', () => {
  clearTimeout(apiOtpSearchTimer);
  APIOTP_SELECTED_ROWS.clear();
  updateSelectionControls('ApiOtpMail', APIOTP_SELECTED_ROWS);
  PAGERS.apiOtpMail.page = 1;
  loadApiOtpMail();
});
$('#apiOtpMailSelectAll')?.addEventListener('change', (e) => {
  APIOTP.forEach(row => setRowSelected(APIOTP_SELECTED_ROWS, row, e.target.checked));
  renderApiOtpMail();
});
$('#apiOtpMailBody')?.addEventListener('change', (e) => {
  const checkbox = e.target.closest('[data-pool-select="api-otp-mail"]');
  if (!checkbox) return;
  const row = rowByEmail(APIOTP, checkbox.dataset.email);
  if (!row) return;
  setRowSelected(APIOTP_SELECTED_ROWS, row, checkbox.checked);
  renderApiOtpMail();
});
$('#copyAllApiOtpMail')?.addEventListener('click', (event) => copyOrDownloadAllPool({
  button: event.currentTarget,
  label: 'API 接码邮箱',
  summary: apiOtpSummary,
  exportUrl: '/api/api-otp-mail/export',
}));
$('#btnExportApiOtpMail')?.addEventListener('click', () => {
  const selected = Array.from(APIOTP_SELECTED_ROWS.values());
  downloadSelected(
    `api-otp-mail-${formatShanghaiDate(new Date())}.txt`,
    selected.map(row => row.copy_line || `${row.email || ''}----${row.api_url || ''}`),
  );
});
$('#btnDeleteApiOtpMail')?.addEventListener('click', async () => {
  const emails = Array.from(APIOTP_SELECTED_ROWS.keys());
  if (!emails.length) return;
  if (!await confirmDialog({
    title: '删除选中 API 接码邮箱？',
    tone: 'error',
    confirmText: '确认删除',
    message: `将删除已勾选的 ${emails.length} 条 API 接码邮箱记录。此操作不可撤销。`,
  })) return;
  try {
    const result = await api('/api/api-otp-mail/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails }),
    });
    APIOTP_SELECTED_ROWS.clear();
    showToast(`已删除 ${result.deleted || 0} 条 API 接码邮箱`, 'success');
    await loadApiOtpMail();
    window.GFR.pages.dashboard.loadSummary();
  } catch (err) {
    showToast('批量删除失败: ' + err.message, 'error');
  }
});
$('#btnClearApiOtpMail')?.addEventListener('click', async () => {
  const poolTotal = Number(apiOtpSummary.total || 0);
  if (!poolTotal) {
    showToast('邮箱池已经为空', 'warning');
    return;
  }
  const confirmed = await confirmDialog({
    title: '清空 API 接码邮箱池？',
    tone: 'error',
    confirmText: '确认清空',
    message: `将删除全部 ${poolTotal} 条 API 接码邮箱记录。此操作不可撤销。`,
  });
  if (!confirmed) return;
  try {
    await api('/api/api-otp-mail/clear', { method:'POST' });
    showToast('API 接码邮箱池已清空', 'success');
    APIOTP_SELECTED_ROWS.clear();
    PAGERS.apiOtpMail.page = 1;
    loadApiOtpMail();
  } catch (err) {
    showToast('清空失败: ' + err.message, 'error');
  }
});
$('#apiOtpMailBody')?.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-pool-act]');
  if (!t) return;
  const { poolAct, email } = t.dataset;
  try {
    if (poolAct === 'delete') {
      if (!await confirmDialog({
        title: '删除邮箱素材？',
        tone: 'error',
        confirmText: '确认删除',
        message: `确定从 API 接码邮箱池删除 ${email}？此操作不可撤销。`,
      })) return;
      await api('/api/api-otp-mail/delete', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email}) });
      showToast('已删除', 'success');
    } else {
      await api('/api/api-otp-mail/status', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email, status: poolAct, note: poolAct==='failed'?'手动标记失败':'手动恢复可用'}) });
      showToast(poolAct === 'failed' ? '已标失败' : '已恢复到可用状态', poolAct === 'failed' ? 'warning' : 'success');
    }
    APIOTP_SELECTED_ROWS.delete(String(email || ''));
    loadApiOtpMail(); window.GFR.pages.dashboard.loadSummary();
  } catch(err) { showToast('操作失败: ' + err.message, 'error'); }
});
$('#btnImportApiOtpMail')?.addEventListener('click', async () => {
  const text = $('#importApiOtpMailText').value;
  if (!text.trim()) { showToast('请粘贴邮箱素材', 'warning'); return; }
  $('#btnImportApiOtpMail').disabled = true;
  try {
    const r = await api('/api/api-otp-mail/import', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({text}) });
    $('#importApiOtpMailResult').innerHTML = noticeHtml('success', `解析 ${r.parsed} 行，新增 ${r.inserted}，跳过 ${r.skipped}`, '导入完成');
    $('#importApiOtpMailText').value = '';
    PAGERS.apiOtpMail.page = 1;
    loadApiOtpMail();
  } catch(e) { $('#importApiOtpMailResult').innerHTML = noticeHtml('error', e.message, '导入失败'); }
  finally { $('#btnImportApiOtpMail').disabled = false; }
});

$('#emailPoolTabs')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-pool-tab]');
  if (!btn) return;
  setActivePoolTab(btn.dataset.poolTab);
  loadActivePool();
});

registerPagerRenderer('outlook', loadOutlook);
registerPagerRenderer('apiOtpMail', loadApiOtpMail);
window.GFR.pages = window.GFR.pages || {};
window.GFR.pages.emailPool = { loadOutlook, loadApiOtpMail, loadActivePool, renderOutlook, renderApiOtpMail, setActivePoolTab };
setActivePoolTab(activePoolTab);
})();
