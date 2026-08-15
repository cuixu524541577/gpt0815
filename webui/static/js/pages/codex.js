// Codex 授权页逻辑。
(function () {
const { $, esc, middleShort, showToast, confirmDialog, api, controlValue, formatDateTime, PAGERS, renderPager: _renderPager, registerPagerRenderer } = window.GFR;

// ---------- Codex 授权 ----------
let CODEX = [];
const CODEX_SELECTED = new Set();

function selectedRows() {
  return Array.from(CODEX_SELECTED)
    .map(fname => CODEX.find(r => r.filename === fname))
    .filter(Boolean);
}

function selectedFilenames() {
  return Array.from(CODEX_SELECTED);
}

function selectedRefreshTokenCount() {
  return selectedRows().filter(r => !!r.has_refresh_token).length;
}

function filteredFilenames() {
  return codexFilteredRows().map(r => r.filename).filter(Boolean);
}

function currentCodexBulkScope() {
  const selected = selectedFilenames();
  if (selected.length) {
    return {
      scope: 'selected',
      filenames: selected,
      count: selected.length,
      label: '选中',
      targetText: `勾选 ${selected.length} 个 Codex 凭证`,
    };
  }
  const filtered = filteredFilenames();
  return {
    scope: 'filtered',
    filenames: filtered,
    count: filtered.length,
    label: '全部',
    targetText: `当前搜索/筛选结果 ${filtered.length} 个 Codex 凭证`,
  };
}

async function loadCodex() {
  try {
    const r = await api('/api/codex');
    CODEX = r.accounts || [];
    const existing = new Set(CODEX.map(x => x.filename));
    Array.from(CODEX_SELECTED).forEach(fname => { if (!existing.has(fname)) CODEX_SELECTED.delete(fname); });
    $('#codexStatTotal').textContent = r.summary?.total ?? 0;
    $('#codexStatExported').textContent = r.summary?.exported ?? 0;
    $('#codexStatPending').textContent = r.summary?.pending ?? 0;
    renderCodex();
  } catch(e) { showToast('加载 Codex 列表失败: ' + e.message, 'error'); }
}

function _codexUpdateSelectedHint() {
  const count = CODEX_SELECTED.size;
  const tokenCount = selectedRefreshTokenCount();
  const filteredCount = filteredFilenames().length;
  const bulkScope = currentCodexBulkScope();
  $('#codexSelectedHint').textContent = count ? `已选 ${count} / 当前 ${filteredCount}，可上传 ${tokenCount}` : `已选 0 / 当前 ${filteredCount}`;
  const refreshToken = $('#btnCodexRefreshToken');
  if (refreshToken) {
    refreshToken.disabled = bulkScope.count === 0;
    refreshToken.textContent = `刷新${bulkScope.label} Token · ${bulkScope.count}`;
    refreshToken.title = count
      ? `刷新已勾选 ${bulkScope.count} 个 Codex 凭证的 access_token`
      : `刷新当前搜索/筛选结果 ${bulkScope.count} 个 Codex 凭证的 access_token`;
  }
  $('#btnCodexDownloadCpa').disabled = count === 0;
  $('#btnCodexDownloadSub2api').disabled = count === 0;
  $('#btnCodexUploadRelay').disabled = tokenCount === 0;
  $('#btnCodexCheckSelected').disabled = count === 0;
  $('#btnCodexDeleteSelected').disabled = count === 0;
  $('#btnCodexDeleteFiltered').disabled = filteredCount === 0;
}

function codexFilteredRows() {
  const q = $('#qCodex').value.trim().toLowerCase();
  const exportFilter = controlValue('#filterCodexExport') || 'all';
  const checkFilter = controlValue('#filterCodexCheck') || 'all';
  return CODEX.filter(r => {
    const exported = (r.exported_count || 0) > 0;
    if (exportFilter === 'exported' && !exported) return false;
    if (exportFilter === 'pending' && exported) return false;
    const checkStatus = r.check_status || 'unchecked';
    const checkOk = !!r.check_ok;
    const checkAlive = !!r.check_alive;
    if (checkFilter === 'unchecked' && checkStatus !== 'unchecked') return false;
    if (checkFilter === 'ok' && !checkOk) return false;
    if (checkFilter === 'alive' && (!checkAlive || checkOk)) return false;
    if (checkFilter === 'quota' && checkStatus !== 'quota') return false;
    if (checkFilter === 'failed' && (checkStatus === 'unchecked' || checkAlive || checkOk)) return false;
    if (!q) return true;
    return [
      r.email,
      r.filename,
      formatDateTime(r.mtime),
      formatDateTime(r.expired),
      formatDateTime(r.checked_at),
      exported ? '已导出 exported' : '未导出 pending',
      r.has_refresh_token ? 'RT refresh_token' : '无 RT no refresh_token',
      codexCheckLabel(r).text,
      r.check_status,
      r.check_message,
      r.check_reply,
    ].join('\n').toLowerCase().includes(q);
  });
}

function codexCheckLabel(r) {
  const status = r.check_status || r.status || 'unchecked';
  if (r.check_ok || status === 'ok') return { text: '试聊成功', cls: 'status-success' };
  if (status === 'quota') return { text: '额度限制', cls: 'status-running' };
  if (status === 'model_unavailable') return { text: '模型不可用', cls: 'status-pending' };
  if (r.check_alive || r.alive || status === 'usage_only') return { text: '凭证可达', cls: 'status-available' };
  if (status === 'unchecked') return { text: '未测活', cls: 'status-used' };
  if (status === 'timeout' || status === 'network_error') return { text: '网络异常', cls: 'status-used' };
  if (status === 'invalid' || status === 'refresh_failed') return { text: '已失效', cls: 'status-failed' };
  return { text: '失败', cls: 'status-failed' };
}

function renderCodexCheckState(r) {
  const label = codexCheckLabel(r);
  const checkedAt = formatDateTime(r.checked_at);
  const latency = r.check_latency_ms ? `${r.check_latency_ms}ms` : '';
  const msg = [r.check_message || '', r.check_reply ? `回复：${r.check_reply}` : '', latency].filter(Boolean).join(' · ');
  const title = [label.text, checkedAt && `时间：${checkedAt}`, msg].filter(Boolean).join('\n');
  return `
    <div class="codex-check-cell">
      <span class="pill ${label.cls}" title="${esc(title)}">${esc(label.text)}</span>
      <div class="sub-cell clip" title="${esc(checkedAt || '尚未测活')}">${esc(checkedAt || '-')}</div>
    </div>`;
}

function renderCodex() {
  const filtered = codexFilteredRows();
  const p = PAGERS.codex;
  const total = filtered.length;
  const rows = filtered.slice((p.page - 1) * p.size, p.page * p.size);
  $('#codexBody').innerHTML = rows.map(r => {
    const exported = (r.exported_count || 0) > 0;
    const exportedAt = formatDateTime(r.exported_at);
    const mtime = formatDateTime(r.mtime);
    const expired = formatDateTime(r.expired);
    const statusBadge = exported
      ? `<span class="pill status-used" title="导出 ${esc(r.exported_count)} 次，最近 ${esc(exportedAt)}">已导出</span>`
      : `<span class="pill status-available">未导出</span>`;
    const refreshBadge = r.has_refresh_token
      ? '<span class="pill status-success" title="存在 refresh_token，可上传 CPA / Sub2API">RT</span>'
      : '<span class="pill status-failed" title="缺少 refresh_token，不能上传到中转">无 RT</span>';
    const checked = CODEX_SELECTED.has(r.filename) ? 'checked' : '';
    return `
    <tr>
      <td><input type="checkbox" class="codex-row-check" data-fname="${esc(r.filename)}" ${checked}></td>
      <td class="cell-account"><div class="main-cell clip" title="${esc(r.email || '-')}">${esc(r.email || '-')}</div><div class="sub-cell mono clip" title="${esc(r.filename)}">${esc(middleShort(r.filename || '', 22, 10))}</div></td>
      <td>${statusBadge}</td>
      <td>${renderCodexCheckState(r)}</td>
      <td>${refreshBadge}</td>
      <td class="muted">${esc(mtime)}</td>
      <td class="muted">${esc(expired)}</td>
      <td class="actions-cell">
        <div class="actions">
          <button class="primary" data-codex-download="${esc(r.filename)}">下载 JSON</button>
          <button data-codex-download-cpa="${esc(r.filename)}" title="下载 CPA 格式，不包含代理">CPA</button>
          <button data-codex-download-sub2api="${esc(r.filename)}" title="下载 Sub2API bundle，不包含代理">Sub2API</button>
          ${exported ? `<button data-codex-reset="${esc(r.filename)}" title="重新标记为未导出">重置</button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" class="muted">还没有符合条件的 Codex 凭证。</td></tr>';
  // 全选 checkbox：仅反映当前页状态
  const pageFilenames = rows.map(r => r.filename);
  const allChecked = pageFilenames.length > 0 && pageFilenames.every(f => CODEX_SELECTED.has(f));
  $('#codexSelectAll').checked = allChecked;
  $('#codexSelectAll').indeterminate = !allChecked && pageFilenames.some(f => CODEX_SELECTED.has(f));
  _codexUpdateSelectedHint();
  _renderPager('codex', total);
}
$('#qCodex').addEventListener('input', () => { PAGERS.codex.page = 1; renderCodex(); });
$('#filterCodexExport')?.addEventListener('change', () => { PAGERS.codex.page = 1; renderCodex(); });
$('#filterCodexCheck')?.addEventListener('change', () => { PAGERS.codex.page = 1; renderCodex(); });
$('#btnRefreshCodex').addEventListener('click', loadCodex);

// 全选 / 取消全选（仅当前页可见行）
$('#codexSelectAll').addEventListener('change', (e) => {
  const filtered = codexFilteredRows();
  const p = PAGERS.codex;
  const pageRows = filtered.slice((p.page - 1) * p.size, p.page * p.size);
  if (e.target.checked) pageRows.forEach(r => CODEX_SELECTED.add(r.filename));
  else pageRows.forEach(r => CODEX_SELECTED.delete(r.filename));
  renderCodex();
});

// 行 checkbox 变化（事件委托）
$('#codexBody').addEventListener('change', (e) => {
  const cb = e.target.closest('.codex-row-check');
  if (!cb) return;
  if (cb.checked) CODEX_SELECTED.add(cb.dataset.fname);
  else CODEX_SELECTED.delete(cb.dataset.fname);
  _codexUpdateSelectedHint();
  const filtered = codexFilteredRows();
  const p = PAGERS.codex;
  const pageFilenames = filtered.slice((p.page - 1) * p.size, p.page * p.size).map(r => r.filename);
  const allChecked = pageFilenames.length > 0 && pageFilenames.every(f => CODEX_SELECTED.has(f));
  $('#codexSelectAll').checked = allChecked;
  $('#codexSelectAll').indeterminate = !allChecked && pageFilenames.some(f => CODEX_SELECTED.has(f));
});

function filenameFromDisposition(cd, fallback) {
  const text = cd || '';
  let m = text.match(/filename\*=UTF-8''([^;]+)/i);
  if (m) return decodeURIComponent(m[1].replace(/"/g, ''));
  m = text.match(/filename="([^"]+)"/i) || text.match(/filename=([^;]+)/i);
  return m ? m[1].replace(/"/g, '').trim() : fallback;
}

async function downloadFromPost(endpoint, filenames, fallbackName, successLabel) {
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filenames }),
  });
  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    throw new Error(e.error || ('HTTP ' + resp.status));
  }
  const dlname = filenameFromDisposition(resp.headers.get('Content-Disposition'), fallbackName);
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = dlname;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 800);
  showToast(successLabel, 'success');
}

