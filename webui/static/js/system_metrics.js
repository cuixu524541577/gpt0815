// 左侧栏服务器资源指标。
(function () {
  window.GFR = window.GFR || {};

  const SUCCESS_INTERVAL_MS = 3000;
  const ERROR_INTERVAL_MS = 10000;
  let initialized = false;
  let timer = null;
  let inFlight = false;
  let lastSnapshot = null;
  let elements = null;

  function t(key, params, fallback) {
    return window.GFR.t?.(key, params, fallback) || fallback || key;
  }

  function clampPercent(value) {
    if (value == null || value === '' || typeof value === 'boolean') return null;
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.round(Math.max(0, Math.min(100, number)));
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return '--';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let scaled = bytes;
    let unitIndex = 0;
    while (scaled >= 1024 && unitIndex < units.length - 1) {
      scaled /= 1024;
      unitIndex += 1;
    }
    const digits = scaled >= 100 || unitIndex === 0 ? 0 : 1;
    return `${scaled.toFixed(digits)} ${units[unitIndex]}`;
  }

  let unavailText = '';

  function renderMetric(row, bar, value, rawPercent) {
    const percent = clampPercent(rawPercent);
    const track = row?.querySelector('.sidebar-metric-track');
    if (value) value.textContent = percent == null ? '--' : `${percent}%`;
    if (bar) bar.style.width = `${percent == null ? 0 : percent}%`;
    if (!track) return;
    if (percent == null) {
      track.removeAttribute('aria-valuenow');
      track.setAttribute('aria-valuetext', unavailText);
      return;
    }
    track.setAttribute('aria-valuenow', String(percent));
    track.setAttribute('aria-valuetext', `${percent}%`);
  }

  function render(snapshot) {
    if (!elements) return;
    const payload = snapshot && typeof snapshot === 'object' ? snapshot : {};
    unavailText = payload.reason
      ? String(payload.reason)
      : unavailText;
    const cpuPercent = payload.available ? payload.cpu_percent : null;
    const memoryPercent = payload.available ? payload.memory_percent : null;
    const diskPercent = payload.available ? payload.disk_percent : null;
    renderMetric(elements.cpuRow, elements.cpuBar, elements.cpuValue, cpuPercent);
    renderMetric(elements.memoryRow, elements.memoryBar, elements.memoryValue, memoryPercent);
    renderMetric(elements.diskRow, elements.diskBar, elements.diskValue, diskPercent);

    const used = Number(payload.memory_used_bytes);
    const total = Number(payload.memory_total_bytes);
    if (clampPercent(memoryPercent) != null && Number.isFinite(used) && Number.isFinite(total)) {
      elements.memoryRow.title = t('sidebar.memory_usage', {
        used: formatBytes(used),
        total: formatBytes(total),
      }, `${formatBytes(used)} / ${formatBytes(total)}`);
    } else {
      elements.memoryRow.title = unavailText;
    }
    const diskUsed = Number(payload.disk_used_bytes);
    const diskTotal = Number(payload.disk_total_bytes);
    if (clampPercent(diskPercent) != null && Number.isFinite(diskUsed) && Number.isFinite(diskTotal)) {
      elements.diskRow.title = t('sidebar.disk_usage', {
        used: formatBytes(diskUsed),
        total: formatBytes(diskTotal),
      }, `${formatBytes(diskUsed)} / ${formatBytes(diskTotal)}`);
    } else {
      elements.diskRow.title = unavailText;
    }
    elements.cpuRow.title = clampPercent(cpuPercent) == null
      ? unavailText
      : `${t('sidebar.cpu', null, 'CPU')} ${clampPercent(cpuPercent)}%`;
  }

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(delay) {
    clearTimer();
    if (document.hidden) return;
    timer = setTimeout(refresh, delay);
  }

  function publish(snapshot) {
    window.dispatchEvent(new CustomEvent('gfr:system-metrics', {
      detail: { snapshot: snapshot && typeof snapshot === 'object' ? snapshot : null },
    }));
  }

  function getSnapshot() {
    return lastSnapshot && typeof lastSnapshot === 'object' ? lastSnapshot : null;
  }

  async function refresh() {
    timer = null;
    if (document.hidden || inFlight) return;
    inFlight = true;
    let nextDelay = ERROR_INTERVAL_MS;
    try {
      const snapshot = await window.GFR.api('/api/system/metrics');
      lastSnapshot = snapshot;
      render(snapshot);
      publish(lastSnapshot);
      if (snapshot?.available) nextDelay = SUCCESS_INTERVAL_MS;
    } catch (_) {
      lastSnapshot = null;
      render(null);
      publish(null);
    } finally {
      inFlight = false;
      schedule(nextDelay);
    }
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      clearTimer();
      return;
    }
    schedule(0);
  }

  function init() {
    if (initialized) return;
    const root = document.getElementById('sidebarSystemMetrics');
    if (!root) return;
    elements = {
      root,
      cpuRow: document.getElementById('sidebarCpuMetric'),
      cpuBar: document.getElementById('sidebarCpuBar'),
      cpuValue: document.getElementById('sidebarCpuValue'),
      memoryRow: document.getElementById('sidebarMemoryMetric'),
      memoryBar: document.getElementById('sidebarMemoryBar'),
      memoryValue: document.getElementById('sidebarMemoryValue'),
      diskRow: document.getElementById('sidebarDiskMetric'),
      diskBar: document.getElementById('sidebarDiskBar'),
      diskValue: document.getElementById('sidebarDiskValue'),
    };
    initialized = true;
    document.addEventListener('visibilitychange', handleVisibilityChange);
    render(null);
    schedule(0);
  }

  function rerenderLocale() {
    render(lastSnapshot);
  }

  window.GFR.systemMetrics = {
    getSnapshot,
    init,
    rerenderLocale,
  };
})();
