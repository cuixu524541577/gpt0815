const { $, $$ } = window.GFR;
const t = (key, params, fallback) => window.GFR.t(key, params, fallback);
const VALID_TABS = ['register','accounts','automation-tasks','codex','outlook','upi','cardpool','config'];

async function bootstrapServerLink() {
  const cid = parseRoute().serverLinkCid;
  if (!cid) return true;
  try {
    await window.GFR.api('/api/auth/server-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cid }),
    });
    history.replaceState(null, '', '#register');
    return true;
  } catch (_) {
    location.href = '/login';
    return false;
  }
}

async function initAuthBar() {
  if (!await bootstrapServerLink()) return null;
  const nameEls = $$('[data-user-name]');
  const kindEls = $$('[data-user-kind]');
  const avatarEl = $('#userAvatar');
  try {
    const me = await window.GFR.api('/api/auth/me');
    if (!me.authenticated || !me.user) throw new Error('unauthenticated');
    const user = me.user || {};
    const display = String(user.username || t('auth.session.password', {}, '密码账号'));
    nameEls.forEach(nameEl => {
      nameEl.textContent = display;
      nameEl.title = display;
    });
    kindEls.forEach(kindEl => {
      kindEl.dataset.i18n = 'auth.session.password';
      kindEl.textContent = t('auth.session.password', {}, '密码账号');
    });
    if (avatarEl) {
      const seed = String(user.username || 'PW').trim();
      avatarEl.textContent = seed ? seed.slice(0, 2).toUpperCase() : 'PW';
      avatarEl.title = display;
    }
    return me;
  } catch (e) {
    // 会话过期时后端会对其它 API 返回 401；这里直接回登录页。
    location.href = '/login';
    return null;
  }
}

async function logout() {
  const btn = $('#btnLogout');
  if (btn) btn.disabled = true;
  try {
    await window.GFR.api('/api/auth/logout', { method: 'POST' });
  } catch (_) {
    // 即使退出接口失败，也清理到登录页让用户重新建会话。
  } finally {
    location.href = '/login';
  }
}

function parseRoute() {
  const raw = (location.hash || '').replace(/^#/, '');
  const queryIndex = raw.indexOf('?');
  const path = queryIndex >= 0 ? raw.slice(0, queryIndex) : raw;
  const query = queryIndex >= 0 ? raw.slice(queryIndex + 1) : '';
  const parts = path.split('/').filter(Boolean);
  const configTab = parts[1] || '';
  const params = new URLSearchParams(query);
  const cid = parts[0] === 'register' ? String(params.get('cid') || '').trim() : '';
  return {
    tab: VALID_TABS.includes(parts[0]) ? parts[0] : '',
    automationTaskId: parts[0] === 'automation-tasks' ? (parts[1] || '') : '',
    configTab,
    smsTab: configTab === 'sms' ? (parts[2] || '') : '',
    relayTab: configTab === 'relay' ? (parts[2] || '') : '',
    serverLinkCid: cid,
  };
}

function writeRoute(tab) {
  const activeTab = tab || window.GFR.activeTab || 'register';
  const parts = [activeTab];
  if (activeTab === 'automation-tasks') {
    const match = String(location.hash || '').match(/^#automation-tasks\/(\d+)$/);
    if (match) parts.push(match[1]);
  }
  if (activeTab === 'config') {
    const configTab = localStorage.getItem('gfr.activeConfigTab') || '';
    const smsTab = localStorage.getItem('gfr.activeSmsTab') || '';
    const relayTab = localStorage.getItem('gfr.activeRelayTab') || '';
    if (configTab) parts.push(configTab);
    if (configTab === 'sms' && smsTab) parts.push(smsTab);
    if (configTab === 'relay' && relayTab) parts.push(relayTab);
  }
  history.replaceState(null, '', '#' + parts.join('/'));
}

window.GFR.route = {
  parse: parseRoute,
  write: writeRoute,
};

window.GFR.setActiveTab = setActiveTab;

// ---------- Tab 切换 ----------
const tabLoaders = {
  register: () => {
    window.GFR.pages.register.loadRunDefaults();
  },
  accounts: () => {
    window.GFR.pages.accounts.loadAccountFilters?.();
    window.GFR.pages.accounts.loadAccounts();
  },
  'automation-tasks': () => window.GFR.pages.automationTasks.load(),
  codex: () => window.GFR.pages.codex.loadCodex(),
  outlook: () => window.GFR.pages.emailPool.loadActivePool?.() || window.GFR.pages.emailPool.loadOutlook(),
  upi: () => window.GFR.pages.upi.load(),
  cardpool: () => window.GFR.pages.cardpool.load(),
  config: () => window.GFR.pages.config.loadConfig(),
};

const tabMeta = {
  register: {
    titleKey: 'nav.register.title',
    subtitleKey: 'nav.register.subtitle',
  },
  accounts: {
    titleKey: 'nav.accounts.title',
    subtitleKey: 'nav.accounts.subtitle',
  },
  'automation-tasks': {
    titleKey: 'nav.automation.title',
    subtitleKey: 'nav.automation.subtitle',
  },
  codex: {
    titleKey: 'nav.codex.title',
    subtitleKey: 'nav.codex.subtitle',
  },
  outlook: {
    titleKey: 'nav.email_pool.title',
    subtitleKey: 'nav.email_pool.subtitle',
  },
  upi: {
    titleKey: 'nav.upi.title',
    subtitleKey: 'nav.upi.page_subtitle',
  },
  cardpool: {
    titleKey: 'nav.cardpool.title',
    subtitleKey: 'nav.cardpool.page_subtitle',
  },
  config: {
    titleKey: 'nav.config.title',
    subtitleKey: 'nav.config.subtitle',
  },
};

function renderActiveTabMeta() {
  const meta = tabMeta[window.GFR.activeTab] || tabMeta.register;
  const title = $('#pageTitle');
  const subtitle = $('#pageSubtitle');
  if (title) title.textContent = t(meta.titleKey);
  if (subtitle) subtitle.textContent = t(meta.subtitleKey);
}

function setActiveTab(tab, opts = {}) {
  if (!VALID_TABS.includes(tab)) tab = 'register';
  window.GFR.activeTab = tab;
  localStorage.setItem('gfr.activeTab', tab);
  $$('nav button').forEach(x => x.classList.toggle('active', x.dataset.tab === tab));
  VALID_TABS.forEach(t => $('#tab-'+t).classList.toggle('hidden', t !== tab));
  renderActiveTabMeta();
  if (!opts.skipRoute) writeRoute(tab);
  tabLoaders[tab]?.();
  window.GFR.pages.register.setPageActive?.(tab === 'register');
}

function initSidebarCollapse() {
  const btn = $('#sidebarToggle');
  if (!btn) return;
  const apply = (collapsed) => {
    $('#userMenu')?.removeAttribute('open');
    document.body.classList.add('sidebar-toggle-lock');
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    document.documentElement.classList.remove('sidebar-collapsed-preload');
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.title = collapsed ? t('sidebar.expand') : t('sidebar.collapse');
    btn.setAttribute('aria-label', collapsed ? t('sidebar.expand') : t('sidebar.collapse'));
    localStorage.setItem('gfr.sidebarCollapsed', collapsed ? '1' : '0');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => document.body.classList.remove('sidebar-toggle-lock'));
    });
  };
  apply(localStorage.getItem('gfr.sidebarCollapsed') === '1');
  btn.addEventListener('click', () => {
    apply(!document.body.classList.contains('sidebar-collapsed'));
  });
}