async function downloadSelected(endpoint, fallbackPrefix, label) {
  if (CODEX_SELECTED.size === 0) return;
  const filenames = selectedFilenames();
  try {
    await downloadFromPost(endpoint, filenames, `${fallbackPrefix}-${Date.now()}.json`, `${label} 下载已开始（${filenames.length} 个）`);
    CODEX_SELECTED.clear();
    setTimeout(loadCodex, 600);
  } catch (err) {
    showToast(`${label} 下载失败: ` + err.message, 'error');
  }
}

$('#btnCodexDownloadCpa').addEventListener('click', () => downloadSelected('/api/codex/download-cpa', 'codex-cpa', 'CPA'));
$('#btnCodexDownloadSub2api').addEventListener('click', () => downloadSelected('/api/codex/download-sub2api', 'codex-sub2api', 'Sub2API'));

async function checkCodexFiles(filenames, label) {
  if (!filenames.length) {
    showToast('没有可测活的 Codex 凭证', 'warning');
    return;
  }
  if (filenames.length > 100) {
    showToast('单次最多测活 100 个，请缩小搜索范围或勾选部分账号', 'warning');
    return;
  }
  if (!await confirmDialog({
    title: label,
    tone: 'warning',
    confirmText: '开始测活',
    message: `将对 ${filenames.length} 个本地 Codex 凭证执行 gpt-5.5 试聊：发送 hi。\n\n只直连模型接口，不调用 CPA/Sub2API 服务器账号测活。继续？`,
  })) return;
  $('#btnCodexCheckSelected').disabled = true;
  $('#btnCodexCheckFiltered').disabled = true;
  try {
    const r = await api('/api/codex/check-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filenames, model: 'gpt-5.5', prompt: 'hi', timeout: 60, max_workers: 6 }),
    });
    const s = r.summary || {};
    showToast(`测活完成：试聊成功 ${s.usable || 0}，凭证可达 ${s.alive || 0} / ${s.total || filenames.length}`, (s.failed || 0) ? 'warning' : 'success');
    await loadCodex();
  } catch(err) {
    showToast('本地测活失败: ' + err.message, 'error');
  } finally {
    $('#btnCodexCheckFiltered').disabled = false;
    _codexUpdateSelectedHint();
  }
}

