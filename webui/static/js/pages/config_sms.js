// 运行配置 -> 接码配置增强面板。
(function () {
  const { $, $$, esc, escRaw, showToast, noticeHtml, customSelectHtml, controlValue, formatDateTime, formatShanghaiDate, copyText, confirmDialog, api } = window.GFR;
  let activeSmsTab = localStorage.getItem('gfr.activeSmsTab') || 'providers';
  let providerItems = [];
  let apiNumberItems = [];
  let apiNumberSummary = { available: 0, used: 0, failed: 0, total: 0 };
  const apiNumberSelected = new Set();
  let allPriceItems = [];
  let priceItems = [];
  let pricesLoaded = false;
  let priceSelectionTouched = false;
  let priceVisibleCount = 200;
  let priceFilterTimer = null;
  const PRICE_RENDER_BATCH = 200;
  const selectedTiers = new Set();

  function activeLocale() {
    return window.GFR.i18n?.getLocale?.() || 'zh_cn';
  }

  function tr(key, params, fallback) {
    return window.GFR.t?.(key, params || {}, fallback) || fallback;
  }

  const PROVIDER_FILTER_OPTIONS = [
    { value: 'all', label: '全部平台' },
    { value: 'grizzly', label: 'GrizzlySMS' },
    { value: 'smsbower', label: 'SmsBower' },
    { value: 'hero', label: 'HeroSMS' },
    { value: 'smsonline', label: 'SMS-Online.pro' },
    { value: 'smspool', label: 'SMSPool' },
  ];
  const PROVIDER_SITE_URLS = {
    smspool: 'https://smspool.net/?r=YzbmQIYjgR',
    smsonline: 'https://sms-online.pro/partners/137553',
    smsbower: 'https://smsbower.app/cn?ref=484302',
    hero: 'https://hero-sms.com',
    grizzly: 'https://grizzlysms.com/cn',
  };
  const PRICE_SELECTION_FILTER_OPTIONS = [
    { value: 'all', label: '全部选择状态' },
    { value: 'selected', label: '已选' },
    { value: 'unselected', label: '未选' },
  ];
  const API_NUMBER_STATUS_FILTER_OPTIONS = [
    { value: 'all', label: '全部状态' },
    { value: 'available', label: '可用' },
    { value: 'used', label: '已领取/已用' },
    { value: 'failed', label: '失败' },
  ];

  const COUNTRY_ZH_BY_ISO = {
    US: '美国', JP: '日本', PH: '菲律宾', PT: '葡萄牙', CL: '智利',
    GB: '英国', UK: '英国', CA: '加拿大', AU: '澳大利亚', DE: '德国',
    FR: '法国', ES: '西班牙', IT: '意大利', NL: '荷兰', BR: '巴西',
    MX: '墨西哥', IN: '印度', ID: '印度尼西亚', MY: '马来西亚', TH: '泰国',
    VN: '越南', KR: '韩国', SG: '新加坡', HK: '中国香港', TW: '中国台湾',
    RU: '俄罗斯', TR: '土耳其', AR: '阿根廷', CO: '哥伦比亚', PL: '波兰',
  };
  const COUNTRY_ZH_BY_NAME = {
    'united states': '美国', 'usa': '美国', 'america': '美国', 'japan': '日本',
    'philippines': '菲律宾', 'portugal': '葡萄牙', 'chile': '智利', 'united kingdom': '英国',
    'canada': '加拿大', 'australia': '澳大利亚', 'germany': '德国', 'france': '法国',
    'spain': '西班牙', 'italy': '意大利', 'netherlands': '荷兰', 'brazil': '巴西',
    'mexico': '墨西哥', 'india': '印度', 'indonesia': '印度尼西亚', 'malaysia': '马来西亚',
    'thailand': '泰国', 'vietnam': '越南', 'korea': '韩国', 'south korea': '韩国',
    'singapore': '新加坡', 'hong kong': '中国香港', 'taiwan': '中国台湾', 'russia': '俄罗斯',
    'turkey': '土耳其', 'argentina': '阿根廷', 'colombia': '哥伦比亚', 'poland': '波兰',
  };
  const COUNTRY_ZH_BY_PROVIDER_ID = {
    smspool: { '12': '菲律宾' },
    grizzly: { '187': '美国', '117': '葡萄牙', '151': '智利' },
    smsbower: { '187': '美国', '117': '葡萄牙', '151': '智利' },
    hero: { '187': '美国', '117': '葡萄牙', '151': '智利' },
    smsonline: { '187': '美国', '117': '葡萄牙', '151': '智利' },
  };

  function money(v) {
    return v == null || v === '' ? '-' : String(v);
  }

  function statusLabel(status) {
    const map = { available: '可用', used: '已领取/已用', failed: '失败' };
    return map[status] || status || '-';
  }

  function filteredApiNumberItems() {
    const q = ($('#smsApiKeywordFilter')?.value || '').trim().toLowerCase();
    const status = controlValue('#smsApiStatusFilter') || 'all';
    return apiNumberItems.filter(row => {
      if (status !== 'all' && row.status !== status) return false;
      if (!q) return true;
      return [row.phone, row.api_url, row.status, statusLabel(row.status), row.last_code, row.note]
        .filter(Boolean)
        .join('\n')
        .toLowerCase()
        .includes(q);
    });
  }

  function pruneApiNumberSelection() {
    const current = new Set(apiNumberItems.map(row => String(row.phone || '')));
    Array.from(apiNumberSelected).forEach(phone => {
      if (!current.has(phone)) apiNumberSelected.delete(phone);
    });
  }

  function updateApiNumberSelectionControls(rows) {
    const hint = $('#smsApiSelectedHint');
    const exportButton = $('#btnSmsApiExportSelected');
    const deleteButton = $('#btnSmsApiDeleteSelected');
    const selectAll = $('#smsApiSelectAll');
    const count = apiNumberSelected.size;
    if (hint) hint.textContent = `已选 ${count}`;
    if (exportButton) exportButton.disabled = count === 0;
    if (deleteButton) deleteButton.disabled = count === 0;
    if (!selectAll) return;
    const phones = rows.map(row => String(row.phone || ''));
    const checkedCount = phones.filter(phone => apiNumberSelected.has(phone)).length;
    selectAll.checked = phones.length > 0 && checkedCount === phones.length;
    selectAll.indeterminate = checkedCount > 0 && checkedCount < phones.length;
  }

  function downloadApiNumberText(lines) {
    const content = lines.filter(Boolean).join('\n');
    if (!content) {
      showToast('没有可导出的选中号码', 'warning');
      return;
    }
    const blob = new Blob([`\uFEFF${content}\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `api-sms-numbers-${formatShanghaiDate(new Date())}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      anchor.remove();
    }, 800);
    showToast(`已导出 ${lines.length} 个 API 接码号码`, 'success');
  }

  function providerName(name) {
    const map = { grizzly: 'GrizzlySMS', smsbower: 'SmsBower', hero: 'HeroSMS', smsonline: 'SMS-Online.pro', smspool: 'SMSPool' };
    return map[name] || name || '-';
  }

  function providerBadge(name) {
    const p = String(name || 'unknown').toLowerCase();
    return `<span class="sms-provider-badge provider-${escRaw(p)}">${esc(providerName(p))}</span>`;
  }

  function providerSiteLink(name) {
    const url = PROVIDER_SITE_URLS[String(name || '').toLowerCase()];
    if (!url) return '';
    return `<br><a class="config-external-link sms-provider-site-link" href="${escRaw(url)}" target="_blank" rel="noopener noreferrer">打开网站</a>`;
  }

  function serviceName() { return 'OpenAI / ChatGPT'; }

  function countryName(itemOrRow) {
    const item = itemOrRow || {};
    const locale = activeLocale();
    if (item._country?.locale === locale) return item._country;
    const provider = String(item.provider || '').toLowerCase();
    const iso = String(item.country_iso || '').toUpperCase();
    const rawName = String(item.country_name || '').trim();
    const id = String(item.country_id || '').trim();
    const backendZh = String(item.country_name_zh || item.country_display || '').trim();
    const byProvider = COUNTRY_ZH_BY_PROVIDER_ID[provider]?.[id];
    // 后端会结合平台 getCountries/pricing 做标准化；前端只做兜底。
    // 注意 provider country_id 不能跨平台复用，例如 Hero/SMS-Activate 的 #4 是菲律宾，SMSPool 的 #4 是俄罗斯。
    const zh = backendZh || COUNTRY_ZH_BY_ISO[iso] || COUNTRY_ZH_BY_NAME[rawName.toLowerCase()] || rawName || byProvider || id || '-';
    let display = zh;
    if (locale === 'en') {
      const englishRaw = rawName && !/[\u3400-\u9fff]/.test(rawName) ? rawName : '';
      let regionName = '';
      if (iso && iso.length === 2) {
        try {
          regionName = new Intl.DisplayNames(['en'], { type: 'region' }).of(iso) || '';
        } catch (_) {}
      }
      display = englishRaw || regionName || iso || id || '-';
    }
    const extras = [];
    if (iso && !display.includes(iso)) extras.push(iso);
    if (id && id !== display) extras.push(`#${id}`);
    return { zh: display, sub: extras.join(' / '), locale };
  }

  function priceTierLabel(item) {
    const pool = item.provider_pool_id
      ? tr('legacy.config-sms.5786ff8afdaa', { value1: item.provider_pool_id }, `线路 ${item.provider_pool_id}`)
      : tr('legacy.config-sms.adedafe24366', {}, '默认线路');
    return `${providerName(item.provider)} · ${countryName(item).zh} · ${money(item.price)} · ${pool}`;
  }

  function normalizePriceItem(item) {
    const c = countryName(item);
    const providerKey = String(item.provider || '').toLowerCase();
    const providerLabel = providerName(providerKey);
    const pool = item.provider_pool_id
      ? tr('legacy.config-sms.5786ff8afdaa', { value1: item.provider_pool_id }, `线路 ${item.provider_pool_id}`)
      : tr('legacy.config-sms.adedafe24366', {}, '默认线路');
    const tierLabel = `${providerLabel} · ${c.zh} · ${money(item.price)} · ${pool}`;
    return {
      ...item,
      _country: c,
      _provider_key: providerKey,
      _provider_label: providerLabel,
      _price_num: Number(item.price || 0),
      _tier_label: tierLabel,
      _search: [
        c.zh, c.sub, item.country_name, item.country_iso, item.country_id,
        providerLabel, providerKey, item.provider_pool_id, item.price_tier_key, tierLabel,
      ].filter(v => v !== undefined && v !== null).join(' ').toLowerCase(),
    };
  }

  function providerStatusHtml(row) {
    if (row?.last_error) return `<span class="pill status-failed">${esc(row.last_error)}</span>`;
    return '<span class="pill status-success">正常</span>';
  }

  function updateProviderRow(rowEl, item) {
    if (!rowEl || !item) return;
    const cells = rowEl.children;
    const enabled = rowEl.querySelector('.sms-provider-enabled');
    const keyInput = rowEl.querySelector('.sms-provider-key');
    if (enabled) enabled.checked = !!item.enabled;
    if (keyInput) {
      keyInput.value = '';
      keyInput.placeholder = item.api_key_masked || '输入 API Key';
      keyInput.classList.add('sms-field-saved');
      setTimeout(() => keyInput.classList.remove('sms-field-saved'), 900);
    }
    if (cells[3]) {
      cells[3].textContent = item.balance || '-';
      cells[3].classList.add('sms-cell-flash');
      setTimeout(() => cells[3].classList.remove('sms-cell-flash'), 900);
    }
    if (cells[4]) cells[4].innerHTML = providerStatusHtml(item);
    const index = providerItems.findIndex(x => x.provider === item.provider);
    if (index >= 0) providerItems[index] = item;
    else providerItems.push(item);
  }

  function renderShell(runtimeFieldsHtml) {
    activeSmsTab = localStorage.getItem('gfr.activeSmsTab') || activeSmsTab || 'providers';
    return `
      <div class="sms-console">
        <div class="sms-subtabs" role="tablist" aria-label="接码配置分类">
          <button type="button" class="sms-subtab${activeSmsTab === 'providers' ? ' active' : ''}" data-sms-tab="providers">平台接码</button>
          <button type="button" class="sms-subtab${activeSmsTab === 'prices' ? ' active' : ''}" data-sms-tab="prices">价格查询</button>
          <button type="button" class="sms-subtab${activeSmsTab === 'strategy' ? ' active' : ''}" data-sms-tab="strategy">使用策略</button>
          <button type="button" class="sms-subtab${activeSmsTab === 'runtime' ? ' active' : ''}" data-sms-tab="runtime">运行参数</button>
          <button type="button" class="sms-subtab${activeSmsTab === 'api' ? ' active' : ''}" data-sms-tab="api">API接码</button>
        </div>

        <section class="sms-panel${activeSmsTab === 'providers' ? '' : ' hidden'}" data-sms-panel="providers">
          <div class="sms-panel-head">
            <div><h4>接码平台</h4><p>API Key、启用状态和余额检查。查询余额不会购买号码。</p></div>
            <button type="button" class="btn" id="btnSmsReloadProviders">刷新平台</button>
          </div>
          <div class="table-wrap"><table class="data-table sms-provider-table">
            <thead><tr><th>启用</th><th>平台</th><th>API Key</th><th>余额</th><th>状态</th><th>操作</th></tr></thead>
            <tbody id="smsProvidersBody"><tr><td colspan="6">加载中…</td></tr></tbody>
          </table></div>
        </section>

        <section class="sms-panel${activeSmsTab === 'prices' ? '' : ' hidden'}" data-sms-panel="prices">
          <div class="sms-panel-head">
            <div><h4>价格列表</h4></div>
            <div class="sms-actions">
              <input class="ui-control" id="smsKeywordFilter" placeholder="国家 / ISO / ID">
              ${customSelectHtml({ id: 'smsProviderFilter', value: 'all', options: PROVIDER_FILTER_OPTIONS, className: 'sms-provider-filter', title: '按平台筛选' })}
              ${customSelectHtml({ id: 'smsSelectedFilter', value: 'all', options: PRICE_SELECTION_FILTER_OPTIONS, className: 'sms-selected-filter', title: '按已选状态筛选' })}
              <input class="ui-control" id="smsMinPriceFilter" type="number" step="0.001" placeholder="最低价">
              <input class="ui-control" id="smsMaxPriceFilter" type="number" step="0.001" placeholder="最高价">
              <button type="button" class="btn primary" id="btnSmsRefreshPrices">刷新价格</button>
            </div>
          </div>
          <div class="sms-price-recommendation">
            <span class="sms-price-recommendation-label">实测成功率高的接码：</span>
            <strong>HeroSMS · 哥伦比亚 · 0.05</strong>
          </div>
          <div id="smsPricesMeta" class="sms-meta">未加载价格。</div>
          <div class="table-wrap sms-price-table-wrap"><table class="data-table sms-price-table">
            <thead><tr><th>选</th><th>平台</th><th>国家</th><th>价格档</th><th>价格</th><th>数量</th><th>成功率</th><th>线路</th><th>更新时间</th></tr></thead>
            <tbody id="smsPricesBody"><tr><td colspan="9">点击“刷新价格”。</td></tr></tbody>
          </table></div>
          <div class="sms-price-more" id="smsPricesMore"></div>
        </section>

        <section class="sms-panel${activeSmsTab === 'strategy' ? '' : ' hidden'}" data-sms-panel="strategy">
          <div class="sms-panel-head">
            <div><h4>使用策略</h4><p>注册流程只会使用这里保存且启用的具体价格档。</p></div>
            <button type="button" class="btn" id="btnSmsReloadSelections">刷新策略</button>
          </div>
          <div class="table-wrap"><table class="data-table sms-selection-table">
            <thead><tr><th>启用</th><th>优先级</th><th>平台</th><th>国家</th><th>价格档</th><th>最高价</th><th>上次结果</th><th>操作</th></tr></thead>
            <tbody id="smsSelectionsBody"><tr><td colspan="8">加载中…</td></tr></tbody>
          </table></div>
        </section>

        <section class="sms-panel${activeSmsTab === 'runtime' ? '' : ' hidden'}" data-sms-panel="runtime">
          <div class="sms-panel-head"><div><h4>运行参数</h4><p>换号次数、等码时间等仍跟随运行配置保存按钮。</p></div></div>
          ${runtimeFieldsHtml}
        </section>

        <section class="sms-panel${activeSmsTab === 'api' ? '' : ' hidden'}" data-sms-panel="api">
          <div class="sms-panel-head">
            <div>
              <h4>API接码</h4>
              <p>导入格式：号码----接码api。注册配置或提Codex配置选择 API接码时，会从这里领取手机号并轮询对应 API。</p>
            </div>
            <div class="row-actions">
              <button type="button" class="btn" id="btnSmsApiReload">刷新号码池</button>
              <button type="button" class="btn" id="btnSmsApiCopyAll">复制当前号码池</button>
              <button type="button" class="btn danger" id="btnSmsApiClear">清空号码池</button>
            </div>
          </div>
          <div class="sms-api-import-box">
            <textarea id="smsApiImportText" class="ui-control" rows="5" placeholder="号码----接码api&#10;+15551234567----https://example.com/sms?id=abc&#10;15557654321----https://example.com/sms?id=def"></textarea>
            <div class="sms-api-import-actions">
              <button type="button" class="btn primary" id="btnSmsApiImport">导入 API 接码号码</button>
              <span class="muted">重复号码会跳过，不覆盖已保存的 API。</span>
            </div>
            <div id="smsApiImportResult"></div>
          </div>
          <div id="smsApiNumbersMeta" class="sms-meta">未加载号码池。</div>
          <div class="sms-api-management-toolbar">
            <input class="ui-control" id="smsApiKeywordFilter" placeholder="搜索号码、API、状态或备注">
            ${customSelectHtml({ id: 'smsApiStatusFilter', value: 'all', options: API_NUMBER_STATUS_FILTER_OPTIONS, className: 'sms-api-status-filter', title: '按使用状态筛选' })}
            <span class="muted selected-hint" id="smsApiSelectedHint">已选 0</span>
            <button type="button" class="btn good" id="btnSmsApiExportSelected" disabled>导出选中</button>
            <button type="button" class="btn danger" id="btnSmsApiDeleteSelected" disabled>删除选中</button>
          </div>
          <div class="table-wrap"><table class="data-table sms-api-number-table">
            <thead><tr><th><input type="checkbox" id="smsApiSelectAll" title="全选/取消全选当前筛选结果"></th><th>号码</th><th>接码 API</th><th>状态</th><th>使用时间</th><th>最近验证码</th><th>备注</th><th>操作</th></tr></thead>
            <tbody id="smsApiNumbersBody"><tr><td colspan="8">加载中…</td></tr></tbody>
          </table></div>
        </section>
      </div>`;
  }

  function bindShell() {
    $$('.sms-subtab').forEach(btn => {
      btn.addEventListener('click', () => {
        setActiveSmsTab(btn.dataset.smsTab);
      });
    });
    $('#btnSmsReloadProviders')?.addEventListener('click', loadProviders);
    $('#btnSmsRefreshPrices')?.addEventListener('click', () => refreshPrices(true));
    $('#btnSmsReloadSelections')?.addEventListener('click', loadSelections);
    $('#btnSmsApiReload')?.addEventListener('click', loadApiNumbers);
    $('#btnSmsApiImport')?.addEventListener('click', importApiNumbers);
    $('#btnSmsApiClear')?.addEventListener('click', clearApiNumbers);
    $('#btnSmsApiCopyAll')?.addEventListener('click', () => {
      copyText(apiNumberItems.map(row => row.copy_line || `${row.phone || ''}----${row.api_url || ''}`).filter(Boolean).join('\n'));
    });
    $('#smsApiKeywordFilter')?.addEventListener('input', renderApiNumbers);
    $('#smsApiStatusFilter')?.addEventListener('change', renderApiNumbers);
    $('#smsApiSelectAll')?.addEventListener('change', (e) => {
      filteredApiNumberItems().forEach(row => {
        const phone = String(row.phone || '');
        if (e.target.checked) apiNumberSelected.add(phone);
        else apiNumberSelected.delete(phone);
      });
      renderApiNumbers();
    });
    $('#btnSmsApiExportSelected')?.addEventListener('click', exportSelectedApiNumbers);
    $('#btnSmsApiDeleteSelected')?.addEventListener('click', deleteSelectedApiNumbers);
    $('#smsApiNumbersBody')?.addEventListener('click', onApiNumbersBodyClick);
    $('#smsApiNumbersBody')?.addEventListener('change', onApiNumbersBodyChange);
    $('#smsPricesBody')?.addEventListener('change', onPriceBodyChange);
    $('#smsPricesMore')?.addEventListener('click', onPriceMoreClick);
    ['#smsKeywordFilter', '#smsProviderFilter', '#smsSelectedFilter', '#smsMinPriceFilter', '#smsMaxPriceFilter'].forEach(sel => {
      $(sel)?.addEventListener('input', () => schedulePriceFilter());
      $(sel)?.addEventListener('change', () => schedulePriceFilter(0));
    });
    loadProviders();
    loadSelections();
    if (activeSmsTab === 'api') loadApiNumbers();
    if (activeSmsTab === 'prices') refreshPrices(false);
  }

  function setActiveSmsTab(tab) {
    if (!tab) return false;
    activeSmsTab = tab;
    localStorage.setItem('gfr.activeSmsTab', activeSmsTab);
    const buttons = $$('.sms-subtab');
    const panels = $$('.sms-panel');
    if (!buttons.length || !panels.length) return false;
    buttons.forEach(btn => btn.classList.toggle('active', btn.dataset.smsTab === activeSmsTab));
    panels.forEach(panel => panel.classList.toggle('hidden', panel.dataset.smsPanel !== activeSmsTab));
    window.GFR.route?.write?.('config');
    if (activeSmsTab === 'prices') {
      if (!pricesLoaded) refreshPrices(false);
      else renderPrices();
    }
    if (activeSmsTab === 'api') {
      loadApiNumbers();
    }
    window.dispatchEvent(new CustomEvent('gfr:config-rendered', { detail: { tab: 'sms', smsTab: activeSmsTab, switched: true } }));
    return true;
  }

  async function loadApiNumbers(opts = {}) {
    const body = $('#smsApiNumbersBody');
    if (!body) return;
    if (!opts.silent) body.innerHTML = '<tr><td colspan="7">加载中…</td></tr>';
    try {
      const r = await api('/api/sms/api-numbers?limit=5000');
      apiNumberItems = r.items || [];
      apiNumberSummary = r.summary || { available: 0, used: 0, failed: 0, total: apiNumberItems.length };
      pruneApiNumberSelection();
      renderApiNumbers();
    } catch (e) {
      body.innerHTML = `<tr><td colspan="8">${noticeHtml('error', e.message, 'API 接码号码池加载失败')}</td></tr>`;
      const meta = $('#smsApiNumbersMeta');
      if (meta) meta.textContent = '加载失败。';
    }
  }

  function renderApiNumbers() {
    const body = $('#smsApiNumbersBody');
    const meta = $('#smsApiNumbersMeta');
    if (!body) return;
    const visibleRows = filteredApiNumberItems();
    if (meta) {
      const total = apiNumberSummary.total || apiNumberItems.length || 0;
      meta.textContent = `共 ${total} 个号码，可用 ${apiNumberSummary.available || 0}，已领取/已用 ${apiNumberSummary.used || 0}，失败 ${apiNumberSummary.failed || 0}；当前显示 ${visibleRows.length}。`;
    }
    body.innerHTML = visibleRows.map(row => {
      const line = row.copy_line || `${row.phone || ''}----${row.api_url || ''}`;
      const canRestore = row.status !== 'available';
      const canFail = row.status !== 'failed';
      return `
        <tr data-phone="${escRaw(row.phone || '')}">
          <td><input type="checkbox" data-api-number-select="true" ${apiNumberSelected.has(String(row.phone || '')) ? 'checked' : ''} aria-label="选择 ${esc(row.phone || '')}"></td>
          <td><span class="mono">${esc(row.phone || '-')}</span></td>
          <td><span class="mono clip" title="${esc(row.api_url || '')}">${esc(row.api_url || '-')}</span></td>
          <td><span class="pill status-${esc(row.status || 'available')}">${esc(statusLabel(row.status))}</span></td>
          <td class="muted">${esc(formatDateTime(row.used_at))}</td>
          <td><span class="mono">${esc(row.last_code || '-')}</span>${row.last_code_at ? `<br><span class="muted">${esc(formatDateTime(row.last_code_at))}</span>` : ''}</td>
          <td><span class="clip" title="${esc(row.note || '')}">${esc(row.note || '-')}</span></td>
          <td><div class="row-actions">
            <button type="button" class="btn" data-api-number-act="copy" data-copy-line="${escRaw(line)}">复制</button>
            ${canRestore ? '<button type="button" class="btn" data-api-number-act="available">恢复可用</button>' : ''}
            ${canFail ? '<button type="button" class="btn" data-api-number-act="failed">标失败</button>' : ''}
            <button type="button" class="btn danger" data-api-number-act="delete">删除</button>
          </div></td>
        </tr>`;
    }).join('') || '<tr><td colspan="8" class="muted">API 接码号码池为空，请按“号码----接码api”格式导入。</td></tr>';
    updateApiNumberSelectionControls(visibleRows);
  }

  function onApiNumbersBodyChange(e) {
    const checkbox = e.target.closest?.('[data-api-number-select="true"]');
    if (!checkbox) return;
    const row = checkbox.closest('tr');
    const phone = String(row?.dataset.phone || '');
    if (!phone) return;
    if (checkbox.checked) apiNumberSelected.add(phone);
    else apiNumberSelected.delete(phone);
    renderApiNumbers();
  }

  function exportSelectedApiNumbers() {
    const selected = apiNumberItems.filter(row => apiNumberSelected.has(String(row.phone || '')));
    downloadApiNumberText(selected.map(row => row.copy_line || `${row.phone || ''}----${row.api_url || ''}`));
  }

  async function deleteSelectedApiNumbers() {
    const phones = Array.from(apiNumberSelected);
    if (!phones.length) return;
    const ok = await confirmDialog({
      title: '删除选中 API 接码号码？',
      tone: 'error',
      confirmText: '确认删除',
      message: `将删除已勾选的 ${phones.length} 个 API 接码号码。此操作不可撤销。`,
    });
    if (!ok) return;
    try {
      const result = await api('/api/sms/api-numbers/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phones }),
      });
      phones.forEach(phone => apiNumberSelected.delete(phone));
      showToast(`已删除 ${result.deleted || 0} 个 API 接码号码`, 'success');
      await loadApiNumbers();
    } catch (e) {
      showToast('批量删除失败: ' + e.message, 'error');
    }
  }

  async function importApiNumbers() {
    const text = $('#smsApiImportText')?.value || '';
    if (!text.trim()) {
      showToast('请粘贴号码----接码api素材', 'warning');
      return;
    }
    const btn = $('#btnSmsApiImport');
    if (btn) btn.disabled = true;
    try {
      const r = await api('/api/sms/api-numbers/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      $('#smsApiImportResult').innerHTML = noticeHtml('success', `解析 ${r.parsed} 行，新增 ${r.inserted}，跳过 ${r.skipped}`, '导入完成');
      $('#smsApiImportText').value = '';
      showToast(`API 接码号码已导入：新增 ${r.inserted || 0}`, 'success');
      loadApiNumbers();
    } catch (e) {
      $('#smsApiImportResult').innerHTML = noticeHtml('error', e.message, '导入失败');
      showToast('导入失败: ' + e.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function clearApiNumbers() {
    if (!apiNumberItems.length) {
      showToast('API 接码号码池已经为空', 'warning');
      return;
    }
    const ok = await confirmDialog({
      title: '清空 API 接码号码池？',
      tone: 'error',
      confirmText: '确认清空',
      message: `将删除全部 ${apiNumberItems.length} 条 API 接码号码记录。此操作不可撤销。`,
    });
    if (!ok) return;
    const btn = $('#btnSmsApiClear');
    if (btn) btn.disabled = true;
    try {
      const r = await api('/api/sms/api-numbers/clear', { method: 'POST' });
      showToast(`已清空 ${r.deleted || 0} 个 API 接码号码`, 'success');
      loadApiNumbers();
    } catch (e) {
      showToast('清空失败: ' + e.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function updateApiNumberStatus(phone, status) {
    await api('/api/sms/api-numbers/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone,
        status,
        note: status === 'failed' ? '手动标记失败' : '手动恢复可用',
      }),
    });
    showToast(status === 'failed' ? '已标失败' : '已恢复可用', status === 'failed' ? 'warning' : 'success');
    loadApiNumbers();
  }

  async function deleteApiNumber(phone) {
    const ok = await confirmDialog({
      title: '删除 API 接码号码？',
      tone: 'error',
      confirmText: '确认删除',
      message: `确定从 API 接码号码池删除 ${phone}？此操作不可撤销。`,
    });
    if (!ok) return;
    await api('/api/sms/api-numbers/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    showToast('已删除 API 接码号码', 'success');
    loadApiNumbers();
  }

  function onApiNumbersBodyClick(e) {
    const btn = e.target.closest?.('[data-api-number-act]');
    if (!btn) return;
    const row = btn.closest('tr');
    const phone = row?.dataset.phone;
    const act = btn.dataset.apiNumberAct;
    if (act === 'copy') {
      copyText(btn.dataset.copyLine || '');
      return;
    }
    if (!phone) return;
    btn.disabled = true;
    const done = act === 'delete'
      ? deleteApiNumber(phone)
      : updateApiNumberStatus(phone, act);
    done
      .catch(err => {
        showToast('操作失败: ' + err.message, 'error');
      })
      .finally(() => {
        if (document.body.contains(btn)) btn.disabled = false;
      });
  }

  async function loadProviders() {
    const body = $('#smsProvidersBody');
    if (!body) return;
    body.innerHTML = '<tr><td colspan="6">加载中…</td></tr>';
    try {
      const r = await api('/api/sms/providers');
      providerItems = r.items || [];
      body.innerHTML = providerItems.map(row => `
        <tr data-provider="${escRaw(row.provider)}">
          <td><input type="checkbox" class="sms-provider-enabled" ${row.enabled ? 'checked' : ''}></td>
          <td>${providerBadge(row.provider)}${providerSiteLink(row.provider)}<br><span class="mono muted">${esc(row.provider)}</span></td>
          <td><input class="ui-control sms-provider-key" type="password" autocomplete="off" placeholder="${escRaw(row.api_key_masked || '输入 API Key')}"></td>
          <td class="mono">${esc(row.balance || '-')}</td>
          <td>${providerStatusHtml(row)}</td>
          <td><div class="row-actions"><button type="button" class="btn sms-save-provider">保存</button><button type="button" class="btn sms-check-balance">查余额</button></div></td>
        </tr>`).join('') || '<tr><td colspan="6">暂无平台</td></tr>';
      body.querySelectorAll('.sms-save-provider').forEach(btn => btn.addEventListener('click', (e) => {
        e.preventDefault();
        saveProvider(btn.closest('tr'));
      }));
      body.querySelectorAll('.sms-check-balance').forEach(btn => btn.addEventListener('click', (e) => {
        e.preventDefault();
        checkBalance(btn.closest('tr'));
      }));
    } catch (e) {
      body.innerHTML = `<tr><td colspan="6">${noticeHtml('error', e.message, '平台加载失败')}</td></tr>`;
    }
  }

  async function saveProvider(row, opts = {}) {
    const provider = row?.dataset.provider;
    if (!provider) return;
    const key = row.querySelector('.sms-provider-key')?.value || '';
    const enabled = !!row.querySelector('.sms-provider-enabled')?.checked;
    const btn = row.querySelector('.sms-save-provider');
    if (btn) btn.disabled = true;
    try {
      const r = await api(`/api/sms/providers/${encodeURIComponent(provider)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, api_key: key || undefined }),
      });
      if (!opts.silent) showToast(`${providerName(provider)} 已保存`, 'success');
      updateProviderRow(row, r.item);
    } catch (e) {
      if (!opts.silent) showToast('保存失败: ' + e.message, 'error');
      else throw e;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function checkBalance(row) {
    const provider = row?.dataset.provider;
    if (!provider) return;
    const key = row.querySelector('.sms-provider-key')?.value || '';
    const enabled = !!row.querySelector('.sms-provider-enabled')?.checked;
    const btn = row.querySelector('.sms-check-balance');
    if (btn) btn.disabled = true;
    try {
      const r = await api(`/api/sms/providers/${encodeURIComponent(provider)}/balance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: key || undefined, enabled }),
      });
      showToast(`${providerName(provider)} 余额：${r.balance}`, 'success');
      updateProviderRow(row, r.item);
    } catch (e) {
      showToast('余额查询失败: ' + e.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }


  function applyPriceFilters(items) {
    const keyword = ($('#smsKeywordFilter')?.value || '').trim().toLowerCase();
    const provider = (controlValue('#smsProviderFilter') || 'all').trim().toLowerCase();
    const selectedFilter = (controlValue('#smsSelectedFilter') || 'all').trim();
    const minPrice = parseFloat($('#smsMinPriceFilter')?.value || '');
    const maxPrice = parseFloat($('#smsMaxPriceFilter')?.value || '');
    return (items || []).filter(item => {
      const selected = selectedTiers.has(item.price_tier_key);
      const price = Number.isFinite(item._price_num) ? item._price_num : Number(item.price || 0);
      if (provider && provider !== 'all' && (item._provider_key || String(item.provider || '').toLowerCase()) !== provider) return false;
      if (selectedFilter === 'selected' && !selected) return false;
      if (selectedFilter === 'unselected' && selected) return false;
      if (keyword && !(item._search || '').includes(keyword)) return false;
      if (!Number.isNaN(minPrice) && price < minPrice) return false;
      if (!Number.isNaN(maxPrice) && price > maxPrice) return false;
      return true;
    });
  }

  function applyAndRenderPriceFilters(opts = {}) {
    priceItems = applyPriceFilters(allPriceItems);
    if (opts.resetVisible !== false) priceVisibleCount = PRICE_RENDER_BATCH;
    renderPrices();
  }

  function schedulePriceFilter(delay = 200) {
    if (priceFilterTimer) clearTimeout(priceFilterTimer);
    priceFilterTimer = setTimeout(() => {
      priceFilterTimer = null;
      applyAndRenderPriceFilters({ resetVisible: true });
    }, delay);
  }

  function sortPrices(items) {
    return [...items].sort((a, b) => {
      const pa = Number(a.price || 0);
      const pb = Number(b.price || 0);
      if (pa !== pb) return pa - pb;
      const ca = Number(a.count || 0);
      const cb = Number(b.count || 0);
      if (ca !== cb) return cb - ca;
      return String(a.provider).localeCompare(String(b.provider));
    });
  }

  async function refreshPrices(force) {
    const body = $('#smsPricesBody');
    if (!body) return;
    if (force) {
      body.innerHTML = '<tr><td colspan="9">刷新中（只查询价格，不购买号码）…</td></tr>';
      const more = $('#smsPricesMore');
      if (more) more.innerHTML = '';
    }
    const qs = new URLSearchParams({ logical_service: 'openai' });
    if (force) qs.set('refresh', '1');
    try {
      const r = await api(`/api/sms/prices?${qs.toString()}`);
      selectedTiers.clear();
      (r.items || []).forEach(item => { if (item.selected) selectedTiers.add(item.price_tier_key); });
      allPriceItems = sortPrices((r.items || []).map(normalizePriceItem));
      pricesLoaded = true;
      priceSelectionTouched = false;
      applyAndRenderPriceFilters({ resetVisible: true });
    } catch (e) {
      body.innerHTML = `<tr><td colspan="9">${noticeHtml('error', e.message, '价格加载失败')}</td></tr>`;
    }
  }

  function renderPrices() {
    const body = $('#smsPricesBody');
    const meta = $('#smsPricesMeta');
    const more = $('#smsPricesMore');
    if (!body) return;
    if (!pricesLoaded) {
      if (meta) meta.textContent = '未加载价格。';
      body.innerHTML = '<tr><td colspan="9">点击“刷新价格”。</td></tr>';
      if (more) more.innerHTML = '';
      return;
    }
    const total = priceItems.length;
    const visibleItems = priceItems.slice(0, Math.min(priceVisibleCount, total));
    const selectedCount = selectedTiers.size;
    if (meta) {
      meta.textContent = `共 ${allPriceItems.length} 个价格档，筛选后 ${total} 个，当前显示 ${visibleItems.length} 个；已选 ${selectedCount} 个。`;
    }
    body.innerHTML = visibleItems.map(item => {
      const checked = selectedTiers.has(item.price_tier_key);
      const c = countryName(item);
      return `
        <tr data-tier="${escRaw(item.price_tier_key)}">
          <td><input type="checkbox" class="sms-price-check" ${checked ? 'checked' : ''}></td>
          <td>${providerBadge(item.provider)}</td>
          <td title="${escRaw([item.country_name, item.country_iso, item.country_id].filter(Boolean).join(' / '))}"><strong>${esc(c.zh)}</strong>${c.sub ? `<br><span class="mono muted">${esc(c.sub)}</span>` : ''}</td>
          <td title="内部ID：${escRaw(item.price_tier_key)}"><strong>${esc(priceTierLabel(item))}</strong></td>
          <td class="mono">${esc(money(item.price))}</td>
          <td class="mono">${esc(item.count ?? '-')}</td>
          <td>${esc(item.success_rate ?? '-')}</td>
          <td class="mono" title="同平台同国家同服务下的供应商线路/池，用来区分不同库存来源">${esc(item.provider_pool_id || '默认')}</td>
          <td class="mono">${esc(formatDateTime(item.fetched_at))}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="9">暂无价格，请先启用平台并刷新。</td></tr>';

    if (more) {
      if (total > visibleItems.length) {
        const next = Math.min(PRICE_RENDER_BATCH, total - visibleItems.length);
        more.innerHTML = `
          <span>还有 ${total - visibleItems.length} 条未显示，已限制首屏渲染避免页面卡顿。</span>
          <div class="buttons">
            <button type="button" class="btn" data-price-more="next">继续显示 ${next} 条</button>
            <button type="button" class="btn" data-price-more="all">显示全部筛选结果</button>
          </div>`;
      } else if (pricesLoaded && total > PRICE_RENDER_BATCH) {
        more.innerHTML = '<span>已显示当前筛选结果的全部价格档。</span>';
      } else {
        more.innerHTML = '';
      }
    }
  }

  function rerenderLocale() {
    if (!pricesLoaded) return;
    allPriceItems = sortPrices(allPriceItems.map(item => normalizePriceItem(item)));
    priceItems = applyPriceFilters(allPriceItems);
    renderPrices();
  }

  function onPriceBodyChange(e) {
    const chk = e.target.closest?.('.sms-price-check');
    if (!chk) return;
    const tier = chk.closest('tr')?.dataset.tier;
    if (!tier) return;
    if (chk.checked) selectedTiers.add(tier);
    else selectedTiers.delete(tier);
    priceSelectionTouched = true;

    const selectedFilter = (controlValue('#smsSelectedFilter') || 'all').trim();
    if (selectedFilter !== 'all') {
      applyAndRenderPriceFilters({ resetVisible: false });
    } else {
      renderPrices();
    }
  }

  function onPriceMoreClick(e) {
    const btn = e.target.closest?.('[data-price-more]');
    if (!btn) return;
    const action = btn.dataset.priceMore;
    priceVisibleCount = action === 'all' ? priceItems.length : priceVisibleCount + PRICE_RENDER_BATCH;
    renderPrices();
  }

  async function saveCheckedPrices(opts = {}) {
    if (!priceSelectionTouched) return null;
    const items = allPriceItems
      .filter(item => selectedTiers.has(item.price_tier_key))
      .map((item, index) => ({
        provider: item.provider,
        price_tier_key: item.price_tier_key,
        service_code: item.service_code,
        country_id: item.country_id,
        country_name: item.country_name,
        country_iso: item.country_iso,
        max_price: item.price,
        provider_pool_id: item.provider_pool_id,
        enabled: true,
        priority: (index + 1) * 10,
      }));
    try {
      const r = await api('/api/sms/selections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logical_service: 'openai', items }),
      });
      if (!opts.silent) showToast(`已保存 ${r.saved} 个接码价格档策略`, 'success');
      priceSelectionTouched = false;
      loadSelections();
      return r.saved || 0;
    } catch (e) {
      if (!opts.silent) showToast('策略保存失败: ' + e.message, 'error');
      throw e;
    }
  }

  async function loadSelections() {
    const body = $('#smsSelectionsBody');
    if (!body) return;
    try {
      const r = await api('/api/sms/selections?logical_service=openai');
      const rows = r.items || [];
      body.innerHTML = rows.map(row => `
        <tr data-id="${escRaw(row.id)}">
          <td><input type="checkbox" class="sms-selection-enabled" ${row.enabled ? 'checked' : ''}></td>
          <td><input class="ui-control sms-selection-priority" type="number" value="${escRaw(row.priority || 100)}"></td>
          <td>${providerBadge(row.provider)}</td>
          <td><strong>${esc(countryName(row).zh)}</strong>${countryName(row).sub ? `<br><span class="mono muted">${esc(countryName(row).sub)}</span>` : ''}</td>
          <td title="内部ID：${escRaw(row.price_tier_key)}"><strong>${esc(providerName(row.provider))} · ${esc(countryName(row).zh)} · ${esc(row.max_price)}</strong></td>
          <td class="mono">${esc(row.max_price)}</td>
          <td>${esc(row.last_result || '-')}</td>
          <td><div class="row-actions"><button type="button" class="btn sms-update-selection">保存</button><button type="button" class="btn sms-delete-selection">删除</button></div></td>
        </tr>`).join('') || '<tr><td colspan="8">暂无策略，请到价格查询里勾选价格档，然后点击右下角“保存配置”。</td></tr>';
      body.querySelectorAll('.sms-update-selection').forEach(btn => btn.addEventListener('click', () => updateSelection(btn.closest('tr'))));
      body.querySelectorAll('.sms-delete-selection').forEach(btn => btn.addEventListener('click', () => deleteSelection(btn.closest('tr'))));
    } catch (e) {
      body.innerHTML = `<tr><td colspan="8">${noticeHtml('error', e.message, '策略加载失败')}</td></tr>`;
    }
  }

  function selectionRowPayload(row) {
    return {
      enabled: !!row.querySelector('.sms-selection-enabled')?.checked,
      priority: parseInt(row.querySelector('.sms-selection-priority')?.value || '100', 10),
    };
  }

  async function updateSelection(row) {
    const id = row?.dataset.id;
    if (!id) return;
    try {
      await api(`/api/sms/selections/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selectionRowPayload(row)),
      });
      showToast('策略已更新', 'success');
      loadSelections();
    } catch (e) {
      showToast('策略更新失败: ' + e.message, 'error');
    }
  }

  async function deleteSelection(row) {
    const id = row?.dataset.id;
    if (!id) return;
    try {
      await api(`/api/sms/selections/${id}`, { method: 'DELETE' });
      showToast('策略已删除', 'success');
      loadSelections();
    } catch (e) {
      showToast('删除失败: ' + e.message, 'error');
    }
  }


  async function saveProviderRows(opts = {}) {
    const rows = $$('#smsProvidersBody tr[data-provider]');
    let saved = 0;
    for (const row of rows) {
      await saveProvider(row, { silent: true });
      saved += 1;
    }
    if (!opts.silent && saved) showToast(`接码平台已保存 ${saved} 项`, 'success');
    return saved;
  }

  async function saveSelectionRows(opts = {}) {
    const rows = $$('#smsSelectionsBody tr[data-id]');
    let saved = 0;
    for (const row of rows) {
      const id = row?.dataset.id;
      if (!id) continue;
      await api(`/api/sms/selections/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selectionRowPayload(row)),
      });
      saved += 1;
    }
    if (!opts.silent && saved) showToast(`使用策略已保存 ${saved} 项`, 'success');
    return saved;
  }

  window.GFR.pages = window.GFR.pages || {};
  window.GFR.pages.configSms = {
    renderShell,
    bindShell,
    saveProviderRows,
    saveCheckedPrices,
    saveSelectionRows,
    setActiveSmsTab,
    rerenderLocale,
  };
})();
