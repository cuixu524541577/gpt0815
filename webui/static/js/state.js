// 全局状态与分页状态。
(function () {
  window.GFR = window.GFR || {};

  const pagerRenderers = {};
  const escAttr = (v) => String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  function pagerSizeSelectHtml(id, value, options) {
    if (window.GFR.customSelectHtml) {
      return window.GFR.customSelectHtml({
        id,
        value,
        options,
        className: 'pager-size-select',
        title: '每页显示条数',
        dataAttrs: { 'pager-id': id.replace(/^pagerSize-/, '') },
      });
    }
    const selected = options.find(opt => String(opt.value) === String(value)) || options[0] || { value: '', label: '-' };
    const optionHtml = options.map(opt => {
      const active = String(opt.value) === String(selected.value) ? ' active' : '';
      return `<button type="button" class="custom-select-option${active}" role="option" data-value="${escAttr(opt.value)}" aria-selected="${active ? 'true' : 'false'}">${escAttr(opt.label)}</button>`;
    }).join('');
    return `
      <div class="custom-select ui-control-shell pager-size-select-shell" id="${escAttr(id)}" data-value="${escAttr(selected.value)}" title="每页显示条数">
        <button type="button" class="ui-control pager-size-select custom-select-trigger" aria-haspopup="listbox" aria-expanded="false" aria-controls="${escAttr(id)}-menu">
          <span>${escAttr(selected.label)}</span>
          <i aria-hidden="true"></i>
        </button>
        <div class="custom-select-menu" role="listbox" id="${escAttr(id)}-menu">${optionHtml}</div>
      </div>`;
  }

  window.GFR.PAGERS = {
    jobs: { page: 1, size: 20 },
    accounts: { page: 1, size: 20 },
    outlook: { page: 1, size: 20 },
    apiOtpMail: { page: 1, size: 20 },
    codex: { page: 1, size: 20 },
  };

  window.GFR.registerPagerRenderer = function registerPagerRenderer(id, renderer) {
    pagerRenderers[id] = renderer;
  };

  window.GFR.renderPager = function renderPager(id, total) {
    const p = window.GFR.PAGERS[id];
    const totalPages = Math.max(1, Math.ceil(total / p.size));
    if (p.page > totalPages) p.page = Math.max(1, totalPages);
    const start = total > 0 ? (p.page - 1) * p.size + 1 : 0;
    const end = Math.min(p.page * p.size, total);
    const el = document.getElementById('pager-' + id);
    if (!el) return;
    const sizes = [20, 50, 100];
    const sizeControlId = `pagerSize-${id}`;
    const sizeOptions = sizes.map(s => ({ value: String(s), label: `${s} 条/页` }));
    const sizeControl = pagerSizeSelectHtml(sizeControlId, String(p.size), sizeOptions);
    el.innerHTML = `
      <button onclick="GFR.pagerGo('${id}',-1)"${p.page <= 1 ? ' disabled' : ''}>← 上一页</button>
      <span class="pager-info">${total > 0 ? `第 ${start}–${end} 条 / 共 ${total} 条（第 ${p.page} / ${totalPages} 页）` : '无数据'}</span>
      <button onclick="GFR.pagerGo('${id}',1)"${p.page >= totalPages ? ' disabled' : ''}>下一页 →</button>
      ${sizeControl}`;
    const sizeEl = document.getElementById(sizeControlId);
    sizeEl?.addEventListener('change', () => {
      const next = window.GFR.controlValue ? window.GFR.controlValue(sizeEl) : sizeEl.value;
      window.GFR.pagerSetSize(id, next);
    });
  };

  window.GFR.applyPagination = function applyPagination(id, pagination) {
    if (!pagination) return;
    const p = window.GFR.PAGERS[id];
    p.page = parseInt(pagination.page, 10) || 1;
    p.size = parseInt(pagination.page_size, 10) || p.size || 20;
  };

  window.GFR.pagerGo = function pagerGo(id, dir) {
    window.GFR.PAGERS[id].page = Math.max(1, window.GFR.PAGERS[id].page + dir);
    pagerRenderers[id]?.();
  };

  window.GFR.pagerSetSize = function pagerSetSize(id, val) {
    window.GFR.PAGERS[id].size = parseInt(val, 10) || 20;
    window.GFR.PAGERS[id].page = 1;
    pagerRenderers[id]?.();
  };
})();
