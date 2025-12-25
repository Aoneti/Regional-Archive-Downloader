// background.js

// default icon mapping (active)
const ICONS_ACTIVE = {
  "16": "icons/icon16.png",
  "32": "icons/icon32.png",
  "48": "icons/icon48.png",
  "128": "icons/icon128.png"
};

// inactive versions (you must provide these files)
const ICONS_INACTIVE = {
  "16": "icons/icon16_inactive.png",
  "32": "icons/icon32_inactive.png",
  "48": "icons/icon48_inactive.png",
  "128": "icons/icon128_inactive.png"
};

// handle download requests from content-script
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'DOWNLOAD') {
    chrome.downloads.download({
      url: msg.url,
      filename: msg.filename,
      conflictAction: 'uniquify'
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.warn('download error', chrome.runtime.lastError.message);
      }
    });
    return;
  }

  // set icon state
  if (msg.type === 'SET_ICON') {
    const state = msg.state === 'active' ? 'active' : 'inactive';
    const path = state === 'active' ? ICONS_ACTIVE : ICONS_INACTIVE;
    chrome.action.setIcon({ path }, () => {
      if (chrome.runtime.lastError) {
        console.warn('setIcon error', chrome.runtime.lastError.message);
      }
    });
  }

  // forward STATUS/PROGRESS/DONE to popup (if open)
  if (msg.type === 'STATUS' || msg.type === 'PROGRESS' || msg.type === 'DONE') {
    // broadcast to all extension contexts
    chrome.runtime.sendMessage(msg);
  }
});