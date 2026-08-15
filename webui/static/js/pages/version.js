// 版本检查与 Docker 更新弹窗。
(function () {
const { $, esc, showToast, api } = window.GFR;

let VERSION = null;
let checking = false;
let updateInProgress = false;
let versionInterval = null;
const RELEASE_NOTES_SEEN_KEY = 'gfr.release_notes.seen';
const RELEASE_NOTES_PROMPT_DELAY_MS = 1100;
let releaseNotesAutoHandled = false;
let releaseNotesPromptTimer = null;

function setChip(info) {
  const chip = $('#appVersionChip');
  const text = $('#appVersionText');
  if (!chip || !text || !info) return;
  text.textContent = `v${info.current || '-'}`;
  chip.classList.toggle('has-update', !!info.update_available);
  chip.title = info.update_available ? `有新版本 v${info.latest}` : '查看版本和更新';
}

function syncRefreshButtonState() {
  const button = $('#btnVersionRefresh');
  if (!button) return;
  button.disabled = checking || updateInProgress;
  button.classList.toggle('is-checking', checking);
}

function ensureVersionModal() {
  let host = $('#versionModalHost');
  if (host) return host;
  host = document.createElement('div');
  host.id = 'versionModalHost';
  document.body.appendChild(host);
  return host;
}

function currentReleaseNotes(info) {
  const notes = info?.release_notes;
  if (!notes || normalizeVersion(notes.version) !== normalizeVersion(info?.current)) return null;
  if (!Array.isArray(notes.items) || !notes.items.length) return null;
  return notes;
}

function releaseNotesItemsHtml(notes) {
  return notes.items.map((item) => `
    <div class="release-note-item">
      <span class="release-note-emoji" aria-hidden="true">${esc(item.emoji)}</span>
      <div class="release-note-copy">
        <strong>${esc(item.title)}</strong>
        <p>${esc(item.description)}</p>
      </div>
    </div>`).join('');
}

function releaseNotesSectionHtml(notes, { summary = true } = {}) {
  if (!notes) return '';
  return `
    <section class="release-notes-section">
      <div class="release-notes-heading">
        <strong>${esc(notes.title)}</strong>
        <span>${esc(notes.published_at)}</span>
      </div>
      ${summary ? `<p class="release-notes-summary">${esc(notes.summary)}</p>` : ''}
      <div class="release-notes-list">${releaseNotesItemsHtml(notes)}</div>
    </section>`;
}

function bindModalDismiss(host) {
  const backdrop = host.querySelector('.version-modal-backdrop');
  host.querySelector('.version-close')?.addEventListener('click', closeModal);
  backdrop?.addEventListener('click', (event) => {
    if (event.target === backdrop) closeModal();
  });
  backdrop?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal();
  });
  backdrop?.focus({ preventScroll: true });
}

function renderReleaseNotesModal(info) {
  const notes = currentReleaseNotes(info);
  if (!notes) return;
  const host = ensureVersionModal();
  host.innerHTML = `
    <div class="version-modal-backdrop show" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="releaseNotesModalTitle">
      <div class="version-card release-notes-card">
        <div class="version-card-head">
          <div>
            <div class="release-notes-kicker">v${esc(info.current || notes.version)} · ${esc(notes.published_at)}</div>
            <h3 id="releaseNotesModalTitle">本次更新</h3>
          </div>
          <button type="button" class="version-close" title="稍后提醒" aria-label="稍后提醒">×</button>
        </div>
        ${releaseNotesSectionHtml(notes)}
        <div class="release-notes-actions">
          <button type="button" class="btn" id="btnReleaseNotesLater">稍后提醒</button>
          <button type="button" class="btn primary" id="btnReleaseNotesAcknowledge">我知道了</button>
        </div>
      </div>
    </div>`;
  bindModalDismiss(host);
  host.querySelector('#btnReleaseNotesLater')?.addEventListener('click', closeModal);
  host.querySelector('#btnReleaseNotesAcknowledge')?.addEventListener('click', () => {
    try {
      localStorage.setItem(RELEASE_NOTES_SEEN_KEY, normalizeVersion(info.current));
    } catch (_) {
      showToast('确认状态无法保存，下次仍会提醒', 'warning');
    }
    closeModal();
  });
}

