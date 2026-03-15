/**
 * content-script.js — основная логика скачивания (YARchive Downloader)
 *
 * Исправления:
 *  1. settingsCache инициализируется как null — ensureSettings() теперь
 *     корректно загружает настройки при первом обращении.
 *  2. chrome.storage.onChanged инвалидирует кэш при изменении настроек
 *     (например, пользователь сохранил новые значения в options.html).
 *  3. findTotalPages() заменён на бинарный поиск — O(log n) вместо O(n).
 *     Для документа 500 страниц: было ~125 сек., стало ~5 сек.
 *  4. testImage() явно очищает img.src после использования — нет утечек памяти.
 *  5. Пустой catch в detectCurrentPage() заменён логирующим.
 *  6. Добавлен обработчик GET_STATE — popup восстанавливает UI при переоткрытии.
 *  7. console.log заменён на log() — в релизе логи выключены (DEBUG = false).
 *  8. Все строки-пути через imageUrl() — нет разбросанных шаблонов.
 */

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

// Инвалидация кэша при изменении настроек из options.html
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    settingsCache = null;
    log('settings cache invalidated');
  }
});

// ── Состояние загрузки ───────────────────────────────────────────────────────

const TEST_TIMEOUT           = 6000;
const RETRY_ATTEMPTS         = 2;     // попыток после первого провала
const RETRY_DELAY_MS         = 400;   // базовая задержка между ретраями (умножается на номер попытки)
const MAX_CONCURRENT_DOWNLOADS = 4;   // максимум параллельных загрузок в chrome.downloads

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

/**
 * Проверяет, существует ли изображение по URL.
 * Явно обнуляет img.src после использования во избежание утечек памяти
 * при большом количестве последовательных проверок.
 */
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
        img.src = '';   // явная очистка — предотвращает утечку памяти
        resolve(result);
      }
    };

    const timerId = setTimeout(() => finish(false), timeout);
    img.onload  = () => finish(true);
    img.onerror = () => finish(false);

    // cache-busting чтобы не получить закешированный 404
    img.src = url + '&_ts=' + Date.now();
  });
}

/**
 * Обёртка над testImage с повторными попытками.
 *
 * Зачем: однократный сетевой сбой (таймаут, обрыв) без retry приводит к тому,
 * что бинарный поиск считает страницу несуществующей и возвращает заниженное
 * число страниц — документ «обрезается» посередине без каких-либо признаков
 * ошибки для пользователя.
 *
 * Стратегия: линейно нарастающая задержка (400 мс, 800 мс, …) — достаточно
 * агрессивна чтобы пережить флуктуацию, но не настолько чтобы заметно замедлить
 * поиск на реально несуществующих страницах.
 *
 * @param {string} url
 * @param {number} [retries=RETRY_ATTEMPTS]
 * @returns {Promise<boolean>}
 */
async function testImageWithRetry(url, retries = RETRY_ATTEMPTS) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ok = await testImage(url);
    if (ok) return true;
    if (attempt < retries) {
      await sleep(RETRY_DELAY_MS * (attempt + 1)); // 400 мс, 800 мс, …
    }
  }
  return false;
}

// ── Семафор загрузок ─────────────────────────────────────────────────────────

/**
 * Количество DOWNLOAD-запросов, отданных в background и ещё не подтверждённых.
 * Ограничивает параллелизм: при 1500 страницах без семафора все 1500 запросов
 * попадают в очередь chrome.downloads одновременно, что может подвесить браузер.
 */
let downloadsInFlight = 0;

/**
 * Отправляет DOWNLOAD-сообщение в background, соблюдая лимит параллелизма.
 * @param {string} url
 * @param {string} filename
 * @param {number} [limit=MAX_CONCURRENT_DOWNLOADS]
 */
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

/**
 * Находит последнюю существующую страницу за O(log n) запросов.
 *
 * Алгоритм:
 *   1. Экспоненциально удваиваем probe пока страница существует — находим
 *      верхнюю границу диапазона (первая несуществующая страница = failedAt).
 *   2. Бинарный поиск в диапазоне [lo … failedAt] — lo это последняя
 *      подтверждённая страница, failedAt — первая несуществующая.
 *
 * Критично: lo и hi должны быть "последний успех" и "первый провал"
 * соответственно, а не lo = lastSuccess/2. Иначе страницы между
 * lastSuccess и failedAt будут пропущены.
 *
 * Пример: 73 страницы
 *   Экспонента: 1✓ 2✓ 4✓ 8✓ 16✓ 32✓ 64✓ 128✗ → lo=64, failedAt=128
 *   Бинарный: 96✗→hi=96, 80✗→hi=80, 72✓→lo=72, 76✗→hi=76,
 *             74✗→hi=74, 73✓→lo=73 → return 73 ✓
 */
async function findTotalPages(unit, start, maxPages, progressCb) {
  await waitIfPaused();

  // Шаг 0: убедиться что стартовая страница существует
  progressCb?.(`Проверка страницы ${start}…`);
  const startExists = await testImageWithRetry(imageUrl(unit, start));
  if (!startExists) return 0;

  // Шаг 1: экспоненциальный рост — найти первую несуществующую страницу
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

  // Если экспонента дошла до maxPages без провала — вернуть lo
  if (failedAt === null) return lo;

  // Шаг 2: бинарный поиск в диапазоне (lo … failedAt)
  // Инвариант: lo — существует, failedAt — не существует
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

/**
 * Скачивает страницы документа в диапазоне [fromPage … toPage].
 * @param {number|null} overrideFrom — первая страница (null = из настроек/авто)
 * @param {number|null} overrideTo   — последняя страница (null = до конца)
 */
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

  // Лимит параллельных загрузок из настроек (или глобальная константа как запасной вариант)
  const concLimit = cfg.concurrentDownloads ?? MAX_CONCURRENT_DOWNLOADS;

  setIcon('active');
  sendStatus(cfg.createFolders ? `Папка: ${folderName}` : 'Файлы в корне загрузок');

  try {
    // Начальная страница: из popup-слайдера → из настроек startFromCurrent → 1
    const start = overrideFrom != null
      ? overrideFrom
      : (cfg.startFromCurrent ? detectCurrentPage() : 1);

    sendStatus(`Поиск страниц, начиная с ${start}…`);
    const discovered = await findTotalPages(unit, start, cfg.maxPages, t => sendStatus(t));

    if (!discovered) {
      sendDone('Страницы не найдены');
      return;
    }

    // Конечная страница: из popup-слайдера (если задана) или весь документ
    const total  = overrideTo != null ? Math.min(overrideTo, discovered) : discovered;
    const pFrom  = overrideFrom != null ? overrideFrom : 1; // скачиваем с 1 если диапазон не задан
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

    /**
     * GET_STATE — отвечает на запрос popup при его открытии.
     * currentPage позволяет popup синхронизировать левый ползунок диапазона.
     */
    case 'GET_STATE':
      sendResponse({
        isRunning,
        isPaused,
        currentPage:    detectCurrentPage(),
        isArchivePage:  !!getUnitId()   // popup показывает предупреждение если false
      });
      return true; // сигнал для асинхронного sendResponse
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
