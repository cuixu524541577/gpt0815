// WebUI 登录页：首次创建管理员账号（注册式）+ 账号密码登录。
(function () {
  async function initLoginPage() {
    await (window.GFR.i18n?.ready || Promise.resolve());
    const { t } = window.GFR.i18n;
    const credentialsConfigured = document.body.dataset.credentialsConfigured === 'true';

    const registerPanel = document.getElementById('registerPanel');
    const registerForm = document.getElementById('registerForm');
    const registerButton = document.getElementById('registerBtn');
    const registerStatus = document.getElementById('registerStatus');
    const loginPanel = document.getElementById('passwordLoginPanel');
    const passwordForm = document.getElementById('passwordLoginForm');
    const passwordButton = document.getElementById('passwordLoginBtn');
    const passwordStatus = document.getElementById('passwordLoginStatus');
    const passwordInput = document.getElementById('loginPassword');
    const visibilityButton = document.getElementById('loginPasswordVisibility');

    function setStatus(element, message, tone = '') {
      if (!element) return;
      element.textContent = message || '';
      element.hidden = !message;
      element.classList.toggle('error', tone === 'error');
      element.classList.toggle('success', tone === 'success');
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

    function setBusy(button, busy) {
      if (button) button.disabled = busy;
    }

    // ---------------- 首次注册（仅未配置凭据时显示） ----------------
    async function submitRegister(event) {
      event.preventDefault();
      if (!registerForm?.reportValidity()) return;
      const username = document.getElementById('registerUsername')?.value || '';
      const password = document.getElementById('registerPassword')?.value || '';
      const confirm = document.getElementById('registerConfirmPassword')?.value || '';
      if (password !== confirm) {
        setStatus(registerStatus, t('auth.register.password_mismatch', {}, '两次输入的密码不一致'), 'error');
        document.getElementById('registerConfirmPassword')?.focus();
        return;
      }
      setBusy(registerButton, true);
      setStatus(registerStatus, '');
      try {
        await postJson('/api/auth/register', { username, password, confirm_password: confirm });
        setStatus(registerStatus, t('auth.register.success', {}, '创建成功，正在进入…'), 'success');
        setTimeout(() => { window.location.href = '/'; }, 250);
      } catch (error) {
        setBusy(registerButton, false);
        setStatus(registerStatus, error.message || t('errors.common.operation_failed', {}, '创建失败，请重试'), 'error');
      }
    }

    // ---------------- 账号密码登录 ----------------
    async function submitPasswordLogin(event) {
      event.preventDefault();
      if (!passwordForm?.reportValidity()) return;
      const username = document.getElementById('loginUsername')?.value || '';
      const password = passwordInput?.value || '';
      setBusy(passwordButton, true);
      setStatus(passwordStatus, '');
      try {
        await postJson('/api/auth/password/login', { username, password });
        setStatus(passwordStatus, t('auth.password.success', {}, '登录成功，正在进入…'), 'success');
        setTimeout(() => { window.location.href = '/'; }, 250);
      } catch (error) {
        setBusy(passwordButton, false);
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

    registerForm?.addEventListener('submit', submitRegister);
    passwordForm?.addEventListener('submit', submitPasswordLogin);
    visibilityButton?.addEventListener('click', passwordVisibility);

    // 未配置凭据 → 显示注册面板；已配置 → 显示登录面板
    if (registerPanel) registerPanel.hidden = credentialsConfigured;
    if (loginPanel) loginPanel.hidden = !credentialsConfigured;
    if (!credentialsConfigured) {
      setTimeout(() => document.getElementById('registerUsername')?.focus(), 0);
    } else {
      setTimeout(() => document.getElementById('loginUsername')?.focus(), 0);
    }
  }

  initLoginPage();
})();
