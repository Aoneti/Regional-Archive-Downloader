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

function suppressLastError() {
  void chrome.runtime.lastError;
}

chrome.runtime.onMessage.addListener((msg, _sender) => {
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
        }
        void downloadId;
      }
    );
    return;
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