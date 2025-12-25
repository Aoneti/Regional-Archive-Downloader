console.log('[popup] loaded');

const statusEl = document.getElementById('status');
const barEl = document.getElementById('progressBar');

const btnAll = document.getElementById('btnAll');
const btnCurrent = document.getElementById('btnCurrent');
const btnPause = document.getElementById('btnPause');
const btnStop = document.getElementById('btnStop');
const openOptions = document.getElementById('openOptions');

let isRunning = false;
let isPaused = false;

function setStatus(text) {
  statusEl.textContent = text || '';
  console.log('[popup] status:', text);
}

function setProgress(percent) {
  barEl.style.width = Math.max(0, Math.min(100, percent)) + '%';
  console.log('[popup] progress:', percent);
}

function sendToActiveTab(message, cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (!tabs || !tabs[0]) {
      console.warn('[popup] no active tab');
      return;
    }
    chrome.tabs.sendMessage(tabs[0].id, message, cb);
  });
}

btnAll.addEventListener('click', () => {
  if (isRunning) return;
  isRunning = true;
  isPaused = false;
  btnAll.disabled = true;
  btnCurrent.disabled = true;
  btnPause.disabled = false;
  btnStop.disabled = false;
  btnPause.textContent = '⏸';
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
  isPaused = !isPaused;
  if (isPaused) {
    btnPause.textContent = '▶';
    setStatus('Пауза');
    sendToActiveTab({ type: 'PAUSE' });
  } else {
    btnPause.textContent = '⏸';
    setStatus('Продолжение…');
    sendToActiveTab({ type: 'RESUME' });
  }
});

btnStop.addEventListener('click', () => {
  if (!isRunning) return;
  sendToActiveTab({ type: 'STOP' });
  setStatus('Остановлено');
  setProgress(0);
  isRunning = false;
  isPaused = false;
  btnAll.disabled = false;
  btnCurrent.disabled = false;
  btnPause.disabled = true;
  btnStop.disabled = true;
  btnPause.textContent = '⏸';
});

openOptions.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'STATUS') {
    setStatus(msg.text);
  } else if (msg.type === 'PROGRESS') {
    setProgress(msg.percent);
  } else if (msg.type === 'DONE') {
    setStatus(msg.text || 'Готово');
    setProgress(100);
    // reset UI
    isRunning = false;
    isPaused = false;
    btnAll.disabled = false;
    btnCurrent.disabled = false;
    btnPause.disabled = true;
    btnStop.disabled = true;
    btnPause.textContent = '⏸';
  } else if (msg.type === 'SET_THEME') {
    if (msg.theme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }
});

(function init() {
  btnPause.disabled = true;
  btnStop.disabled = true;
  chrome.storage.sync.get({ theme: 'light' }, items => {
    if (items.theme === 'dark') document.documentElement.classList.add('dark');
  });
})();