$('#btnCodexCheckSelected').addEventListener('click', () => checkCodexFiles(selectedFilenames(), '测活选中账号？'));
$('#btnCodexCheckFiltered').addEventListener('click', () => checkCodexFiles(filteredFilenames(), '测活当前列表全部账号？'));

function renderCodexBulkResult(title, summary, text) {
  const panel = $('#codexBulkResultPanel');
  $('#codexBulkResultTitle').textContent = title;
  $('#codexBulkResultSummary').textContent = summary || '';
  $('#codexBulkResultContent').textContent = text || '暂无结果';
  panel?.classList.remove('hidden');
}

function codexRefreshResultText(r, bulkScope) {
  const lines = [];
  lines.push(`范围: ${bulkScope.label}`);
  lines.push(`请求: ${r.requested || bulkScope.count || 0}`);
  lines.push(`结果: ${r.success || 0} 成功 / ${r.failed || 0} 失败`);
  lines.push('');
  (r.items || []).forEach((item, index) => {
    const mark = item.ok ? '✅' : '❌';
    const saved = item.saved === false ? ' 写回账号资产失败' : '';
    const plan = item.plan_type ? ` plan=${item.plan_type}` : '';
    const expired = item.expired ? ` 过期=${item.expired}` : '';
    lines.push(`${index + 1}. ${mark} ${item.filename || item.codex_filename || '-'} [${item.status || '-'}]${saved}${plan}${expired}`);
    if (item.identity) lines.push(`   账号: ${item.identity}`);
    if (item.access_token_preview) lines.push(`   token: ${item.access_token_preview}…`);
    if (item.message) lines.push(`   ${String(item.message).slice(0, 500)}`);
  });
  return lines.join('\n');
}

