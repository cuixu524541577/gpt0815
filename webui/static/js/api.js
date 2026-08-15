// 后端 API 访问封装。
(function () {
  window.GFR = window.GFR || {};

  window.GFR.api = async function api(url, opts) {
    const options = { credentials: 'same-origin', ...(opts || {}) };
    const headers = new Headers(options.headers || {});
    const locale = window.GFR.i18n?.getLocale?.();
    if (locale) headers.set('X-GFR-Locale', locale);
    options.headers = headers;
    const r = await fetch(url, options);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const fallback = j.error || window.GFR.t?.('errors.request.http', { status: r.status }) || ('HTTP ' + r.status);
      const message = j.message_key
        ? window.GFR.t?.(j.message_key, j.message_params || {}, fallback) || fallback
        : fallback;
      const error = new Error(message);
      error.status = r.status;
      error.errorCode = j.error_code || '';
      error.messageKey = j.message_key || '';
      error.messageParams = j.message_params || {};
      error.detail = j.detail || '';
      error.payload = j;
      throw error;
    }
    return j;
  };
})();
