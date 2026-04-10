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

// ── Константы ─────────────────────────────────────────────────────────────────

const BLANK_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const ARCHIVE_NUM_MAP = {
  'af.yar-archives.ru':    '27',
  'gosarchive.gov35.ru':   '1',
  'archives.permkrai.ru':  '2',
  'archivesaratov.ru':     '3',
  'www.archivesaratov.ru': '3'
};
const ARCHIVE_PROBE_CANDIDATES = ['27', '1', '2', '3', '4', '5'];
const PDF_PAGE_HARD_LIMIT = 500;
const DOWNLOAD_TIMEOUT_MS = 60_000;

// ── Кэш номера архива ─────────────────────────────────────────────────────────
let cachedArchNum = null;

// ── IndexedDB ─────────────────────────────────────────────────────────────────

const IDB_NAME    = 'yarchive_v1';
const IDB_VERSION = 1;
const IMG_TTL_MS  = 24 * 60 * 60 * 1000;

let _idb     = null;
let _idbDead = false;

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
      _idb.onclose = () => {
        log('IDB connection closed unexpectedly – will reopen on next use');
        _idb = null;
      };
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

function idbTx(storeName, mode, fn) {
  return idbOpen().then(db => new Promise((resolve, reject) => {
    const tx    = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;

    try { result = fn(store, tx); }
    catch (e) { reject(e); return; }

    // If fn returned a Promise, delegate to it directly.
    if (result instanceof Promise) {
      result.then(resolve, reject);
      return;
    }

    tx.oncomplete = () => resolve(result?.result ?? result);
    tx.onerror    = ({ target: { error } }) => reject(error);
  }));
}

// ── Resume-state API ──────────────────────────────────────────────────────────

const resumeKey = unit => `yar_resume_${unit}`;

