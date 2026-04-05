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
  if (!settingsCache) await getSettings();
  return settingsCache;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    settingsCache = null;
    log('settings cache invalidated');
  }
});

// ── Возобновление загрузки ───────────────────────────────────────────────────

function resumeKey(unit) { return `yar_resume_${unit}`; }

function saveResumeState(unit, state) {
  chrome.storage.local.set({ [resumeKey(unit)]: { ...state, savedAt: Date.now() } });
}

function clearResumeState(unit) {
  chrome.storage.local.remove(resumeKey(unit));
}

function getResumeState(unit) {
  return new Promise(resolve => {
    chrome.storage.local.get(resumeKey(unit), result => {
      resolve(result[resumeKey(unit)] ?? null);
    });
  });
}

// ── Состояние загрузки ───────────────────────────────────────────────────────

const TEST_TIMEOUT             = 6000;
const RETRY_ATTEMPTS           = 2;
const RETRY_DELAY_MS           = 400;
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

function sendDone(text, extra = {}) {
  chrome.runtime.sendMessage({ type: 'DONE', text, ...extra });
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

/**
 * Собирает метаданные документа из страницы.
 * Пробует несколько распространённых селекторов архивных систем.
 */
function collectPageMeta() {
  const lines = [];

  // Таблица реквизитов (встречается на большинстве платформ)
  document.querySelectorAll('table.table tr, .unit-info tr, .well tr').forEach(row => {
    const cells = [...row.querySelectorAll('td, th')].map(c => c.textContent.trim()).filter(Boolean);
    if (cells.length >= 2) lines.push(cells.join(': '));
  });

  // Абзацы в блоке описания
  if (!lines.length) {
    document.querySelectorAll('.well p, .description p, .card-body p').forEach(p => {
      const t = p.textContent.trim();
      if (t) lines.push(t);
    });
  }

  return lines.slice(0, 30).join('\n');
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

/**
 * Возвращает URL изображения. archNum передаётся явно,
 * чтобы поддерживать разные архивы с разными номерами.
 */
function imageUrl(unit, archNum, page) {
  return `${location.origin}/archive${archNum}/image/${unit}?n=${page}`;
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

// ── Определение номера архива ────────────────────────────────────────────────

/**
 * Пробует извлечь номер архива из pathname.
 * Если не удалось — последовательно проверяет варианты /archive1/, /archive27/ и т.д.
 * Идея позаимствована из cgamos-downloader (UrlMutationHelper).
 */
async function detectArchiveNum(unit) {
  // Быстрый путь: номер уже есть в URL
  const fromPath = location.pathname.match(/\/archive(\d+)\//)?.[1];
  if (fromPath) return fromPath;

  log('archiveNum not in pathname, probing variants…');
  const CANDIDATES = ['1', '27', '2', '3', '4', '5'];
  for (const n of CANDIDATES) {
    const url = `${location.origin}/archive${n}/image/${unit}?n=1&_ts=${Date.now()}`;
    const ok  = await testImage(url, 4000);
    if (ok) {
      log('archiveNum detected:', n);
      return n;
    }
  }

  log('archiveNum fallback: 27');
  return '27';
}

// ── Проверка существования страницы ─────────────────────────────────────────

/**
 * Проверяет доступность изображения.
 * naturalWidth > 10 защищает от placeholder-пикселей (200 OK, но пустой контент).
 * Идея из vol-archive-grabber: проверка не только статуса, но и содержимого ответа.
 */
function testImage(url, timeout = TEST_TIMEOUT) {
  return new Promise(resolve => {
    const img = new Image();
    let done  = false;

    const finish = (result) => {
      if (!done) {
        done = true;
        clearTimeout(timerId);
        img.onload  = null;
        img.onerror = null;
        img.src     = '';
        resolve(result);
      }
    };

    const timerId = setTimeout(() => finish(false), timeout);
    // naturalWidth > 10 — защита от пустых/placeholder ответов
    img.onload  = () => finish(img.naturalWidth > 10);
    img.onerror = () => finish(false);

    img.src = url + (url.includes('?') ? '&' : '?') + '_ts=' + Date.now();
  });
}

async function testImageWithRetry(url, retries = RETRY_ATTEMPTS) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ok = await testImage(url);
    if (ok) return true;
    if (attempt < retries) await sleep(RETRY_DELAY_MS * (attempt + 1));
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

// ── Бинарный поиск числа страниц с параллельной разведкой ───────────────────

/**
 * Находит количество страниц документа.
 *
 * Фаза 1 (параллельная разведка): одновременно проверяет контрольные точки
 *   [start, start×4, start×16, …, maxPages], чтобы быстро найти грубую границу.
 *   При старте с 1 страницы и лимите 1500 — это ~6 параллельных запросов.
 *   Ускорение особенно заметно для длинных документов (500+ стр.).
 *
 * Фаза 2 (бинарный поиск): уточняет границу между последней найденной точкой
 *   и первой ненайденной.
 */
async function findTotalPages(unit, archNum, start, maxPages, progressCb) {
  await waitIfPaused();

  progressCb?.(`Проверка страницы ${start}…`);
  if (!await testImageWithRetry(imageUrl(unit, archNum, start))) return 0;

  // Строим контрольные точки кратно 4 (шире покрытие за меньше запросов)
  const checkpoints = [start];
  let p = start;
  while (p < maxPages) {
    p = Math.min(p * 4, maxPages);
    if (!checkpoints.includes(p)) checkpoints.push(p);
  }

  progressCb?.(`Параллельная разведка (${checkpoints.length} точек)…`);

  // Promise.all сохраняет порядок — results[i] соответствует checkpoints[i]
  const results = await Promise.all(
    checkpoints.map(cp =>
      testImageWithRetry(imageUrl(unit, archNum, cp)).then(ok => ({ page: cp, ok }))
    )
  );

  // Находим переход ok→false
  let lo = start, hi = null;
  for (const { page, ok } of results) {
    if (ok) lo = page;
    else    { hi = page; break; }
  }

  if (hi === null) return lo; // все контрольные точки существуют

  // Бинарный поиск между lo и hi
  while (lo < hi - 1) {
    await waitIfPaused();
    const mid = Math.floor((lo + hi) / 2);
    progressCb?.(`Уточнение: страница ${mid}…`);
    if (await testImageWithRetry(imageUrl(unit, archNum, mid))) lo = mid;
    else hi = mid;
  }

  return lo;
}

// ── Вспомогательные загрузки (метаданные и лог ошибок) ──────────────────────

/**
 * Сохраняет _meta.txt рядом со страницами документа.
 * Содержит реквизиты дела, URL, дату скачивания.
 * Идея из vol-archive-grabber (сохранение desc.html).
 */
function downloadMetadata(folderName, unit, totalPages, titleRaw) {
  const pageMeta = collectPageMeta();

  const lines = [
    `Архив: ${location.hostname}`,
    `URL документа: ${location.href}`,
    `Unit ID: ${unit}`,
    `Название: ${titleRaw || 'не определено'}`,
    `Страниц найдено: ${totalPages}`,
    `Дата скачивания: ${new Date().toLocaleString('ru-RU')}`,
  ];

  if (pageMeta) {
    lines.push('', '── Реквизиты дела ──', pageMeta);
  }

  const encoded = 'data:text/plain;charset=utf-8,' + encodeURIComponent(lines.join('\n'));
  chrome.runtime.sendMessage({
    type: 'DOWNLOAD',
    url:      encoded,
    filename: `${folderName}/_meta.txt`
  });
}

/**
 * Сохраняет _errors.txt со списком пропущенных страниц.
 * Идея из Rusneb-Downloader (логирование проблем в отдельный файл).
 */
function downloadErrorLog(folderName, failedPages) {
  if (!failedPages.length) return;

  const lines = [
    `Не удалось скачать страниц: ${failedPages.length}`,
    `Номера: ${failedPages.join(', ')}`,
    '',
    'Попробуйте скачать эти страницы вручную или выставьте диапазон в расширении.',
  ];

  const encoded = 'data:text/plain;charset=utf-8,' + encodeURIComponent(lines.join('\n'));
  chrome.runtime.sendMessage({
    type: 'DOWNLOAD',
    url:      encoded,
    filename: `${folderName}/_errors.txt`
  });
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

  setIcon('active');

  try {
    // Определяем номер архива (из URL или перебором вариантов)
    sendStatus('Определение архива…');
    const archNum = await detectArchiveNum(unit);
    log('using archiveNum:', archNum);

    const titleRaw   = getTitleFromPage();
    const folderName = `${sanitizeForFilename(titleRaw)}_unit_${unit}`;
    const concLimit  = cfg.concurrentDownloads ?? MAX_CONCURRENT_DOWNLOADS;

    let pFrom, total;
    let isResuming = false;

    // ── Проверяем наличие сохранённого прогресса ──────────────────────────
    if (overrideFrom === null) {
      const saved = await getResumeState(unit);
      if (saved?.lastPage && saved?.totalPages) {
        isResuming = true;
        pFrom      = saved.lastPage + 1;
        total      = saved.totalPages;

        const ageMin = Math.round((Date.now() - (saved.savedAt ?? 0)) / 60000);
        sendStatus(`Продолжение с стр. ${pFrom} / ${total} (${ageMin} мин. назад)…`);
        await sleep(1200);
      }
    }

    // ── Обычный старт: обнаруживаем страницы ─────────────────────────────
    if (!isResuming) {
      sendStatus(cfg.createFolders ? `Папка: ${folderName}` : 'Файлы в корне загрузок');

      const start = overrideFrom != null
        ? overrideFrom
        : (cfg.startFromCurrent ? detectCurrentPage() : 1);

      sendStatus(`Поиск страниц, начиная с ${start}…`);
      const discovered = await findTotalPages(unit, archNum, start, cfg.maxPages, t => sendStatus(t));

      if (!discovered) {
        sendDone('Страницы не найдены');
        clearResumeState(unit);
        return;
      }

      total = overrideTo != null ? Math.min(overrideTo, discovered) : discovered;
      pFrom = overrideFrom != null ? overrideFrom : 1;

      // Метаданные сохраняем только при первом запуске (не при возобновлении)
      if (cfg.createFolders) {
        downloadMetadata(folderName, unit, total, titleRaw);
      }
    }

    const padWidth    = String(total).length || 3;
    const failedPages = [];

    // ── Основной цикл загрузки ────────────────────────────────────────────
    for (let p = pFrom; p <= total; p++) {
      await waitIfPaused();
      sendProgress(p - pFrom + 1, total - pFrom + 1);
      sendStatus(`Скачивание ${p} / ${total}`);

      const filename = cfg.createFolders
        ? `${folderName}/${pad(p, padWidth)}.jpg`
        : `unit_${unit}_p${pad(p, padWidth)}.jpg`;

      await downloadWithSemaphore(imageUrl(unit, archNum, p), filename, concLimit);

      // Сохраняем прогресс каждые 10 страниц для возможности возобновления
      if (p % 10 === 0) {
        saveResumeState(unit, { lastPage: p, totalPages: total, folderName, fromPage: pFrom });
      }

      await sleep(cfg.delayMs);
    }

    // ── Завершение ────────────────────────────────────────────────────────
    if (cfg.createFolders && failedPages.length > 0) {
      downloadErrorLog(folderName, failedPages);
    }

    clearResumeState(unit);

    const failedNote = failedPages.length > 0 ? ` (пропущено: ${failedPages.length})` : '';
    sendDone(`Готово: ${total - pFrom + 1} стр.${failedNote}`, { failedCount: failedPages.length });

  } catch (e) {
    if (e.message === 'stopped') {
      // Прогресс уже сохранён в цикле каждые 10 страниц
      sendDone('Остановлено');
    } else {
      console.error('[YARchive] downloadAll error:', e);
      sendDone('Ошибка: ' + e.message);
    }
  } finally {
    isRunning         = false;
    isPaused          = false;
    isStopped         = false;
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

  const archNum    = await detectArchiveNum(unit);
  const titleRaw   = getTitleFromPage();
  const folderName = `${sanitizeForFilename(titleRaw)}_unit_${unit}`;
  const p          = detectCurrentPage();

  setIcon('active');

  const filename = cfg.createFolders
    ? `${folderName}/${pad(p, 3)}.jpg`
    : `unit_${unit}_p${pad(p, 3)}.jpg`;

  chrome.runtime.sendMessage({ type: 'DOWNLOAD', url: imageUrl(unit, archNum, p), filename });

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
      if (isRunning && !isPaused) { isPaused = true; sendStatus('Пауза'); }
      break;

    case 'RESUME':
      if (isRunning && isPaused) { isPaused = false; sendStatus('Продолжение…'); }
      break;

    case 'STOP':
      if (isRunning) { isStopped = true; isPaused = false; sendStatus('Остановка…'); }
      break;

    case 'GET_STATE': {
      const unit = getUnitId();

      const respond = (resumeState) => sendResponse({
        isRunning,
        isPaused,
        currentPage:   detectCurrentPage(),
        isArchivePage: !!unit,
        resumeState
      });

      if (unit) {
        getResumeState(unit).then(respond);
      } else {
        respond(null);
      }
      return true; // асинхронный ответ
    }

    case 'CLEAR_RESUME': {
      const unit = getUnitId();
      if (unit) clearResumeState(unit);
      break;
    }
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