function releaseNotesWereSeen(info) {
  try {
    return normalizeVersion(localStorage.getItem(RELEASE_NOTES_SEEN_KEY)) === normalizeVersion(info?.current);
  } catch (_) {
    return false;
  }
}

function isBlockingModalVisible() {
  return !!document.querySelector([
    '.modal-backdrop.show',
    '.guide-layer.show',
    '.guide-picker-layer.show',
    '#versionModalHost .version-modal-backdrop.show',
  ].join(', '));
}

function scheduleReleaseNotesModal(info) {
  clearTimeout(releaseNotesPromptTimer);
  const showWhenReady = () => {
    if (releaseNotesWereSeen(info)) {
      releaseNotesPromptTimer = null;
      return;
    }
    if (isBlockingModalVisible()) {
      releaseNotesPromptTimer = setTimeout(showWhenReady, 250);
      return;
    }
    releaseNotesPromptTimer = null;
    renderReleaseNotesModal(info);
  };
  releaseNotesPromptTimer = setTimeout(showWhenReady, RELEASE_NOTES_PROMPT_DELAY_MS);
}

function maybeAutoShowReleaseNotes(info) {
  if (releaseNotesAutoHandled) return;
  const notes = currentReleaseNotes(info);
  if (!notes) return;
  if (releaseNotesWereSeen(info)) return;
  releaseNotesAutoHandled = true;
  scheduleReleaseNotesModal(info);
}

function renderModal(info) {
  const host = ensureVersionModal();
  const notes = currentReleaseNotes(info);
  const updateNote = info.update_available
    ? `<div class="version-alert"><div class="version-alert-icon">↓</div><div><strong>有新版本可用</strong><span>v${esc(info.latest)}</span></div></div>`
    : `<div class="version-ok"><strong>当前已经是最新版</strong></div>`;
  host.innerHTML = `
    <div class="version-modal-backdrop show" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="versionModalTitle">
      <div class="version-card">
        <div class="version-card-head">
          <div>
            <h3 id="versionModalTitle">版本与更新</h3>
          </div>
          <button type="button" class="version-close" aria-label="关闭">×</button>
        </div>
        <div class="version-hero-row">
          <div class="version-hero">v${esc(info.current || '-')}</div>
          <button type="button" class="version-refresh" id="btnVersionRefresh" title="检查最新版本" aria-label="检查最新版本">
            <span class="version-refresh-icon" aria-hidden="true">↻</span>
          </button>
        </div>
        <div class="version-latest">最新版本：v${esc(info.latest || info.current || '-')}</div>
        ${updateNote}
        ${releaseNotesSectionHtml(notes, { summary: false })}
        <div class="version-update-panel hidden" id="versionUpdatePanel" aria-live="polite">
          <div class="version-update-row">
            <strong id="versionUpdateTitle">准备更新</strong>
            <span id="versionUpdatePercent">0%</span>
          </div>
          <div class="version-progress" aria-hidden="true"><span id="versionProgressBar"></span></div>
          <div class="version-update-detail" id="versionUpdateDetail">点击更新后将自动通知服务器拉取镜像并重启服务。</div>
          <div class="version-update-steps">
            <span data-step="start">触发更新</span>
            <span data-step="download">下载镜像</span>
            <span data-step="restart">重启服务</span>
            <span data-step="refresh">刷新页面</span>
          </div>
        </div>
        <div class="version-actions">
          <button type="button" class="btn primary" id="btnVersionUpdate" ${info.update_available && info.update_enabled ? '' : 'disabled'}>立即下载并重启更新</button>
        </div>
      </div>
    </div>`;
  bindModalDismiss(host);
  host.querySelector('#btnVersionRefresh')?.addEventListener('click', () => loadVersion(true, true));
  host.querySelector('#btnVersionUpdate')?.addEventListener('click', startUpdate);
  syncRefreshButtonState();
}

