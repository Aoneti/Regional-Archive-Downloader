const ICONS_ACTIVE = {
  '16':  'icons/icon16.png',
  '32':  'icons/icon32.png',
  '48':  'icons/icon48.png',
  '128': 'icons/icon128.png'
};

const ICONS_INACTIVE = {
  '16':  'icons/icon16_inactive.png',
  '32':  'icons/icon32_inactive.png',
  '48':  'icons/icon48_inactive.png',
  '128': 'icons/icon128_inactive.png'
};


const PENDING_DOWNLOAD_TTL_MS = 2 * 60 * 60 * 1000;
const pendingDownloads = new Map(); // downloadId → { tabId, savedAt }

function suppressLastError() { void chrome.runtime.lastError; }

// ── Периодическая очистка устаревших записей ──────────────────────────────────

function sweepPendingDownloads() {
  const now = Date.now();
  for (const [id, entry] of pendingDownloads) {
    if (now - entry.savedAt > PENDING_DOWNLOAD_TTL_MS) {
      pendingDownloads.delete(id);
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.get('sweepPendingDownloads', existing => {
    if (!existing) {
      chrome.alarms.create('sweepPendingDownloads', { periodInMinutes: 30 });
    }
  });
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'sweepPendingDownloads') sweepPendingDownloads();
});

// ── Бейдж на иконке ───────────────────────────────────────────────────────────

function setBadge(text, color) {
  chrome.action.setBadgeText({ text: text ? String(text) : '' }, suppressLastError);
  if (text) chrome.action.setBadgeBackgroundColor({ color: color || '#7FBE00' }, suppressLastError);
}

// ── Уведомления ───────────────────────────────────────────────────────────────

function showNotification(title, message) {
  const notifId = 'rad_done_' + (crypto.randomUUID?.() ?? Date.now());
  chrome.notifications.create(notifId, {
    type: 'basic', iconUrl: 'icons/icon128.png',
    title, message, priority: 1
  }, suppressLastError);
}

// ── Обработчик сообщений ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'DOWNLOAD') {
    chrome.downloads.download(
      { url: msg.url, filename: msg.filename, conflictAction: 'uniquify' },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          console.warn('[RAD] download error:', chrome.runtime.lastError.message);
          sendResponse({ downloadId: null, error: chrome.runtime.lastError.message });
          return;
        }
        if (downloadId != null && sender?.tab?.id != null) {
          pendingDownloads.set(downloadId, { tabId: sender.tab.id, savedAt: Date.now() });
        }
        sendResponse({ downloadId: downloadId ?? null });
      }
    );
    return true;
  }

  if (msg.type === 'SET_ICON') {
    const path = msg.state === 'active' ? ICONS_ACTIVE : ICONS_INACTIVE;
    chrome.action.setIcon({ path }, () => {
      if (chrome.runtime.lastError) console.warn('[RAD] setIcon error:', chrome.runtime.lastError.message);
    });
    if (msg.state !== 'active') setBadge('');
    return;
  }

  if (msg.type === 'STATUS' || msg.type === 'PROGRESS' || msg.type === 'DONE') {
    chrome.runtime.sendMessage(msg, suppressLastError);

    if (msg.type === 'PROGRESS' && msg.percent != null) {
      const pct = Math.round(msg.percent);
      setBadge(pct > 0 && pct < 100 ? pct + '%' : '');
    }

    if (msg.type === 'DONE') {
      setBadge('');
      const text      = msg.text || '';
      const isStopped = /^Остановлено|^PDF: остановлено/i.test(text);
      const isError   = /^Ошибка|^PDF: ошибка/i.test(text);
      if (!isStopped && !isError && text) {
        showNotification(
          msg.isPDF ? 'PDF готов — RAD' : 'Загрузка завершена — RAD',
          text.replace(/^(Готово|PDF готов):\s*/i, '') || 'Готово'
        );
      } else if (isError) {
        showNotification('Ошибка — RAD', text.replace(/^(Ошибка|PDF: ошибка)[: ]*/i, ''));
      }
    }
    return;
  }
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state) return;
  const { current } = delta.state;
  if (current !== 'complete' && current !== 'interrupted') return;

  const entry = pendingDownloads.get(delta.id);
  if (entry == null) return;
  pendingDownloads.delete(delta.id);

  chrome.tabs.sendMessage(
    entry.tabId,
    { type: 'DOWNLOAD_DONE', downloadId: delta.id, success: current === 'complete' },
    suppressLastError
  );
});