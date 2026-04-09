const DEBUG = false;
const log   = (...args) => DEBUG && console.log('[YARchive]', ...args);

// ── Настройки ────────────────────────────────────────────────────────────────

const DEFAULTS = {
  createFolders:       true,
  delayMs:             250,
  maxPages:            1500,
  startFromCurrent:    true,
  concurrentDownloads: 4,
  adaptiveSpeed:       false,
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

// ── Кэш номера архива ─────────────────────────────────────────────────────────
let cachedArchNum = null;

// ── IndexedDB — хранилище resume-state и кэша изображений ────────────────────
// Dexie.js требует локального файла. Вместо него — минимальный нативный wrapper с graceful fallback на chrome.storage.local при недоступности IDB

const IDB_NAME    = 'yarchive_v1';
const IDB_VERSION = 1;
const IMG_TTL_MS  = 24 * 60 * 60 * 1000; // 24 часа

let _idb      = null;   // открытое соединение
let _idbDead  = false;  // флаг: IDB недоступен, используем fallback

/** Открывает БД (идемпотентно). */
function idbOpen() {
  if (_idb)     return Promise.resolve(_idb);
  if (_idbDead) return Promise.reject(new Error('IDB unavailable'));

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);

    req.onupgradeneeded = ({ target: { result: db } }) => {
      if (!db.objectStoreNames.contains('resume')) {
        db.createObjectStore('resume', { keyPath: 'unit' });
      }
      if (!db.objectStoreNames.contains('imgcache')) {
        const s = db.createObjectStore('imgcache', { keyPath: 'cacheKey' });
        s.createIndex('byUnit',     'unit',     { unique: false });
        s.createIndex('byCachedAt', 'cachedAt', { unique: false });
      }
    };

    req.onsuccess = ({ target: { result: db } }) => {
      _idb = db;
      _idb.onerror = ev => log('IDB error:', ev.target.error);
      resolve(_idb);
    };

    req.onerror = ({ target: { error } }) => {
      _idbDead = true;
      log('IDB open failed, using storage.local fallback:', error);
      reject(error);
    };

    req.onblocked = () => log('IDB upgrade blocked — another tab open?');
  });
}

/** Выполняет транзакционную операцию, возвращая Promise. */
function idbTx(storeName, mode, fn) {
  return idbOpen().then(db => new Promise((resolve, reject) => {
    const tx    = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;

    try { result = fn(store, tx); }
    catch (e) { reject(e); return; }

    // Если fn вернула IDBRequest — дожидаемся его
    if (result && typeof result.onsuccess === 'undefined' && result instanceof Promise) {
      result.then(resolve, reject);
      return;
    }

    tx.oncomplete = () => resolve(result?.result ?? result);
    tx.onerror    = ({ target: { error } }) => reject(error);
  }));
}

// ── Resume-state API ──────────────────────────────────────────────────────────

/** Ключ для chrome.storage.local fallback */
const resumeKey = unit => `yar_resume_${unit}`;

async function saveResumeState(unit, state) {
  const record = { unit, ...state, savedAt: Date.now() };
  try {
    await idbTx('resume', 'readwrite', store => store.put(record));
  } catch {
    // Fallback: chrome.storage.local (fire-and-forget)
    chrome.storage.local.set({ [resumeKey(unit)]: record });
  }
}

async function getResumeState(unit) {
  try {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const req = db.transaction('resume', 'readonly')
                    .objectStore('resume')
                    .get(unit);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = ({ target: { error } }) => reject(error);
    });
  } catch {
    return new Promise(resolve => {
      chrome.storage.local.get(resumeKey(unit), r => resolve(r[resumeKey(unit)] ?? null));
    });
  }
}

async function clearResumeState(unit) {
  try {
    await idbTx('resume', 'readwrite', store => store.delete(unit));
  } catch {
    log('IDB clearResume failed');
  }
  // Дополнительно чистим storage.local на случай старых записей
  chrome.storage.local.remove(resumeKey(unit));
}

// ── Image-cache API ───────────────────────────────────────────────────────────

const imgCacheKey = (unit, page) => `${unit}_${page}`;

/**
 * Возвращает кэшированные байты страницы или null, если кэш устарел/отсутствует.
 * @returns {Promise<Uint8Array|null>}
 */