function closeModal() {
  if (updateInProgress) return;
  const host = $('#versionModalHost');
  if (!host) return;
  host.querySelector('.version-modal-backdrop')?.classList.remove('show');
  setTimeout(() => { host.innerHTML = ''; }, 160);
}

async function loadVersion(force = false, open = false) {
  if (checking) return VERSION;
  checking = true;
  syncRefreshButtonState();
  try {
    const info = await api(`/api/version${force ? '?force=1' : ''}`);
    VERSION = info;
    setChip(info);
    if (open) renderModal(info);
    return info;
  } catch (e) {
    showToast('版本检查失败: ' + e.message, 'warning');
  } finally {
    checking = false;
    syncRefreshButtonState();
  }
  return VERSION;
}

async function openModal() {
  releaseNotesAutoHandled = true;
  clearTimeout(releaseNotesPromptTimer);
  releaseNotesPromptTimer = null;
  const info = VERSION || await loadVersion(false, false);
  renderModal(info || { current: '-', latest: '-', source: 'local', update_enabled: false });
}

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function setStepState(activeStep) {
  const order = ['start', 'download', 'restart', 'refresh'];
  const activeIndex = order.indexOf(activeStep);
  document.querySelectorAll('.version-update-steps [data-step]').forEach((el) => {
    const index = order.indexOf(el.dataset.step || '');
    el.classList.toggle('active', index === activeIndex);
    el.classList.toggle('done', activeIndex >= 0 && index >= 0 && index < activeIndex);
  });
}

function setUpdateProgress({ step = 'start', title = '', detail = '', percent = 0, indeterminate = false, tone = '' } = {}) {
  const panel = $('#versionUpdatePanel');
  const card = panel?.closest('.version-card');
  if (!panel) return;
  panel.classList.remove('hidden', 'success', 'error', 'warning');
  if (tone) panel.classList.add(tone);
  card?.classList.add('updating');
  const titleEl = $('#versionUpdateTitle');
  const detailEl = $('#versionUpdateDetail');
  const percentEl = $('#versionUpdatePercent');
  const bar = $('#versionProgressBar');
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  if (titleEl) titleEl.textContent = title || '正在更新';
  if (detailEl) detailEl.textContent = detail || '';
  if (percentEl) percentEl.textContent = indeterminate ? '处理中' : `${Math.round(value)}%`;
  if (bar) {
    bar.style.width = `${value}%`;
    bar.classList.toggle('indeterminate', !!indeterminate);
  }
  setStepState(step);
}

