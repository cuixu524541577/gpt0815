// 新手指引引擎：本地轻量实现 Driver.js 风格遮罩/高亮，不依赖外网 CDN。
(function () {
  window.GFR = window.GFR || {};

  const STORAGE_DONE = 'gfr.guide.done.v1';
  const STORAGE_AUTOPROMPT = 'gfr.guide.autoprompt.v1';
  const STORAGE_STEP = 'gfr.guide.lastStep.v1';
  const WAIT_TIMEOUT_MS = 2600;

  const state = {
    active: false,
    index: 0,
    groupId: 'overview',
    groupTitle: '新手指引',
    steps: [],
    pendingTimer: null,
    resizeHandler: null,
    scrollHandler: null,
    configRenderHandler: null,
    keyHandler: null,
    rerenderTimer: null,
    repositionTimer: null,
    renderSeq: 0,
    currentTarget: null,
    currentStep: null,
  };

  function $(selector) { return document.querySelector(selector); }
  function $$(selector) { return Array.from(document.querySelectorAll(selector)); }

  function nextFrame() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function guideApi() {
    window.GFR.guide = window.GFR.guide || {};
    return window.GFR.guide;
  }

  function setConfigTab(tab) {
    if (!tab) return;
    localStorage.setItem('gfr.activeConfigTab', tab);
  }

  function setSmsTab(tab) {
    if (!tab) return;
    localStorage.setItem('gfr.activeSmsTab', tab);
  }

  function switchSmsTab(tab) {
    if (!tab) return false;
    setSmsTab(tab);
    if (window.GFR.pages?.configSms?.setActiveSmsTab) {
      return window.GFR.pages.configSms.setActiveSmsTab(tab);
    }
    const buttons = $$('[data-sms-tab]');
    const panels = $$('[data-sms-panel]');
    if (!buttons.length || !panels.length) return false;
    buttons.forEach(btn => btn.classList.toggle('active', btn.dataset.smsTab === tab));
    panels.forEach(panel => panel.classList.toggle('hidden', panel.dataset.smsPanel !== tab));
    window.GFR.route?.write?.('config');
    window.dispatchEvent(new CustomEvent('gfr:config-rendered', { detail: { tab: 'sms', smsTab: tab, switched: true } }));
    return true;
  }

  function switchRegisterTab(tab) {
    if (!tab) return false;
    const next = tab === 'jobs' ? 'jobs' : 'logs';
    if (window.GFR.pages?.register?.setRegisterTab) {
      window.GFR.pages.register.setRegisterTab(next);
      window.dispatchEvent(new CustomEvent('gfr:register-tab-rendered', { detail: { tab: next } }));
      return true;
    }
    const buttons = $$('[data-register-tab]');
    const panels = $$('[data-register-panel]');
    if (!buttons.length || !panels.length) return false;
    buttons.forEach(btn => btn.classList.toggle('active', btn.dataset.registerTab === next));
    panels.forEach(panel => panel.classList.toggle('hidden', panel.dataset.registerPanel !== next));
    if (next === 'jobs') window.GFR.pages?.register?.refreshJobs?.();
    if (next === 'logs') window.GFR.pages?.register?.refreshLogs?.({ force: true });
    window.dispatchEvent(new CustomEvent('gfr:register-tab-rendered', { detail: { tab: next } }));
    return true;
  }

  function switchPoolTab(tab) {
    if (!tab) return false;
    if (window.GFR.pages?.emailPool?.setActivePoolTab) {
      window.GFR.pages.emailPool.setActivePoolTab(tab);
      window.GFR.pages.emailPool.loadActivePool?.();
      window.dispatchEvent(new CustomEvent('gfr:email-pool-tab-rendered', { detail: { tab } }));
      return true;
    }
    const next = tab === 'api-otp-mail' ? 'api-otp-mail' : 'outlook';
    const buttons = $$('[data-pool-tab]');
    const panels = $$('[data-pool-panel]');
    if (!buttons.length || !panels.length) return false;
    buttons.forEach(btn => btn.classList.toggle('active', btn.dataset.poolTab === next));
    panels.forEach(panel => panel.classList.toggle('hidden', panel.dataset.poolPanel !== next));
    window.dispatchEvent(new CustomEvent('gfr:email-pool-tab-rendered', { detail: { tab: next } }));
    return true;
  }

  function isUsableTarget(target) {
    if (!target || !target.isConnected) return false;
    if (target.closest('.hidden,[hidden]')) return false;
    const style = window.getComputedStyle(target);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = target.getBoundingClientRect();
    return rect.width >= 8 && rect.height >= 8;
  }

  function findTarget(selector) {
    if (!selector) return null;
    return $$(selector).find(isUsableTarget) || null;
  }

  function activateStepContext(step) {
    if (!step) return;
    const prevConfigTab = localStorage.getItem('gfr.activeConfigTab') || '';
    if (step.configTab) setConfigTab(step.configTab);
    if (step.smsTab) setSmsTab(step.smsTab);
    let switchedMainTab = false;
    if (step.tab && window.GFR.activeTab !== step.tab) {
      window.GFR.setActiveTab?.(step.tab, { reason: 'guide' });
      switchedMainTab = true;
    }

    if (step.tab === 'config' && step.configTab) {
      if (window.GFR.pages?.config?.setActiveConfigTab) {
        window.GFR.pages.config.setActiveConfigTab(step.configTab, { reason: 'guide', reload: !switchedMainTab });
      } else {
        const panel = document.querySelector(`[data-config-panel="${step.configTab}"]`);
        const needsRender = !switchedMainTab && (prevConfigTab !== step.configTab || !panel || panel.classList.contains('hidden'));
        if (needsRender) window.GFR.pages?.config?.loadConfig?.();
      }
    }
    if (step.tab === 'config' && step.configTab === 'sms' && step.smsTab) {
      switchSmsTab(step.smsTab);
    }
    if (step.tab === 'register' && step.registerTab) {
      switchRegisterTab(step.registerTab);
    }
    if (step.tab === 'outlook' && step.poolTab) {
      switchPoolTab(step.poolTab);
    }
  }

  function waitForElement(selector, timeout = WAIT_TIMEOUT_MS) {
    const started = performance.now();
    return new Promise((resolve) => {
      const tick = () => {
        const target = selector ? findTarget(selector) : null;
        if (target) {
          resolve(target);
          return;
        }
        if (performance.now() - started > timeout) {
          resolve(null);
          return;
        }
        state.pendingTimer = setTimeout(tick, 80);
      };
      tick();
    });
  }

  function ensureLayer() {
    let layer = $('#guideLayer');
    if (layer) return layer;
    layer = document.createElement('div');
    layer.id = 'guideLayer';
    layer.className = 'guide-layer';
    layer.innerHTML = `
      <div class="guide-scrim"></div>
      <div class="guide-spotlight" aria-hidden="true"></div>
      <section class="guide-popover" role="dialog" aria-modal="true" aria-labelledby="guideTitle">
        <div class="guide-kicker"><span class="guide-kicker-dot"></span><span id="guideProgress">新手指引</span></div>
        <h3 id="guideTitle"></h3>
        <p id="guideText"></p>
        <div class="guide-actions">
          <button type="button" class="btn guide-skip" data-guide-action="skip">跳过</button>
          <button type="button" class="btn" data-guide-action="prev">上一步</button>
          <button type="button" class="btn primary" data-guide-action="next">下一步</button>
        </div>
      </section>`;
    document.body.appendChild(layer);
    layer.addEventListener('click', (event) => {
      const action = event.target.closest('[data-guide-action]')?.dataset.guideAction;
      if (!action) return;
      if (action === 'skip') finishGuide(false);
      if (action === 'prev') previousStep();
      if (action === 'next') nextStep();
    });
    return layer;
  }

  function groupById(id) {
    const groups = Array.isArray(window.GFR.guideGroups) ? window.GFR.guideGroups : [];
    return groups.find(group => group.id === id) || groups[0] || {
      id: 'overview',
      title: '快速总览',
      steps: window.GFR.guideSteps || [],
    };
  }

  function ensurePicker() {
    let picker = $('#guidePicker');
    if (picker) return picker;
    picker = document.createElement('div');
    picker.id = 'guidePicker';
    picker.className = 'guide-picker-layer';
    picker.innerHTML = `
      <div class="guide-picker-scrim" data-guide-picker-close="1"></div>
      <section class="guide-picker-card" role="dialog" aria-modal="true" aria-labelledby="guidePickerTitle">
        <div class="guide-picker-head">
          <div>
            <span class="guide-picker-kicker">Guide Center</span>
            <h3 id="guidePickerTitle">选择新手指引</h3>
            <p>按当前要做的任务选择一套指引。每套指引都会自动切换到对应页面和配置分类。</p>
          </div>
          <button type="button" class="guide-picker-close" data-guide-picker-close="1" aria-label="关闭">×</button>
        </div>
        <div class="guide-picker-grid" id="guidePickerGrid"></div>
      </section>`;
    document.body.appendChild(picker);
    picker.addEventListener('click', (event) => {
      if (event.target.closest('[data-guide-picker-close]')) {
        hidePicker();
        return;
      }
      const btn = event.target.closest('[data-guide-group]');
      if (!btn) return;
      hidePicker();
      startGuide({ groupId: btn.dataset.guideGroup, index: 0 });
    });
    return picker;
  }

  function showPicker() {
    const picker = ensurePicker();
    const grid = picker.querySelector('#guidePickerGrid');
    const groups = Array.isArray(window.GFR.guideGroups) ? window.GFR.guideGroups : [];
    grid.innerHTML = groups.map(group => `
      <button type="button" class="guide-picker-item" data-guide-group="${esc(group.id)}">
        <span class="guide-picker-badge">${esc(group.badge || `${group.steps?.length || 0} 步`)}</span>
        <strong>${esc(group.title || '新手指引')}</strong>
        <small>${esc(group.desc || '')}</small>
      </button>`).join('');
    picker.classList.add('show');
  }

  function hidePicker() {
    $('#guidePicker')?.classList.remove('show');
  }

  function showLayer() {
    ensureLayer().classList.add('show');
    document.body.classList.add('guide-running');
  }

  function hideLayer() {
    $('#guideLayer')?.classList.remove('show');
    document.body.classList.remove('guide-running');
  }

  function positionPopover(layer, rect, side) {
    const popover = layer.querySelector('.guide-popover');
    const margin = 18;
    const width = Math.min(380, window.innerWidth - margin * 2);
    popover.style.width = `${width}px`;

    const popRect = popover.getBoundingClientRect();
    let top;
    let left;
    const preferred = side || 'bottom';

    if (preferred === 'right') {
      top = rect.top + rect.height / 2 - popRect.height / 2;
      left = rect.right + margin;
    } else if (preferred === 'left') {
      top = rect.top + rect.height / 2 - popRect.height / 2;
      left = rect.left - width - margin;
    } else if (preferred === 'top') {
      top = rect.top - popRect.height - margin;
      left = rect.left + rect.width / 2 - width / 2;
    } else {
      top = rect.bottom + margin;
      left = rect.left + rect.width / 2 - width / 2;
    }

    if (left + width > window.innerWidth - margin) left = window.innerWidth - width - margin;
    if (left < margin) left = margin;
    if (top + popRect.height > window.innerHeight - margin) top = rect.top - popRect.height - margin;
    if (top < margin) top = margin;

    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  }

  function applySpotlight(layer, target, step) {
    const rect = target.getBoundingClientRect();
    if (!rect || rect.width < 8 || rect.height < 8) return false;
    const pad = Number(step.padding ?? 8);
    const left = clamp(rect.left - pad, 8, window.innerWidth - 24);
    const top = clamp(rect.top - pad, 8, window.innerHeight - 24);
    const right = clamp(rect.right + pad, 24, window.innerWidth - 8);
    const bottom = clamp(rect.bottom + pad, 24, window.innerHeight - 8);
    const spot = layer.querySelector('.guide-spotlight');
    spot.style.left = `${Math.round(left)}px`;
    spot.style.top = `${Math.round(top)}px`;
    spot.style.width = `${Math.round(Math.max(32, right - left))}px`;
    spot.style.height = `${Math.round(Math.max(32, bottom - top))}px`;
    positionPopover(layer, { left, top, right, bottom, width: right - left, height: bottom - top }, step.side);
    return true;
  }

  function scheduleRender(delay = 80) {
    if (!state.active) return;
    clearTimeout(state.rerenderTimer);
    state.rerenderTimer = setTimeout(renderCurrentStep, delay);
  }

  function scheduleReposition(delay = 50) {
    if (!state.active) return;
    clearTimeout(state.repositionTimer);
    state.repositionTimer = setTimeout(() => {
      if (!state.active || !state.currentTarget || !state.currentStep) return;
      if (!isUsableTarget(state.currentTarget)) {
        scheduleRender();
        return;
      }
      applySpotlight(ensureLayer(), state.currentTarget, state.currentStep);
    }, delay);
  }

  async function renderCurrentStep() {
    if (!state.active) return;
    const renderSeq = ++state.renderSeq;
    clearTimeout(state.pendingTimer);
    clearTimeout(state.repositionTimer);
    const step = state.steps[state.index];
    if (!step) {
      finishGuide(true);
      return;
    }

    activateStepContext(step);
    const target = await waitForElement(step.selector);
    if (!state.active || renderSeq !== state.renderSeq) return;
    if (!target) {
      // 页面状态不满足时自动跳过，避免新手指引卡死。
      if (state.index < state.steps.length - 1) {
        state.index += 1;
        renderCurrentStep();
      } else {
        finishGuide(true);
      }
      return;
    }

    target.scrollIntoView({ behavior: 'auto', block: step.block || 'center', inline: 'nearest' });
    await nextFrame();
    await nextFrame();
    if (!state.active || renderSeq !== state.renderSeq || !isUsableTarget(target)) return;

    const layer = ensureLayer();
    layer.querySelector('#guideTitle').textContent = step.title || '新手指引';
    layer.querySelector('#guideText').textContent = step.text || '';
    layer.querySelector('#guideProgress').textContent = `${state.groupTitle || '新手指引'} ${state.index + 1} / ${state.steps.length}`;
    const prev = layer.querySelector('[data-guide-action="prev"]');
    const next = layer.querySelector('[data-guide-action="next"]');
    prev.disabled = state.index === 0;
    next.textContent = state.index === state.steps.length - 1 ? '完成' : '下一步';
    showLayer();
    state.currentTarget = target;
    state.currentStep = step;
    if (!applySpotlight(layer, target, step)) {
      scheduleRender(120);
      return;
    }
    localStorage.setItem(STORAGE_STEP, String(state.index));
  }

  function startGuide(options = {}) {
    const group = options.groupId ? groupById(options.groupId) : null;
    const steps = Array.isArray(options.steps)
      ? options.steps
      : (group?.steps || window.GFR.guideSteps || []);
    if (!steps.length) return;
    state.active = true;
    state.groupId = group?.id || options.groupId || 'overview';
    state.groupTitle = group?.title || '新手指引';
    state.steps = steps;
    state.index = clamp(Number(options.index ?? 0), 0, steps.length - 1);

    if (!state.resizeHandler) {
      state.resizeHandler = () => scheduleReposition(60);
      window.addEventListener('resize', state.resizeHandler);
    }
    if (!state.scrollHandler) {
      state.scrollHandler = () => scheduleReposition(60);
      window.addEventListener('scroll', state.scrollHandler, true);
    }
    if (!state.configRenderHandler) {
      state.configRenderHandler = () => scheduleRender(70);
      window.addEventListener('gfr:config-rendered', state.configRenderHandler);
      window.addEventListener('gfr:register-tab-rendered', state.configRenderHandler);
      window.addEventListener('gfr:email-pool-tab-rendered', state.configRenderHandler);
    }
    if (!state.keyHandler) {
      state.keyHandler = (event) => {
        if (!state.active) return;
        if (event.key === 'Escape') finishGuide(false);
        if (event.key === 'ArrowRight') nextStep();
        if (event.key === 'ArrowLeft') previousStep();
      };
      document.addEventListener('keydown', state.keyHandler);
    }
    renderCurrentStep();
  }

  function nextStep() {
    if (!state.active) return;
    if (state.index >= state.steps.length - 1) {
      finishGuide(true);
      return;
    }
    state.index += 1;
    renderCurrentStep();
  }

  function previousStep() {
    if (!state.active || state.index <= 0) return;
    state.index -= 1;
    renderCurrentStep();
  }

  function finishGuide(completed) {
    clearTimeout(state.pendingTimer);
    clearTimeout(state.rerenderTimer);
    clearTimeout(state.repositionTimer);
    hideLayer();
    state.active = false;
    state.currentTarget = null;
    state.currentStep = null;
    localStorage.setItem(STORAGE_AUTOPROMPT, '1');
    if (completed) {
      localStorage.setItem(STORAGE_DONE, '1');
      localStorage.removeItem(STORAGE_STEP);
      window.GFR.showToast?.(`${state.groupTitle || '新手指引'}已完成，可从左下角重新打开。`, 'success');
    } else {
      window.GFR.showToast?.('已跳过新手指引，可从左下角重新打开。', 'info');
    }
  }

  function resetGuide(groupId = '') {
    localStorage.removeItem(STORAGE_DONE);
    localStorage.removeItem(STORAGE_AUTOPROMPT);
    localStorage.removeItem(STORAGE_STEP);
    if (groupId) startGuide({ groupId, index: 0 });
    else showPicker();
  }

  function maybeAutoPrompt() {
    if (localStorage.getItem(STORAGE_DONE) === '1') return;
    if (localStorage.getItem(STORAGE_AUTOPROMPT) === '1') return;
    setTimeout(async () => {
      if (localStorage.getItem(STORAGE_DONE) === '1' || localStorage.getItem(STORAGE_AUTOPROMPT) === '1') return;
      const ok = await window.GFR.confirmDialog?.({
        tone: 'info',
        icon: '?',
        title: '开启新手指引？',
        message: '第一次使用建议先选择一套指引：邮箱注册、手机号注册、Codex 授权或运行配置。也可以稍后从左下角重新打开。',
        confirmText: '选择指引',
        cancelText: '暂不需要',
      });
      localStorage.setItem(STORAGE_AUTOPROMPT, '1');
      if (ok) showPicker();
    }, 900);
  }

  Object.assign(guideApi(), {
    start: startGuide,
    reset: resetGuide,
    choose: showPicker,
    next: nextStep,
    previous: previousStep,
    finish: finishGuide,
    maybeAutoPrompt,
    isDone: () => localStorage.getItem(STORAGE_DONE) === '1',
  });
})();
