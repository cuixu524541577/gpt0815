// 通用 UI 工具。
(function () {
  window.GFR = window.GFR || {};

  let copySeq = 0;
  const copyStore = new Map();

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  function fmt(v) { return v == null || v === '' ? '-' : String(v); }
  function esc(v) { return fmt(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function escRaw(v) { return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function htmlLines(v) { return esc(v).replace(/\n/g, '<br>'); }
  function short(v, n = 40) { const s = v || ''; return s.length > n ? s.slice(0, n) + '…' : s; }
  function middleShort(v, head = 12, tail = 6) {
    const s = v || '';
    return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
  }
  function pad2(v) { return String(v).padStart(2, '0'); }
  const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';
  const shanghaiDateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  function shanghaiDateParts(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const values = {};
    shanghaiDateTimeFormatter.formatToParts(date).forEach(part => {
      if (part.type !== 'literal') values[part.type] = part.value;
    });
    if (!values.year || !values.month || !values.day) return null;
    return {
      year: values.year,
      month: values.month,
      day: values.day,
      hour: values.hour || '00',
      minute: values.minute || '00',
      second: values.second || '00',
    };
  }

  function formatShanghaiDate(value = new Date()) {
    const s = typeof value === 'string' ? value.trim() : '';
    const naive = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?!.*(?:Z|[+-]\d{2}:?\d{2})$)/i);
    if (naive) return `${naive[1]}-${pad2(naive[2])}-${pad2(naive[3])}`;
    const parts = shanghaiDateParts(value);
    return parts ? `${parts.year}-${parts.month}-${parts.day}` : '';
  }

  function formatDateTime(value) {
    if (value == null || value === '') return '-';
    if (value instanceof Date) {
      const parts = shanghaiDateParts(value);
      return parts ? `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}` : '-';
    }
    const s = String(value).trim();
    if (!s || s === '-') return '-';
    if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
      const parts = shanghaiDateParts(s);
      return parts ? `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}` : s;
    }
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.\d+)?)?)?/);
    if (m) return `${pad2(m[2])}-${pad2(m[3])} ${pad2(m[4] || '0')}:${pad2(m[5] || '0')}:${pad2(m[6] || '0')}`;
    m = s.match(/^(\d{1,2})-(\d{1,2})(?:[T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.\d+)?)?)?/);
    if (m) return `${pad2(m[1])}-${pad2(m[2])} ${pad2(m[3] || '0')}:${pad2(m[4] || '0')}:${pad2(m[5] || '0')}`;
    return s;
  }

  function normalizeTone(tone) {
    const t = String(tone || 'info').toLowerCase();
    if (['ok', 'good', 'success', 'succeed', 'done'].includes(t)) return 'success';
    if (['warn', 'warning', 'caution'].includes(t)) return 'warning';
    if (['err', 'error', 'danger', 'fail', 'failed'].includes(t)) return 'error';
    return 'info';
  }

  function inferTone(message, tone) {
    if (tone) return normalizeTone(tone);
    const s = String(message || '');
    if (/失败|错误|异常|Error|Exception|Failed|fail|denied|invalid/i.test(s)) return 'error';
    if (/警告|注意|取消|等待|重试|没有|为空|需重启|warning/i.test(s)) return 'warning';
    if (/成功|已保存|已提交|已复制|已删除|已恢复|已重置|已生效|OK|完成/i.test(s)) return 'success';
    return 'info';
  }

  const toneMeta = {
    info: { title: '提示', icon: 'i' },
    success: { title: '成功', icon: '✓' },
    warning: { title: '警告', icon: '!' },
    error: { title: '错误', icon: '×' },
  };

  function ensureToastHost() {
    let host = $('#toast');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toast';
      document.body.appendChild(host);
    }
    host.classList.add('toast-host');
    host.setAttribute('aria-live', 'polite');
    host.setAttribute('aria-atomic', 'false');
    return host;
  }

  function showToast(message, tone, opts = {}) {
    const level = inferTone(message, tone);
    const meta = toneMeta[level] || toneMeta.info;
    const host = ensureToastHost();
    const item = document.createElement('div');
    item.className = `toast-item toast-${level}`;
    item.setAttribute('role', level === 'error' ? 'alert' : 'status');
    item.innerHTML = `
      <div class="toast-icon">${esc(meta.icon)}</div>
      <div class="toast-content">
        <div class="toast-title">${esc(opts.title || meta.title)}</div>
        <div class="toast-message">${htmlLines(message)}</div>
      </div>
      <button type="button" class="toast-close" aria-label="关闭">×</button>`;
    host.prepend(item);
    const close = () => {
      item.classList.remove('show');
      item.classList.add('closing');
      setTimeout(() => item.remove(), 180);
    };
    item.querySelector('.toast-close').addEventListener('click', close);
    requestAnimationFrame(() => item.classList.add('show'));
    setTimeout(close, opts.duration || (level === 'error' ? 5200 : 3200));
  }

  function noticeHtml(tone, message, title = '') {
    const level = normalizeTone(tone);
    const meta = toneMeta[level] || toneMeta.info;
    return `<div class="banner ui-notice ${level}"><span class="notice-icon">${esc(meta.icon)}</span><div><strong>${esc(title || meta.title)}</strong><p>${htmlLines(message)}</p></div></div>`;
  }

  function customSelectHtml(opts = {}) {
    const options = Array.isArray(opts.options) ? opts.options : [];
    const current = String(opts.value ?? '');
    const selected = options.find(opt => String(opt.value ?? '') === current) || options[0] || { value: '', label: '-' };
    const selectedValue = String(selected.value ?? '');
    const selectedLabel = String(selected.label ?? selectedValue);
    const idAttr = opts.id ? ` id="${escRaw(opts.id)}"` : '';
    const keyAttr = opts.key ? ` data-key="${escRaw(opts.key)}"` : '';
    const titleAttr = opts.title ? ` title="${escRaw(opts.title)}"` : '';
    const dataAttrs = opts.dataAttrs && typeof opts.dataAttrs === 'object'
      ? Object.entries(opts.dataAttrs).map(([k, v]) => ` data-${escRaw(k)}="${escRaw(v)}"`).join('')
      : '';
    const cls = `ui-control${opts.className ? ` ${escRaw(opts.className)}` : ''}`;
    const shellClass = [
      'custom-select',
      'ui-control-shell',
      opts.shellClassName || '',
      opts.className ? `${opts.className}-shell` : '',
    ].filter(Boolean).map(escRaw).join(' ');
    const listId = opts.id ? `${opts.id}-menu` : '';
    const menuIdAttr = listId ? ` id="${escRaw(listId)}"` : '';
    const ariaControls = listId ? ` aria-controls="${escRaw(listId)}"` : '';
    const optionHtml = options.map(opt => {
      const optValue = String(opt.value ?? '');
      const optLabel = String(opt.label ?? optValue);
      const active = selectedValue === optValue ? ' active' : '';
      return `<button type="button" class="custom-select-option${active}" role="option" data-value="${escRaw(optValue)}" aria-selected="${selectedValue === optValue ? 'true' : 'false'}">${esc(optLabel)}</button>`;
    }).join('');
    return `
      <div class="${shellClass}"${idAttr}${keyAttr}${titleAttr}${dataAttrs} data-value="${escRaw(selectedValue)}">
        <button type="button" class="${cls} custom-select-trigger" aria-haspopup="listbox" aria-expanded="false"${ariaControls}>
          <span>${esc(selectedLabel)}</span>
          <i aria-hidden="true"></i>
        </button>
        <div class="custom-select-menu" role="listbox"${menuIdAttr}>${optionHtml}</div>
      </div>`;
  }

  function controlValue(target) {
    const el = typeof target === 'string' ? $(target) : target;
    if (!el) return '';
    if (el.classList?.contains('custom-select')) return el.dataset.value ?? '';
    return el.dataset?.value ?? el.value ?? '';
  }

  function setControlValue(target, value) {
    const el = typeof target === 'string' ? $(target) : target;
    if (!el) return;
    const next = String(value ?? '');
    if (!el.classList?.contains('custom-select')) {
      if ('value' in el) el.value = next;
      else el.dataset.value = next;
      return;
    }
    el.dataset.value = next;
    const option = Array.from(el.querySelectorAll('.custom-select-option')).find(item => (item.dataset.value || '') === next);
    if (option) {
      el.querySelector('.custom-select-trigger span').textContent = option.textContent;
      el.querySelectorAll('.custom-select-option').forEach(item => {
        const active = item === option;
        item.classList.toggle('active', active);
        item.setAttribute('aria-selected', active ? 'true' : 'false');
      });
    }
  }

  function controlHtml(opts = {}) {
    const key = opts.key || '';
    const type = opts.type || 'str';
    const value = opts.value;
    const dataKey = `data-key="${escRaw(key)}"`;
    const cls = `ui-control${opts.className ? ` ${escRaw(opts.className)}` : ''}`;
    const placeholder = opts.placeholder ? ` placeholder="${escRaw(opts.placeholder)}"` : '';
    const rows = opts.rows ? ` rows="${escRaw(opts.rows)}"` : '';
    const min = opts.min !== undefined ? ` min="${escRaw(opts.min)}"` : '';
    const max = opts.max !== undefined ? ` max="${escRaw(opts.max)}"` : '';
    if (Array.isArray(opts.options) && opts.options.length) {
      return customSelectHtml({
        key,
        value,
        options: opts.options,
        className: opts.className,
      });
    }
    if (type === 'bool') {
      const current = value ? 'true' : 'false';
      return customSelectHtml({
        key,
        value: current,
        options: [
          { value: 'true', label: '开启 (True)' },
          { value: 'false', label: '关闭 (False)' },
        ],
        className: opts.className,
      });
    }
    if (type === 'int') return `<input class="${cls}" type="number" ${dataKey}${placeholder}${min}${max} value="${escRaw(value)}">`;
    if (type === 'date') return `<input class="${cls}" type="date" ${dataKey}${placeholder} value="${escRaw(value || '')}">`;
    if (type === 'list_str_multiline') return `<textarea class="${cls}" ${dataKey}${placeholder}${rows}>${escRaw((value || []).join('\n'))}</textarea>`;
    if (opts.secret) return `<input class="${cls}" type="password" autocomplete="off" ${dataKey}${placeholder} value="${escRaw(value || '')}">`;
    return `<input class="${cls}" type="text" ${dataKey}${placeholder} value="${escRaw(value)}">`;
  }

  function closeCustomSelects(except) {
    $$('.custom-select.open').forEach(select => {
      if (select === except) return;
      select.classList.remove('open');
      select.querySelector('.custom-select-trigger')?.setAttribute('aria-expanded', 'false');
    });
  }

  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('.custom-select-trigger');
    if (trigger) {
      const select = trigger.closest('.custom-select');
      const willOpen = !select.classList.contains('open');
      closeCustomSelects(select);
      select.classList.toggle('open', willOpen);
      trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      if (willOpen) {
        const active = select.querySelector('.custom-select-option.active') || select.querySelector('.custom-select-option');
        setTimeout(() => active?.focus?.(), 0);
      }
      return;
    }

    const option = e.target.closest('.custom-select-option');
    if (option) {
      const select = option.closest('.custom-select');
      const value = option.dataset.value || '';
      setControlValue(select, value);
      closeCustomSelects();
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    if (!e.target.closest('.custom-select')) closeCustomSelects();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const open = document.querySelector('.custom-select.open');
      closeCustomSelects();
      open?.querySelector('.custom-select-trigger')?.focus?.();
      return;
    }

    const trigger = e.target.closest?.('.custom-select-trigger');
    if (trigger && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown')) {
      e.preventDefault();
      trigger.click();
      return;
    }

    const option = e.target.closest?.('.custom-select-option');
    if (!option) return;
    const select = option.closest('.custom-select');
    const options = Array.from(select?.querySelectorAll('.custom-select-option') || []);
    const index = options.indexOf(option);
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      option.click();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      const next = options[(index + dir + options.length) % options.length];
      next?.focus?.();
    }
  });

  function ensureModalHost() {
    let host = $('#modalHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'modalHost';
      document.body.appendChild(host);
    }
    return host;
  }

  function confirmDialog(options) {
    const opts = typeof options === 'string' ? { message: options } : (options || {});
    const level = normalizeTone(opts.tone || 'warning');
    const meta = toneMeta[level] || toneMeta.warning;
    const host = ensureModalHost();
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = `modal-backdrop modal-${level}`;
      wrap.innerHTML = `
        <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="uiConfirmTitle">
          <div class="modal-mark">${esc(opts.icon || meta.icon)}</div>
          <div class="modal-main">
            <h3 id="uiConfirmTitle">${esc(opts.title || '请确认操作')}</h3>
            <div class="modal-message">${htmlLines(opts.message || '')}</div>
            <div class="modal-actions">
              <button type="button" class="btn modal-cancel">${esc(opts.cancelText || '取消')}</button>
              <button type="button" class="btn primary modal-confirm">${esc(opts.confirmText || '确认')}</button>
            </div>
          </div>
        </div>`;
      host.appendChild(wrap);
      const cleanup = (ok) => {
        document.removeEventListener('keydown', onKey);
        wrap.classList.remove('show');
        setTimeout(() => wrap.remove(), 160);
        resolve(ok);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') cleanup(false);
        if (e.key === 'Enter') cleanup(true);
      };
      wrap.addEventListener('click', (e) => { if (e.target === wrap) cleanup(false); });
      wrap.querySelector('.modal-cancel').addEventListener('click', () => cleanup(false));
      wrap.querySelector('.modal-confirm').addEventListener('click', () => cleanup(true));
      document.addEventListener('keydown', onKey);
      requestAnimationFrame(() => wrap.classList.add('show'));
      setTimeout(() => wrap.querySelector('.modal-confirm').focus(), 0);
    });
  }

  function copyId(v) { if (!v) return ''; const id = 'c' + (++copySeq); copyStore.set(id, v); return id; }
  function cbtn(label, value, cls = '') { const id = copyId(value); return `<button class="${cls}" data-copy-id="${id}" ${id ? '' : 'disabled'}>${label}</button>`; }
  function pill(status) {
    const map = { available: '可用', used: '已用', failed: '失败', pending: '排队', running: '运行中', success: '成功', cancelled: '已取消' };
    return `<span class="pill status-${esc(status)}">${esc(map[status] || status || '-')}</span>`;
  }

  async function copyText(text, successMessage = '已复制') {
    if (!text) return false;
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else {
        const a = document.createElement('textarea');
        a.value = text;
        a.style.position = 'fixed';
        a.style.opacity = '0';
        document.body.appendChild(a);
        a.select();
        document.execCommand('copy');
        a.remove();
      }
      showToast(successMessage, 'success');
      return true;
    } catch (e) {
      showToast('复制失败', 'error');
      return false;
    }
  }

  function renderLogEventText(item) {
    const event = item || {};
    if (!event.message_key) return String(event.line || '');
    const translated = window.GFR.t?.(event.message_key, event.message_params || {}, event.line || '') || event.line || '';
    const message = event.message_key === 'logs.raw' && event.raw_detail ? event.raw_detail : translated;
    const detail = event.raw_detail && event.message_key !== 'logs.raw' ? `\n${event.raw_detail}` : '';
    const level = String(event.level || 'INFO').toUpperCase();
    const thread = event.thread ? ` [${event.thread}]` : '';
    return `${event.time || '--:--:--'} [${level}]${thread} ${message}${detail}`;
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-copy-id]');
    if (!t) return;
    copyText(copyStore.get(t.dataset.copyId));
  });

  Object.assign(window.GFR, {
    $, $$, fmt, esc, escRaw, short, middleShort, formatDateTime, formatShanghaiDate,
    normalizeTone, noticeHtml, controlHtml, customSelectHtml, controlValue, setControlValue, confirmDialog,
    copyId, cbtn, pill, showToast, copyText, renderLogEventText,
  });
})();