function setUpdateButtons(disabled) {
  ['#btnVersionUpdate', '#btnVersionRefresh'].forEach((selector) => {
    const btn = $(selector);
    if (btn) btn.disabled = !!disabled;
  });
  const close = $('.version-close');
  if (close) close.disabled = !!disabled;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientUpdateError(error) {
  const message = String(error?.message || error || '');
  return /Failed to fetch|NetworkError|Load failed|abort|ECONN|connection|fetch/i.test(message);
}

async function fetchJsonWithTimeout(url, timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { 'Accept': 'application/json' },
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForServiceRecovery(expectedVersion, previousLastAttemptAt = null) {
  const deadline = Date.now() + 180000;
  let sawOffline = false;
  let percent = 62;
  await sleep(5000);
  while (Date.now() < deadline) {
    try {
      const info = await fetchJsonWithTimeout(`/api/version?force=1&_=${Date.now()}`, 4500);
      const current = normalizeVersion(info.current);
      const state = info?.deployment_updater?.state || {};
      const attemptAt = Number(state.last_attempt_at || 0);
      if (
        previousLastAttemptAt !== null
        && attemptAt > previousLastAttemptAt
        && ['failed', 'deferred'].includes(String(state.status || ''))
      ) {
        return {
          ok: false,
          failed: true,
          message: String(state.message || '主机部署更新器执行失败。'),
        };
      }
      if (expectedVersion && current === normalizeVersion(expectedVersion)) {
        VERSION = info;
        setChip(info);
        return { ok: true, version: current, updated: true };
      }
      if (sawOffline) {
        return { ok: true, version: current, updated: false };
      }
      percent = Math.min(88, percent + 2);
      setUpdateProgress({
        step: 'download',
        title: '正在下载并应用镜像',
        detail: '服务器仍在线，主机部署更新器可能正在拉取 Release。请保持此窗口打开。',
        percent,
        indeterminate: true,
      });
    } catch (_) {
      sawOffline = true;
      percent = Math.min(94, percent + 3);
      setUpdateProgress({
        step: 'restart',
        title: '服务正在重启',
        detail: '检测到 WebUI 短暂不可用，正在等待新容器恢复。',
        percent,
        indeterminate: true,
      });
    }
    await sleep(3000);
  }
  return { ok: false, updated: false };
}

async function startUpdate() {
  const info = VERSION || {};
  if (!info.update_available) return;
  if (updateInProgress) return;
  updateInProgress = true;
  setUpdateButtons(true);
  setUpdateProgress({
    step: 'start',
    title: '正在触发更新',
    detail: `准备从 v${info.current || '-'} 更新到 v${info.latest || '-'}，无需输入更新口令。`,
    percent: 12,
  });
  try {
    await sleep(250);
    let r = null;
    try {
      r = await api('/api/update/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
    } catch (postError) {
      if (!isTransientUpdateError(postError)) throw postError;
      setUpdateProgress({
        step: 'restart',
        title: '服务正在重启',
        detail: '更新请求已发出，连接中断可能是服务正在重启。正在等待 WebUI 恢复。',
        percent: 58,
        indeterminate: true,
      });
    }
    setUpdateProgress({
      step: 'download',
      title: '已开始下载镜像',
      detail: r?.message || '主机部署更新器已收到请求，正在校验并应用最新 Release。',
      percent: 38,
      indeterminate: true,
    });
    const previousAttempt = Number(r?.previous_last_attempt_at);
    const recovery = await waitForServiceRecovery(
      info.latest,
      Number.isFinite(previousAttempt) ? previousAttempt : null,
    );
    if (!recovery.ok) {
      updateInProgress = false;
      setUpdateButtons(false);
      setUpdateProgress({
        step: recovery.failed ? 'download' : 'restart',
        title: recovery.failed ? '主机部署更新失败' : '仍在等待服务恢复',
        detail: recovery.failed
          ? recovery.message
          : '更新可能仍在后台进行。请稍后手动刷新页面，或查看主机部署更新器日志。',
        percent: recovery.failed ? 100 : 92,
        indeterminate: !recovery.failed,
        tone: recovery.failed ? 'error' : 'warning',
      });
      return;
    }
    setUpdateProgress({
      step: 'refresh',
      title: recovery.updated ? '更新完成' : '服务已恢复',
      detail: recovery.updated ? `已切换到 v${recovery.version}，页面即将刷新。` : '服务已恢复，页面即将刷新确认当前版本。',
      percent: 100,
      tone: 'success',
    });
    showToast('服务已恢复，正在刷新页面', 'success', { duration: 2200 });
    setTimeout(() => location.reload(), 1600);
  } catch (e) {
    updateInProgress = false;
    setUpdateButtons(false);
    setUpdateProgress({
      step: 'start',
      title: '触发更新失败',
      detail: e.message || '请检查服务器更新服务状态。',
      percent: 100,
      tone: 'error',
    });
  }
}

$('#appVersionChip')?.addEventListener('click', openModal);

// 版本接口受登录鉴权保护，必须等 app.js 完成会话初始化后再启动检查。
function startVersionChecks() {
  if (versionInterval) return;
  loadVersion(false, false).then(maybeAutoShowReleaseNotes);
  versionInterval = setInterval(async () => {
    if (document.hidden) return;  // 页面不可见时暂停版本检查
    maybeAutoShowReleaseNotes(await loadVersion(false, false));
  }, 5 * 60 * 1000);
}

window.GFR.pages = window.GFR.pages || {};
window.GFR.pages.version = { loadVersion, openModal, startVersionChecks };
})();