async function refreshCodexTokensAdaptive() {
  const bulkScope = currentCodexBulkScope();
  if (!bulkScope.count) {
    showToast('当前没有可刷新的 Codex 凭证', 'warning');
    return;
  }
  if (bulkScope.count > 1000) {
    showToast('单次最多刷新 1000 个，请缩小搜索/筛选范围或勾选部分凭证', 'warning');
    return;
  }
  const msg = bulkScope.scope === 'selected'
    ? `将刷新已勾选 ${bulkScope.count} 个 Codex 凭证。`
    : `将刷新当前搜索/筛选结果 ${bulkScope.count} 个 Codex 凭证。`;
  if (!await confirmDialog({
    title: '刷新 Codex access_token？',
    tone: 'warning',
    confirmText: '开始刷新',
    message: `${msg}\n\n刷新会反查对应账号资产，并复用注册时保存的代理、指纹和 device_id；只刷新 Codex OAuth token，不删除账号资产。`,
  })) return;
  $('#btnCodexRefreshToken').disabled = true;
  renderCodexBulkResult('Codex Token 刷新结果', `执行中：${bulkScope.targetText}`, '正在刷新 Codex access_token...\n同步执行中，请等待完成。');
  try {
    const r = await api('/api/codex/access-token/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filenames: bulkScope.filenames }),
    });
    showToast(`Codex Token 刷新完成：成功 ${r.success || 0} / 失败 ${r.failed || 0}`, (r.failed || 0) ? 'warning' : 'success');
    renderCodexBulkResult('Codex Token 刷新结果', `成功 ${r.success || 0} / 失败 ${r.failed || 0}`, codexRefreshResultText(r, bulkScope));
    await loadCodex();
  } catch (err) {
    showToast('刷新 Codex Token 失败: ' + err.message, 'error');
    renderCodexBulkResult('Codex Token 刷新结果', '执行失败', `刷新失败：${err.message}`);
  } finally {
    _codexUpdateSelectedHint();
  }
}

