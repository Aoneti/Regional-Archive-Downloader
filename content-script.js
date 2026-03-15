const DEBUG = false;
const log   = (...args) => DEBUG && console.log('[YARchive]', ...args);

// ── Настройки ────────────────────────────────────────────────────────────────

const DEFAULTS = {
  createFolders:       true,
  delayMs:             250,
  maxPages:            1500,
  startFromCurrent:    true,
  concurrentDownloads: 4,
  theme:               'light'
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

const TEST_TIMEOUT           = 6000;
const RETRY_ATTEMPTS         = 2;
const RETRY_DELAY_MS         = 400;
const MAX_CONCURRENT_DOWNLOADS = 4;

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
  chrome.runtime.sendMessage({ type: 'PROGRESS', percent, current: cur, total });
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
      if (img.src && img.src.includes('/image/')) {
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
        clearTimeout(timerId);
        img.onload  = null;
        img.onerror = null;
        img.src = '';  
        resolve(result);
      }
    };

    const timerId = setTimeout(() => finish(false), timeout);
    img.onload  = () => finish(true);
    img.onerror = () => finish(false);

    img.src = url + '&_ts=' + Date.now();
  });
}

async function testImageWithRetry(url, retries = RETRY_ATTEMPTS) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ok = await testImage(url);
    if (ok) return true;
    if (attempt < retries) {
      await sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }
  return false;
}

// ── Семафор загрузок ─────────────────────────────────────────────────────────

let downloadsInFlight = 0;

async function downloadWithSemaphore(url, filename, limit = MAX_CONCURRENT_DOWNLOADS) {
  while (downloadsInFlight >= limit) {
    await sleep(200);
    await waitIfPaused();
  }

  downloadsInFlight++;

  chrome.runtime.sendMessage({ type: 'DOWNLOAD', url, filename }, () => {
    void chrome.runtime.lastError;
    downloadsInFlight--;
  });
}

// ── Бинарный поиск числа страниц ────────────────────────────────────────────

async function findTotalPages(unit, start, maxPages, progressCb) {
  await waitIfPaused();

  progressCb?.(`Проверка страницы ${start}…`);
  const startExists = await testImageWithRetry(imageUrl(unit, start));
  if (!startExists) return 0;

  let lo       = start; // последняя подтверждённая страница
  let failedAt = null;  // первая несуществующая (верхняя граница)

  let probe = start;
  while (probe <= maxPages) {
    await waitIfPaused();
    const next = Math.min(probe * 2, maxPages);
    progressCb?.(`Проверка страницы ${next}…`);
    const ok = await testImageWithRetry(imageUrl(unit, next));
    if (ok) {
      lo = next;
      if (next === maxPages) return maxPages; // все страницы до лимита существуют
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
    progressCb?.(`Уточнение: страница ${mid}…`);
    const ok = await testImageWithRetry(imageUrl(unit, mid));
    if (ok) lo = mid; else hi = mid;
  }

  return lo;
}

// ── Скачать весь документ ────────────────────────────────────────────────────

async function downloadAll(overrideFrom = null, overrideTo = null) {
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

  const concLimit = cfg.concurrentDownloads ?? MAX_CONCURRENT_DOWNLOADS;

  setIcon('active');
  sendStatus(cfg.createFolders ? `Папка: ${folderName}` : 'Файлы в корне загрузок');

  try {
    const start = overrideFrom != null
      ? overrideFrom
      : (cfg.startFromCurrent ? detectCurrentPage() : 1);

    sendStatus(`Поиск страниц, начиная с ${start}…`);
    const discovered = await findTotalPages(unit, start, cfg.maxPages, t => sendStatus(t));

    if (!discovered) {
      sendDone('Страницы не найдены');
      return;
    }

    const total  = overrideTo != null ? Math.min(overrideTo, discovered) : discovered;
    const pFrom  = overrideFrom != null ? overrideFrom : 1;
    const padWidth = String(total).length || 3;

    for (let p = pFrom; p <= total; p++) {
      await waitIfPaused();
      sendProgress(p - pFrom + 1, total - pFrom + 1);
      sendStatus(`Скачивание ${p} / ${total}`);

      const filename = cfg.createFolders
        ? `${folderName}/${pad(p, padWidth)}.jpg`
        : `unit_${unit}_p${pad(p, padWidth)}.jpg`;

      await downloadWithSemaphore(imageUrl(unit, p), filename, concLimit);

      await sleep(cfg.delayMs);
    }

    sendDone(`Готово: ${total - pFrom + 1} стр.`);

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
    downloadsInFlight = 0;
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.type) return;

  switch (msg.type) {
    case 'DOWNLOAD_ALL':
      downloadAll(msg.fromPage ?? null, msg.toPage ?? null);
      break;

    case 'DOWNLOAD_CURRENT':
      downloadCurrent();
      break;

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
      sendResponse({
        isRunning,
        isPaused,
        currentPage:    detectCurrentPage(),
        isArchivePage:  !!getUnitId()
      });
      return true;
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
