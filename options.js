const DEFAULTS = {
  createFolders:    true,
  delayMs:          250,
  maxPages:         1500,
  startFromCurrent: true,
  theme:            'light'
};

/** Ограничения полей ввода */
const LIMITS = {
  delayMs:  { min: 0,    max: 5000 },
  maxPages: { min: 1,    max: 5000 }
};

function $(id) { return document.getElementById(id); }

function applyTheme(theme) {
  if (theme === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}

function load() {
  chrome.storage.sync.get(DEFAULTS, (items) => {
    $('createFolders').checked    = !!items.createFolders;
    $('delayMs').value            = items.delayMs  ?? DEFAULTS.delayMs;
    $('maxPages').value           = items.maxPages ?? DEFAULTS.maxPages;
    $('startFromCurrent').checked = !!items.startFromCurrent;

    const theme = items.theme || DEFAULTS.theme;
    (theme === 'dark' ? $('themeDark') : $('themeLight')).checked = true;
    applyTheme(theme);
  });
}

function save() {
  // Парсинг числовых значений
  const rawDelay    = parseInt($('delayMs').value,  10);
  const rawMaxPages = parseInt($('maxPages').value, 10);

  // Валидация — проверяем что это число
  if (isNaN(rawDelay) || isNaN(rawMaxPages)) {
    showMsg('Некорректные значения', 'error');
    return;
  }

  // Зажим в допустимый диапазон
  const delayMs  = Math.max(LIMITS.delayMs.min,  Math.min(LIMITS.delayMs.max,  rawDelay));
  const maxPages = Math.max(LIMITS.maxPages.min, Math.min(LIMITS.maxPages.max, rawMaxPages));

  // Обновить поля с исправленными значениями (если были вне диапазона)
  $('delayMs').value  = delayMs;
  $('maxPages').value = maxPages;

  const themeInput = document.querySelector('input[name="theme"]:checked');
  const theme = themeInput ? themeInput.value : DEFAULTS.theme;

  const toSave = {
    createFolders:    !!$('createFolders').checked,
    delayMs,
    maxPages,
    startFromCurrent: !!$('startFromCurrent').checked,
    theme
  };

  chrome.storage.sync.set(toSave, () => {
    if (chrome.runtime.lastError) {
      showMsg('Ошибка сохранения', 'error');
      return;
    }
    showMsg('Сохранено');
    applyTheme(theme);

    // Уведомить popup/background об изменении настроек (включая тему)
    chrome.runtime.sendMessage(
      { type: 'SETTINGS_UPDATED', settings: toSave },
      () => void chrome.runtime.lastError // popup может быть закрыт
    );
  });
}

function resetDefaults() {
  chrome.storage.sync.set(DEFAULTS, () => {
    if (chrome.runtime.lastError) {
      showMsg('Ошибка сброса', 'error');
      return;
    }
    showMsg('Сброшено');
    load();
    chrome.runtime.sendMessage(
      { type: 'SETTINGS_UPDATED', settings: DEFAULTS },
      () => void chrome.runtime.lastError
    );
  });
}

/**
 * Показывает сообщение обратной связи пользователю.
 * @param {string} text
 * @param {'ok'|'error'} [kind='ok']
 */
function showMsg(text, kind = 'ok') {
  const msg = $('msg');
  msg.textContent = text;
  msg.className   = 'msg msg--' + kind;
  setTimeout(() => {
    if (msg.textContent === text) {
      msg.textContent = '';
      msg.className   = 'msg';
    }
  }, 2500);
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  $('saveBtn').addEventListener('click', save);
  $('resetBtn').addEventListener('click', resetDefaults);
});