async function deleteCodexFiles(filenames, label, scopeText) {
  if (!filenames.length) {
    showToast('没有可删除的 Codex 凭证', 'warning');
    return;
  }
  if (!await confirmDialog({
    title: `${label}？`,
    tone: 'error',
    confirmText: '确认删除',
    message: `将删除 ${scopeText} 的 ${filenames.length} 个 Codex 凭证文件。\n\n只删除 exports/codex_accounts 下的 codex-*.json 和对应导出/测活状态，不删除账号资产。`,
  })) return;
  try {
    const r = await api('/api/codex/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filenames }),
    });
    const failed = (r.errors || []).length;
    showToast(`删除完成：成功 ${r.deleted || 0} / 失败 ${failed}`, failed ? 'warning' : 'success');
    if (failed) {
      renderCodexBulkResult(
        'Codex 删除结果',
        `成功 ${r.deleted || 0} / 失败 ${failed}`,
        (r.errors || []).map((x, i) => `${i + 1}. ❌ ${x.filename}: ${x.error}`).join('\n')
      );
    }
    filenames.forEach(fname => CODEX_SELECTED.delete(fname));
    await loadCodex();
  } catch (err) {
    showToast('删除 Codex 凭证失败: ' + err.message, 'error');
  }
}

$('#btnCodexRefreshToken')?.addEventListener('click', refreshCodexTokensAdaptive);
$('#btnCodexDeleteSelected')?.addEventListener('click', () => deleteCodexFiles(selectedFilenames(), '删除选中 Codex 凭证', '已勾选'));
$('#btnCodexDeleteFiltered')?.addEventListener('click', () => deleteCodexFiles(filteredFilenames(), '删除当前筛选全部 Codex 凭证', '当前搜索/筛选结果'));
$('#btnCloseCodexBulkResult')?.addEventListener('click', () => $('#codexBulkResultPanel')?.classList.add('hidden'));

