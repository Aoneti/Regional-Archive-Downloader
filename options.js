/**
 * options.js — страница настроек YARchive Downloader
 *
 * Новое в этой версии:
 *  1. Слайдеры синхронизированы с числовыми полями (двусторонняя привязка).
 *  2. Чипы-пресеты: Быстро / Нормально / Медленно / Вежливо.
 *  3. Настройка параллельных загрузок (concurrentDownloads, 1–8).
 *  4. Тема — кнопочный переключатель вместо radio-инпутов.
 *  5. Валидация с зажимом в допустимый диапазон (no silent NaN).
 */

const DEFAULTS = {
  createFolders:       true,
  delayMs:             250,
  maxPages:            1500,
  startFromCurrent:    true,
  concurrentDownloads: 4,
  theme:               'light'
};

const LIMITS = {
  delayMs:             { min: 0,    max: 5000 },
  maxPages:            { min: 1,    max: 5000 },
  concurrentDownloads: { min: 1,    max: 8    }
};

/** Пресеты задержки с метками */
const DELAY_PRESETS = [0, 250, 600, 1200];

function $(id) { return document.getElementById(id); }

// ── Тема ──────────────────────────────────────────────────────────────────────

function applyTheme(theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  $('themeLightBtn').classList.toggle('active', theme === 'light');
  $('themeLightBtn').setAttribute('aria-checked', String(theme === 'light'));
  $('themeDarkBtn').classList.toggle('active', theme === 'dark');
  $('themeDarkBtn').setAttribute('aria-checked', String(theme === 'dark'));
  // Обновить скрытые radio (используются в save())
  $('themeLight').checked = (theme === 'light');
  $('themeDark').checked  = (theme === 'dark');
}

$('themeLightBtn').addEventListener('click', () => applyTheme('light'));
$('themeDarkBtn').addEventListener('click',  () => applyTheme('dark'));

// ── Двусторонняя привязка слайдер ↔ число ────────────────────────────────────

/**
 * Связывает input[range] и input[number]: изменение одного обновляет другой
 * и отображаемое значение в label.
 *
 * @param {string} sliderId   — id range-инпута
 * @param {string} numberId   — id number-инпута
 * @param {string} displayId  — id span с отображаемым значением (может быть null)
 * @param {string} limitKey   — ключ в LIMITS
 */
function bindSliderNumber(sliderId, numberId, displayId, limitKey) {
  const slider  = $(sliderId);
  const number  = $(numberId);
  const display = displayId ? $(displayId) : null;
  const { min, max } = LIMITS[limitKey];

  function clamp(v) { return Math.max(min, Math.min(max, v)); }

  function update(value) {
    const v = clamp(Math.round(Number(value)));
    slider.value  = v;
    number.value  = v;
    if (display) display.textContent = v;
    // Подсветить активный пресет задержки
    if (numberId === 'delayMs') syncPresets(v);
  }

  slider.addEventListener('input',  () => update(slider.value));
  number.addEventListener('change', () => update(number.value));
  number.addEventListener('blur',   () => update(number.value));

  // Начальная синхронизация
  update(number.value || DEFAULTS[limitKey]);
}

bindSliderNumber('delaySlider',      'delayMs',            'delayVal',      'delayMs');
bindSliderNumber('maxPagesSlider',   'maxPages',           'maxPagesVal',   'maxPages');
bindSliderNumber('concurrentSlider', 'concurrentDownloads','concurrentVal', 'concurrentDownloads');

// ── Пресеты задержки ──────────────────────────────────────────────────────────

/** Выделяет чип пресета соответствующий текущему значению (если есть). */
function syncPresets(value) {
  document.querySelectorAll('.preset[data-target="delayMs"]').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.value) === value);
  });
}

document.querySelectorAll('.preset').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.target;
    const value  = Number(btn.dataset.value);
    const input  = $(target);
    if (!input) return;
    input.value = value;
    input.dispatchEvent(new Event('change')); // триггерим двустороннюю привязку
  });
});

// ── Загрузка настроек ─────────────────────────────────────────────────────────

function load() {
  chrome.storage.sync.get(DEFAULTS, items => {
    $('createFolders').checked    = !!items.createFolders;
    $('startFromCurrent').checked = !!items.startFromCurrent;

    $('delayMs').value            = items.delayMs             ?? DEFAULTS.delayMs;
    $('maxPages').value           = items.maxPages            ?? DEFAULTS.maxPages;
    $('concurrentDownloads').value = items.concurrentDownloads ?? DEFAULTS.concurrentDownloads;

    // Триггернуть синхронизацию слайдеров и дисплея
    ['delayMs', 'maxPages', 'concurrentDownloads'].forEach(id => {
      $(id).dispatchEvent(new Event('change'));
    });

    applyTheme(items.theme || DEFAULTS.theme);
  });
}

// ── Сохранение ────────────────────────────────────────────────────────────────

function clampField(id, key) {
  const raw = parseInt($(id).value, 10);
  if (isNaN(raw)) return null;
  return Math.max(LIMITS[key].min, Math.min(LIMITS[key].max, raw));
}

function save() {
  const delayMs             = clampField('delayMs',             'delayMs');
  const maxPages            = clampField('maxPages',            'maxPages');
  const concurrentDownloads = clampField('concurrentDownloads', 'concurrentDownloads');

  if (delayMs === null || maxPages === null || concurrentDownloads === null) {
    showMsg('Некорректные значения', 'error');
    return;
  }

  // Обновить поля если были зажаты
  $('delayMs').value             = delayMs;
  $('maxPages').value            = maxPages;
  $('concurrentDownloads').value = concurrentDownloads;

  const themeInput = document.querySelector('input[name="theme"]:checked');
  const theme = themeInput ? themeInput.value : DEFAULTS.theme;

  const toSave = {
    createFolders:       !!$('createFolders').checked,
    delayMs,
    maxPages,
    startFromCurrent:    !!$('startFromCurrent').checked,
    concurrentDownloads,
    theme
  };

  chrome.storage.sync.set(toSave, () => {
    if (chrome.runtime.lastError) {
      showMsg('Ошибка сохранения', 'error');
      return;
    }
    showMsg('Сохранено');
    applyTheme(theme);
    // Уведомить popup об изменении настроек (тема, maxPages)
    chrome.runtime.sendMessage(
      { type: 'SETTINGS_UPDATED', settings: toSave },
      () => void chrome.runtime.lastError
    );
  });
}

function resetDefaults() {
  chrome.storage.sync.set(DEFAULTS, () => {
    if (chrome.runtime.lastError) { showMsg('Ошибка сброса', 'error'); return; }
    showMsg('Сброшено');
    load();
    chrome.runtime.sendMessage(
      { type: 'SETTINGS_UPDATED', settings: DEFAULTS },
      () => void chrome.runtime.lastError
    );
  });
}

// ── Сообщение обратной связи ──────────────────────────────────────────────────

function showMsg(text, kind = 'ok') {
  const el = $('msg');
  el.textContent = text;
  el.className   = 'msg msg--' + kind;
  setTimeout(() => {
    if (el.textContent === text) { el.textContent = ''; el.className = 'msg'; }
  }, 2500);
}

// ── Инициализация ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  load();
  $('saveBtn').addEventListener('click', save);
  $('resetBtn').addEventListener('click', resetDefaults);
});
