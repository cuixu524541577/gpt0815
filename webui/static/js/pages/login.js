// WebUI username/password and Telegram sign-in page.
(function () {
  async function initLoginPage() {
    await (window.GFR.i18n?.ready || Promise.resolve());
    const { t } = window.GFR.i18n;
    const credentialsConfigured = document.body.dataset.credentialsConfigured === 'true';
    const methodTabs = Array.from(document.querySelectorAll('[data-login-method]'));
    const methodPanels = {
      password: document.getElementById('passwordLoginPanel'),
      telegram: document.getElementById('telegramLoginPanel'),
    };
    const passwordForm = document.getElementById('passwordLoginForm');
    const passwordButton = document.getElementById('passwordLoginBtn');
    const passwordStatus = document.getElementById('passwordLoginStatus');
    const passwordInput = document.getElementById('loginPassword');
    const visibilityButton = document.getElementById('loginPasswordVisibility');
    const telegramButton = document.getElementById('tgLoginBtn');
    const telegramStatus = document.getElementById('loginStatus');
    let pollTimer = null;
    let pollUntil = 0;

    function setStatus(element, message, tone = '') {
      if (!element) return;
      element.textContent = message || '';
      element.hidden = !message;
      element.classList.toggle('error', tone === 'error');
      element.classList.toggle('success', tone === 'success');
    }

    function activateLoginMethod(method, { focus = false } = {}) {
      if (!methodPanels[method]) return;
      methodTabs.forEach(tab => {
        const active = tab.dataset.loginMethod === method;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
        if (active && focus) tab.focus();
      });
      Object.entries(methodPanels).forEach(([name, panel]) => {
        if (panel) panel.hidden = name !== method;
      });
    }

    async function postJson(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-GFR-Locale': window.GFR.i18n.getLocale(),
        },
        body: body ? JSON.stringify(body) : '{}',
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        const fallback = data.error || t('errors.request.http', { status: response.status });
        throw new Error(data.message_key ? t(data.message_key, data.message_params || {}, fallback) : fallback);
      }
      return data;
    }

    function setPasswordBusy(busy) {
      if (passwordButton) passwordButton.disabled = busy || !credentialsConfigured;
      passwordForm?.querySelectorAll('input, .password-visibility').forEach(control => {
        control.disabled = busy || !credentialsConfigured;
      });
    }

    async function submitPasswordLogin(event) {
      event.preventDefault();
      if (!passwordForm || !credentialsConfigured) return;
      if (!passwordForm.reportValidity()) return;
      const username = document.getElementById('loginUsername')?.value || '';
      const password = passwordInput?.value || '';
      setPasswordBusy(true);
      setStatus(passwordStatus, '');
      try {
        await postJson('/api/auth/password/login', {
          username,
          password,
        });
        setStatus(passwordStatus, t('auth.password.success', {}, '登录成功，正在进入…'), 'success');
        setTimeout(() => { window.location.href = '/'; }, 250);
      } catch (error) {
        setPasswordBusy(false);
        setStatus(passwordStatus, error.message || t('auth.password.invalid', {}, '用户名或密码错误'), 'error');
      }
    }

    function passwordVisibility() {
      if (!passwordInput || !visibilityButton) return;
      const show = passwordInput.type === 'password';
      passwordInput.type = show ? 'text' : 'password';
      const label = show
        ? t('auth.password.hide', {}, '隐藏密码')
        : t('auth.password.show', {}, '显示密码');
      visibilityButton.setAttribute('aria-label', label);
      visibilityButton.title = label;
      visibilityButton.classList.toggle('active', show);
      passwordInput.focus();
    }

    function stopPolling() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    }

    async function pollStatus() {
      try {
        if (pollUntil && Date.now() > pollUntil) {
          stopPolling();
          if (telegramButton) telegramButton.disabled = false;
          setStatus(telegramStatus, t('auth.telegram.expired'), 'error');
          return;
        }
        const data = await postJson('/api/auth/telegram/status');
        if (data.status === 'approved' && data.authenticated) {
          stopPolling();
          setStatus(telegramStatus, t('auth.telegram.success'), 'success');
          setTimeout(() => { window.location.href = '/'; }, 300);
          return;
        }
        if (data.status === 'denied' || data.status === 'access_denied') {
          stopPolling();
          if (telegramButton) telegramButton.disabled = false;
          setStatus(telegramStatus, t('auth.telegram.denied'), 'error');
          return;
        }
        setStatus(telegramStatus, t('auth.telegram.confirm'));
      } catch (error) {
        stopPolling();
        if (telegramButton) telegramButton.disabled = false;
        setStatus(telegramStatus, error.message || t('auth.telegram.failed'), 'error');
      }
    }

    async function startTelegramLogin() {
      stopPolling();
      setStatus(telegramStatus, t('auth.telegram.opening'));
      if (telegramButton) telegramButton.disabled = true;

      // Open synchronously so browsers do not block the popup.
      const popup = window.open('about:blank', '_blank');
      try {
        const data = await postJson('/api/auth/telegram/start');
        if (popup) popup.location.href = data.telegram_url;
        else window.location.href = data.telegram_url;
        pollUntil = Date.now() + Math.max(30, data.expires_in || 600) * 1000;
        setStatus(telegramStatus, t('auth.telegram.confirm'));
        pollTimer = setInterval(pollStatus, 2000);
        setTimeout(pollStatus, 800);
      } catch (error) {
        if (popup) popup.close();
        if (telegramButton) telegramButton.disabled = false;
        setStatus(telegramStatus, error.message || t('auth.telegram.failed'), 'error');
      }
    }

    methodTabs.forEach((tab, index) => {
      tab.addEventListener('click', () => activateLoginMethod(tab.dataset.loginMethod));
      tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        let nextIndex = index;
        if (event.key === 'ArrowLeft') nextIndex = (index - 1 + methodTabs.length) % methodTabs.length;
        if (event.key === 'ArrowRight') nextIndex = (index + 1) % methodTabs.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = methodTabs.length - 1;
        activateLoginMethod(methodTabs[nextIndex].dataset.loginMethod, { focus: true });
      });
    });

    passwordForm?.addEventListener('submit', submitPasswordLogin);
    visibilityButton?.addEventListener('click', passwordVisibility);
    telegramButton?.addEventListener('click', startTelegramLogin);
    activateLoginMethod(credentialsConfigured ? 'password' : 'telegram');
  }

  initLoginPage();
})();