function initAccountMenu() {
  const menu = $('#userMenu');
  const trigger = menu?.querySelector('summary');
  if (!menu || !trigger) return;

  const close = (restoreFocus = false) => {
    if (!menu.open) return;
    menu.open = false;
    if (restoreFocus) trigger.focus();
  };
  const syncExpanded = () => {
    trigger.setAttribute('aria-expanded', String(menu.open));
  };

  syncExpanded();
  menu.addEventListener('toggle', syncExpanded);
  document.addEventListener('click', event => {
    if (menu.open && !menu.contains(event.target)) close();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu.open) close(true);
  });
}

function initGuideEntry() {
  const btn = $('#guideEntryBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    window.GFR.guide?.reset?.();
  });
}

// ---------- 初始化 ----------
async function initApp() {
  await (window.GFR.i18n?.ready || Promise.resolve());
  const me = await initAuthBar();
  if (!me) return;
  window.GFR.pages.version?.startVersionChecks?.();
  window.GFR.credentials?.init?.(me);
  $('#btnLogout')?.addEventListener('click', logout);
  $$('nav button').forEach(b => b.addEventListener('click', () => setActiveTab(b.dataset.tab)));
  initSidebarCollapse();
  initAccountMenu();
  initGuideEntry();
  window.GFR.systemMetrics?.init?.();
  window.GFR.pages.dashboard.init?.();
  window.GFR.pages.register.initRegisterPage();
  window.GFR.pages.upi.init?.();
  window.GFR.pages.cardpool.init?.();
  const route = parseRoute();
  const initialTab = route.tab || localStorage.getItem('gfr.activeTab') || 'register';
  if (route.configTab) localStorage.setItem('gfr.activeConfigTab', route.configTab);
  if (route.configTab === 'sms' && route.smsTab) localStorage.setItem('gfr.activeSmsTab', route.smsTab);
  if (route.configTab === 'relay' && route.relayTab) localStorage.setItem('gfr.activeRelayTab', route.relayTab);
  setActiveTab(initialTab, { skipRoute: !route.tab });
  if (!me.credential_prompt_required) window.GFR.guide?.maybeAutoPrompt?.();
}

window.addEventListener('gfr:localechange', () => {
  renderActiveTabMeta();
  const collapsed = document.body.classList.contains('sidebar-collapsed');
  const sidebarButton = $('#sidebarToggle');
  if (sidebarButton) {
    sidebarButton.title = collapsed ? t('sidebar.expand') : t('sidebar.collapse');
    sidebarButton.setAttribute('aria-label', sidebarButton.title);
  }
  window.GFR.systemMetrics?.rerenderLocale?.();
  Object.values(window.GFR.pages || {}).forEach(page => page?.rerenderLocale?.());
  window.GFR.guide?.rerenderLocale?.();
});

initApp();