async function saveResumeState(unit, state) {
  const record = { unit, ...state, savedAt: Date.now() };
  try {
    await idbTx('resume', 'readwrite', store => store.put(record));
  } catch {
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
  chrome.storage.local.remove(resumeKey(unit));
}

// ── Image-cache API ───────────────────────────────────────────────────────────

const imgCacheKey = (unit, page) => `${unit}_${page}`;

async function imgCacheGet(unit, page) {
  try {
    const db = await idbOpen();
    return new Promise((resolve) => {
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

function imgCachePut(unit, page, bytes) {
  idbTx('imgcache', 'readwrite', store =>
    store.put({ cacheKey: imgCacheKey(unit, page), unit, page, bytes, cachedAt: Date.now() })
  ).catch(() => {});
}

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
  } catch { /* not critical */ }
}

// ── Адаптивный троттлер ───────────────────────────────────────────────────────

class AdaptiveThrottle {
  constructor() {
    this.baseDelay    = 250;
    this.currentDelay = 250;
    this.enabled      = false;
    this._ok          = 0;
    this._fail        = 0;
    this._REDUCE_AT   = 30;
    this._MAX_DELAY   = 8000;
  }

  configure(baseDelay, enabled) {
    this.baseDelay = baseDelay;
    this.enabled   = enabled;
    if (!enabled) this.currentDelay = baseDelay;
  }

  get delay() {
    return this.enabled ? this.currentDelay : this.baseDelay;
  }

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

  onRateLimit(status = 0) {
    if (!this.enabled) return;
    this._ok = 0;
    this._fail++;
    const prev        = this.currentDelay;
    this.currentDelay = Math.min(this._MAX_DELAY, Math.round(prev * 2 + 1000));
    log(`[throttle] backed off: ${prev} → ${this.currentDelay} ms (status=${status})`);
    sendStatus(`⚠ Сервер (${status || 'timeout'}) — задержка увеличена до ${this.currentDelay} мс`);
  }

  reset() {
    this._ok = this._fail = 0;
    this.currentDelay = this.baseDelay;
  }
}

const throttle = new AdaptiveThrottle();

// ── Состояние загрузки ────────────────────────────────────────────────────────

const TEST_TIMEOUT   = 6000;
const RETRY_ATTEMPTS = 2;
const RETRY_DELAY_MS = 400;

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
    unitId:      getUnitId()        || '',
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
    .replace(/^_+|_+$/g, '')
    .replace(/\.+$/, '');         // strip trailing dots (Windows issue)
  if (WINDOWS_RESERVED.test(str)) str = `_${str}`;
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

  // Try the well-known mapping first – avoids unnecessary probing.
  const known = ARCHIVE_NUM_MAP[location.hostname];
  if (known) {
    const ok = await testImage(
      `${location.origin}/archive${known}/image/${unit}?n=1&_ts=${Date.now()}`, 4000
    );
    if (ok) { cachedArchNum = known; return known; }
  }

  // Fall through to probing remaining candidates.
  log('archiveNum not in pathname or map, probing…');
  for (const n of ARCHIVE_PROBE_CANDIDATES) {
    if (n === known) continue; // already tried above
    const ok = await testImage(
      `${location.origin}/archive${n}/image/${unit}?n=1&_ts=${Date.now()}`, 4000
    );
    if (ok) { cachedArchNum = n; return n; }
  }

  cachedArchNum = known ?? '27';
  return cachedArchNum;
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
      img.src = BLANK_GIF;
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

class Semaphore {
  constructor(limit) {
    this._limit = limit;
    this._count = 0;
    this._queue = [];
  }

  setLimit(n) { this._limit = n; }

  acquire() {
    return new Promise(resolve => {
      if (this._count < this._limit) {
        this._count++;
        resolve();
      } else {
        this._queue.push(resolve);
      }
    });
  }

  release() {
    this._count = Math.max(0, this._count - 1);
    if (this._queue.length > 0 && this._count < this._limit) {
      this._count++;
      this._queue.shift()();
    }
  }

  drain() {
    this._queue.forEach(r => r());
    this._queue = [];
    this._count = 0;
  }
}

const dlSemaphore = new Semaphore(DEFAULTS.concurrentDownloads);

// downloadId → finish(success) callback, resolved by DOWNLOAD_DONE from background.
const downloadResolvers = new Map();

async function downloadWithSemaphore(url, filename) {
  await dlSemaphore.acquire();

  // Guard: Stop was signalled while we were waiting for a slot.
  if (isStopped) {
    dlSemaphore.release();
    return false;
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (success) => {
      if (settled) return;
      settled = true;
      clearTimeout(tid);
      dlSemaphore.release();
      resolve(success);
    };

    // Safety net: if the service-worker restarts and we never receive DOWNLOAD_DONE, release the slot after 60 seconds.
    const tid = setTimeout(() => {
      log(`download timeout for ${filename}`);
      finish(false);
    }, DOWNLOAD_TIMEOUT_MS);

    chrome.runtime.sendMessage({ type: 'DOWNLOAD', url, filename }, (response) => {
      void chrome.runtime.lastError;
      if (isStopped || response?.error != null || response?.downloadId == null) {
        finish(!isStopped && response?.error == null);
        return;
      }
      downloadResolvers.set(response.downloadId, finish);
    });
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

  // Honour Stop that was signalled during the parallel probe.
  if (isStopped) throw new Error('stopped');

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

async function downloadMetadata(folderName, unit, totalPages, titleRaw, archNum) {
  const pageMeta = collectPageMeta();

  let sha256 = null;
  try {
    const res = await fetch(imageUrl(unit, archNum, 1));
    if (res.ok) sha256 = await sha256Hex(await res.arrayBuffer());
  } catch (e) {
    log('SHA-256 fetch error:', e);
  }

  const lines = [
    `Архив: ${location.hostname}`,
    `URL документа: ${location.href}`,
    `Unit ID: ${unit}`,
    `Название: ${titleRaw || 'не определено'}`,
    `Страниц найдено: ${totalPages}`,
    `Дата скачивания: ${new Date().toLocaleString('ru-RU')}`
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
    'Попробуйте скачать эти страницы вручную или выставьте диапазон в расширении.'
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

// ── Probe URL (адаптивный режим) ──────────────────────────────────────────────

async function probeUrl(url) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    ctrl.abort();
    clearTimeout(timer);
    if (res.status === 429 || res.status === 503) {
      throttle.onRateLimit(res.status);
    } else if (res.ok) {
      throttle.onSuccess();
    }
  } catch (e) {
    clearTimeout(timer);
    if (!(e instanceof DOMException && e.name === 'AbortError')) {
      log('probe error (possible overload):', e);
      throttle.onRateLimit(0);
    }
  }
}

// ── Генерация PDF ─────────────────────────────────────────────────────────────

async function generatePDF(overrideFrom = null, overrideTo = null) {
  if (isRunning) return;
  // Set isRunning BEFORE the first await to prevent a race where two concurrent callers both pass the guard before either sets the flag.
  isRunning = true;
  isPaused  = false;
  isStopped = false;

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

    // Hard limit: assembling hundreds of MBs of JPEG data in a single tab's heap will cause an OOM crash in most environments.
    if (total > PDF_PAGE_HARD_LIMIT) {
      sendDone(
        `PDF: слишком много страниц (${total}). Максимум ${PDF_PAGE_HARD_LIMIT} за раз — ` +
        'задайте диапазон в слайдере или используйте режим JPG.'
      );
      return;
    }

    if (total > 150) {
      sendStatus(
        `PDF: ${total} стр. — потребуется несколько минут ` +
        `и ~${Math.round(total * 0.3)} МБ памяти…`
      );
      await sleep(2000);
    }

    const pagesData = [];
    const failedNums = new Set();

    for (let p = start; p <= last; p++) {
      await waitIfPaused();
      sendProgress(p - start + 1, total);
      sendStatus(`PDF: страница ${p} / ${last}` +
        (cfg.adaptiveSpeed ? ` (задержка ${throttle.delay} мс)` : ''));

      let bytes = await imgCacheGet(unit, p);

      if (bytes) {
        log(`PDF: cache hit p${p}`);
        throttle.onSuccess();
      } else {
        let fetchedBytes = null;
        const MAX_RETRIES = 3;

        for (let attempt = 0; attempt < MAX_RETRIES && !fetchedBytes; attempt++) {
          try {
            const res = await fetch(imageUrl(unit, archNum, p));
            if (res.ok) {
              fetchedBytes = new Uint8Array(await res.arrayBuffer());
              imgCachePut(unit, p, fetchedBytes);
              throttle.onSuccess();
            } else if (res.status === 429 || res.status === 503) {
              throttle.onRateLimit(res.status);
              if (attempt < MAX_RETRIES - 1) await sleep(throttle.delay);
            } else {
              log(`PDF: skip p${p} (HTTP ${res.status})`);
              break;
            }
          } catch (e) {
            log('PDF: fetch error p' + p, e);
            break;
          }
        }

        if (fetchedBytes) {
          bytes = fetchedBytes;
        } else {
          failedNums.add(p);
        }
      }

      if (bytes) pagesData.push({ bytes, ...parseJpegHeader(bytes) });

      await sleep(throttle.delay);
    }

    if (!pagesData.length) { sendDone('PDF: нет данных для сборки'); return; }

    sendStatus(`PDF: сборка ${pagesData.length} страниц…`);
    const pdfBytes = buildPDF(pagesData);

    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 60_000);

    imgCacheClear(unit).catch(() => {});

    const failNote = failedNums.size ? ` (пропущено: ${failedNums.size})` : '';
    sendDone(`PDF готов: ${pagesData.length} стр.${failNote}`,
      { isPDF: true, failedCount: failedNums.size });

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
    setIcon('inactive');
  }
}

// ── Скачать весь документ (JPG) ───────────────────────────────────────────────

async function downloadAll(overrideFrom = null, overrideTo = null) {
  if (isRunning) return;
  isRunning = true;
  isPaused  = false;
  isStopped = false;

  const cfg  = await ensureSettings();
  const unit = getUnitId();

  if (!unit) {
    sendDone('Не удалось определить unit');
    isRunning = false; setIcon('inactive'); return;
  }

  throttle.configure(cfg.delayMs, cfg.adaptiveSpeed);
  throttle.reset();

  // Configure the semaphore limit for this session.
  dlSemaphore.setLimit(cfg.concurrentDownloads ?? DEFAULTS.concurrentDownloads);

  setIcon('active');

  try {
    sendStatus('Определение архива…');
    const archNum    = await detectArchiveNum(unit);
    const titleRaw   = getTitleFromPage();
    const folderName = `${sanitizeForFilename(titleRaw)}_unit_${unit}`;

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

      if (cfg.createFolders) {
        downloadMetadata(folderName, unit, total, titleRaw, archNum).catch(e => log('meta:', e));
      }
    }

    const padWidth    = String(total).length || 3;
    const failedPages = [];
    const PROBE_EVERY = 20;

    for (let p = pFrom; p <= total; p++) {
      await waitIfPaused();
      sendProgress(p - pFrom + 1, total - pFrom + 1);
      sendStatus(`Скачивание ${p} / ${total}` +
        (cfg.adaptiveSpeed ? ` (${throttle.delay} мс)` : ''));

      // Adaptive probe: check server health every PROBE_EVERY pages.
      if (cfg.adaptiveSpeed && p > pFrom && (p - pFrom) % PROBE_EVERY === 0) {
        await probeUrl(imageUrl(unit, archNum, p));
      }

      const filename = cfg.createFolders
        ? `${folderName}/${pad(p, padWidth)}.jpg`
        : `unit_${unit}_p${pad(p, padWidth)}.jpg`;

      const success = await downloadWithSemaphore(imageUrl(unit, archNum, p), filename);
      if (!success) failedPages.push(p);

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
    // Unblock any queued acquire() calls and resolve all in-flight download promises so they don't leak after a Stop.
    dlSemaphore.drain();
    downloadResolvers.forEach(fn => fn(false));
    downloadResolvers.clear();
    setIcon('inactive');
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

// ── Обработчик сообщений от popup / background ────────────────────────────────

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

    // Fired by background.js when chrome.downloads.onChanged signals completion or interruption for a download we initiated.
    case 'DOWNLOAD_DONE': {
      const fn = downloadResolvers.get(msg.downloadId);
      if (fn) {
        downloadResolvers.delete(msg.downloadId);
        fn(msg.success);
      }
      break;
    }

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

log('content-script loaded (v2.5.5)');