async function imgCacheGet(unit, page) {
  try {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const req = db.transaction('imgcache', 'readonly')
                    .objectStore('imgcache')
                    .get(imgCacheKey(unit, page));
      req.onsuccess = () => {
        const rec = req.result;
        resolve((rec && (Date.now() - rec.cachedAt) < IMG_TTL_MS) ? rec.bytes : null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/**
 * Сохраняет байты страницы в кэш (fire-and-forget, ошибки не критичны).
 * @param {string}     unit
 * @param {number}     page
 * @param {Uint8Array} bytes
 */
function imgCachePut(unit, page, bytes) {
  idbTx('imgcache', 'readwrite', store =>
    store.put({ cacheKey: imgCacheKey(unit, page), unit, page, bytes, cachedAt: Date.now() })
  ).catch(() => {});
}

/**
 * Удаляет все кэшированные страницы заданного документа.
 * Вызывается после успешной сборки PDF (кэш больше не нужен).
 */
async function imgCacheClear(unit) {
  try {
    const db = await idbOpen();
    await new Promise((resolve) => {
      const tx  = db.transaction('imgcache', 'readwrite');
      const idx = tx.objectStore('imgcache').index('byUnit');
      const req = idx.openCursor(IDBKeyRange.only(unit));
      req.onsuccess = ({ target: { result: cursor } }) => {
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
      tx.oncomplete = () => resolve();
      tx.onerror    = () => resolve();
    });
  } catch { /* не критично */ }
}

// ── Адаптивный троттлер ───────────────────────────────────────────────────────

/**
 * Отслеживает ответы сервера и автоматически корректирует задержку:
 * — при 429 / 503          → экспоненциальный бэкофф (макс. 8 с)
 * — при N последовательных успехах → плавное снижение к базовому значению
 */
class AdaptiveThrottle {
  constructor() {
    this.baseDelay    = 250;
    this.currentDelay = 250;
    this.enabled      = false;
    this._ok          = 0;   // consecutive successes
    this._fail        = 0;   // consecutive failures
    this._REDUCE_AT   = 30;  // успехов до снижения
    this._MAX_DELAY   = 8000;
  }

  /** Обновляет параметры из настроек (вызывается в начале каждой сессии). */
  configure(baseDelay, enabled) {
    this.baseDelay = baseDelay;
    this.enabled   = enabled;
    if (!enabled) this.currentDelay = baseDelay;
  }

  /** Текущая задержка (мс). */
  get delay() {
    return this.enabled ? this.currentDelay : this.baseDelay;
  }

  /** Вызывается при успешном HTTP-ответе. */
  onSuccess() {
    if (!this.enabled) return;
    this._fail = 0;
    this._ok++;
    if (this._ok >= this._REDUCE_AT && this.currentDelay > this.baseDelay) {
      this.currentDelay = Math.max(this.baseDelay, Math.round(this.currentDelay * 0.80));
      this._ok = 0;
      log(`[throttle] reduced → ${this.currentDelay} ms`);
      sendStatus(`↓ Задержка снижена до ${this.currentDelay} мс`);
    }
  }

  /**
   * Вызывается при получении 429 / 503 или таймауте.
   * @param {number} status  HTTP-статус (0 = таймаут/сетевая ошибка)
   */
  onRateLimit(status = 0) {
    if (!this.enabled) return;
    this._ok = 0;
    this._fail++;
    const prev        = this.currentDelay;
    this.currentDelay = Math.min(this._MAX_DELAY, Math.round(prev * 2 + 1000));
    log(`[throttle] backed off: ${prev} → ${this.currentDelay} ms (status=${status})`);
    sendStatus(`⚠ Сервер (${status || 'timeout'}) — задержка увеличена до ${this.currentDelay} мс`);
  }

  /** Сброс в начало новой сессии (без изменения baseDelay / enabled). */
  reset() {
    this._ok = this._fail = 0;
    this.currentDelay = this.baseDelay;
  }
}

const throttle = new AdaptiveThrottle();

// ── Состояние загрузки ────────────────────────────────────────────────────────

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

// ── Хелперы общения с background/popup ───────────────────────────────────────

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

// ── Утилиты DOM / URL ─────────────────────────────────────────────────────────

function getUnitId() {
  const m = location.pathname.match(/\/unit\/(\d+)/);
  return m ? m[1] : null;
}

function getTitleFromPage() {
  const h = document.querySelector('h1.title');
  return h && h.textContent ? h.textContent.trim() : null;
}

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

function collectStructuredMeta() {
  const result = {};
  document.querySelectorAll('table.table tr, .unit-info tr, .well tr').forEach(row => {
    const cells = [...row.querySelectorAll('td, th')]
      .map(c => c.textContent.trim()).filter(Boolean);
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

function getFullMetadata() {
  return {
    unitId:      getUnitId()     || '',
    title:       getTitleFromPage() || '',
    archive:     location.hostname,
    archiveNum:  cachedArchNum || '',
    url:         location.href,
    currentPage: detectCurrentPage(),
    accessedAt:  new Date().toISOString(),
    fields:      collectStructuredMeta()
  };
}

function sanitizeForFilename(s) {
  if (!s) return 'untitled';
  let str = String(s).trim()
    .replace(/[\u0000-\u001F]/g, '')
    .replace(/[\/\\:*?"<>|]+/g, '_')
    .replace(/[\s_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (str.length > 100 ? str.slice(0, 100) : str) || 'untitled';
}

function imageUrl(unit, archNum, page) {
  return `${location.origin}/archive${archNum}/image/${unit}?n=${page}`;
}

function pad(num, w) { return String(num).padStart(w, '0'); }

function detectCurrentPage() {
  for (const img of document.querySelectorAll('img')) {
    try {
      if (img.src?.includes('/image/')) {
        const m = img.src.match(/[?&]n=(\d+)/);
        if (m) return Number(m[1]);
      }
    } catch { /* ignore */ }
  }
  return 1;
}

// ── Определение номера архива ─────────────────────────────────────────────────

async function detectArchiveNum(unit) {
  if (cachedArchNum) return cachedArchNum;

  const fromPath = location.pathname.match(/\/archive(\d+)\//)?.[1];
  if (fromPath) { cachedArchNum = fromPath; return fromPath; }

  log('archiveNum not in pathname, probing…');
  for (const n of ['1', '27', '2', '3', '4', '5']) {
    const ok = await testImage(
      `${location.origin}/archive${n}/image/${unit}?n=1&_ts=${Date.now()}`, 4000
    );
    if (ok) { cachedArchNum = n; return n; }
  }
  cachedArchNum = '27';
  return '27';
}

// ── Проверка существования страницы ──────────────────────────────────────────

function testImage(url, timeout = TEST_TIMEOUT) {
  return new Promise(resolve => {
    const img = new Image();
    let done  = false;
    const finish = r => {
      if (done) return;
      done = true;
      clearTimeout(tid);
      img.onload = img.onerror = null;
      img.src = '';
      resolve(r);
    };
    const tid = setTimeout(() => finish(false), timeout);
    img.onload  = () => finish(img.naturalWidth > 10);
    img.onerror = () => finish(false);
    img.src = url + (url.includes('?') ? '&' : '?') + '_ts=' + Date.now();
  });
}

async function testImageWithRetry(url, retries = RETRY_ATTEMPTS) {
  for (let i = 0; i <= retries; i++) {
    if (await testImage(url)) return true;
    if (i < retries) await sleep(RETRY_DELAY_MS * (i + 1));
  }
  return false;
}

// ── SHA-256 ───────────────────────────────────────────────────────────────────

/**
 * Вычисляет SHA-256 буфера и возвращает hex-строку.
 * Используется для fingerprint первой страницы в _meta.txt.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string|null>}
 */
async function sha256Hex(buffer) {
  try {
    const hash = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  } catch (e) {
    log('sha256 failed:', e);
    return null;
  }
}

// ── Семафор загрузок ──────────────────────────────────────────────────────────

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

// ── Бинарный поиск числа страниц ─────────────────────────────────────────────

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
    if (ok) lo = page; else { hi = page; break; }
  }
  if (hi === null) return lo;

  while (lo < hi - 1) {
    await waitIfPaused();
    const mid = Math.floor((lo + hi) / 2);
    progressCb?.(`Уточнение: страница ${mid}…`);
    if (await testImageWithRetry(imageUrl(unit, archNum, mid))) lo = mid; else hi = mid;
  }
  return lo;
}

// ── Метаданные ────────────────────────────────────────────────────────────────

/**
 * Скачивает _meta.txt для документа.
 * Дополнительно вычисляет SHA-256 первой страницы — это позволяет
 * при повторном скачивании проверить, не изменился ли документ на сервере.
 *
 * @param {string}      folderName
 * @param {string}      unit
 * @param {number}      totalPages
 * @param {string|null} titleRaw
 * @param {string}      archNum
 */
async function downloadMetadata(folderName, unit, totalPages, titleRaw, archNum) {
  const pageMeta = collectPageMeta();

  // SHA-256 первой страницы
  let sha256 = null;
  try {
    const res = await fetch(imageUrl(unit, archNum, 1));
    if (res.ok) {
      sha256 = await sha256Hex(await res.arrayBuffer());
    }
  } catch (e) {
    log('SHA-256 fetch error:', e);
  }

  const lines = [
    `Архив: ${location.hostname}`,
    `URL документа: ${location.href}`,
    `Unit ID: ${unit}`,
    `Название: ${titleRaw || 'не определено'}`,
    `Страниц найдено: ${totalPages}`,
    `Дата скачивания: ${new Date().toLocaleString('ru-RU')}`,
  ];

  if (sha256) {
    lines.push(`SHA-256 (стр. 1): ${sha256}`);
    lines.push(`  (для проверки: повторно скачайте стр. 1 и сравните хэш)`);
  }

  if (pageMeta) lines.push('', '── Реквизиты дела ──', pageMeta);

  const encoded = 'data:text/plain;charset=utf-8,' + encodeURIComponent(lines.join('\n'));
  chrome.runtime.sendMessage({
    type:     'DOWNLOAD',
    url:      encoded,
    filename: `${folderName}/_meta.txt`
  });
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
  chrome.runtime.sendMessage({
    type:     'DOWNLOAD',
    url:      encoded,
    filename: `${folderName}/_errors.txt`
  });
}

// ── История загрузок ──────────────────────────────────────────────────────────

const HISTORY_KEY     = 'yar_history';
const HISTORY_MAX_LEN = 50;

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

// ── PDF: парсинг JPEG-заголовка ───────────────────────────────────────────────

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

// ── PDF: компоновщик ──────────────────────────────────────────────────────────

function buildPDF(pages) {
  const enc    = new TextEncoder();
  const chunks = [];
  const xref   = {};
  let pos      = 0;

  function write(data) {
    const chunk = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(chunk); pos += chunk.length;
  }
  function obj(id, fn) {
    xref[id] = pos; write(`${id} 0 obj\n`); fn(); write('\nendobj\n');
  }

  write('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n');
  obj(1, () => write('<< /Type /Catalog /Pages 2 0 R >>'));
  const kidRefs = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(2, () => write(`<< /Type /Pages /Kids [${kidRefs}] /Count ${pages.length} >>`));

  for (let i = 0; i < pages.length; i++) {
    const { bytes, w, h, cs } = pages[i];
    const pageId = 3 + i * 3, xobjId = 4 + i * 3, cntId = 5 + i * 3;

    obj(xobjId, () => {
      write(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} `);
      write(`/ColorSpace ${cs} /BitsPerComponent 8 `);
      write(`/Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`);
      write(bytes); write('\nendstream');
    });

    const csBytes = enc.encode(`q ${w} 0 0 ${h} 0 0 cm /Im Do Q`);
    obj(cntId, () => {
      write(`<< /Length ${csBytes.length} >>\nstream\n`);
      write(csBytes); write('\nendstream');
    });

    obj(pageId, () => {
      write(`<< /Type /Page /Parent 2 0 R `);
      write(`/MediaBox [0 0 ${w} ${h}] `);
      write(`/Resources << /XObject << /Im ${xobjId} 0 R >> >> `);
      write(`/Contents ${cntId} 0 R >>`);
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

  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out   = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// ── Probe URL (адаптивный режим для downloadAll) ──────────────────────────────

/**
 * Делает HEAD-запрос к URL и сигнализирует троттлеру о результате.
 * Вызывается каждые N страниц только при включённом adaptiveSpeed.
 * Используем GET с немедленным abort после получения статуса —
 * HEAD может быть не поддержан сервером.
 */
async function probeUrl(url) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    ctrl.abort();  // прерываем чтение тела
    clearTimeout(timer);
    if (res.status === 429 || res.status === 503) {
      throttle.onRateLimit(res.status);
    } else if (res.ok) {
      throttle.onSuccess();
    }
  } catch (e) {
    clearTimeout(timer);
    // AbortError — мы сами отменили, это успех (статус получен)
    if (!(e instanceof DOMException && e.name === 'AbortError')) {
      log('probe error (possible overload):', e);
      throttle.onRateLimit(0);
    }
  }
}

// ── Генерация PDF ─────────────────────────────────────────────────────────────

/**
 * Загружает страницы документа (сначала из IDB-кэша, потом из сети),
 * собирает PDF в памяти и сохраняет через <a download>.
 * Полностью совместимо с MV3 — без offscreen-документа и внешних библиотек.
 */
async function generatePDF(overrideFrom = null, overrideTo = null) {
  if (isRunning) return;
  isRunning = true; isPaused = false; isStopped = false;

  const cfg  = await ensureSettings();
  const unit = getUnitId();

  if (!unit) {
    sendDone('PDF: не удалось определить unit');
    isRunning = false; setIcon('inactive'); return;
  }

  throttle.configure(cfg.delayMs, cfg.adaptiveSpeed);
  throttle.reset();
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
      unit, archNum, start, cfg.maxPages, t => sendStatus(`PDF: ${t}`)
    );

    if (!discovered) { sendDone('PDF: страницы не найдены'); return; }

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
      sendStatus(`PDF: страница ${p} / ${last}` +
        (cfg.adaptiveSpeed ? ` (задержка ${throttle.delay} мс)` : ''));

      // 1. Проверяем IDB-кэш (изображение уже скачивали < 24 ч назад)
      let bytes = await imgCacheGet(unit, p);

      if (bytes) {
        log(`PDF: cache hit p${p}`);
        throttle.onSuccess();
      } else {
        // 2. Загружаем из сети, до 3 попыток при rate-limit
        const MAX_RETRIES = 3;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          try {
            const res = await fetch(imageUrl(unit, archNum, p));

            if (res.ok) {
              const buf = await res.arrayBuffer();
              bytes     = new Uint8Array(buf);
              imgCachePut(unit, p, bytes);  // сохраняем в кэш
              throttle.onSuccess();
              break;
            } else if (res.status === 429 || res.status === 503) {
              throttle.onRateLimit(res.status);
              await sleep(throttle.delay);  // ждём увеличенную паузу
              // следующая итерация = retry
            } else {
              log(`PDF: skip p${p} (HTTP ${res.status})`);
              failedNums.push(p);
              break;
            }
          } catch (e) {
            log('PDF: fetch error p' + p, e);
            failedNums.push(p);
            break;
          }
        }
        if (!bytes && !failedNums.includes(p)) failedNums.push(p);
      }

      if (bytes) pagesData.push({ bytes, ...parseJpegHeader(bytes) });

      await sleep(throttle.delay);
    }

    if (!pagesData.length) { sendDone('PDF: нет данных для сборки'); return; }

    sendStatus(`PDF: сборка ${pagesData.length} страниц…`);
    const pdfBytes = buildPDF(pagesData);

    // Сохраняем PDF через временный <a download>
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 60_000);

    // Чистим кэш — данные больше не нужны
    imgCacheClear(unit).catch(() => {});

    const failNote = failedNums.length ? ` (пропущено: ${failedNums.length})` : '';
    sendDone(`PDF готов: ${pagesData.length} стр.${failNote}`,
      { isPDF: true, failedCount: failedNums.length });

    saveHistory({
      unit, title: titleRaw || `Документ ${unit}`,
      pages: pagesData.length, timestamp: Date.now(),
      url: location.href, format: 'pdf'
    });

  } catch (e) {
    if (e.message === 'stopped') sendDone('PDF: остановлено');
    else { console.error('[YARchive] generatePDF:', e); sendDone('PDF: ошибка — ' + e.message); }
  } finally {
    isRunning = false; isPaused = false; isStopped = false;
    downloadsInFlight = 0; setIcon('inactive');
  }
}

// ── Скачать весь документ (JPG) ───────────────────────────────────────────────

async function downloadAll(overrideFrom = null, overrideTo = null) {
  if (isRunning) return;
  isRunning = true; isPaused = false; isStopped = false;

  const cfg  = await ensureSettings();
  const unit = getUnitId();

  if (!unit) {
    sendDone('Не удалось определить unit');
    isRunning = false; setIcon('inactive'); return;
  }

  throttle.configure(cfg.delayMs, cfg.adaptiveSpeed);
  throttle.reset();
  setIcon('active');

  try {
    sendStatus('Определение архива…');
    const archNum    = await detectArchiveNum(unit);
    const titleRaw   = getTitleFromPage();
    const folderName = `${sanitizeForFilename(titleRaw)}_unit_${unit}`;
    const concLimit  = cfg.concurrentDownloads ?? MAX_CONCURRENT_DOWNLOADS;

    let pFrom, total, isResuming = false;

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
        sendDone('Страницы не найдены'); clearResumeState(unit); return;
      }

      total = overrideTo != null ? Math.min(overrideTo, discovered) : discovered;
      pFrom = overrideFrom != null ? overrideFrom : 1;

      // Метаданные + SHA-256 первой страницы
      if (cfg.createFolders) {
        downloadMetadata(folderName, unit, total, titleRaw, archNum).catch(e => log('meta:', e));
      }
    }

    const padWidth    = String(total).length || 3;
    const failedPages = [];
    // Интервал зонд-проверок в адаптивном режиме (каждые 20 страниц)
    const PROBE_EVERY = 20;

    for (let p = pFrom; p <= total; p++) {
      await waitIfPaused();
      sendProgress(p - pFrom + 1, total - pFrom + 1);
      sendStatus(`Скачивание ${p} / ${total}` +
        (cfg.adaptiveSpeed ? ` (${throttle.delay} мс)` : ''));

      // В адаптивном режиме каждые PROBE_EVERY страниц проверяем сервер
      if (cfg.adaptiveSpeed && p > pFrom && (p - pFrom) % PROBE_EVERY === 0) {
        await probeUrl(imageUrl(unit, archNum, p));
        // После бэкоффа ждём уже обновлённую задержку
        await sleep(throttle.delay);
      }

      const filename = cfg.createFolders
        ? `${folderName}/${pad(p, padWidth)}.jpg`
        : `unit_${unit}_p${pad(p, padWidth)}.jpg`;

      await downloadWithSemaphore(imageUrl(unit, archNum, p), filename, concLimit);

      if (p % 10 === 0) {
        saveResumeState(unit, { lastPage: p, totalPages: total, folderName, fromPage: pFrom });
      }

      await sleep(throttle.delay);
    }

    if (cfg.createFolders && failedPages.length > 0) downloadErrorLog(folderName, failedPages);
    clearResumeState(unit);

    const failedNote = failedPages.length ? ` (пропущено: ${failedPages.length})` : '';
    sendDone(`Готово: ${total - pFrom + 1} стр.${failedNote}`, { failedCount: failedPages.length });

    saveHistory({
      unit, title: getTitleFromPage() || `Документ ${unit}`,
      pages: total - pFrom + 1 - failedPages.length,
      timestamp: Date.now(), url: location.href, format: 'jpg'
    });

  } catch (e) {
    if (e.message === 'stopped') sendDone('Остановлено');
    else { console.error('[YARchive] downloadAll:', e); sendDone('Ошибка: ' + e.message); }
  } finally {
    isRunning = false; isPaused = false; isStopped = false;
    downloadsInFlight = 0; setIcon('inactive');
  }
}

// ── Скачать текущую страницу ──────────────────────────────────────────────────

async function downloadCurrent() {
  const cfg      = await ensureSettings();
  const unit     = getUnitId();
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

// ── Обработчик сообщений от popup ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.type) return;

  switch (msg.type) {
    case 'DOWNLOAD_ALL':
      downloadAll(msg.fromPage ?? null, msg.toPage ?? null); break;
    case 'DOWNLOAD_CURRENT':
      downloadCurrent(); break;
    case 'GENERATE_PDF':
      generatePDF(msg.fromPage ?? null, msg.toPage ?? null); break;
    case 'PAUSE':
      if (isRunning && !isPaused) { isPaused = true; sendStatus('Пауза'); } break;
    case 'RESUME':
      if (isRunning && isPaused) { isPaused = false; sendStatus('Продолжение…'); } break;
    case 'STOP':
      if (isRunning) { isStopped = true; isPaused = false; sendStatus('Остановка…'); } break;

    case 'GET_STATE': {
      const unit    = getUnitId();
      const curPage = detectCurrentPage();
      const respond = rs => sendResponse({
        isRunning, isPaused, currentPage: curPage,
        isArchivePage: !!unit, unit,
        title:      getTitleFromPage(),
        previewUrl: (unit && cachedArchNum) ? imageUrl(unit, cachedArchNum, curPage) : null,
        resumeState: rs
      });
      if (unit) getResumeState(unit).then(respond);
      else      respond(null);
      return true;
    }

    case 'GET_METADATA': {
      const unit = getUnitId();
      if (!unit) sendResponse({ error: 'not_archive_page' });
      else       sendResponse({ ok: true, data: getFullMetadata() });
      return true;
    }

    case 'CLEAR_RESUME': {
      const unit = getUnitId();
      if (unit) clearResumeState(unit);
      break;
    }
  }
});

// ── Инициализация ─────────────────────────────────────────────────────────────

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
    log('init error:', e); setIcon('inactive');
  }
});

log('content-script loaded (v2.2.6)');