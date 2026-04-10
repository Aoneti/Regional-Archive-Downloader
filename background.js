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

const pendingDownloads = new Map();

function suppressLastError() {
  void chrome.runtime.lastError;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'DOWNLOAD') {
    chrome.downloads.download(
      {
        url:            msg.url,
        filename:       msg.filename,
        conflictAction: 'uniquify'
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          console.warn('[YARchive] download error:', chrome.runtime.lastError.message);
          sendResponse({ downloadId: null, error: chrome.runtime.lastError.message });
          return;
        }
        if (downloadId != null && sender?.tab?.id != null) {
          pendingDownloads.set(downloadId, sender.tab.id);
        }
        sendResponse({ downloadId: downloadId ?? null });
      }
    );
    return true;
  }

  if (msg.type === 'SET_ICON') {
    const path = msg.state === 'active' ? ICONS_ACTIVE : ICONS_INACTIVE;
    chrome.action.setIcon({ path }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[YARchive] setIcon error:', chrome.runtime.lastError.message);
      }
    });
    return;
  }

  if (msg.type === 'STATUS' || msg.type === 'PROGRESS' || msg.type === 'DONE') {
    chrome.runtime.sendMessage(msg, suppressLastError);
    return;
  }
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state) return;
  const { current } = delta.state;
  if (current !== 'complete' && current !== 'interrupted') return;

  const tabId = pendingDownloads.get(delta.id);
  if (tabId == null) return;
  pendingDownloads.delete(delta.id);

  chrome.tabs.sendMessage(
    tabId,
    {
      type:       'DOWNLOAD_DONE',
      downloadId: delta.id,
      success:    current === 'complete'
    },
    suppressLastError
  );
});