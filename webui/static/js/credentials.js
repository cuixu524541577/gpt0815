// Telegram 会话设置或重置 WebUI 本地登录账号。
(function () {
  window.GFR = window.GFR || {};

  const state = {
    authType: '',
    configured: false,
    username: '',
    mode: 'manual',
    busy: false,
    bound: false,
    autoOpened: false,
    previousFocus: null,
    closeTimer: null,
  };

  const elements = {};

  function t(key, fallback, params = {}) {
    return window.GFR.t?.(key, params, fallback) || fallback;
  }

  function cacheElements() {
    elements.action = document.getElementById('credentialMenuAction');
    elements.actionLabel = document.getElementById('credentialMenuActionLabel');
    elements.modal = document.getElementById('credentialModal');
    elements.title = document.getElementById('credentialModalTitle');
    elements.form = document.getElementById('credentialForm');
    elements.username = document.getElementById('credentialUsername');
    elements.password = document.getElementById('credentialPassword');
    elements.confirmPassword = document.getElementById('credentialConfirmPassword');
    elements.status = document.getElementById('credentialStatus');
    elements.cancel = document.getElementById('credentialCancel');
    elements.skip = document.getElementById('credentialSkip');
    elements.save = document.getElementById('credentialSave');
  }

  function setStatus(message, tone = '') {
    if (!elements.status) return;
    elements.status.textContent = message || '';
    elements.status.hidden = !message;
    elements.status.classList.toggle('error', tone === 'error');
    elements.status.classList.toggle('success', tone === 'success');
  }

  function actionText() {
    return state.configured
      ? t('auth.credentials.reset_action', '重置登录账号')
      : t('auth.credentials.set_action', '设置登录账号');
  }

  function titleText() {
    return state.configured
      ? t('auth.credentials.reset_title', '重置登录账号')
      : t('auth.credentials.set_title', '设置登录账号');
  }

  function renderAction() {
    if (!elements.action) return;
    const telegramSession = state.authType === 'telegram';
    const label = actionText();
    elements.action.hidden = !telegramSession;
    elements.action.title = label;
    elements.action.setAttribute('aria-label', label);
    if (elements.actionLabel) elements.actionLabel.textContent = label;
  }

  function renderModalTitle() {
    if (elements.title) elements.title.textContent = titleText();
  }

  function setBusy(busy) {
    state.busy = Boolean(busy);
    elements.form?.setAttribute('aria-busy', String(state.busy));
    elements.form?.querySelectorAll('input, button').forEach(control => {
      control.disabled = state.busy;
    });
  }

  function isOpen() {
    return Boolean(elements.modal && !elements.modal.classList.contains('hidden'));
  }

  function close({ force = false } = {}) {
    if (!isOpen() || (state.busy && !force)) return;
    if (state.closeTimer) clearTimeout(state.closeTimer);
    elements.modal.classList.remove('show');
    elements.modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('credential-modal-open');
    state.closeTimer = setTimeout(() => {
      elements.modal?.classList.add('hidden');
      state.closeTimer = null;
    }, 160);
    const previousFocus = state.previousFocus;
    state.previousFocus = null;
    if (previousFocus && document.contains(previousFocus)) previousFocus.focus();
  }

  function open(mode) {
    if (state.authType !== 'telegram' || !elements.modal || !elements.form) return;
    if (state.closeTimer) {
      clearTimeout(state.closeTimer);
      state.closeTimer = null;
    }
    state.mode = mode === 'initial' ? 'initial' : 'manual';
    state.previousFocus = document.activeElement;
    setBusy(false);
    setStatus('');
    renderModalTitle();
    elements.username.value = state.username || '';
    elements.password.value = '';
    elements.confirmPassword.value = '';
    elements.cancel.hidden = state.mode === 'initial';
    elements.skip.hidden = state.mode !== 'initial';
    document.getElementById('userMenu')?.removeAttribute('open');
    elements.modal.classList.remove('hidden');
    elements.modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('credential-modal-open');
    requestAnimationFrame(() => elements.modal?.classList.add('show'));
    setTimeout(() => elements.username?.focus(), 0);
  }

  async function save(event) {
    event.preventDefault();
    if (state.busy || state.authType !== 'telegram' || !elements.form?.reportValidity()) return;
    if (elements.password.value !== elements.confirmPassword.value) {
      setStatus(t('auth.credentials.password_mismatch', '两次输入的密码不一致'), 'error');
      elements.confirmPassword.focus();
      return;
    }

    setBusy(true);
    setStatus('');
    try {
      const result = await window.GFR.api('/api/auth/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: elements.username.value,
          password: elements.password.value,
          confirm_password: elements.confirmPassword.value,
        }),
      });
      const credentials = result.credentials || {};
      state.configured = Boolean(credentials.configured ?? true);
      state.username = String(credentials.username || elements.username.value || '').trim();
      renderAction();
      close({ force: true });
      window.GFR.showToast?.(t('auth.credentials.saved', '登录账号已保存'), 'success');
    } catch (error) {
      setBusy(false);
      setStatus(error.message || t('errors.common.operation_failed', '保存失败，请重试'), 'error');
    }
  }

  async function skip() {
    if (state.busy || state.mode !== 'initial' || state.authType !== 'telegram') return;
    setBusy(true);
    setStatus('');
    try {
      await window.GFR.api('/api/auth/credentials/prompt-dismiss', { method: 'POST' });
      close({ force: true });
      window.GFR.showToast?.(t('auth.credentials.skipped', '已暂时跳过登录账号设置'), 'info');
    } catch (error) {
      setBusy(false);
      setStatus(error.message || t('errors.common.operation_failed', '操作失败，请重试'), 'error');
    }
  }

  function bindEvents() {
    if (state.bound) return;
    state.bound = true;
    elements.action?.addEventListener('click', () => open('manual'));
    elements.form?.addEventListener('submit', save);
    elements.cancel?.addEventListener('click', () => {
      if (state.mode === 'manual') close();
    });
    elements.skip?.addEventListener('click', skip);
    elements.modal?.addEventListener('click', event => {
      if (event.target === elements.modal && state.mode === 'manual') close();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && isOpen() && state.mode === 'manual') close();
    });
    window.addEventListener('gfr:localechange', () => {
      renderAction();
      if (isOpen()) renderModalTitle();
    });
  }

  function init(me) {
    cacheElements();
    bindEvents();
    const user = me?.user || {};
    state.authType = String(me?.auth_type || user.auth_type || '');
    state.configured = Boolean(me?.credentials_configured);
    state.username = String(me?.credentials_username || '').trim();
    renderAction();
    if (state.authType === 'telegram' && me?.credential_prompt_required && !state.autoOpened) {
      state.autoOpened = true;
      open('initial');
    }
  }

  window.GFR.credentials = { init };
})();
