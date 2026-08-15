// 配置页逻辑。
(function () {
  const { $, $$, esc, escRaw, showToast, noticeHtml, controlHtml, api } = window.GFR;
  let CONFIG = [];
  let REGISTRATION_CAPACITY = null;
  let activeConfigTab = localStorage.getItem('gfr.activeConfigTab') || 'features';
  let activeRelayTab = localStorage.getItem('gfr.activeRelayTab') || 'cpa';
  let activeProxyPoolTab = localStorage.getItem('gfr.activeProxyPoolTab') || 'global';
  let CUSTOM_API_FIELD_OPTIONS = [];
  let customApiFields = [];
  const BUYGPTPULS_TEMP_MAIL_URL = 'https://email.oai9.com';
  const PROXY_POOL_PORTAL_URL = 'https://api.1024proxy.com/share/6vy1csx3b';
  const PROXY_POOL_PORTAL_2_URL = 'https://www.b2proxy.com/signup?code=10C67C';
  const PROXY_INPUT_FORMAT_HINT = '每行一个代理，协议前缀必填：http://、https://、socks4://、socks5:// 或 socks5h://。支持：用户名:密码@网关:端口、用户名:密码:网关:端口、网关:端口@用户名:密码、网关:端口:用户名:密码、网关:端口##用户名##密码。';
  const PROXY_INPUT_PLACEHOLDER = [
    '每行一个代理，协议前缀可用 http:// 或 socks5://：',
    'http://用户名:密码@网关:端口',
    'http://用户名:密码:网关:端口',
    'http://网关:端口@用户名:密码',
    'http://网关:端口:用户名:密码',
    'http://网关:端口##用户名##密码',
    '也支持 https://、socks4://、socks5h://',
  ].join('\n');
  const REGISTER_BIRTHDAY_ERROR = '默认生日格式必须为 YYYY-MM-DD，例如 2000-01-01';

  const EMAIL_SOURCE_OPTIONS = [
    { value: 'outlook', label: 'Outlook 邮箱池（REST / Graph / IMAP OAuth2）' },
    { value: 'buygptpuls_temp', label: 'buygptpuls 临时邮箱 API' },
    { value: 'api_otp_mail', label: '邮箱API接码（邮箱----api_url）' },
  ];
  const OUTLOOK_FETCH_MODE_OPTIONS = [
    { value: 'auto', label: '自动兼容（Outlook REST → Graph → IMAP）' },
    { value: 'rest', label: '只使用 Outlook REST API' },
    { value: 'graph', label: '只使用 Microsoft Graph API' },
    { value: 'imap', label: '只使用 IMAP OAuth2 / XOAUTH2' },
  ];
  const REGISTRATION_MODE_OPTIONS = [
    { value: 'email', label: '邮箱注册（默认）' },
    { value: 'phone', label: '手机号注册' },
  ];
  const PROXY_MODE_OPTIONS = [
    { value: 'global', label: '默认模式：使用全局代理池' },
    { value: 'advanced', label: '高级模式：注册/Codex 分池' },
  ];
  const OUTLOOK_EMAIL_KEYS = new Set([
    'OUTLOOK_FETCH_MODE', 'OUTLOOK_USE_PASSWORD_LOGIN', 'OUTLOOK_CONNECTION_CACHE_TTL', 'OUTLOOK_FETCH_LIMIT',
  ]);
  const AUTH_CONFIG_KEYS = new Set([
    'TELEGRAM_OAUTH_BASE_URL', 'TELEGRAM_OAUTH_CLIENT_ID', 'TELEGRAM_OAUTH_CLIENT_SECRET',
    'TELEGRAM_OAUTH_SCOPE', 'TELEGRAM_OAUTH_REDIRECT_URI', 'TELEGRAM_OAUTH_TIMEOUT',
    'TELEGRAM_AUTH_ALLOWED_USERS',
  ]);
  // 固定协议参数不在 WebUI 暴露，避免误改导致 Outlook / Telegram 登录流程失败。
  const HIDDEN_CONFIG_KEYS = new Set([
    'OUTLOOK_IMAP_HOST', 'OUTLOOK_IMAP_PORT', 'OUTLOOK_OAUTH_TENANT',
    'CUSTOM_API_FIELDS',
    ...AUTH_CONFIG_KEYS,
  ]);
  const BUYGPTPULS_EMAIL_KEYS = new Set([
    'BUYGPTPULS_API_BASE', 'BUYGPTPULS_API_KEY', 'BUYGPTPULS_DOMAIN', 'BUYGPTPULS_DOMAIN_LEVEL',
    'BUYGPTPULS_PREFIX', 'BUYGPTPULS_RANDOM_LENGTH',
  ]);
  const CONFIG_TABS = [
    {
      id: 'features',
      title: '功能开关',
      desc: '控制注册流程中的高层功能开关。',
      keys: [
        'ENABLE_CODEX_AUTO', 'ENABLE_TRIAL_CHECK', 'CODEX_OAUTH_SKIP_PHONE', 'ENABLE_2FA',
        'ENABLE_PAYMENT_LINK_AUTO_EXTRACT', 'PAYMENT_LINK_PROVIDER',
      ],
    },
    {
      id: 'register',
      title: '注册配置',
      desc: '注册模式、生日，以及 WebUI 批量任务启动参数。',
      keys: [
        'REGISTRATION_MODE',
        'ENABLE_POST_REGISTER_PASSWORD', 'POST_REGISTER_PASSWORD',
        'PHONE_REGISTRATION_SMS_SOURCE',
        'REGISTER_BATCH_COUNT',
        'REGISTER_WORKERS',
        'REGISTER_BIRTHDAY',
      ],
    },
    {
      id: 'codex-extract',
      title: '提Codex配置',
      desc: '控制 Codex OAuth 手机验证时使用平台接码或 API接码。',
      keys: ['CODEX_SMS_SOURCE'],
    },
    {
      id: 'email',
      title: '邮箱配置',
      desc: '邮箱来源、Outlook、buygptpuls 临时邮箱、邮箱 API 接码和邮件 OTP 轮询参数。',
      keys: [
        'EMAIL_SOURCE', 'EMAIL_FAILURE_MAX_RETRIES', 'OTP_MAX_WAIT', 'OTP_POLL_INTERVAL',
        'OUTLOOK_FETCH_MODE', 'OUTLOOK_USE_PASSWORD_LOGIN', 'OUTLOOK_CONNECTION_CACHE_TTL', 'OUTLOOK_FETCH_LIMIT',
        'BUYGPTPULS_API_BASE', 'BUYGPTPULS_API_KEY', 'BUYGPTPULS_DOMAIN', 'BUYGPTPULS_DOMAIN_LEVEL',
        'BUYGPTPULS_PREFIX', 'BUYGPTPULS_RANDOM_LENGTH',
      ],
    },
    {
      id: 'proxy',
      title: '代理配置',
      desc: '代理池配置；默认全局随机，高级模式可拆分注册代理池和提 Codex 代理池。',
      externalLinks: [
        { url: PROXY_POOL_PORTAL_URL, label: '打开代理官网' },
        { url: PROXY_POOL_PORTAL_2_URL, label: '打开代理官网2' },
      ],
      keys: ['PROXY_MODE', 'PROXY_EGRESS_COUNTRY', 'PROXY_POOL', 'REGISTER_PROXY_POOL', 'CODEX_PROXY_POOL'],
    },
    {
      id: 'sms',
      title: '接码配置',
      desc: '多平台接码、价格档策略、等待时间和重试次数。',
      keys: ['SMS_MAX_RETRIES', 'SMS_CODE_WAIT', 'SMS_POLL_INTERVAL', 'SMS_CANCEL_ON_TIMEOUT', 'SMS_BLACKLIST_ON_BAD_CODE'],
    },
    {
      id: 'relay',
      title: '上传配置',
      desc: 'CPA / Sub2API 自动上传与手动上传参数，以及注册完成后的自定义 API 推送。',
      keys: [
        'CPA_ENABLED', 'CPA_API_URL', 'CPA_LOGIN_PASSWORD',
        'SUB2API_ENABLED', 'SUB2API_API_URL', 'SUB2API_API_KEY', 'SUB2API_GROUP_IDS',
        'CUSTOM_API_ENABLED', 'CUSTOM_API_URL', 'CUSTOM_API_TRIGGER', 'CUSTOM_API_FORMAT', 'CUSTOM_API_FIELDS',
      ],
    },
    {
      id: 'card-pool',
      title: '卡池支付',
      desc: '虚拟信用卡池 / PayPal 池自动支付：驱动选择、提链后自动支付、BIN 白名单与并发控制。',
      keys: [
        'ENABLE_CARD_POOL', 'CARD_POOL_DRIVER', 'CARD_POOL_AUTO_PAY', 'CARD_POOL_PAY_METHOD',
        'CARD_POOL_PREFERRED_BINS', 'CARD_POOL_LEASE_SECONDS', 'CARD_POOL_MAX_CONCURRENT',
        'PAYPAL_OTP_TIMEOUT_SECONDS', 'PAYPAL_OTP_POLL_INTERVAL_SECONDS',
      ],
    },
  ];

  function fieldByKey(fields, key) {
    return fields.find(f => f.key === key);
  }

  function externalLink(url, label = '打开网站') {
    return `<a class="config-external-link" href="${escRaw(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
  }

  function tabDescHtml(tab) {
    const links = (tab.externalLinks || [])
      .map(link => externalLink(link.url, link.label || '打开网站'))
      .join(' ');
    return `<p>${esc(tab.desc)}${links ? ` ${links}` : ''}</p>`;
  }

  function currentEmailSource() {
    const el = $('#configForm [data-key="EMAIL_SOURCE"]');
    const source = el ? (el.dataset.value ?? el.value) : (fieldByKey(CONFIG, 'EMAIL_SOURCE')?.value || 'outlook');
    if (source === 'buygptpuls_temp') return 'buygptpuls_temp';
    if (source === 'api_otp_mail') return 'api_otp_mail';
    return 'outlook';
  }

  function fieldScopeAttr(f) {
    if (f.key === 'CODEX_OAUTH_SKIP_PHONE') return ' data-feature-scope="codex-oauth"';
    if (f.key === 'PAYMENT_LINK_PROVIDER') return ' data-feature-scope="payment-link-provider"';
    if (f.key === 'PHONE_REGISTRATION_SMS_SOURCE') return ' data-register-scope="phone"';
    if (f.key === 'ENABLE_POST_REGISTER_PASSWORD') return ' data-register-scope="email"';
    if (f.key === 'REGISTER_PROXY_POOL' || f.key === 'CODEX_PROXY_POOL') return ' data-proxy-scope="advanced"';
    if (OUTLOOK_EMAIL_KEYS.has(f.key)) return ' data-source-scope="outlook"';
    if (BUYGPTPULS_EMAIL_KEYS.has(f.key)) return ' data-source-scope="buygptpuls_temp"';
    if (/^(API_OTP_MAIL_)/.test(f.key)) return ' data-source-scope="api_otp_mail"';
    return '';
  }

  function fieldOptions(f) {
    if (Array.isArray(f.options) && f.options.length) return f.options;
    if (f.key === 'EMAIL_SOURCE') return EMAIL_SOURCE_OPTIONS;
    if (f.key === 'OUTLOOK_FETCH_MODE') return OUTLOOK_FETCH_MODE_OPTIONS;
    if (f.key === 'REGISTRATION_MODE') return REGISTRATION_MODE_OPTIONS;
    if (f.key === 'PROXY_MODE') return PROXY_MODE_OPTIONS;
    return null;
  }

  function fieldPlaceholder(f) {
    if (f.key === 'REGISTER_BIRTHDAY') return '2000-01-01';
    if (f.key === 'PROXY_EGRESS_COUNTRY') return '设置国家字母，如：JP、TR';
    if (['PROXY_POOL', 'REGISTER_PROXY_POOL', 'CODEX_PROXY_POOL'].includes(f.key)) return PROXY_INPUT_PLACEHOLDER;
    if (f.key === 'BUYGPTPULS_API_BASE') return BUYGPTPULS_TEMP_MAIL_URL;
    if (f.key === 'BUYGPTPULS_API_KEY') return 'emotp_xxx';
    if (f.key === 'BUYGPTPULS_DOMAIN') return '留空=随机启用域名；例如 buygptpuls.com';
    if (f.key === 'BUYGPTPULS_DOMAIN_LEVEL') return '5';
    if (f.key === 'BUYGPTPULS_PREFIX') return '可留空；例如 test';
    if (f.key === 'BUYGPTPULS_RANDOM_LENGTH') return '6';
    if (f.key === 'CPA_API_URL') return 'http://127.0.0.1:8317';
    if (f.key === 'CPA_LOGIN_PASSWORD') return 'CPA 管理密码 / Bearer Token';
    if (f.key === 'SUB2API_API_URL') return 'http://127.0.0.1:8080';
    if (f.key === 'SUB2API_API_KEY') return 'sk-...';
    if (f.key === 'SUB2API_GROUP_IDS') return '例如：1,2,3；也可点“获取线上分组”勾选';
    if (f.key === 'CUSTOM_API_URL') return 'https://example.com/api/push';
    if (f.key === 'TELEGRAM_OAUTH_BASE_URL') return 'https://bot.oai9.com';
    if (f.key === 'TELEGRAM_OAUTH_CLIENT_ID') return 'cli_...';
    if (f.key === 'TELEGRAM_OAUTH_CLIENT_SECRET') return 'client_secret_xxx';
    if (f.key === 'TELEGRAM_OAUTH_SCOPE') return 'profile.basic message.send';
    if (f.key === 'TELEGRAM_OAUTH_REDIRECT_URI') return '可留空自动生成；例如 http://127.0.0.1:5000/auth/telegram/callback';
    if (f.key === 'TELEGRAM_OAUTH_TIMEOUT') return '20';
    if (f.key === 'TELEGRAM_AUTH_ALLOWED_USERS') return '留空=首次成功登录自动锁定；填写多个用户 ID 或 @username，逗号分隔';
    return '';
  }

  function fieldControlClass(f) {
    if (['PROXY_POOL', 'REGISTER_PROXY_POOL', 'CODEX_PROXY_POOL'].includes(f.key)) return 'proxy-pool-input';
    return '';
  }

  function formatCapacityMemory(value) {
    if (value == null || value === '' || typeof value === 'boolean') return '--';
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return '--';
    if (bytes >= 1024 ** 3) {
      const gib = bytes / (1024 ** 3);
      return `${gib >= 10 ? gib.toFixed(0) : gib.toFixed(1)} GiB`;
    }
    const mib = bytes / (1024 ** 2);
    return `${mib >= 10 ? mib.toFixed(0) : mib.toFixed(1)} MiB`;
  }

  function registrationWorkersRecommendationHtml(f) {
    if (f.key !== 'REGISTER_WORKERS') return '';
    return `
      <div class="config-worker-recommendation is-unavailable">
        <div class="config-worker-recommendation-head">
          <strong data-recommendation-title></strong>
          <span data-recommendation-estimated></span>
        </div>
        <span data-recommendation-detail></span>
        <span data-recommendation-warning></span>
        <span data-recommendation-disk></span>
      </div>`;
  }

  function numberOrNull(value) {
    if (value == null || value === '' || typeof value === 'boolean') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function isValidRegisterBirthday(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    if (year < 1 || month < 1 || month > 12 || day < 1) return false;
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day <= daysInMonth[month - 1];
  }

  function validateRegisterBirthday() {
    const input = $('#configForm [data-key="REGISTER_BIRTHDAY"]');
    if (!input) return true;
    // 空值回填默认生日（与占位符一致），而不是判空报错
    if (!String(input.value ?? '').trim()) {
      input.value = '2000-01-01';
      setConfigControlValue?.('REGISTER_BIRTHDAY', '2000-01-01');
    }
    const valid = isValidRegisterBirthday(String(input.value ?? ''));
    input.setCustomValidity(valid ? '' : REGISTER_BIRTHDAY_ERROR);
    if (valid) {
      input.removeAttribute('aria-invalid');
      return true;
    }
    input.setAttribute('aria-invalid', 'true');
    setActiveConfigTab('register');
    input.focus();
    input.reportValidity();
    showToast(REGISTER_BIRTHDAY_ERROR, 'error');
    return false;
  }

  function updateRegistrationWorkerRecommendation(snapshot = REGISTRATION_CAPACITY) {
    REGISTRATION_CAPACITY = snapshot && typeof snapshot === 'object' ? snapshot : null;
    const element = $('#configForm .config-worker-recommendation');
    const input = $('#configForm [data-key="REGISTER_WORKERS"]');
    if (!element || !input) return;

    const recommended = numberOrNull(REGISTRATION_CAPACITY?.recommended_registration_workers);
    const configured = numberOrNull(input.value);
    const cpuIdle = numberOrNull(REGISTRATION_CAPACITY?.registration_cpu_idle_percent);
    const memoryAvailable = numberOrNull(REGISTRATION_CAPACITY?.registration_memory_available_bytes);
    const validRecommendation = Number.isInteger(recommended) && recommended >= 1;
    const estimated = REGISTRATION_CAPACITY?.registration_recommendation_estimated === true;
    const overRecommendation = validRecommendation && Number.isInteger(configured) && configured > recommended;

    element.classList.toggle('is-warning', overRecommendation);
    element.classList.toggle('is-estimated', estimated);
    element.classList.toggle('is-unavailable', !validRecommendation);
    element.querySelector('[data-recommendation-title]').textContent = validRecommendation
      ? (window.GFR.t?.(
        'config.register.recommended_workers',
        { workers: recommended },
        `推荐 ${recommended} 线程`,
      ) || `推荐 ${recommended} 线程`)
      : (window.GFR.t?.(
        'config.register.metrics_unavailable',
        null,
        '服务器资源暂不可用',
      ) || '服务器资源暂不可用');
    element.querySelector('[data-recommendation-estimated]').textContent = validRecommendation && estimated
      ? (window.GFR.t?.('config.register.recommendation_estimated', null, '估算值') || '估算值')
      : '';
    element.querySelector('[data-recommendation-detail]').textContent = validRecommendation
      ? (window.GFR.t?.(
        'config.register.available_capacity',
        {
          cpu: Number.isFinite(cpuIdle) ? Math.round(cpuIdle) : '--',
          memory: formatCapacityMemory(memoryAvailable),
        },
        `CPU 空闲 ${Number.isFinite(cpuIdle) ? Math.round(cpuIdle) : '--'}% · 可用内存 ${formatCapacityMemory(memoryAvailable)}`,
      ) || '')
      : '';
    element.querySelector('[data-recommendation-warning]').textContent = overRecommendation
      ? (window.GFR.t?.(
        'config.register.workers_over_recommendation',
        { configured, recommended },
        `当前设置 ${configured} 线程，高于实时推荐 ${recommended} 线程，可能出现响应变慢或任务超时`,
      ) || '')
      : '';
    const diskAvailable = numberOrNull(REGISTRATION_CAPACITY?.disk_available_bytes);
    element.querySelector('[data-recommendation-disk]').textContent = REGISTRATION_CAPACITY?.registration_disk_low === true
      ? (window.GFR.t?.(
        'config.register.disk_low',
        { available: formatCapacityMemory(diskAvailable) },
        `磁盘剩余空间不足：${formatCapacityMemory(diskAvailable)}`,
      ) || '')
      : '';
  }

  function rerenderRegistrationWorkerRecommendation() {
    updateRegistrationWorkerRecommendation(REGISTRATION_CAPACITY);
  }

  function classifyFields(fields, tab) {
    const ordered = tab.keys.map(k => fieldByKey(fields, k)).filter(f => f && !HIDDEN_CONFIG_KEYS.has(f.key));
    if (tab.id !== 'email') return ordered;

    // 邮箱页允许兜底承接后续新增的 EMAIL/OUTLOOK/OTP/BUYGPTPULS 邮箱相关字段。
    const used = new Set(CONFIG_TABS.flatMap(t => t.keys));
    const extra = fields.filter(f => (
      !used.has(f.key)
      && !HIDDEN_CONFIG_KEYS.has(f.key)
      && /^(EMAIL_|OUTLOOK_|OTP_|BUYGPTPULS_|API_OTP_MAIL_)/.test(f.key)
    ));
    return ordered.concat(extra);
  }

  function renderField(f) {
    const wideClass = f.type === 'list_str_multiline' ? ' config-field-wide' : '';
    const sourceScope = fieldScopeAttr(f);
    const control = controlHtml({
      key: f.key,
      type: f.type,
      value: f.value,
      secret: f.secret,
      options: fieldOptions(f),
      placeholder: fieldPlaceholder(f),
      className: fieldControlClass(f),
      rows: ['PROXY_POOL', 'REGISTER_PROXY_POOL', 'CODEX_PROXY_POOL'].includes(f.key) ? 8 : undefined,
      min: f.min,
      max: f.max,
    });
    const recommendation = registrationWorkersRecommendationHtml(f);
    return `
      <div class="config-field-row${wideClass}" data-field-key="${esc(f.key)}"${sourceScope}>
        <div class="config-label">
          <span>${esc(f.label)}</span>
          <em class="mono">${esc(f.key)}</em>
        </div>
        <div class="config-control-wrap">${control}</div>
        <div class="config-help">${recommendation}<span>${esc(f.help)}</span></div>
      </div>`;
  }

  function updateEmailSourceVisibility() {
    const source = currentEmailSource();
    $$('#configForm [data-source-scope]').forEach(row => {
      row.classList.toggle('hidden', row.dataset.sourceScope !== source);
    });

    const labelMap = {
      outlook: 'Outlook 邮箱池',
      buygptpuls_temp: 'buygptpuls 临时邮箱',
      api_otp_mail: '邮箱 API 接码',
    };
    const note = $('#emailSourceNote');
    if (note) {
      if (source === 'buygptpuls_temp') {
        note.innerHTML = `当前显示 buygptpuls 临时邮箱地址、API Key、域名/级数、前缀、邮箱长度和通用 OTP 轮询配置。domain 留空时随机选择启用域名。${externalLink(BUYGPTPULS_TEMP_MAIL_URL, '打开临时邮箱官网')}`;
      } else if (source === 'api_otp_mail') {
        note.innerHTML = '当前显示 API 接码邮箱地址和通用 OTP 轮询配置；导入格式为：邮箱----接码api地址。';
      } else {
        note.textContent = '当前只显示 Outlook 本地 IMAP / OAuth 和通用 OTP 轮询配置。';
      }
    }
    const badge = $('#emailSourceBadge');
    if (badge) badge.textContent = labelMap[source] || labelMap.outlook;

    const emailPanel = $('#configForm [data-config-panel="email"]');
    const count = emailPanel
      ? emailPanel.querySelectorAll('.config-field-row:not(.hidden)').length
      : 0;
    const countEl = $('#configForm [data-config-count="email"]');
    if (countEl) countEl.textContent = `${count} 项`;
  }

  function codexOAuthEnabled() {
    const el = $('#configForm [data-key="ENABLE_CODEX_AUTO"]');
    const value = el ? (el.dataset.value ?? el.value) : (fieldByKey(CONFIG, 'ENABLE_CODEX_AUTO')?.value ? 'true' : 'false');
    return String(value) === 'true';
  }

  function paymentLinkAutoExtractEnabled() {
    const value = configControlValue('ENABLE_PAYMENT_LINK_AUTO_EXTRACT')
      || (fieldByKey(CONFIG, 'ENABLE_PAYMENT_LINK_AUTO_EXTRACT')?.value ? 'true' : 'false');
    return String(value) === 'true';
  }

  function updateFeatureVisibility() {
    updateConfigBadges?.();
    const showCodexSubOptions = codexOAuthEnabled();
    if (!showCodexSubOptions) {
      setConfigControlValue('CODEX_OAUTH_SKIP_PHONE', 'false');
    }
    $$('#configForm [data-feature-scope="codex-oauth"]').forEach(row => {
      row.classList.toggle('hidden', !showCodexSubOptions);
    });
    const showPaymentLinkProvider = paymentLinkAutoExtractEnabled();
    $$('#configForm [data-feature-scope="payment-link-provider"]').forEach(row => {
      row.classList.toggle('hidden', !showPaymentLinkProvider);
    });

    const featurePanel = $('#configForm [data-config-panel="features"]');
    const count = featurePanel
      ? featurePanel.querySelectorAll('.config-field-row:not(.hidden)').length
      : 0;
    const countEl = $('#configForm [data-config-count="features"]');
    if (countEl) countEl.textContent = `${count} 项`;
  }

  function currentRegistrationMode() {
    const value = configControlValue('REGISTRATION_MODE') || fieldByKey(CONFIG, 'REGISTRATION_MODE')?.value || 'email';
    return String(value).trim().toLowerCase() === 'phone' ? 'phone' : 'email';
  }

  function updateRegisterModeVisibility() {
    const mode = currentRegistrationMode();
    $$('#configForm [data-register-scope]').forEach(row => {
      row.classList.toggle('hidden', row.dataset.registerScope !== mode);
    });

    const registerPanel = $('#configForm [data-config-panel="register"]');
    const count = registerPanel
      ? registerPanel.querySelectorAll('.config-field-row:not(.hidden)').length
      : 0;
    const countEl = $('#configForm [data-config-count="register"]');
    if (countEl) countEl.textContent = `${count} 项`;
  }

  function currentProxyMode() {
    const value = configControlValue('PROXY_MODE') || fieldByKey(CONFIG, 'PROXY_MODE')?.value || 'global';
    return String(value).trim().toLowerCase() === 'advanced' ? 'advanced' : 'global';
  }

  function updateProxyModeVisibility() {
    const mode = currentProxyMode();
    const advanced = mode === 'advanced';
    $$('#configForm [data-proxy-scope="advanced"]').forEach(row => {
      row.classList.toggle('hidden', !advanced);
    });
    $$('#configForm [data-proxy-pool-tab-advanced]').forEach(btn => {
      btn.classList.toggle('hidden', !advanced);
    });
    $$('#configForm [data-proxy-test-advanced]').forEach(btn => {
      btn.classList.toggle('hidden', !advanced);
    });
    setActiveProxyPoolTab(
      advanced ? activeProxyPoolTab : 'global',
      { persist: advanced, updateState: advanced },
    );

    const badge = $('#proxyModeBadge');
    if (badge) badge.textContent = advanced ? '高级分池' : '默认全局';
    const note = $('#proxyModeNote');
    if (note) {
      note.textContent = advanced
        ? '高级模式：注册优先用“注册代理池”，为空回退“全局代理池”；自动提 Codex 和账号资产页手动补跑优先用“提 Codex 代理池”，如果“提 Codex 代理池”为空，优先回退“全局代理池”，全局池也为空再回退账号原注册代理/直连。'
        : '默认模式：注册、自动提 Codex、账号资产页手动补跑都优先从“全局代理池”随机取；全局池为空时，提 Codex 再回退账号原注册代理，没有原代理则直连。';
    }

    const proxyPanel = $('#configForm [data-config-panel="proxy"]');
    const count = proxyPanel
      ? proxyPanel.querySelectorAll('.config-field-row:not(.hidden)').length
      : 0;
    const countEl = $('#configForm [data-config-count="proxy"]');
    if (countEl) countEl.textContent = `${count} 项`;
  }

  function normalizeProxyPoolTab(tab) {
    const value = String(tab || 'global').trim().toLowerCase();
    return ['global', 'register', 'codex'].includes(value) ? value : 'global';
  }

  function setActiveProxyPoolTab(tab, opts = {}) {
    const normalized = normalizeProxyPoolTab(tab);
    if (opts.updateState !== false) activeProxyPoolTab = normalized;
    if (opts.persist !== false) {
      localStorage.setItem('gfr.activeProxyPoolTab', activeProxyPoolTab);
    }
    $$('#configForm [data-proxy-pool-tab]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.proxyPoolTab === normalized);
    });
    $$('#configForm [data-proxy-pool-panel]').forEach(panel => {
      panel.classList.toggle('hidden', panel.dataset.proxyPoolPanel !== normalized);
    });
  }

  function normalizeCustomApiFields(value) {
    let raw = value;
    if (typeof raw === 'string') {
      try { raw = raw.trim() ? JSON.parse(raw) : []; } catch (_) {
        raw = raw.split(',').map(item => item.trim());
      }
    }
    if (!Array.isArray(raw)) raw = [];
    const allowed = new Set(CUSTOM_API_FIELD_OPTIONS.map(item => item.value));
    const out = [];
    raw.forEach(item => {
      const field = String(item || '').trim();
      if (allowed.has(field) && !out.includes(field)) out.push(field);
    });
    if (out.length) return out;
    return ['email', 'email_password', 'client_id', 'refresh_token']
      .filter(field => allowed.has(field));
  }

  function customApiFieldLabel(field) {
    return CUSTOM_API_FIELD_OPTIONS.find(item => item.value === field)?.label || field;
  }

  function customApiFieldIcon(kind) {
    const icons = {
      up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5l-7 7m7-7 7 7M12 6v13"/></svg>',
      down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19l7-7m-7 7-7-7M12 18V5"/></svg>',
      delete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M9 7l1-2h4l1 2m-8 0 1 13h8l1-13"/></svg>',
    };
    return icons[kind] || '';
  }

  function renderCustomApiFieldList() {
    const list = $('#customApiFieldList');
    const addSelect = $('#customApiAddField');
    if (!list || !addSelect) return;
    customApiFields = normalizeCustomApiFields(customApiFields);
    list.innerHTML = customApiFields.map((field, index) => `
      <div class="account-io-field-item" data-custom-api-field="${escRaw(field)}">
        <strong>${esc(customApiFieldLabel(field))}<small>${esc(field)}</small></strong>
        <button type="button" class="btn account-io-icon-btn" data-custom-api-move="up" title="上移" aria-label="上移" ${index === 0 ? 'disabled' : ''}>${customApiFieldIcon('up')}</button>
        <button type="button" class="btn account-io-icon-btn" data-custom-api-move="down" title="下移" aria-label="下移" ${index === customApiFields.length - 1 ? 'disabled' : ''}>${customApiFieldIcon('down')}</button>
        <button type="button" class="btn danger account-io-icon-btn" data-custom-api-remove="${escRaw(field)}" title="删除" aria-label="删除" ${customApiFields.length <= 1 ? 'disabled' : ''}>${customApiFieldIcon('delete')}</button>
      </div>`).join('') || '<div class="muted">请至少添加一个字段</div>';
    const selected = new Set(customApiFields);
    const options = CUSTOM_API_FIELD_OPTIONS.filter(item => !selected.has(item.value));
    addSelect.outerHTML = window.GFR.customSelectHtml({
      id: 'customApiAddField',
      value: options[0]?.value || '',
      options: options.length
        ? options.map(item => ({ value: item.value, label: `${item.label} (${item.value})` }))
        : [{ value: '', label: '没有可添加字段' }],
      className: 'filter-select account-io-select',
      shellClassName: 'filter-select-shell account-io-select-shell',
      title: '选择要添加的字段',
    });
    const hidden = $('#configForm [data-key="CUSTOM_API_FIELDS"]');
    if (hidden) hidden.value = JSON.stringify(customApiFields);
    const summary = $('#customApiFieldSummary');
    if (summary) summary.textContent = customApiFields.map(customApiFieldLabel).join('、');
    $('#btnCustomApiAddField')?.classList.toggle('hidden', !options.length);

    list.querySelectorAll('[data-custom-api-move]').forEach(btn => {
      btn.addEventListener('click', () => {
        const field = btn.closest('[data-custom-api-field]')?.dataset.customApiField || '';
        const index = customApiFields.indexOf(field);
        const next = index + (btn.dataset.customApiMove === 'up' ? -1 : 1);
        if (index < 0 || next < 0 || next >= customApiFields.length) return;
        [customApiFields[index], customApiFields[next]] = [customApiFields[next], customApiFields[index]];
        renderCustomApiFieldList();
      });
    });
    list.querySelectorAll('[data-custom-api-remove]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (customApiFields.length <= 1) return;
        const field = btn.dataset.customApiRemove || '';
        customApiFields = customApiFields.filter(item => item !== field);
        renderCustomApiFieldList();
      });
    });
  }

  function openCustomApiFieldsModal() {
    customApiFields = normalizeCustomApiFields(configControlValue('CUSTOM_API_FIELDS'));
    renderCustomApiFieldList();
    const modal = $('#customApiFieldsModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => modal.classList.add('show'));
  }

  function closeCustomApiFieldsModal() {
    const modal = $('#customApiFieldsModal');
    if (!modal) return;
    modal.classList.remove('show');
    setTimeout(() => {
      modal.classList.add('hidden');
      modal.setAttribute('aria-hidden', 'true');
    }, 150);
  }

  async function testCustomApi() {
    const btn = $('#btnTestCustomApi');
    const resultBox = $('#customApiTestResult');
    if (btn) btn.disabled = true;
    if (resultBox) resultBox.textContent = '正在发送脱敏示例数据…';
    try {
      const result = await api('/api/relay/custom-api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: configControlValue('CUSTOM_API_ENABLED') === 'true',
          api_url: configControlValue('CUSTOM_API_URL'),
          trigger: configControlValue('CUSTOM_API_TRIGGER'),
          format: configControlValue('CUSTOM_API_FORMAT'),
          fields: customApiFields,
        }),
      });
      if (resultBox) resultBox.textContent = JSON.stringify({
        status_code: result.status_code,
        elapsed_ms: result.elapsed_ms,
        response_body: result.response_body,
        message: result.message,
        error: result.error,
      }, null, 2);
      showToast(result.status_code ? `测试推送完成：HTTP ${result.status_code}` : (result.message || '测试推送完成'), result.ok ? 'success' : 'warning');
    } catch (e) {
      if (resultBox) resultBox.textContent = e.message;
      showToast('测试推送失败: ' + e.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function renderProxyShell(fields) {
    const fieldsByKey = Object.fromEntries(fields.map(f => [f.key, f]));
    const modeField = fieldsByKey.PROXY_MODE;
    const egressCountryField = fieldsByKey.PROXY_EGRESS_COUNTRY;
    const modeFields = [modeField, egressCountryField].filter(Boolean);
    const tabs = [
      { id: 'global', title: '全局代理池', key: 'PROXY_POOL', desc: '默认模式和高级模式兜底都使用这里。' },
      { id: 'register', title: '注册代理池', key: 'REGISTER_PROXY_POOL', desc: '高级模式生效；为空时回退全局代理池。', advanced: true },
      { id: 'codex', title: '提 Codex 代理池', key: 'CODEX_PROXY_POOL', desc: '高级模式生效；为空时优先回退全局代理池。', advanced: true },
    ];
    const modeHtml = modeFields.length
      ? `<div class="config-field-grid proxy-mode-grid">${modeFields.map(renderField).join('')}</div>`
      : noticeHtml('warning', '当前没有代理模式或出口检测配置字段。', '无配置项');
    const tabButtons = tabs.map(tab => `
      <button type="button" class="config-tab-btn${tab.id === normalizeProxyPoolTab(activeProxyPoolTab) ? ' active' : ''}" data-proxy-pool-tab="${esc(tab.id)}"${tab.advanced ? ' data-proxy-pool-tab-advanced="true"' : ''}>
        <span>${esc(tab.title)}</span>
      </button>`).join('');
    const tabPanels = tabs.map(tab => {
      const field = fieldsByKey[tab.key];
      return `
        <section class="proxy-pool-panel${tab.id === normalizeProxyPoolTab(activeProxyPoolTab) ? '' : ' hidden'}" data-proxy-pool-panel="${esc(tab.id)}">
          <div class="proxy-pool-panel-head">
            <strong>${esc(tab.title)}</strong>
            <p>${esc(tab.desc)}</p>
          </div>
          ${field ? `<div class="config-field-grid proxy-pool-panel-grid">${renderField(field)}</div>` : noticeHtml('warning', '当前没有可编辑字段。', '无配置项')}
        </section>`;
    }).join('');
    return `
      ${noticeHtml(
        'warning',
        `${PROXY_INPUT_FORMAT_HINT}\nBR（巴西）、MX（墨西哥）、TH（泰国）、TR（土耳其）、VN（越南）代理可以0元试用。带 -sid- 的代理一条即可自动更换 IP；其他不带会话标记的代理建议配置多条。`,
        '',
      )}
      ${modeHtml}
      <div class="proxy-pool-tabs">
        <div class="config-tabs proxy-pool-tabbar" role="tablist" aria-label="代理池分类">
          ${tabButtons}
        </div>
        <div class="proxy-pool-panels">${tabPanels}</div>
      </div>`;
  }

  function renderRelayShell(fields) {
    activeRelayTab = localStorage.getItem('gfr.activeRelayTab') || activeRelayTab || 'cpa';
    const cpaFields = fields.filter(f => f.key.startsWith('CPA_'));
    const subFields = fields.filter(f => f.key.startsWith('SUB2API_'));
    const customFields = CONFIG
      .filter(f => f.key.startsWith('CUSTOM_API_') && f.key !== 'CUSTOM_API_FIELDS')
      .map(f => f.key === 'CUSTOM_API_ENABLED'
        ? { ...f, type: 'select', options: [{ value: 'true', label: '开启' }, { value: 'false', label: '关闭' }] }
        : f);
    customApiFields = normalizeCustomApiFields(fieldByKey(CONFIG, 'CUSTOM_API_FIELDS')?.value);
    const customFieldInput = fieldByKey(CONFIG, 'CUSTOM_API_FIELDS');
    const customFieldsBody = customFields.length
      ? `<div class="config-field-grid">${customFields.map(renderField).join('')}</div>`
      : noticeHtml(
        'warning',
        '自定义 API 配置字段尚未加载，请重启 WebUI 后刷新页面。',
        '配置字段未加载',
      );
    const renderPanel = (id, title, desc, body, actions = '') => `
      <section class="relay-panel${activeRelayTab === id ? '' : ' hidden'}" data-relay-panel="${id}">
        <div class="relay-panel-head">
          <div><h4>${esc(title)}</h4><p>${esc(desc)}</p></div>
          ${actions}
        </div>
        ${body}
      </section>`;
    return `
      <div class="relay-console">
        <div class="relay-subtabs" role="tablist" aria-label="上传配置分类">
          <button type="button" class="relay-subtab${activeRelayTab === 'cpa' ? ' active' : ''}" data-relay-tab="cpa">CPA</button>
          <button type="button" class="relay-subtab${activeRelayTab === 'sub2api' ? ' active' : ''}" data-relay-tab="sub2api">SUB2API</button>
          <button type="button" class="relay-subtab${activeRelayTab === 'custom-api' ? ' active' : ''}" data-relay-tab="custom-api">自定义API</button>
        </div>
        ${renderPanel(
          'cpa',
          'CPA 配置',
          '开启后，Codex 授权成功并拿到 refresh_token 时自动上传；Codex 页面也可以手动上传选中凭证。',
          cpaFields.length ? `<div class="config-field-grid">${cpaFields.map(renderField).join('')}</div>` : noticeHtml('warning', '当前没有 CPA 配置字段。', '无配置项')
        )}
        ${renderPanel(
          'sub2api',
          'SUB2API 配置',
          '填写接口地址与 APIKEY 后可获取线上分组；保存配置后自动上传会使用选中的分组。',
          subFields.length ? `<div class="config-field-grid">${subFields.map(renderField).join('')}</div><div id="sub2apiGroupsBox" class="relay-groups-box">点击“获取线上分组”后可勾选上传分组。</div>` : noticeHtml('warning', '当前没有 SUB2API 配置字段。', '无配置项'),
          '<button type="button" class="btn" id="btnFetchSub2apiGroups">获取线上分组</button>'
        )}
        ${renderPanel(
          'custom-api',
          '自定义 API',
          '注册账号保存成功后按所选字段发送 POST 请求；无论目标接口返回什么结果，都不影响注册任务。',
          `${customFieldsBody}
           ${customFieldInput ? `<input type="hidden" data-key="CUSTOM_API_FIELDS" value="${escRaw(JSON.stringify(customApiFields))}">` : ''}
           <div class="custom-api-field-settings">
             <div><strong>推送内容</strong><p class="muted">当前字段：<span id="customApiFieldSummary"></span></p></div>
             <button type="button" class="btn" id="btnConfigureCustomApiFields">设置推送字段</button>
           </div>
           <div class="custom-api-actions"><button type="button" class="btn primary" id="btnTestCustomApi">测试推送</button></div>
           <pre id="customApiTestResult" class="custom-api-test-result hidden" aria-live="polite"></pre>
           <div id="customApiFieldsModal" class="modal-backdrop workspace-modal hidden" aria-hidden="true">
             <div class="modal-card workspace-modal-card account-io-modal-card" role="dialog" aria-modal="true" aria-labelledby="customApiFieldsModalTitle">
               <div class="modal-card-head"><div><h3 id="customApiFieldsModalTitle">设置推送字段</h3><p>字段列表与账号资产自定义导出保持一致。</p></div><button type="button" class="btn" id="btnCloseCustomApiFields">关闭</button></div>
               <div class="account-io-field-list" id="customApiFieldList"></div>
               <div class="account-io-add-row"><div class="custom-select ui-control-shell filter-select-shell account-io-select-shell" id="customApiAddField" data-value="" title="选择要添加的字段"></div><button type="button" class="btn" id="btnCustomApiAddField">添加字段</button></div>
             </div>
           </div>`,
          ''
        )}
      </div>`;
  }

  function bindRelayShell() {
    $$('.relay-subtab').forEach(btn => {
      btn.addEventListener('click', () => {
        activeRelayTab = btn.dataset.relayTab || 'cpa';
        localStorage.setItem('gfr.activeRelayTab', activeRelayTab);
        $$('.relay-subtab').forEach(x => x.classList.toggle('active', x === btn));
        $$('.relay-panel').forEach(panel => panel.classList.toggle('hidden', panel.dataset.relayPanel !== activeRelayTab));
        window.GFR.route?.write?.('config');
      });
    });
    $('#btnFetchSub2apiGroups')?.addEventListener('click', fetchSub2apiGroups);
    $('#btnConfigureCustomApiFields')?.addEventListener('click', openCustomApiFieldsModal);
    $('#btnCloseCustomApiFields')?.addEventListener('click', closeCustomApiFieldsModal);
    $('#customApiFieldsModal')?.addEventListener('click', event => {
      if (event.target?.id === 'customApiFieldsModal') closeCustomApiFieldsModal();
    });
    $('#btnCustomApiAddField')?.addEventListener('click', () => {
      const selected = window.GFR.controlValue?.($('#customApiAddField')) || '';
      if (selected && !customApiFields.includes(selected)) {
        customApiFields.push(selected);
        renderCustomApiFieldList();
      }
    });
    $('#btnTestCustomApi')?.addEventListener('click', testCustomApi);
    $('#customApiTestResult')?.classList.remove('hidden');
    renderCustomApiFieldList();
  }

  function configControlValue(key) {
    const el = $(`#configForm [data-key="${key}"]`);
    if (!el) return '';
    return window.GFR.controlValue ? window.GFR.controlValue(el) : (el.dataset.value ?? el.value ?? '');
  }

  function setConfigControlValue(key, value) {
    const el = $(`#configForm [data-key="${key}"]`);
    if (!el) return;
    if (window.GFR.setControlValue) window.GFR.setControlValue(el, value);
    else if ('value' in el) el.value = value;
    else el.dataset.value = value;
  }

  function renderSub2apiGroups(groups) {
    const box = $('#sub2apiGroupsBox');
    if (!box) return;
    const selected = new Set(String(configControlValue('SUB2API_GROUP_IDS') || '')
      .replace(/，/g, ',')
      .split(',')
      .map(x => x.trim())
      .filter(Boolean));
    if (!groups.length) {
      box.innerHTML = '<div class="muted">已连接，但线上没有返回可选分组。</div>';
      return;
    }
    groups.forEach(g => {
      const id = String(g.id ?? '').trim();
      if (id && selected.has(id)) g._checked = true;
    });
    box.innerHTML = `
      <div class="relay-groups-head"><strong>线上分组</strong><span class="muted">勾选后会写入“上传分组”，记得点击保存配置。</span></div>
      <div class="relay-group-list">
        ${groups.map(g => {
          const id = String(g.id ?? '').trim();
          const checked = selected.has(id) || g._checked ? 'checked' : '';
          return `<label class="relay-group-item"><input type="checkbox" value="${esc(id)}" ${checked}><span>${esc(g.name || ('分组 ' + id))}</span><em class="mono">#${esc(id)}</em></label>`;
        }).join('')}
      </div>`;
    box.querySelectorAll('input[type="checkbox"]').forEach(chk => {
      chk.addEventListener('change', () => {
        const ids = Array.from(box.querySelectorAll('input[type="checkbox"]:checked')).map(x => x.value).filter(Boolean);
        setConfigControlValue('SUB2API_GROUP_IDS', ids.join(','));
      });
    });
  }

  function currentProxyLines(key = 'PROXY_POOL') {
    const el = $(`#configForm [data-key="${key}"]`);
    if (!el) return [];
    return String(el.value || '')
      .split('\n')
      .map(s => s.trim())
      .filter(s => s && s !== '-');
  }

  function dedupeProxyLines(lines) {
    const out = [];
    const seen = new Set();
    (lines || []).forEach(line => {
      const text = String(line || '').trim();
      if (!text || text === '-' || seen.has(text)) return;
      seen.add(text);
      out.push(text);
    });
    return out;
  }

  function proxyStatusPill(row) {
    return row.ok
      ? '<span class="pill status-success">可用</span>'
      : '<span class="pill status-failed">失败</span>';
  }

  function proxyEgressMatchPill(row) {
    if (row.expected_country_match === true) {
      return '<span class="pill status-success">匹配</span>';
    }
    if (row.expected_country_match === false) {
      return '<span class="pill status-failed">不匹配</span>';
    }
    return '<span class="muted">-</span>';
  }

  function proxyGeoText(row) {
    const parts = [
      row.geo_country_code ? `${row.geo_country || ''} (${row.geo_country_code})` : row.geo_country,
      row.geo_region,
      row.geo_city,
    ].filter(Boolean);
    if (parts.length) return parts.join(' / ');
    return row.geo_error || '-';
  }

  function renderProxyTestResult(data) {
    const box = $('#proxyTestResult');
    if (!box) return;
    const results = Array.isArray(data.results) ? data.results : [];
    if (!results.length) {
      box.innerHTML = noticeHtml('warning', data.note || '代理池为空，未执行测试。', '未测试');
      return;
    }
    box.innerHTML = `
      <div class="proxy-test-card">
        <div class="proxy-test-summary">
          <div>
            <strong>${esc(data.scope_label || '代理测试结果')}</strong>
            <p>${esc(data.note || '')} 出口：<span class="mono">${esc(data.target_url || '-')}</span>；ChatGPT TLS：<span class="mono">${esc(data.transport_url || '-')}</span></p>
          </div>
          <div class="proxy-test-stats">
            <span class="status-success">可用 ${esc(data.success ?? 0)}</span>
            <span class="status-failed">失败 ${esc(data.failed ?? 0)}</span>
            <span>总耗时 ${esc(data.elapsed_ms ?? 0)}ms</span>
          </div>
        </div>
        <div class="table-wrap proxy-test-table-wrap">
          <table class="data-table proxy-test-table">
            <thead><tr><th>#</th><th>状态</th><th>代理</th><th>出口 IP</th><th>ChatGPT</th><th>实测地区</th><th>出口匹配</th><th>耗时</th><th>错误</th></tr></thead>
            <tbody>
              ${results.map(row => `
                <tr class="${row.ok ? 'proxy-ok' : 'proxy-bad'}">
                  <td>${esc(row.index)}</td>
                  <td>${proxyStatusPill(row)}</td>
                  <td><span class="mono clip" title="${esc(row.proxy || '')}">${esc(row.proxy || '-')}</span></td>
                  <td><span class="mono">${esc(row.ip || '-')}</span></td>
                  <td><span class="mono">${row.chatgpt_status_code == null ? '-' : 'HTTP ' + esc(row.chatgpt_status_code)}</span></td>
                  <td><span class="clip" title="${esc(proxyGeoText(row))}">${esc(proxyGeoText(row))}</span></td>
                  <td>${proxyEgressMatchPill(row)}</td>
                  <td>${esc(row.elapsed_ms ?? '-')}ms</td>
                  <td><span class="clip" title="${esc(row.error || '')}">${esc(row.error || '-')}</span></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  function renderProxyTools() {
    return `
      <div class="config-source-hint proxy-mode-hint">
        <span id="proxyModeBadge">默认全局</span>
        <p id="proxyModeNote">默认模式：注册和提 Codex 都优先从全局代理池随机取。</p>
      </div>
      <div class="proxy-tools">
        <div>
          <h4>代理连通性测试</h4>
          <p>使用与注册一致的 Chrome 146 传输逐条检查出口 IP 和 ChatGPT TLS；不会保存配置。高级模式可分别测试注册池和提 Codex 池。</p>
        </div>
        <div class="proxy-test-actions">
          <button type="button" class="btn" data-proxy-test="PROXY_POOL">测试全局池</button>
          <button type="button" class="btn" data-proxy-test="REGISTER_PROXY_POOL" data-proxy-test-advanced="true">测试注册池</button>
          <button type="button" class="btn" data-proxy-test="CODEX_PROXY_POOL" data-proxy-test-advanced="true">测试 Codex 池</button>
          <button type="button" class="btn primary" data-proxy-test="ALL" data-proxy-test-advanced="true">测试全部</button>
        </div>
      </div>
      <div id="proxyTestResult"></div>`;
  }

  function proxyTestScope(scope) {
    const key = String(scope || 'PROXY_POOL').trim().toUpperCase();
    const defs = {
      PROXY_POOL: { label: '全局代理池', keys: ['PROXY_POOL'] },
      REGISTER_PROXY_POOL: { label: '注册代理池', keys: ['REGISTER_PROXY_POOL'] },
      CODEX_PROXY_POOL: { label: '提 Codex 代理池', keys: ['CODEX_PROXY_POOL'] },
      ALL: { label: '全部代理池', keys: ['PROXY_POOL', 'REGISTER_PROXY_POOL', 'CODEX_PROXY_POOL'] },
    };
    return defs[key] || defs.PROXY_POOL;
  }

  async function testProxyPool(scope = 'PROXY_POOL', btn = null) {
    const def = proxyTestScope(scope);
    const box = $('#proxyTestResult');
    const proxies = dedupeProxyLines(def.keys.flatMap(key => currentProxyLines(key)));
    if (box) {
      box.innerHTML = proxies.length
        ? noticeHtml('info', `正在测试 ${def.label} ${proxies.length} 条代理，请稍候…`, '测试中')
        : noticeHtml('warning', `${def.label}为空，未执行测试。`, '未测试');
    }
    if (!proxies.length) return;
    if (btn) {
      btn.disabled = true;
      btn.textContent = '测试中…';
    }
    try {
      const r = await api('/api/proxy/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proxies,
          timeout_s: 10,
          expected_country: configControlValue('PROXY_EGRESS_COUNTRY'),
        }),
      });
      r.scope_label = `${def.label}测试结果`;
      renderProxyTestResult(r);
      showToast(`${def.label}测试完成：可用 ${r.success || 0} / ${r.total || 0}`, r.failed ? 'warning' : 'success');
    } catch (e) {
      if (box) box.innerHTML = noticeHtml('error', e.message, '代理测试失败');
      showToast('代理测试失败: ' + e.message, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = btn.dataset.originalText || '测试代理';
      }
    }
  }

  async function fetchSub2apiGroups() {
    const btn = $('#btnFetchSub2apiGroups');
    const box = $('#sub2apiGroupsBox');
    if (btn) btn.disabled = true;
    if (box) box.innerHTML = '<div class="muted">正在获取线上分组…</div>';
    try {
      const r = await api('/api/codex/sub2api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_url: configControlValue('SUB2API_API_URL'),
          api_key: configControlValue('SUB2API_API_KEY'),
        }),
      });
      renderSub2apiGroups(r.groups || []);
      showToast(`已获取 ${r.count || 0} 个 Sub2API 分组`, 'success');
    } catch (e) {
      if (box) box.innerHTML = noticeHtml('error', e.message, '获取分组失败');
      showToast('获取 Sub2API 分组失败: ' + e.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function visibleFieldCount(panelEl) {
    if (!panelEl) return 0;
    return Array.from(panelEl.querySelectorAll('.config-field-row'))
      .filter(row => !row.classList.contains('hidden')).length;
  }

  function updateConfigBadges() {
    $$('[data-config-panel]').forEach(panel => {
      const count = visibleFieldCount(panel);
      const tabId = panel.dataset.configPanel;
      const btn = $(`#configForm [data-config-tab="${tabId}"] small`);
      if (btn) btn.textContent = String(count);
      const head = panel.querySelector('.config-count');
      if (head) head.textContent = `${count} 项`;
    });
  }

  function renderConfigTabs() {
    const availableTabs = CONFIG_TABS.map(tab => ({ ...tab, fields: classifyFields(CONFIG, tab) }));
    if (!availableTabs.some(t => t.id === activeConfigTab)) {
      activeConfigTab = availableTabs[0]?.id || 'features';
      localStorage.setItem('gfr.activeConfigTab', activeConfigTab);
      window.GFR.route?.write?.('config');
    }

    const tabButtons = availableTabs.map(tab => `
      <button type="button" class="config-tab-btn${tab.id === activeConfigTab ? ' active' : ''}" data-config-tab="${esc(tab.id)}">
        <span>${esc(tab.title)}</span><small>${tab.fields.length}</small>
      </button>`).join('');
    setTimeout(updateConfigBadges, 0);

    const panels = availableTabs.map(tab => {
      const sourceHint = tab.id === 'email'
        ? `<div class="config-source-hint"><span id="emailSourceBadge">Outlook 邮箱池</span><p id="emailSourceNote">当前只显示与邮箱来源匹配的配置。</p></div>`
        : '';
      const fieldsBody = tab.fields.length
        ? `<div class="config-field-grid">${tab.fields.map(renderField).join('')}</div>`
        : noticeHtml('warning', '当前没有可编辑字段。', '无配置项');
      const body = tab.id === 'sms' && window.GFR.pages?.configSms
        ? window.GFR.pages.configSms.renderShell(fieldsBody)
        : tab.id === 'relay'
        ? renderRelayShell(tab.fields)
        : tab.id === 'proxy'
        ? `${renderProxyShell(tab.fields)}${renderProxyTools()}`
        : fieldsBody;
      return `
        <section class="config-panel${tab.id === activeConfigTab ? '' : ' hidden'}" data-config-panel="${esc(tab.id)}">
          <div class="config-panel-head">
            <div><h3>${esc(tab.title)}</h3>${tabDescHtml(tab)}</div>
            <span class="config-count" data-config-count="${esc(tab.id)}">${tab.fields.length} 项</span>
          </div>
          ${sourceHint}
          ${body}
        </section>`;
    }).join('');

    $('#configForm').innerHTML = `
      <div class="config-tabs" role="tablist" aria-label="运行配置分类">
        ${tabButtons}
      </div>
      <div class="config-panels">${panels}</div>`;

    $$('#configForm [data-config-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        setActiveConfigTab(btn.dataset.configTab);
      });
    });
    $$('#configForm [data-proxy-pool-tab]').forEach(btn => {
      btn.addEventListener('click', () => setActiveProxyPoolTab(btn.dataset.proxyPoolTab));
    });

    $('#configForm [data-key="EMAIL_SOURCE"]')?.addEventListener('change', updateEmailSourceVisibility);
    $('#configForm [data-key="ENABLE_CODEX_AUTO"]')?.addEventListener('change', () => {
      updateFeatureVisibility();
    });
    $('#configForm [data-key="ENABLE_PAYMENT_LINK_AUTO_EXTRACT"]')?.addEventListener('change', () => {
      updateFeatureVisibility();
    });
    $('#configForm [data-key="REGISTRATION_MODE"]')?.addEventListener('change', updateRegisterModeVisibility);
    $('#configForm [data-key="PROXY_MODE"]')?.addEventListener('change', updateProxyModeVisibility);
    $('#configForm [data-key="PROXY_EGRESS_COUNTRY"]')?.addEventListener('input', event => {
      event.currentTarget.value = event.currentTarget.value.toUpperCase();
    });
    $('#configForm [data-key="REGISTER_WORKERS"]')?.addEventListener('input', () => {
      updateRegistrationWorkerRecommendation(REGISTRATION_CAPACITY);
    });
    $('#configForm [data-key="REGISTER_BIRTHDAY"]')?.addEventListener('input', event => {
      event.currentTarget.setCustomValidity('');
      event.currentTarget.removeAttribute('aria-invalid');
    });
    updateEmailSourceVisibility();
    updateFeatureVisibility();
    updateRegisterModeVisibility();
    updateProxyModeVisibility();
    window.GFR.pages?.configSms?.bindShell?.();
    bindRelayShell();
    rerenderRegistrationWorkerRecommendation();
    $$('#configForm [data-proxy-test]').forEach(btn => {
      btn.dataset.originalText = btn.textContent;
      btn.addEventListener('click', () => testProxyPool(btn.dataset.proxyTest, btn));
    });
  }

  function setActiveConfigTab(tab, opts = {}) {
    if (!tab) return false;
    if (!CONFIG_TABS.some(item => item.id === tab)) {
      tab = CONFIG_TABS[0]?.id || 'features';
    }
    const currentPanel = $(`#configForm [data-config-panel="${tab}"]`);
    const currentButton = $(`#configForm [data-config-tab="${tab}"]`);
    if (
      activeConfigTab === tab
      && currentPanel
      && !currentPanel.classList.contains('hidden')
      && currentButton?.classList.contains('active')
    ) {
      return true;
    }
    activeConfigTab = tab;
    localStorage.setItem('gfr.activeConfigTab', activeConfigTab);
    const buttons = $$('#configForm [data-config-tab]');
    const panels = $$('#configForm [data-config-panel]');
    const hasRenderedTabs = buttons.length > 0 && panels.length > 0;
    if (!hasRenderedTabs) {
      if (opts.reload !== false) loadConfig();
      return false;
    }
    buttons.forEach(btn => btn.classList.toggle('active', btn.dataset.configTab === activeConfigTab));
    panels.forEach(panel => panel.classList.toggle('hidden', panel.dataset.configPanel !== activeConfigTab));
    window.GFR.route?.write?.('config');
    window.dispatchEvent(new CustomEvent('gfr:config-rendered', { detail: { tab: activeConfigTab, switched: true } }));
    return true;
  }

  async function loadConfig() {
    try {
      activeConfigTab = localStorage.getItem('gfr.activeConfigTab') || activeConfigTab || 'features';
      if (!CONFIG_TABS.some(item => item.id === activeConfigTab)) {
        activeConfigTab = CONFIG_TABS[0]?.id || 'features';
        localStorage.setItem('gfr.activeConfigTab', activeConfigTab);
      }
      const [config, fieldCatalog] = await Promise.all([
        api('/api/config'),
        api('/api/accounts/custom-io/fields').catch(() => null),
      ]);
      CONFIG = config;
      CUSTOM_API_FIELD_OPTIONS = Array.isArray(fieldCatalog?.export_fields)
        ? fieldCatalog.export_fields.map(item => ({ value: String(item.value || ''), label: String(item.label || item.value || '') }))
          .filter(item => item.value)
        : [];
      REGISTRATION_CAPACITY = window.GFR.systemMetrics?.getSnapshot?.() || null;
      renderConfigTabs();
      window.dispatchEvent(new CustomEvent('gfr:config-rendered', { detail: { tab: activeConfigTab } }));
    } catch (e) {
      $('#configForm').innerHTML = noticeHtml('error', e.message, '加载配置失败');
    }
  }

  async function saveConfig() {
    const updates = {};
    $$('#configForm [data-key]').forEach(el => {
      const f = CONFIG.find(x => x.key === el.dataset.key);
      if (!f) return;
      if (f.type === 'list_str_multiline') updates[f.key] = el.value.split('\n').map(s => s.trim()).filter(s => s && s !== '-');
      else if (f.type === 'bool') updates[f.key] = (el.dataset.value ?? el.value) === 'true';
      else if (f.type === 'int') updates[f.key] = parseInt(el.value || '0', 10);
      else updates[f.key] = el.dataset.value ?? el.value;
    });
    if (updates.ENABLE_CODEX_AUTO === false) {
      updates.CODEX_OAUTH_SKIP_PHONE = false;
      setConfigControlValue('CODEX_OAUTH_SKIP_PHONE', 'false');
    }
    if (!validateRegisterBirthday()) return;
    // int 字段边界校验（与后端一致）
    for (const f of CONFIG) {
      if (f.type !== 'int' || f.min === undefined) continue;
      const v = updates[f.key];
      if (v !== undefined && v !== null && v !== '' && v < f.min) {
        showToast(`${f.label}不能小于 ${f.min}`, 'error');
        setActiveConfigTab('register');
        const el = $(`#configForm [data-key="${f.key}"]`);
        el?.focus();
        return;
      }
    }
    const saveButton = $('#btnSaveConfig');
    const defaultSaveLabel = saveButton?.dataset.defaultLabel || saveButton?.textContent || '保存配置';
    if (saveButton) {
      saveButton.dataset.defaultLabel = defaultSaveLabel;
      saveButton.disabled = true;
      saveButton.classList.add('is-saving');
      saveButton.setAttribute('aria-busy', 'true');
      saveButton.textContent = '保存中...';
    }
    try {
      const smsSaved = await window.GFR.pages?.configSms?.saveProviderRows?.({ silent: true });
      const smsStrategySaved = await window.GFR.pages?.configSms?.saveSelectionRows?.({ silent: true });
      const smsSelectionsSaved = await window.GFR.pages?.configSms?.saveCheckedPrices?.({ silent: true });
      const r = await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ updates }) });
      const parts = [];
      if (smsSaved) parts.push(`接码平台 ${smsSaved} 项`);
      if (smsStrategySaved) parts.push(`使用策略 ${smsStrategySaved} 项`);
      if (smsSelectionsSaved !== null && smsSelectionsSaved !== undefined) parts.push(`价格策略 ${smsSelectionsSaved} 项`);
      const suffix = parts.length ? `，已同步 ${parts.join('、')}` : '';
      showToast((r.reloaded ? '配置已生效' : '配置已保存（需重启）') + suffix, r.reloaded ? 'success' : 'warning');
    } catch (e) {
      showToast('保存失败: ' + e.message, 'error');
    } finally {
      const button = $('#btnSaveConfig');
      if (button) {
        button.disabled = false;
        button.classList.remove('is-saving');
        button.removeAttribute('aria-busy');
        button.textContent = button.dataset.defaultLabel || '保存配置';
      }
    }
  }

  window.addEventListener('gfr:system-metrics', event => {
    updateRegistrationWorkerRecommendation(event.detail?.snapshot || null);
  });

  $('#btnSaveConfig')?.addEventListener('click', saveConfig);
  window.GFR.pages = window.GFR.pages || {};
  window.GFR.pages.config = {
    loadConfig,
    saveConfig,
    setActiveConfigTab,
    rerenderLocale: rerenderRegistrationWorkerRecommendation,
  };
})();
