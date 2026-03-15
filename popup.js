const statusEl  = document.getElementById('status');
const barEl     = document.getElementById('progressBar');
const btnAll    = document.getElementById('btnAll');
const btnCurrent = document.getElementById('btnCurrent');
const btnPause  = document.getElementById('btnPause');
const btnStop   = document.getElementById('btnStop');
const openOptions = document.getElementById('openOptions');

let isRunning = false;
let isPaused  = false;

// ── Утилиты UI ───────────────────────────────────────────────────────────────

function setStatus(text) {
  statusEl.textContent = text || '';
}

function setProgress(percent) {
  barEl.style.width = Math.max(0, Math.min(100, percent)) + '%';
}

/**
 * Переключает кнопки в соответствии с текущим состоянием.
 * @param {boolean} running  — идёт ли загрузка
 * @param {boolean} paused   — стоит ли на паузе
 */
function setRunningUI(running, paused) {
  isRunning = running;
  isPaused  = paused;

  btnAll.disabled     = running;
  btnCurrent.disabled = running;
  btnPause.disabled   = !running;
  btnStop.disabled    = !running;
  btnPause.textContent = paused ? '▶' : '⏸';
}

function applyTheme(theme) {
  if (theme === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}

// ── Отправка в активный таб ──────────────────────────────────────────────────

function sendToActiveTab(message, cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (!tabs || !tabs[0]) {
      console.warn('[YARchive popup] no active tab');
      return;
    }
    chrome.tabs.sendMessage(tabs[0].id, message, cb);
  });
}

// ── Кнопки ───────────────────────────────────────────────────────────────────

btnAll.addEventListener('click', () => {
  if (isRunning) return;
  setRunningUI(true, false);
  setStatus('Поиск страниц…');
  setProgress(0);
  sendToActiveTab({ type: 'DOWNLOAD_ALL' });
});

btnCurrent.addEventListener('click', () => {
  setStatus('Скачивание текущей страницы…');
  sendToActiveTab({ type: 'DOWNLOAD_CURRENT' });
});

btnPause.addEventListener('click', () => {
  if (!isRunning) return;
  if (!isPaused) {
    // Ставим на паузу
    btnPause.textContent = '▶';
    setStatus('Пауза');
    isPaused = true;
    sendToActiveTab({ type: 'PAUSE' });
  } else {
    // Снимаем с паузы
    btnPause.textContent = '⏸';
    setStatus('Продолжение…');
    isPaused = false;
    sendToActiveTab({ type: 'RESUME' });
  }
});

btnStop.addEventListener('click', () => {
  if (!isRunning) return;
  sendToActiveTab({ type: 'STOP' });
  setStatus('Остановлено');
  setProgress(0);
  setRunningUI(false, false);
});

openOptions.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// ── Входящие сообщения от content-script (через background) ─────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'STATUS':
      setStatus(msg.text);
      break;

    case 'PROGRESS':
      setProgress(msg.percent);
      break;

    case 'DONE':
      setStatus(msg.text || 'Готово');
      setProgress(100);
      setRunningUI(false, false);
      break;

    case 'SET_THEME':
      applyTheme(msg.theme);
      break;

    case 'SETTINGS_UPDATED':
      if (msg.settings && msg.settings.theme) {
        applyTheme(msg.settings.theme);
      }
      break;
  }
});

// ── Инициализация ─────────────────────────────────────────────────────────────

(function init() {
  // Начальное состояние кнопок
  setRunningUI(false, false);

  // Загрузить тему из хранилища
  chrome.storage.sync.get({ theme: 'light' }, items => {
    applyTheme(items.theme);
  });

  // Восстановить состояние UI если скачивание уже идёт
  // (пользователь закрыл popup и снова открыл)
  sendToActiveTab({ type: 'GET_STATE' }, (state) => {
    if (chrome.runtime.lastError || !state) return;
    if (state.isRunning) {
      setRunningUI(true, state.isPaused);
      setStatus(state.isPaused ? 'Пауза' : 'Загрузка…');
    }
  });
})();