$('#btnCodexUploadRelay').addEventListener('click', async () => {
  if (CODEX_SELECTED.size === 0) return;
  const rows = selectedRows();
  const tokenCount = rows.filter(r => r.has_refresh_token).length;
  if (!tokenCount) {
    showToast('选中的凭证都缺少 refresh_token，不能上传', 'warning');
    return;
  }
  const note = `选中 ${CODEX_SELECTED.size} 个凭证，其中 ${tokenCount} 个有 refresh_token。\n\n` +
               `将上传到“运行配置 → 中转配置”中已开启的 CPA / SUB2API。缺少 refresh_token 的凭证会跳过。`;
  if (!await confirmDialog({
    title: '上传到中转？',
    tone: 'warning',
    confirmText: '开始上传',
    message: note,
  })) return;
  $('#btnCodexUploadRelay').disabled = true;
  try {
    const r = await api('/api/codex/upload-relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filenames: selectedFilenames() }),
    });
    const msg = `上传完成：成功 ${r.success || 0}，跳过 ${r.skipped || 0}，失败 ${r.failed || 0}`;
    showToast(msg, r.failed ? 'warning' : 'success');
    if (Array.isArray(r.items)) {
      const failed = r.items.filter(x => !x.ok && !x.skipped).slice(0, 3)
        .map(x => `${x.filename}: ${x.error || (x.results || []).filter(y => !y.ok).map(y => y.error).join('; ')}`)
        .filter(Boolean);
      if (failed.length) showToast(failed.join('\n'), 'error', { duration: 7000, title: '上传失败明细' });
    }
  } catch(err) {
    showToast('上传到中转失败: ' + err.message, 'error');
  } finally {
    _codexUpdateSelectedHint();
  }
});

$('#codexBody').addEventListener('click', async (e) => {
  const dl = e.target.closest('[data-codex-download]');
  if (dl) {
    const fname = dl.dataset.codexDownload;
    window.location.href = `/api/codex/download/${encodeURIComponent(fname)}`;
    setTimeout(loadCodex, 800);
    return;
  }
  const cpa = e.target.closest('[data-codex-download-cpa]');
  if (cpa) {
    const fname = cpa.dataset.codexDownloadCpa;
    try {
      await downloadFromPost('/api/codex/download-cpa', [fname], `${fname.replace(/^codex-/, '')}`, 'CPA 下载已开始');
      setTimeout(loadCodex, 600);
    } catch (err) { showToast('CPA 下载失败: ' + err.message, 'error'); }
    return;
  }
  const sub2api = e.target.closest('[data-codex-download-sub2api]');
  if (sub2api) {
    const fname = sub2api.dataset.codexDownloadSub2api;
    try {
      await downloadFromPost('/api/codex/download-sub2api', [fname], `sub2api-${Date.now()}.json`, 'Sub2API 下载已开始');
      setTimeout(loadCodex, 600);
    } catch (err) { showToast('Sub2API 下载失败: ' + err.message, 'error'); }
    return;
  }
  const rs = e.target.closest('[data-codex-reset]');
  if (rs) {
    const fname = rs.dataset.codexReset;
    if (!await confirmDialog({
      title: '重置导出标记？',
      tone: 'warning',
      confirmText: '确认重置',
      message: `把 ${fname} 标记重置为未导出？`,
    })) return;
    try {
      await api('/api/codex/reset-export', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({filename: fname}) });
      showToast('已重置', 'success');
      loadCodex();
    } catch(err) { showToast('重置失败: ' + err.message, 'error'); }
  }
});

registerPagerRenderer('codex', renderCodex);
window.GFR.pages = window.GFR.pages || {};
window.GFR.pages.codex = { loadCodex, renderCodex };
})();
