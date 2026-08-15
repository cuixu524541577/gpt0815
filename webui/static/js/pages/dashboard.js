// 概览页逻辑。
(function () {
const { $, api } = window.GFR;
const SUMMARY_INTERVAL_MS = 10000;
let initialized = false;
let summaryTimer = null;
let summaryRequest = null;

// ---------- 概览 ----------
async function loadSummary() {
  if (summaryRequest) return summaryRequest;
  summaryRequest = (async () => {
    try {
      const s = await api('/api/summary');
      $('#statAccounts').textContent = s.accounts;
      $('#statOutlook').textContent = s.outlook_total;
      $('#statAvailable').textContent = s.outlook_available;
      $('#statUsed').textContent = s.outlook_used;
      $('#statFailed').textContent = s.outlook_failed;
    } catch(e) {}
  })();
  try {
    return await summaryRequest;
  } finally {
    summaryRequest = null;
  }
}

function clearSummaryTimer() {
  if (summaryTimer !== null) {
    clearTimeout(summaryTimer);
    summaryTimer = null;
  }
}

function scheduleSummary(delay) {
  clearSummaryTimer();
  if (document.hidden) return;
  summaryTimer = setTimeout(refreshSummary, delay);
}

async function refreshSummary() {
  summaryTimer = null;
  if (document.hidden) return;
  await loadSummary();
  scheduleSummary(SUMMARY_INTERVAL_MS);
}

function handleVisibilityChange() {
  clearSummaryTimer();
  if (!document.hidden) scheduleSummary(0);
}

function init() {
  if (initialized) return;
  initialized = true;
  document.addEventListener('visibilitychange', handleVisibilityChange);
  scheduleSummary(0);
}

window.GFR.pages = window.GFR.pages || {};
window.GFR.pages.dashboard = { init, loadSummary };
})();
