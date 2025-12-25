// options.js
const DEFAULTS = {
  createFolders: true,
  delayMs: 250,
  maxPages: 1500,
  startFromCurrent: true,
  theme: 'light'
};

function $(id) { return document.getElementById(id); }

function load() {
  chrome.storage.sync.get(DEFAULTS, (items) => {
    $('createFolders').checked = !!items.createFolders;
    $('delayMs').value = items.delayMs || DEFAULTS.delayMs;
    $('maxPages').value = items.maxPages || DEFAULTS.maxPages;
    $('startFromCurrent').checked = !!items.startFromCurrent;
    if ((items.theme || DEFAULTS.theme) === 'dark') {
      $('themeDark').checked = true;
    } else {
      $('themeLight').checked = true;
    }
  });
}

function save() {
  const toSave = {
    createFolders: !!$('createFolders').checked,
    delayMs: Number($('delayMs').value) || DEFAULTS.delayMs,
    maxPages: Number($('maxPages').value) || DEFAULTS.maxPages,
    startFromCurrent: !!$('startFromCurrent').checked,
    theme: document.querySelector('input[name="theme"]:checked').value || DEFAULTS.theme
  };
  chrome.storage.sync.set(toSave, () => {
    showMsg('Сохранено');
    // also notify popup/background (so theme can be applied if open)
    chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED', settings: toSave });
  });
}

function resetDefaults() {
  chrome.storage.sync.set(DEFAULTS, () => {
    showMsg('Сброшено');
    load();
    chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED', settings: DEFAULTS });
  });
}

function showMsg(t) {
  const msg = $('msg');
  msg.textContent = t;
  setTimeout(() => { if (msg.textContent === t) msg.textContent = ''; }, 2000);
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  $('saveBtn').addEventListener('click', save);
  $('resetBtn').addEventListener('click', resetDefaults);
});
