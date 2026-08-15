// Shared WebUI localization runtime.
(function () {
  window.GFR = window.GFR || {};

  const SUPPORTED = new Set(['zh_cn', 'en']);
  const STORAGE_KEY = 'gfr.locale';
  const COOKIE_NAME = 'gfr_locale';
  const bootstrap = window.GFR_I18N_BOOTSTRAP || {};
  const catalogs = new Map();
  const textBindings = new WeakMap();
  const attributeBindings = new WeakMap();
  const sourceExact = new Map();
  let sourcePatterns = [];
  let applying = false;
  let observer = null;
  let locale = normalizeLocale(bootstrap.locale, true);
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });

  if (bootstrap.catalog && typeof bootstrap.catalog === 'object') {
    catalogs.set(locale, bootstrap.catalog);
  }

  function normalizeLocale(value, explicit = false) {
    const raw = String(value || '').trim().toLowerCase().replace(/-/g, '_');
    if (raw === 'zh' || raw === 'zh_cn' || raw === 'zh_hans' || raw.startsWith('zh_')) return 'zh_cn';
    if (raw === 'en' || raw.startsWith('en_')) return 'en';
    if (!explicit && raw) return 'en';
    return 'zh_cn';
  }

  function savedLocale() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (SUPPORTED.has(saved)) return saved;
    } catch (_) {}
    return '';
  }

  function interpolate(message, params) {
    const values = params && typeof params === 'object' ? params : {};
    return String(message).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => (
      Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
    ));
  }

  function selectedValue(value, count) {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return null;
    if (locale === 'en' && Number(count) === 1 && typeof value.one === 'string') return value.one;
    if (typeof value.other === 'string') return value.other;
    return typeof value.one === 'string' ? value.one : null;
  }

  function t(key, params, fallback) {
    const catalog = catalogs.get(locale) || {};
    const zh = catalogs.get('zh_cn') || {};
    const value = Object.prototype.hasOwnProperty.call(catalog, key) ? catalog[key] : zh[key];
    const message = selectedValue(value, params?.count);
    return interpolate(message == null ? (fallback == null ? key : fallback) : message, params);
  }

  function tp(key, count, params, fallback) {
    return t(key, { ...(params || {}), count }, fallback);
  }

  async function loadCatalog(nextLocale) {
    if (catalogs.has(nextLocale)) return catalogs.get(nextLocale);
    const version = encodeURIComponent(String(bootstrap.version || '1'));
    const response = await fetch(`/static/i18n/${nextLocale}.json?v=${version}`, {
      credentials: 'same-origin',
      cache: 'force-cache',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid locale catalog');
    catalogs.set(nextLocale, payload);
    if (nextLocale === 'zh_cn') rebuildSourceIndex();
    return payload;
  }

  function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function rebuildSourceIndex() {
    sourceExact.clear();
    sourcePatterns = [];
    const source = catalogs.get('zh_cn') || {};
    Object.entries(source).forEach(([key, rawValue]) => {
      const values = typeof rawValue === 'string' ? [rawValue] : Object.values(rawValue || {});
      values.filter(value => typeof value === 'string').forEach(value => {
        const names = [];
        let last = 0;
        let pattern = '';
        const matcher = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
        let match;
        while ((match = matcher.exec(value))) {
          pattern += escapeRegex(value.slice(last, match.index));
          pattern += '([\\s\\S]+?)';
          names.push(match[1]);
          last = match.index + match[0].length;
        }
        if (!names.length) {
          if (!sourceExact.has(value)) sourceExact.set(value, { key, params: {} });
          return;
        }
        pattern += escapeRegex(value.slice(last));
        const weight = value.replace(matcher, '').length;
        if (weight <= 0) return;
        sourcePatterns.push({
          key,
          names,
          regex: new RegExp(`^${pattern}$`),
          weight,
        });
      });
    });
    sourcePatterns.sort((a, b) => b.weight - a.weight);
  }

  if (catalogs.has('zh_cn')) rebuildSourceIndex();

  function resolveSource(value) {
    const exact = sourceExact.get(value);
    if (exact) return { ...exact, source: value };
    for (const candidate of sourcePatterns) {
      const match = candidate.regex.exec(value);
      if (!match) continue;
      const params = {};
      candidate.names.forEach((name, index) => { params[name] = match[index + 1]; });
      return { key: candidate.key, params, source: value };
    }
    return null;
  }

  function translateSourceParam(value, depth = 0) {
    if (depth > 2 || typeof value !== 'string' || !value) return value;
    const parts = splitWhitespace(value);
    const resolved = resolveSource(parts.core);
    if (!resolved) return value;
    const params = {};
    Object.entries(resolved.params || {}).forEach(([name, item]) => {
      params[name] = translateSourceParam(item, depth + 1);
    });
    return parts.leading + t(resolved.key, params, resolved.source) + parts.trailing;
  }

  function localizedParams(params) {
    const values = {};
    Object.entries(params || {}).forEach(([name, value]) => {
      values[name] = translateSourceParam(value);
    });
    return values;
  }

  function splitWhitespace(value) {
    const match = String(value).match(/^(\s*)([\s\S]*?)(\s*)$/);
    return { leading: match?.[1] || '', core: match?.[2] || '', trailing: match?.[3] || '' };
  }

  function shouldSkipNode(node) {
    const parent = node?.parentElement;
    return !parent || Boolean(parent.closest('script, style, noscript, textarea, pre, code, [data-i18n-raw]'));
  }

  function localizeTextNode(node) {
    if (shouldSkipNode(node)) return;
    const current = String(node.nodeValue || '');
    const previous = textBindings.get(node);
    if (previous && current === previous.rendered) {
      const renderedCore = t(previous.key, localizedParams(previous.params), previous.source);
      const rendered = previous.leading + renderedCore + previous.trailing;
      previous.rendered = rendered;
      if (rendered !== current) node.nodeValue = rendered;
      return;
    }
    const parts = splitWhitespace(current);
    if (!parts.core) return;
    const resolved = resolveSource(parts.core);
    if (!resolved) {
      textBindings.delete(node);
      return;
    }
    const rendered = parts.leading + t(resolved.key, localizedParams(resolved.params), resolved.source) + parts.trailing;
    textBindings.set(node, { ...resolved, leading: parts.leading, trailing: parts.trailing, rendered });
    if (rendered !== current) node.nodeValue = rendered;
  }

  function localizeAttribute(element, attr) {
    const current = element.getAttribute(attr);
    if (current == null) return;
    let bindings = attributeBindings.get(element);
    if (!bindings) {
      bindings = new Map();
      attributeBindings.set(element, bindings);
    }
    const previous = bindings.get(attr);
    if (previous && current === previous.rendered) {
      const rendered = t(previous.key, localizedParams(previous.params), previous.source);
      previous.rendered = rendered;
      if (rendered !== current) element.setAttribute(attr, rendered);
      return;
    }
    const resolved = resolveSource(current);
    if (!resolved) {
      bindings.delete(attr);
      return;
    }
    const rendered = t(resolved.key, localizedParams(resolved.params), resolved.source);
    bindings.set(attr, { ...resolved, rendered });
    if (rendered !== current) element.setAttribute(attr, rendered);
  }

  function localizeLegacyTree(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) {
      localizeTextNode(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) localizeTextNode(node);
    const elements = root.nodeType === Node.ELEMENT_NODE ? [root, ...root.querySelectorAll('*')] : root.querySelectorAll('*');
    elements.forEach(element => {
      ['title', 'placeholder', 'aria-label', 'alt'].forEach(attr => localizeAttribute(element, attr));
    });
  }

  function setCookie(nextLocale) {
    document.cookie = `${COOKIE_NAME}=${encodeURIComponent(nextLocale)}; Path=/; Max-Age=31536000; SameSite=Lax`;
  }

  function syncLocaleControls() {
    document.querySelectorAll('[data-locale-option]').forEach(button => {
      const active = button.dataset.localeOption === locale;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function applyDocument(root = document) {
    applying = true;
    root.querySelectorAll?.('[data-i18n]').forEach(element => {
      element.textContent = t(element.dataset.i18n, null, element.textContent);
    });
    const attrs = {
      'data-i18n-title': 'title',
      'data-i18n-placeholder': 'placeholder',
      'data-i18n-aria-label': 'aria-label',
    };
    Object.entries(attrs).forEach(([selector, attr]) => {
      root.querySelectorAll?.(`[${selector}]`).forEach(element => {
        element.setAttribute(attr, t(element.getAttribute(selector), null, element.getAttribute(attr) || ''));
      });
    });
    localizeLegacyTree(root);
    document.documentElement.lang = locale === 'zh_cn' ? 'zh-CN' : 'en';
    syncLocaleControls();
    applying = false;
  }

  async function setLocale(value, opts = {}) {
    const nextLocale = normalizeLocale(value, true);
    if (!SUPPORTED.has(nextLocale)) return false;
    try {
      await Promise.all([loadCatalog(nextLocale), loadCatalog('zh_cn')]);
    } catch (error) {
      if (!opts.silent) window.GFR.showToast?.(t('errors.i18n.load_failed'), 'error');
      return false;
    }
    const changed = nextLocale !== locale;
    locale = nextLocale;
    if (opts.persist !== false) {
      try { localStorage.setItem(STORAGE_KEY, locale); } catch (_) {}
      setCookie(locale);
    }
    applyDocument(document);
    document.title = t(document.body?.classList.contains('login-page') ? 'app.login_title' : 'app.title', null, document.title);
    if (changed) {
      window.dispatchEvent(new CustomEvent('gfr:localechange', { detail: { locale } }));
    }
    return true;
  }

  function bindLocaleControls() {
    document.addEventListener('click', event => {
      const button = event.target.closest('[data-locale-option]');
      if (button) setLocale(button.dataset.localeOption);
    });
  }

  function observeDocument() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver(mutations => {
      if (applying) return;
      applying = true;
      try {
        mutations.forEach(mutation => {
          if (mutation.type === 'characterData') {
            localizeTextNode(mutation.target);
          } else if (mutation.type === 'attributes') {
            localizeAttribute(mutation.target, mutation.attributeName);
          } else {
            mutation.addedNodes.forEach(localizeLegacyTree);
          }
        });
      } finally {
        applying = false;
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['title', 'placeholder', 'aria-label', 'alt'],
      characterData: true,
      childList: true,
      subtree: true,
    });
  }

  window.GFR.i18n = {
    applyDocument,
    getLocale: () => locale,
    loadCatalog,
    normalizeLocale,
    ready,
    setLocale,
    t,
    tp,
  };
  window.GFR.t = t;
  window.GFR.tp = tp;

  bindLocaleControls();
  observeDocument();
  const initial = savedLocale() || locale || normalizeLocale(navigator.language);
  setLocale(initial, { persist: true, silent: true }).finally(() => readyResolve(locale));
})();
