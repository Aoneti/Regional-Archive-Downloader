const DEBUG = false;
const log   = (...args) => DEBUG && console.log('[YARchive]', ...args);

// ── Настройки ────────────────────────────────────────────────────────────────

const DEFAULTS = {
  createFolders:    true,
  delayMs:          250,
  maxPages:         1500,
  startFromCurrent: true,
  theme:            'light'
};

/** @type {object|null} null означает «кэш не загружен» */
let settingsCache = null;

function getSettings() {
  return new Promise(resolve => {
    chrome.storage.sync.get(DEFAULTS, (items) => {
      settingsCache = Object.assign({}, DEFAULTS, items || {});
      resolve(settingsCache);
    });
  });
}

async function ensureSettings() {
  if (!settingsCache) {
    await getSettings();
  }
  return settingsCache;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    settingsCache = null;
    log('settings cache invalidated');
  }
});

// ── Состояние загрузки ───────────────────────────────────────────────────────

const TEST_TIMEOUT = 6000;

let isPaused  = false;
let isStopped = false;
let isRunning = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitIfPaused() {
  while (isPaused) {
    await sleep(300);
    if (isStopped) throw new Error('stopped');
  }
  if (isStopped) throw new Error('stopped');
}

// ── Хелперы общения с background/popup ──────────────────────────────────────

function sendStatus(text) {
  chrome.runtime.sendMessage({ type: 'STATUS', text });
}

function sendProgress(cur, total) {
  const percent = total > 0 ? Math.round((cur / total) * 100) : 0;
  chrome.runtime.sendMessage({ type: 'PROGRESS', percent });
}

function sendDone(text) {
  chrome.runtime.sendMessage({ type: 'DONE', text });
}

function setIcon(state) {
  chrome.runtime.sendMessage({ type: 'SET_ICON', state });
}

// ── Утилиты DOM / URL ────────────────────────────────────────────────────────

function getUnitId() {
  const m = location.pathname.match(/\/unit\/(\d+)/);
  return m ? m[1] : null;
}

function getTitleFromPage() {
  const h = document.querySelector('h1.title');
  return h && h.textContent ? h.textContent.trim() : null;
}

