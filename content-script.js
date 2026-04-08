const DEBUG = false;
const log   = (...args) => DEBUG && console.log('[YARchive]', ...args);

// ── Настройки ────────────────────────────────────────────────────────────────

const DEFAULTS = {
  createFolders:       true,
  delayMs:             250,
  maxPages:            1500,
  startFromCurrent:    true,
  concurrentDownloads: 4,
  theme:               'auto'
};

let settingsCache = null;

function getSettings() {
  return new Promise(resolve => {
    chrome.storage.sync.get(DEFAULTS, items => {
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

// ── Кэш номера архива ──
let cachedArchNum = null;

// ── Возобновление загрузки ──

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

// ── Состояние загрузки ──

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

// ── Хелперы общения с background/popup ──

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

// ── Утилиты DOM / URL ──

function getUnitId() {
  const m = location.pathname.match(/\/unit\/(\d+)/);
  return m ? m[1] : null;
}

function getTitleFromPage() {
  const h = document.querySelector('h1.title');
  return h && h.textContent ? h.textContent.trim() : null;
}

/**
 * Собирает плоский текстовый список реквизитов документа
 * (для вставки в _meta.txt).
 */
function collectPageMeta() {
  const lines = [];

  document.querySelectorAll('table.table tr, .unit-info tr, .well tr').forEach(row => {
    const cells = [...row.querySelectorAll('td, th')].map(c => c.textContent.trim()).filter(Boolean);
    if (cells.length >= 2) lines.push(cells.join(': '));
  });

  if (!lines.length) {
    document.querySelectorAll('.well p, .description p, .card-body p').forEach(p => {
      const t = p.textContent.trim();
      if (t) lines.push(t);
    });
  }

  return lines.slice(0, 30).join('\n');
}

/**
 * Собирает структурированный объект реквизитов документа:
 * ключ → значение из таблиц на странице.
 * Используется для экспорта в CSV / JSON / BibTeX.
 * @returns {Record<string, string>}
 */
function collectStructuredMeta() {
  const result = {};

  document.querySelectorAll('table.table tr, .unit-info tr, .well tr').forEach(row => {
    const cells = [...row.querySelectorAll('td, th')]
      .map(c => c.textContent.trim())
      .filter(Boolean);
    if (cells.length >= 2) {
      const key   = cells[0].replace(/:$/, '').trim();
      const value = cells.slice(1).join('; ').trim();
      if (key && value) result[key] = value;
    }
  });

  if (!Object.keys(result).length) {
    let idx = 0;
    document.querySelectorAll('.well p, .description p, .card-body p').forEach(p => {
      const t = p.textContent.trim();
      if (t) result[`Описание ${++idx}`] = t;
    });
  }

  return result;
}

/**
 * Возвращает полный объект метаданных текущего документа.
 * Используется обработчиком GET_METADATA для экспорта.
 */
function getFullMetadata() {
  const unit     = getUnitId();
  const title    = getTitleFromPage();
  const metaRows = collectStructuredMeta();

  return {
    unitId:      unit     || '',
    title:       title    || '',
    archive:     location.hostname,
    archiveNum:  cachedArchNum || '',
    url:         location.href,
    currentPage: detectCurrentPage(),
    accessedAt:  new Date().toISOString(),
    fields:      metaRows   // { "Фонд": "...", "Опись": "...", … }
  };
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

// ── Определение номера архива ──

async function detectArchiveNum(unit) {
  if (cachedArchNum) return cachedArchNum;

  const fromPath = location.pathname.match(/\/archive(\d+)\//)?.[1];
  if (fromPath) { cachedArchNum = fromPath; return fromPath; }

  log('archiveNum not in pathname, probing variants…');
  const CANDIDATES = ['1', '27', '2', '3', '4', '5'];
  for (const n of CANDIDATES) {
    const url = `${location.origin}/archive${n}/image/${unit}?n=1&_ts=${Date.now()}`;
    const ok  = await testImage(url, 4000);
    if (ok) {
      log('archiveNum detected:', n);
      cachedArchNum = n;
      return n;
    }
  }

  log('archiveNum fallback: 27');
  cachedArchNum = '27';
  return '27';
}

// ── Проверка существования страницы ──

function testImage(url, timeout = TEST_TIMEOUT) {
  return new Promise(resolve => {
    const img = new Image();
    let done  = false;

    const finish = result => {
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

// ── Семафор загрузок ──

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

// ── Бинарный поиск числа страниц ──

async function findTotalPages(unit, archNum, start, maxPages, progressCb) {
  await waitIfPaused();

  progressCb?.(`Проверка страницы ${start}…`);
  if (!await testImageWithRetry(imageUrl(unit, archNum, start))) return 0;

  const checkpoints = [start];
  let p = start;
  while (p < maxPages) {
    p = Math.min(p * 4, maxPages);
    if (!checkpoints.includes(p)) checkpoints.push(p);
  }

  progressCb?.(`Параллельная разведка (${checkpoints.length} точек)…`);

  const results = await Promise.all(
    checkpoints.map(cp =>
      testImageWithRetry(imageUrl(unit, archNum, cp)).then(ok => ({ page: cp, ok }))
    )
  );

  let lo = start, hi = null;
  for (const { page, ok } of results) {
    if (ok) lo = page;
    else    { hi = page; break; }
  }

  if (hi === null) return lo;

  while (lo < hi - 1) {
    await waitIfPaused();
    const mid = Math.floor((lo + hi) / 2);
    progressCb?.(`Уточнение: страница ${mid}…`);
    if (await testImageWithRetry(imageUrl(unit, archNum, mid))) lo = mid;
    else hi = mid;
  }

  return lo;
}

// ── Метаданные и лог ошибок ──

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

  if (pageMeta) lines.push('', '── Реквизиты дела ──', pageMeta);

  const encoded = 'data:text/plain;charset=utf-8,' + encodeURIComponent(lines.join('\n'));
  chrome.runtime.sendMessage({ type: 'DOWNLOAD', url: encoded, filename: `${folderName}/_meta.txt` });
}

function downloadErrorLog(folderName, failedPages) {
  if (!failedPages.length) return;

  const lines = [
    `Не удалось скачать страниц: ${failedPages.length}`,
    `Номера: ${failedPages.join(', ')}`,
    '',
    'Попробуйте скачать эти страницы вручную или выставьте диапазон в расширении.',
  ];

  const encoded = 'data:text/plain;charset=utf-8,' + encodeURIComponent(lines.join('\n'));
  chrome.runtime.sendMessage({ type: 'DOWNLOAD', url: encoded, filename: `${folderName}/_errors.txt` });
}

// ── История загрузок ──

const HISTORY_KEY     = 'yar_history';
const HISTORY_MAX_LEN = 50;

/** Добавляет запись в историю загрузок. Общий размер ограничен HISTORY_MAX_LEN.*/
function saveHistory(entry) {
  chrome.storage.local.get({ [HISTORY_KEY]: [] }, data => {
    const prev    = Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : [];
    const updated = [
      { ...entry, savedAt: Date.now() },
      ...prev.filter(e => String(e.unit) !== String(entry.unit))
    ].slice(0, HISTORY_MAX_LEN);
    chrome.storage.local.set({ [HISTORY_KEY]: updated });
  });
}

// ── PDF: парсинг заголовка ──

function parseJpegHeader(bytes) {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xFF) { i++; continue; }
    const m = bytes[i + 1];

    if (m === 0xC0 || m === 0xC1 || m === 0xC2 || m === 0xC3) {
      const nComp = bytes[i + 9];
      return {
        h:  (bytes[i + 5] << 8) | bytes[i + 6],
        w:  (bytes[i + 7] << 8) | bytes[i + 8],
        cs: nComp === 1 ? '/DeviceGray' : nComp === 4 ? '/DeviceCMYK' : '/DeviceRGB'
      };
    }

    if (m === 0xD8 || m === 0xD9 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }

    if (i + 3 >= bytes.length) break;
    const segLen = (bytes[i + 2] << 8) | bytes[i + 3];
    if (segLen < 2) break;
    i += 2 + segLen;
  }

  return { w: 2480, h: 3508, cs: '/DeviceGray' };
}

// ── PDF: компоновщик ──

function buildPDF(pages) {
  const enc    = new TextEncoder();
  const chunks = [];
  const xref   = {};
  let pos      = 0;

  function write(data) {
    const chunk = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(chunk);
    pos += chunk.length;
  }

  function obj(id, fn) {
    xref[id] = pos;
    write(`${id} 0 obj\n`);
    fn();
    write('\nendobj\n');
  }

  write('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n');

  obj(1, () => write('<< /Type /Catalog /Pages 2 0 R >>'));

  const kidRefs = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(2, () => write(`<< /Type /Pages /Kids [${kidRefs}] /Count ${pages.length} >>`));

  for (let i = 0; i < pages.length; i++) {
    const { bytes, w, h, cs } = pages[i];
    const pageId = 3 + i * 3;
    const xobjId = 4 + i * 3;
    const cntId  = 5 + i * 3;

    obj(xobjId, () => {
      write(
        `<< /Type /XObject /Subtype /Image ` +
        `/Width ${w} /Height ${h} ` +
        `/ColorSpace ${cs} /BitsPerComponent 8 ` +
        `/Filter /DCTDecode /Length ${bytes.length} >>\n` +
        `stream\n`
      );
      write(bytes);
      write('\nendstream');
    });

    const csBytes = enc.encode(`q ${w} 0 0 ${h} 0 0 cm /Im Do Q`);
    obj(cntId, () => {
      write(`<< /Length ${csBytes.length} >>\nstream\n`);
      write(csBytes);
      write('\nendstream');
    });

    obj(pageId, () => {
      write(
        `<< /Type /Page /Parent 2 0 R ` +
        `/MediaBox [0 0 ${w} ${h}] ` +
        `/Resources << /XObject << /Im ${xobjId} 0 R >> >> ` +
        `/Contents ${cntId} 0 R >>`
      );
    });
  }

  const xrefStart = pos;
  const objCount  = 3 + pages.length * 3;
  write(`xref\n0 ${objCount}\n`);
  write('0000000000 65535 f\r\n');
  for (let id = 1; id < objCount; id++) {
    write(`${String(xref[id] ?? 0).padStart(10, '0')} 00000 n\r\n`);
  }

  write(`trailer\n<< /Size ${objCount} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

  const total  = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let offset   = 0;
  for (const c of chunks) { result.set(c, offset); offset += c.length; }
  return result;
}

// ── Генерация PDF ──

async function generatePDF(overrideFrom = null, overrideTo = null) {
  if (isRunning) return;
  isRunning = true;
  isPaused  = false;
  isStopped = false;

  const cfg  = await ensureSettings();
  const unit = getUnitId();

  if (!unit) {
    sendDone('PDF: не удалось определить unit');
    isRunning = false;
    setIcon('inactive');
    return;
  }

  setIcon('active');

  try {
    sendStatus('PDF: определение архива…');
    const archNum  = await detectArchiveNum(unit);
    const titleRaw = getTitleFromPage();
    const filename = `${sanitizeForFilename(titleRaw)}_unit_${unit}.pdf`;

    const start = overrideFrom != null
      ? overrideFrom
      : (cfg.startFromCurrent ? detectCurrentPage() : 1);

    sendStatus(`PDF: поиск страниц начиная с ${start}…`);
    const discovered = await findTotalPages(
      unit, archNum, start, cfg.maxPages,
      t => sendStatus(`PDF: ${t}`)
    );

    if (!discovered) {
      sendDone('PDF: страницы не найдены');
      return;
    }

    const last  = overrideTo != null ? Math.min(overrideTo, discovered) : discovered;
    const total = last - start + 1;

    if (total > 300) {
      sendStatus(
        `PDF: ${total} стр. — потребуется несколько минут ` +
        `и ~${Math.round(total * 0.3)} МБ памяти…`
      );
      await sleep(2000);
    }

    const pagesData  = [];
    const failedNums = [];

    for (let p = start; p <= last; p++) {
      await waitIfPaused();
      sendProgress(p - start + 1, total);
      sendStatus(`PDF: загрузка ${p} / ${last}`);

      try {
        const res = await fetch(imageUrl(unit, archNum, p));
        if (res.ok) {
          const buf   = await res.arrayBuffer();
          const bytes = new Uint8Array(buf);
          pagesData.push({ bytes, ...parseJpegHeader(bytes) });
        } else {
          failedNums.push(p);
          log(`PDF: пропуск стр. ${p} (HTTP ${res.status})`);
        }
      } catch (e) {
        failedNums.push(p);
        log('PDF: ошибка загрузки стр.', p, e);
      }

      await sleep(cfg.delayMs);
    }

    if (!pagesData.length) {
      sendDone('PDF: нет данных для сборки');
      return;
    }

    sendStatus(`PDF: сборка ${pagesData.length} страниц…`);
    const pdfBytes = buildPDF(pagesData);

    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 60_000);

    const failNote = failedNums.length ? ` (пропущено: ${failedNums.length})` : '';
    sendDone(
      `PDF готов: ${pagesData.length} стр.${failNote}`,
      { isPDF: true, failedCount: failedNums.length }
    );

    saveHistory({
      unit,
      title:     titleRaw || `Документ ${unit}`,
      pages:     pagesData.length,
      timestamp: Date.now(),
      url:       location.href,
      format:    'pdf'
    });

  } catch (e) {
    if (e.message === 'stopped') {
      sendDone('PDF: остановлено');
    } else {
      console.error('[YARchive] generatePDF error:', e);
      sendDone('PDF: ошибка — ' + e.message);
    }
  } finally {
    isRunning         = false;
    isPaused          = false;
    isStopped         = false;
    downloadsInFlight = 0;
    setIcon('inactive');
  }
}

// ── Скачать весь документ (JPG) ──

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
    sendStatus('Определение архива…');
    const archNum = await detectArchiveNum(unit);
    log('using archiveNum:', archNum);

    const titleRaw   = getTitleFromPage();
    const folderName = `${sanitizeForFilename(titleRaw)}_unit_${unit}`;
    const concLimit  = cfg.concurrentDownloads ?? MAX_CONCURRENT_DOWNLOADS;

    let pFrom, total;
    let isResuming = false;

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

      if (cfg.createFolders) downloadMetadata(folderName, unit, total, titleRaw);
    }

    const padWidth    = String(total).length || 3;
    const failedPages = [];

    for (let p = pFrom; p <= total; p++) {
      await waitIfPaused();
      sendProgress(p - pFrom + 1, total - pFrom + 1);
      sendStatus(`Скачивание ${p} / ${total}`);

      const filename = cfg.createFolders
        ? `${folderName}/${pad(p, padWidth)}.jpg`
        : `unit_${unit}_p${pad(p, padWidth)}.jpg`;

      await downloadWithSemaphore(imageUrl(unit, archNum, p), filename, concLimit);

      if (p % 10 === 0) {
        saveResumeState(unit, { lastPage: p, totalPages: total, folderName, fromPage: pFrom });
      }

      await sleep(cfg.delayMs);
    }

    if (cfg.createFolders && failedPages.length > 0) downloadErrorLog(folderName, failedPages);

    clearResumeState(unit);

    const failedNote = failedPages.length > 0 ? ` (пропущено: ${failedPages.length})` : '';
    sendDone(`Готово: ${total - pFrom + 1} стр.${failedNote}`, { failedCount: failedPages.length });

    saveHistory({
      unit,
      title:     getTitleFromPage() || `Документ ${unit}`,
      pages:     total - pFrom + 1 - failedPages.length,
      timestamp: Date.now(),
      url:       location.href,
      format:    'jpg'
    });

  } catch (e) {
    if (e.message === 'stopped') {
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

// ── Скачать текущую страницу ───

async function downloadCurrent() {
  const cfg  = await ensureSettings();
  const unit = getUnitId();

  if (!unit) { sendStatus('Unit не определён'); return; }

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

// ── Обработчик сообщений от popup ──

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.type) return;

  switch (msg.type) {

    case 'DOWNLOAD_ALL':
      downloadAll(msg.fromPage ?? null, msg.toPage ?? null);
      break;

    case 'DOWNLOAD_CURRENT':
      downloadCurrent();
      break;

    case 'GENERATE_PDF':
      generatePDF(msg.fromPage ?? null, msg.toPage ?? null);
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
      const unit    = getUnitId();
      const curPage = detectCurrentPage();

      const previewUrl = (unit && cachedArchNum)
        ? imageUrl(unit, cachedArchNum, curPage)
        : null;

      const respond = resumeState => sendResponse({
        isRunning,
        isPaused,
        currentPage:   curPage,
        isArchivePage: !!unit,
        unit,
        title:         getTitleFromPage(),
        previewUrl,
        resumeState
      });

      if (unit) getResumeState(unit).then(respond);
      else      respond(null);
      return true;
    }

    case 'GET_METADATA': {
      // Возвращает структурированные метаданные текущего документа.
      // Используется popup для экспорта в CSV / JSON / BibTeX.
      const unit = getUnitId();
      if (!unit) {
        sendResponse({ error: 'not_archive_page' });
      } else {
        sendResponse({ ok: true, data: getFullMetadata() });
      }
      return true;
    }

    case 'CLEAR_RESUME': {
      const unit = getUnitId();
      if (unit) clearResumeState(unit);
      break;
    }
  }
});

// ── Инициализация ──

ensureSettings().then(async () => {
  try {
    const unit = getUnitId();
    if (unit) {
      await detectArchiveNum(unit);
      setIcon('active');
    } else {
      setIcon('inactive');
    }
  } catch (e) {
    log('init error:', e);
    setIcon('inactive');
  }
});

log('content-script loaded (v2.2.2)');