function sanitizeForFilename(s) {
  if (!s) return 'untitled';
  let str = String(s).trim();
  str = str.replace(/[\u0000-\u001F]/g, '');
  str = str.replace(/[\/\\:*?"<>|]+/g, '_');
  str = str.replace(/[\s_]+/g, '_');
  str = str.replace(/^_+|_+$/g, '');
  if (str.length > 100) str = str.slice(0, 100);
  return str || 'untitled';
}

function imageUrl(unit, page) {
  return `https://af.yar-archives.ru/archive27/image/${unit}?n=${page}`;
}

function pad(num, w) {
  return String(num).padStart(w, '0');
}

function detectCurrentPage() {
  for (const img of document.querySelectorAll('img')) {
    try {
      if (img.src && img.src.includes('/archive27/image/')) {
        const m = img.src.match(/[?&]n=(\d+)/);
        if (m) return Number(m[1]);
      }
    } catch (e) {
      log('detectCurrentPage error:', e);
    }
  }
  return 1;
}

// ── Проверка существования страницы ─────────────────────────────────────────

function testImage(url, timeout = TEST_TIMEOUT) {
  return new Promise(resolve => {
    const img = new Image();
    let done = false;

    const finish = (result) => {
      if (!done) {
        done = true;
        clearTimeout(t);
        img.onload  = null;
        img.onerror = null;
        img.src = '';  
        resolve(result);
      }
    };

    const t = setTimeout(() => finish(false), timeout);
    img.onload  = () => finish(true);
    img.onerror = () => finish(false);

    img.src = url + '&_ts=' + Date.now();
  });
}

// ── Бинарный поиск числа страниц ────────────────────────────────────────────

async function findTotalPages(unit, start, maxPages, progressCb) {
  await waitIfPaused();

  progressCb && progressCb(`Проверка страницы ${start}…`);
  const startExists = await testImage(imageUrl(unit, start));
  if (!startExists) return 0;

  let lo       = start; 
  let failedAt = null;  

  let probe = start;
  while (probe <= maxPages) {
    await waitIfPaused();
    const next = Math.min(probe * 2, maxPages);
    progressCb && progressCb(`Проверка страницы ${next}…`);
    const ok = await testImage(imageUrl(unit, next));
    if (ok) {
      lo = next;
      if (next === maxPages) return maxPages; 
      probe = next;
    } else {
      failedAt = next;
      break;
    }
  }

  if (failedAt === null) return lo;

  let hi = failedAt;

  while (lo < hi - 1) {
    await waitIfPaused();
    const mid = Math.floor((lo + hi) / 2);
    progressCb && progressCb(`Уточнение: страница ${mid}…`);
    const ok = await testImage(imageUrl(unit, mid));
    if (ok) lo = mid; else hi = mid;
  }

  return lo;
}

// ── Скачать весь документ ────────────────────────────────────────────────────

async function downloadAll() {
  if (isRunning) return;
  isRunning = true;
  isPaused  = false;
  isStopped = false;

  const cfg  = await ensureSettings();
  const unit = getUnitId();

  if (!unit) {
    sendDone('Не удалось определить unit');
    isRunning = false;
    setIcon('inactive');
    return;
  }

  const titleRaw   = getTitleFromPage();
  const folderName = `${sanitizeForFilename(titleRaw)}_unit_${unit}`;

  setIcon('active');
  sendStatus(cfg.createFolders ? `Папка: ${folderName}` : 'Файлы в корне загрузок');

  try {
    const start = cfg.startFromCurrent ? detectCurrentPage() : 1;
    sendStatus(`Поиск страниц, начиная с ${start}…`);

    const total = await findTotalPages(unit, start, cfg.maxPages, (t) => sendStatus(t));

    if (!total) {
      sendDone('Страницы не найдены');
      return;
    }

    const padWidth = String(total).length || 3;

    for (let p = 1; p <= total; p++) {
      await waitIfPaused();
      sendProgress(p, total);
      sendStatus(`Скачивание ${p} / ${total}`);

      const filename = cfg.createFolders
        ? `${folderName}/${pad(p, padWidth)}.jpg`
        : `unit_${unit}_p${pad(p, padWidth)}.jpg`;

      chrome.runtime.sendMessage({ type: 'DOWNLOAD', url: imageUrl(unit, p), filename });

      await sleep(cfg.delayMs);
    }

    sendDone(`Готово: ${total} стр.`);

  } catch (e) {
    if (e.message === 'stopped') {
      sendDone('Остановлено');
    } else {
      console.error('[YARchive] downloadAll error:', e);
      sendDone('Ошибка: ' + e.message);
    }
  } finally {
    isRunning = false;
    isPaused  = false;
    isStopped = false;
    setIcon('inactive');
  }
}

// ── Скачать текущую страницу ─────────────────────────────────────────────────

async function downloadCurrent() {
  const cfg  = await ensureSettings();
  const unit = getUnitId();

  if (!unit) {
    sendStatus('Unit не определён');
    return;
  }

  const titleRaw   = getTitleFromPage();
  const folderName = `${sanitizeForFilename(titleRaw)}_unit_${unit}`;
  const p          = detectCurrentPage();

  setIcon('active');

  const filename = cfg.createFolders
    ? `${folderName}/${pad(p, 3)}.jpg`
    : `unit_${unit}_p${pad(p, 3)}.jpg`;

  chrome.runtime.sendMessage({ type: 'DOWNLOAD', url: imageUrl(unit, p), filename });

  sendStatus(`Скачана стр. ${p}`);
  setTimeout(() => setIcon('inactive'), 1200);
}

// ── Обработчик сообщений от popup ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'DOWNLOAD_ALL':     downloadAll();   break;
    case 'DOWNLOAD_CURRENT': downloadCurrent(); break;

    case 'PAUSE':
      if (isRunning && !isPaused) {
        isPaused = true;
        sendStatus('Пауза');
      }
      break;

    case 'RESUME':
      if (isRunning && isPaused) {
        isPaused = false;
        sendStatus('Продолжение…');
      }
      break;

    case 'STOP':
      if (isRunning) {
        isStopped = true;
        isPaused  = false;
        sendStatus('Остановка…');
      }
      break;
      
    case 'GET_STATE':
      return true; 
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'GET_STATE') {
    sendResponse({ isRunning, isPaused });
  }
});

// ── Инициализация иконки при загрузке страницы ──────────────────────────────

ensureSettings().then(() => {
  try {
    const unit = getUnitId();
    setIcon(unit ? 'active' : 'inactive');
  } catch (e) {
    setIcon('inactive');
  }
});

log('content-script loaded');
