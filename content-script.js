const DEBUG = false;
const log   = (...args) => DEBUG && console.log('[RAD]', ...args);

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
  'www.archivesaratov.ru': '3',
  'lk.iaoo.ru':            '1'
};

const ARCHIVE_PROBE_CANDIDATES = [
  '27', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10',
  '11', '12', '13', '14', '15', '16', '17', '18', '19', '20',
  '21', '22', '23', '24', '25', '26'
];

const PDF_PAGE_HARD_LIMIT = 5000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

// ── Кэш номера архива ─────────────────────────────────────────────────────────
let cachedArchNum = null;
let _archiveImageSuffix = null;

function getArchiveImageSuffix() {
  if (_archiveImageSuffix !== null) return _archiveImageSuffix;
  const invImg = document.querySelector('img[src*="/image-inv/"]');
  _archiveImageSuffix = invImg ? 'image-inv' : 'image';
  log('archive image suffix detected:', _archiveImageSuffix);
  return _archiveImageSuffix;
}

// ── IndexedDB ─────────────────────────────────────────────────────────────────

const IDB_NAME    = 'rad_v1';
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

    if (result instanceof Promise) {
      result.then(resolve, reject);
      return;
    }

    tx.oncomplete = () => resolve(result?.result ?? result);
    tx.onerror    = ({ target: { error } }) => reject(error);
  }));
}

// ── Resume-state API ──────────────────────────────────────────────────────────

const resumeKey = unit => `rad_resume_${unit}`;

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
  // Стандартный путь: /unit/12345
  const m = location.pathname.match(/\/unit\/(\d+)/);
  if (m) return m[1];
  const archViewerImg = document.querySelector('img[src*="/archive"][src*="/image"]');
  if (archViewerImg) {
    const sm = (archViewerImg.getAttribute('src') || '')
      .match(/\/archive\d+\/image(?:-inv)?\/(\d+)/);
    if (sm) return sm[1];
  }

  return null;
}

function getTitleFromPage() {
  // VRR (Кострома, Приморье): заголовок в блоке меню
  const vrrMenu = document.getElementById('VRR_MPM_TopMenu_Big_Name');
  if (vrrMenu) {
    const p = vrrMenu.querySelector('p');
    const t = (p || vrrMenu).textContent.trim();
    if (t) return t;
  }
  const vrrName = document.getElementById('VRR_SV_name');
  if (vrrName?.textContent?.trim()) return vrrName.textContent.trim();

  // Яндекс Архив: путь фонда/описи/дела в заголовке документа
  const yaPath = document.querySelector('.OneDocumentHeader-Path');
  if (yaPath) {
    const text = Array.from(yaPath.childNodes)
      .filter(n => n.nodeType === Node.TEXT_NODE || n.tagName === 'SPAN' && !n.querySelector('svg'))
      .map(n => n.textContent)
      .join('')
      .replace(/\s+/g, ' ').trim();
    if (text) return text;
  }

  // Стандартные варианты
  const h = document.querySelector('h1.title') || document.querySelector('h1');
  if (h?.textContent?.trim()) return h.textContent.trim();
  const misc = document.querySelector('.page-title, .document-title, .file-title');
  if (misc?.textContent?.trim()) return misc.textContent.trim();
  if (document.title) {
    return document.title.replace(/\s*[|–—\-].*$/, '').trim() || null;
  }
  return null;
}

function collectPageMeta() {
  const lines = [];

  const well = document.querySelector('.well');
  if (well) {
    const h1 = well.querySelector('h1');
    if (h1?.textContent?.trim()) lines.push(h1.textContent.trim());
    well.querySelectorAll('p').forEach(p => {
      const t = p.textContent.trim();
      if (t) lines.push(t);
    });
  }

  if (!lines.length) {
    document.querySelectorAll('table.table tr, .unit-info tr').forEach(row => {
      const cells = [...row.querySelectorAll('td, th')].map(c => c.textContent.trim()).filter(Boolean);
      if (cells.length >= 2) lines.push(cells.join(': '));
    });
  }

  if (!lines.length) {
    document.querySelectorAll('.description p, .card-body p').forEach(p => {
      const t = p.textContent.trim();
      if (t) lines.push(t);
    });
  }

  return lines.slice(0, 30).join('\n');
}

function collectStructuredMeta() {
  const result = {};

  const well = document.querySelector('.well');
  if (well) {
    const h1 = well.querySelector('h1');
    if (h1?.textContent?.trim()) result['Название'] = h1.textContent.trim();
    well.querySelectorAll('p').forEach(p => {
      const t = p.textContent.trim();
      if (!t) return;
      const colonIdx = t.indexOf(':');
      if (colonIdx > 0 && colonIdx < 30) {
        result[t.slice(0, colonIdx).trim()] = t.slice(colonIdx + 1).trim();
      } else {
        result['Реквизиты'] = t;
      }
    });
  }

  if (Object.keys(result).length < 2) {
    document.querySelectorAll('table.table tr, .unit-info tr').forEach(row => {
      const cells = [...row.querySelectorAll('td, th')]
        .map(c => c.textContent.trim()).filter(Boolean);
      if (cells.length >= 2) {
        const key   = cells[0].replace(/:$/, '').trim();
        const value = cells.slice(1).join('; ').trim();
        if (key && value) result[key] = value;
      }
    });
  }

  if (!Object.keys(result).length) {
    let idx = 0;
    document.querySelectorAll('.description p, .card-body p').forEach(p => {
      const t = p.textContent.trim();
      if (t) result[`Описание ${++idx}`] = t;
    });
  }
  return result;
}

function getFullMetadata() {
  const adapter = getAdapterInfo();
  return {
    unitId:      adapter?.unitId || getUnitId() || '',
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
    .replace(/\.+$/, '');
  if (WINDOWS_RESERVED.test(str)) str = `_${str}`;
  return (str.length > 100 ? str.slice(0, 100) : str) || 'untitled';
}

function imageUrl(unit, archNum, page) {
  const suffix = getArchiveImageSuffix();
  return `${location.origin}/archive${archNum}/${suffix}/${unit}?n=${page}`;
}

function pad(num, w) { return String(num).padStart(w, '0'); }
function detectCurrentPage() {
  if (isArsvoPage()) {
    const el = document.getElementById(
      'MainPlaceHolder_StorageFilesViewerControl_h_currentImagePageNumber'
    );
    if (el) {
      const n = parseInt(el.value);
      if (!isNaN(n) && n >= 0) return n + 1;
    }
    return getArsvoCurrentPage();
  }

  let maxPage = 1;
  let found   = false;
  for (const img of document.querySelectorAll('img')) {
    try {
      const src = img.getAttribute('src') || img.src || '';
      if (src.includes('/image/') || src.includes('/image-inv/')) {
        const m = src.match(/[?&]n=(\d+)/);
        if (m) {
          const n = Number(m[1]);
          if (n > maxPage) maxPage = n;
          found = true;
        }
      }
    } catch { /* ignore */ }
  }
  return found ? maxPage : 1;
}

// ── VRR Адаптер ────────────────────

let _vrrDirectPrefix = null;

function isVrrPage() {
  return !!(
    document.getElementById('VRR_id_sys-viewer') ||
    document.querySelector('script[src*="VRR-CORE"]')
  );
}

function getVrrCanvas() {
  return document.getElementById('sys_viewer_img') ||
         document.querySelector('canvas[id*="sys_viewer"], canvas[id*="viewer_img"]');
}

function getVrrCanvasFingerprint(canvas) {
  try {
    const ctx = canvas.getContext('2d');
    const cx = Math.floor(canvas.width  / 2);
    const cy = Math.floor(canvas.height / 2);
    const d  = ctx.getImageData(cx, cy, 8, 8);
    return Array.from(d.data).filter((_, i) => i % 16 === 0).join(',');
  } catch { return String(Math.random()); }
}

function navigateVrrToOffset(unitId, offset) {
  const img = document.querySelector(
    `img[src="/m/${unitId}/${offset}"], img[src^="/m/${unitId}/${offset}?"]`
  );
  if (!img) return false;
  const clickable = img.closest('li, [role="button"], [onclick], [class*="thumb"], [class*="item"]') || img;
  clickable.click();
  return true;
}

async function waitForVrrCanvasRender(canvas, prevFingerprint, timeoutMs = 20000) {
  const startedAt  = Date.now();
  const MIN_LEN    = 40000;
  let   didChange  = false;

  while (Date.now() - startedAt < timeoutMs) {
    if (isStopped) throw new Error('stopped');
    await sleep(300);

    const fp = getVrrCanvasFingerprint(canvas);
    if (!didChange && fp !== prevFingerprint && fp !== '') {
      didChange = true;
      await sleep(600);
      continue;
    }

    if (didChange) {
      const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
      if (dataUrl && dataUrl.length >= MIN_LEN) return dataUrl;
    }
  }
  throw new Error(`VRR: тайм-аут ожидания страницы`);
}

async function probeVrrDirectPrefix(unitId, offset) {
  if (_vrrDirectPrefix !== null) return _vrrDirectPrefix;
  for (const prefix of ['/i/', '/img/', '/f/', '/file/']) {
    const url = `${location.origin}${prefix}${unitId}/${offset}`;
    if (await testImage(url, 4000)) {
      log(`VRR direct prefix found: ${prefix}`);
      _vrrDirectPrefix = prefix;
      return prefix;
    }
  }
  log('VRR: no direct prefix — will use canvas capture');
  _vrrDirectPrefix = '';
  return '';
}

function vrrDirectImageUrl(unitId, offset) {
  return `${location.origin}${_vrrDirectPrefix}${unitId}/${offset}`;
}

function getVrrUnitId() {
  const img = document.querySelector('img[src^="/m/"]');
  if (img) {
    const m = img.getAttribute('src').match(/^\/m\/(\d+)\//);
    if (m) return m[1];
  }
  const pm = location.pathname.match(/\/(?:section|view|doc)\/(\d+)/);
  return pm ? pm[1] : null;
}

function getVrrTotalPages() {
  const el = document.querySelector('input[name="count_rows"]');
  if (el) {
    const n = parseInt(el.value);
    if (!isNaN(n) && n > 0) return n;
  }
  return 0;
}

function getVrrPageOffsets(unitId) {
  const imgs    = document.querySelectorAll(`img[src^="/m/${unitId}/"]`);
  const seen    = new Set();
  const offsets = [];
  for (const img of imgs) {
    const m = img.getAttribute('src').match(/\/m\/\d+\/(\d+)$/);
    if (m) {
      const offset = parseInt(m[1]);
      if (!seen.has(offset)) { seen.add(offset); offsets.push(offset); }
    }
  }
  return offsets;
}

function vrrThumbUrl(unitId, offset) {
  return `${location.origin}/m/${unitId}/${offset}`;
}

function getVrrCurrentOffset(unitId) {
  const active = document.querySelector(
    '.VRR_min_selected img[src^="/m/"], ' +
    '[class*="selected"] img[src^="/m/"], ' +
    '[class*="active"] img[src^="/m/"]'
  );
  if (active) {
    const m = active.getAttribute('src').match(/\/m\/\d+\/(\d+)$/);
    if (m) return parseInt(m[1]);
  }
  const offsets = getVrrPageOffsets(unitId);
  return offsets.length > 0 ? offsets[0] : 0;
}

// ── ELAR Адаптер ──────────

const ARSVO_GUID_SEL =
  '#MainPlaceHolder_StorageFilesViewerControl_DeepZoomImageViewer_h_fileId';

function isArsvoPage() {
  if (document.querySelector(ARSVO_GUID_SEL)?.value?.includes('-')) return true;
  if (document.getElementById('storageFilesViewerPnl')) return true;
  return !!(
    document.querySelector('img[src*="ImageFile.ashx"][src*="id="]') ||
    document.querySelector('img[src*="ImageFile.ashx"][src*="Id="]') ||
    document.querySelector('img[src*="ImageFilePart.ashx"]')
  );
}
function isElarPage() {
  return !!(document.getElementById('storageFilesViewerPnl') ||
            document.querySelector('[id$="ForwardBtn"]'));
}

function getArsvoUnitId() {
  const m = location.search.match(/[?&]ItemId=(\d+)/i);
  if (m) return m[1];
  const elarM = location.search.match(/[?&](?:id|unitId|unitid)=(\d+)/i);
  if (elarM) return elarM[1];
  const pathM = location.pathname.match(/\/(\d{4,})\/?$/);
  if (pathM) return pathM[1];
  const link = document.querySelector('a[href*="ItemId="]');
  if (link) {
    const lm = link.href.match(/ItemId=(\d+)/);
    if (lm) return lm[1];
  }
  return null;
}

function getArsvoGuid() {
  const el = document.querySelector(ARSVO_GUID_SEL);
  if (el?.value?.includes('-')) return el.value;
  for (const sel of [
    'input[type="hidden"][id*="_h_fileId"]',
    'input[type="hidden"][id*="FileId"]',
    'input[type="hidden"][name*="fileId"]',
  ]) {
    const inp = document.querySelector(sel);
    if (inp?.value?.match(/^[0-9a-f-]{36}$/i)) return inp.value;
  }

  const GUID_RE = /[?&][Ii]d=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  for (const sel of ['img[src*="ImageFile.ashx"]', 'img[src*="ImageFilePart.ashx"]']) {
    for (const img of document.querySelectorAll(sel)) {
      const src = img.getAttribute('src') || '';
      const m   = src.match(GUID_RE);
      if (m) {
        log('ЭЛАР GUID из URL тайла:', m[1]);
        return m[1];
      }
    }
  }

  return null;
}

function getArsvoCurrentPage() {
  const el1 = document.getElementById(
    'MainPlaceHolder_StorageFilesViewerControl_h_currentPageNumber'
  );
  if (el1) {
    const n = parseInt(el1.value);
    if (!isNaN(n) && n > 0) return n;
  }
  const el0 = document.getElementById(
    'MainPlaceHolder_StorageFilesViewerControl_h_currentImagePageNumber'
  );
  if (el0) {
    const n = parseInt(el0.value);
    if (!isNaN(n) && n >= 0) return n + 1;
  }
  const tb = document.querySelector('input[id*="_tbCurrentPage"]');
  if (tb) {
    const n = parseInt(tb.value);
    if (!isNaN(n) && n > 0) return n;
  }
  const tileImg = document.querySelector('img[src*="ImageFile.ashx"][src*="page="]');
  if (tileImg) {
    const m = (tileImg.getAttribute('src') || '').match(/[?&]page=(\d+)/);
    if (m) return parseInt(m[1]) + 1;
  }
  for (const sel of ['[id*="CurrentPage"]', '[id*="currentPage"]', 'input[id*="Page"]']) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const n = parseInt(el.value || el.textContent);
    if (!isNaN(n) && n > 0) return n;
  }
  return 1;
}

function getArsvoTotalPagesFromDOM() {
  const hiddenSels = [
    '#MainPlaceHolder_StorageFilesViewerControl_h_pagesCount',
    'input[id$="_h_pagesCount"]',
    'input[id*="PagesCount"]',
    'input[id*="pagesCount"]',
    'input[id*="TotalPages"]',
    'span[id*="lbPagesCount"]',
    'span[id*="TotalPages"]',
    '[id*="TotalCount"]',
    '[id*="totalCount"]',
    '[id*="CountPages"]',
    '[id*="PagesCount"]',
  ];
  for (const sel of hiddenSels) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const raw = el.value !== undefined ? el.value : el.textContent;
    const n   = parseInt(raw);
    if (!isNaN(n) && n > 0) return n;
  }

  for (const el of document.querySelectorAll('span, td, label')) {
    const text = el.childNodes.length <= 2 ? (el.textContent || '').trim() : '';
    if (!text || text.length > 30) continue;
    const m = text.match(/(?:из|of|\/)\s*(\d{1,5})(?:\s|$)/i);
    if (m) {
      const n = parseInt(m[1]);
      if (n > 0 && n < 50000) return n;
    }
  }

  return null;
}

function arsvoImageUrl(guid, pageIndex) {
  return `${location.origin}/Pages/ImageFilePart.ashx?Crop=False&Id=${guid}&Page=${pageIndex}&Zoom=1`;
}

const _arsvoFullPageOk = false;
async function probeArsvoFullPage(guid) { return false; }

function arsvoTileUrl(guid, pageIndex, level, x, y, tileSize = 800, overlap = 1) {
  return `${location.origin}/Pages/ImageFile.ashx?level=${level}&x=${x}&y=${y}` +
    `&tileSize=${tileSize}&tileOverlap=${overlap}&id=${guid}&page=${pageIndex}&rotation=0&searchtext=`;
}

function isElarSingleTileMode() {
  const img = document.querySelector('img[src*="ImageFile.ashx"]');
  if (!img) return false;
  const src = img.getAttribute('src') || '';
  const ts  = parseInt(src.match(/[?&]tileSize=(\d+)/)?.[1]);
  return ts >= 100000;
}

function elarSingleTileUrl(guid, pageIndex) {
  return `${location.origin}/Pages/ImageFile.ashx?level=12&x=0&y=0&tileSize=999999&tileOverlap=1&id=${guid}&page=${pageIndex}&rotation=0&searchtext=`;
}

function getArsvoTileParams() {
  const img = document.querySelector('img[src*="ImageFile.ashx"][src*="level="]');
  if (!img) {
    return isElarPage()
      ? { level: 12, tileSize: 1000, overlap: 1 }
      : { level: 11, tileSize: 800,  overlap: 1 };
  }
  const src     = img.getAttribute('src') || '';
  const level   = parseInt(src.match(/[?&]level=(\d+)/)?.[1])       || 11;
  const tileSize= parseInt(src.match(/[?&]tileSize=(\d+)/)?.[1])    || 800;
  const overlap = parseInt(src.match(/[?&]tileOverlap=(\d+)/)?.[1]) || 1;
  return { level, tileSize, overlap };
}

const ARSVO_TILE_MIN_BYTES = 3000;

async function tileExists(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url + '&_ts=' + Date.now(), {
      signal: ctrl.signal,
      credentials: 'include',
    });
    clearTimeout(timer);
    if (!res.ok) return false;
    const reader = res.body.getReader();
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done || value == null) break;
      total += value.length;
      if (total >= ARSVO_TILE_MIN_BYTES) { reader.cancel(); return true; }
    }
    return false;
  } catch { return false; }
}

async function probeArsvoTileGrid(guid, pageIndex, level, tileSize, overlap) {
  let cols = 0;
  for (let x = 0; x < 40; x++) {
    if (!await tileExists(arsvoTileUrl(guid, pageIndex, level, x, 0, tileSize, overlap))) break;
    cols = x + 1;
  }
  if (cols === 0) return { cols: 0, rows: 0 };

  let rows = 0;
  for (let y = 0; y < 40; y++) {
    if (!await tileExists(arsvoTileUrl(guid, pageIndex, level, 0, y, tileSize, overlap))) break;
    rows = y + 1;
  }
  return { cols, rows };
}

async function stitchArsvoPageOnCanvas(guid, pageIndex, progressCb) {
  const { level, tileSize, overlap } = getArsvoTileParams();

  progressCb?.(`ЭЛАР: сетка тайлов стр. ${pageIndex + 1}…`);
  const { cols, rows } = await probeArsvoTileGrid(guid, pageIndex, level, tileSize, overlap);
  if (cols === 0 || rows === 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width  = cols * tileSize;
  canvas.height = rows * tileSize;
  const ctx = canvas.getContext('2d');

  let loaded = 0;
  const total = cols * rows;

  await Promise.all(
    Array.from({ length: rows }, (_, y) =>
      Array.from({ length: cols }, (_, x) =>
        new Promise(resolve => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            ctx.drawImage(img, x * tileSize, y * tileSize);
            progressCb?.(`ЭЛАР: тайл ${++loaded}/${total} (стр. ${pageIndex + 1})`);
            resolve();
          };
          img.onerror = () => { loaded++; resolve(); };
          img.src = arsvoTileUrl(guid, pageIndex, level, x, y, tileSize, overlap) + '&_ts=' + Date.now();
        })
      )
    ).flat()
  );

  if (isStopped) throw new Error('stopped');
  return canvas.toDataURL('image/jpeg', 0.92);
}

async function findTotalPagesARSVOTiled(guid, maxPages, progressCb) {
  const { level, tileSize, overlap } = getArsvoTileParams();
  if (!await tileExists(arsvoTileUrl(guid, 0, level, 0, 0, tileSize, overlap))) return 0;

  let lo = 0, hi = 1;
  while (hi < maxPages) {
    progressCb?.(`ЭЛАР тайлы: разведка стр. ${hi + 1}…`);
    if (!await tileExists(arsvoTileUrl(guid, hi, level, 0, 0, tileSize, overlap))) break;
    lo = hi; hi = Math.min(hi * 4, maxPages);
  }
  if (isStopped) throw new Error('stopped');
  if (hi >= maxPages && await tileExists(arsvoTileUrl(guid, maxPages - 1, level, 0, 0, tileSize, overlap)))
    return maxPages;
  while (lo < hi - 1) {
    await waitIfPaused();
    const mid = Math.floor((lo + hi) / 2);
    progressCb?.(`ЭЛАР тайлы: уточнение стр. ${mid + 1}…`);
    if (await tileExists(arsvoTileUrl(guid, mid, level, 0, 0, tileSize, overlap))) lo = mid; else hi = mid;
  }
  return lo + 1;
}

async function findTotalPagesARSVO(guid, maxPages, progressCb) {
  const domCount = getArsvoTotalPagesFromDOM();
  if (domCount) {
    progressCb?.(`ЭЛАР: найдено ${domCount} стр. (из DOM)`);
    log('ЭЛАР: число страниц из DOM:', domCount);
    return domCount;
  }

  await waitIfPaused();

  if (isElarSingleTileMode()) {
    progressCb?.('ЭЛАР: однотайловый режим, поиск числа страниц…');
    if (!await testImageWithRetry(elarSingleTileUrl(guid, 0))) return 0;

    let lo = 0, hi = 1;
    while (hi < maxPages) {
      progressCb?.(`ЭЛАР: разведка стр. ${hi + 1}…`);
      if (!await testImageWithRetry(elarSingleTileUrl(guid, hi))) break;
      lo = hi; hi = Math.min(hi * 4, maxPages);
    }
    if (isStopped) throw new Error('stopped');
    while (lo < hi - 1) {
      await waitIfPaused();
      const mid = Math.floor((lo + hi) / 2);
      progressCb?.(`ЭЛАР: уточнение стр. ${mid + 1}…`);
      if (await testImageWithRetry(elarSingleTileUrl(guid, mid))) lo = mid; else hi = mid;
    }
    return lo + 1;
  }

  progressCb?.('ЭЛАР: многотайловый режим, поиск числа страниц…');
  return findTotalPagesARSVOTiled(guid, maxPages, progressCb);
}

// ── Яндекс Архив ──────────────────────────────────────────────────────────────

function isYandexArchivePage() {
  return /(^|\.)yandex\.ru$/i.test(location.hostname) && /\/archive\//i.test(location.pathname) ||
         location.hostname === 'ya.ru' && /\/archive\//i.test(location.pathname);
}

function getYandexArchiveDocId() {
  const fondM = location.pathname.match(
    /fond[_/-]?(\d+)[^/]*\/opis[_/-]?(\d+)[^/]*\/(?:delo|unit|ed)[_/-]?(\d+)/i
  );
  if (fondM) return `f${fondM[1]}_o${fondM[2]}_d${fondM[3]}`;
  const parts = location.pathname.split('/').filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^\d+$/.test(parts[i])) return parts[i];
  }
  const qId = new URLSearchParams(location.search).get('id') ||
              new URLSearchParams(location.search).get('docId');
  if (qId) return qId;
  return 'doc_' + Date.now();
}

function getYandexPageUrl(pageNumber) {
  const base = location.href.replace(/[?#].*$/, '');
  const replaced = base.replace(/\/\d+\/?$/, '/' + pageNumber);
  return replaced !== base ? replaced : base.replace(/\/?$/, '/' + pageNumber);
}

function looksLikeHtmlBytes(bytes) {
  if (!bytes || !bytes.length) return false;
  let sample = '';
  const limit = Math.min(bytes.length, 256);
  for (let i = 0; i < limit; i++) sample += String.fromCharCode(bytes[i]);
  return /^[\s\uFEFF]*<!doctype html|^[\s\uFEFF]*<html|^[\s\uFEFF]*<head|^[\s\uFEFF]*<body/i.test(sample);
}

function isBlockedYandexAsset(url) {
  const blocked = [
    /captcha/i, /og-image/i, /favicon/i, /logo/i,
    /sprite/i, /avatar/i, /thumbnail/i, /preview/i,
    /mc\.yandex\.ru/i, /yastatic\.net\/s3\/home-static/i, /adfstat\.yandex\.ru/i
  ];
  return blocked.some(re => re.test(url));
}

function isAllowedYandexCandidate(url) {
  if (!url || isBlockedYandexAsset(url)) return false;
  if (/\.js($|[?#])/i.test(url))  return false;
  if (/\.css($|[?#])/i.test(url)) return false;
  if (/\/_next\//i.test(url))     return false;
  if (/\/webpack/i.test(url))     return false;
  if (/[?&]type=original([&#]|$)/i.test(url))           return true;
  if (/\/archive\/api\/image/i.test(url))                return true;
  if (/\/archive\/catalog\//i.test(url))                 return true;
  if (/\.(jpg|jpeg|png|gif|bmp|webp|tif|tiff|jp2|avif)($|[?#])/i.test(url)) return true;
  if (/(image|download|scan|page|canvas|manifest|content|entity)/i.test(url)) return true;
  return false;
}

function scoreYandexUrl(url, source) {
  if (!isAllowedYandexCandidate(url)) return -100000;
  let score = 0;
  if (/[?&]type=original([&#]|$)/i.test(url))  score += 1200;
  if (/[?&]type=thumb([&#]|$)/i.test(url))      score -= 1200;
  if (/\/archive\/api\/image/i.test(url))        score +=  800;
  if (/\/archive\/catalog\//i.test(url))         score +=  600;
  if (/avatars\.mds\.yandex/i.test(url))         score +=  400;
  if (/storage\.yandexcloud/i.test(url))         score +=  400;
  if (/\/thumb/i.test(url))                      score -=  600;
  if (/(thumbnail|preview|small)/i.test(url))    score -=  700;
  if (/\.(jpg|jpeg|png|webp|jp2|tif|tiff)($|[?#])/i.test(url)) score += 100;
  if (source === 'json' || source === 'script')  score +=  260;
  if (source === 'img')                          score +=   40;
  return score;
}

function extractBestYandexImageFromHtml(html, pageUrl) {
  const base = pageUrl || location.href;
  const candidates = [];
  const seen = new Set();

  function push(rawUrl, source) {
    if (!rawUrl || typeof rawUrl !== 'string') return;
    const clean = rawUrl
      .replace(/\\//g, '/').replace(/\u002F/gi, '/')
      .replace(/\u003A/gi, ':').replace(/\u0026/gi, '&').trim();
    let absolute;
    try { absolute = new URL(clean, base).href; } catch { return; }
    if (seen.has(absolute)) return;
    seen.add(absolute);
    const score = scoreYandexUrl(absolute, source);
    if (score > -1000) candidates.push({ url: absolute, score });
  }

  let m;

  const reOrigAbs = /https?:\?\/\?\/[^"'<>\\s]*\/archive\/api\/image\?[^"'<>\\s]*type=original[^"'<>\\s]*/gi;
  while ((m = reOrigAbs.exec(html)) !== null) push(m[0], 'script');

  const reOrigRel = /(["'])(\/archive\/api\/image\?[^"']*type=original[^"']*)/gi;
  while ((m = reOrigRel.exec(html)) !== null) push(m[2], 'script');

  const reCatalog = /(["'])(\/archive\/catalog\/[^"']+\.(?:jpg|jpeg|png|webp|jp2|tif|tiff)[^"']*)/gi;
  while ((m = reCatalog.exec(html)) !== null) push(m[2], 'script');

  const reNamed = /(?:imageUrl|originalUrl|downloadUrl|contentUrl|resourceUrl)\s*[:=]\s*["']([^"']+)["']/gi;
  while ((m = reNamed.exec(html)) !== null) push(m[1], 'script');

  const reGeneric = /(https?:\?\/\?\/[^"'<>\\s]*\.(?:jpg|jpeg|png|webp|jp2|tif|tiff)(?:[?#][^"'<>\\s]*)?)/gi;
  while ((m = reGeneric.exec(html)) !== null) push(m[1], 'img');

  candidates.sort((a, b) => b.score - a.score);
  log('Yandex top candidates:', candidates.slice(0, 3).map(c => `${c.score}: ${c.url.slice(0, 80)}`));
  return candidates.length ? candidates[0].url : null;
}

function extractBestImageFromLiveDom() {
  const candidates = [];
  const seen = new Set();

  function pushCandidate(rawUrl, width, height, source) {
    if (!rawUrl) return;
    let url;
    try { url = new URL(rawUrl, location.href).href; } catch { return; }
    if (seen.has(url) || !isAllowedYandexCandidate(url)) return;
    seen.add(url);
    candidates.push({ url, score: scoreYandexUrl(url, source) + (width > 400 && height > 400 ? 300 : 0) });
  }

  for (const img of document.images) {
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    pushCandidate(img.currentSrc || img.src, w, h, 'img');
    pushCandidate(img.getAttribute('data-src'), w, h, 'img');
  }

  for (const scriptEl of document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"], script#__NEXT_DATA__')) {
    const text = scriptEl.textContent || '';
    if (!text.trim()) continue;
    try {
      const json = JSON.parse(text);
      function walkJson(v) {
        if (!v) return;
        if (typeof v === 'string') { pushCandidate(v, 0, 0, 'json'); return; }
        if (Array.isArray(v)) { v.forEach(walkJson); return; }
        if (typeof v === 'object') Object.values(v).forEach(walkJson);
      }
      walkJson(json);
    } catch { /* skip invalid JSON */ }
  }

  for (const scriptEl of document.scripts) {
    const text = scriptEl.textContent || '';
    if (!text) continue;
    const matches = text.match(/https?:\/\/[^"'\\s)]+/gi) || [];
    matches.forEach(u => pushCandidate(u, 0, 0, 'script'));
  }

  candidates.sort((a, b) => b.score - a.score);

  if (!candidates.length || candidates[0].score < 500) {
    let bestCanvas = null, bestArea = 0;
    for (const canvas of document.querySelectorAll('canvas')) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 200) continue;
      const area = (canvas.width || rect.width) * (canvas.height || rect.height);
      if (area > bestArea) { bestArea = area; bestCanvas = canvas; }
    }
    if (bestCanvas) {
      try {
        const dataUrl = bestCanvas.toDataURL('image/jpeg', 0.95);
        if (dataUrl && dataUrl.length > 5000) return { url: dataUrl, isCanvas: true };
      } catch { /* tainted canvas — skip */ }
    }
  }

  return candidates.length ? { url: candidates[0].url, isCanvas: false } : null;
}

async function fetchYandexPageImage(pageNumber) {
  const pageUrl = getYandexPageUrl(pageNumber);
  const response = await fetch(pageUrl, { credentials: 'include' });
  if (!response.ok) throw new Error(`Страница ${pageNumber}: HTTP ${response.status}`);
  const html = await response.text();
  const imageUrl = extractBestYandexImageFromHtml(html, pageUrl);
  if (!imageUrl) throw new Error(`Страница ${pageNumber}: изображение не найдено`);
  return { pageUrl, imageUrl };
}

async function getValidatedYandexBytes(url, pageNumber) {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error(`Скан стр. ${pageNumber}: HTTP ${response.status}`);
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (contentType && !contentType.startsWith('image/')) {
    throw new Error(`Стр. ${pageNumber}: не изображение (${contentType})`);
  }
  if (looksLikeHtmlBytes(bytes)) {
    throw new Error(`Стр. ${pageNumber}: получен HTML вместо скана`);
  }
  if (bytes.length < 10000) {
    throw new Error(`Стр. ${pageNumber}: файл слишком мал (${bytes.length} байт)`);
  }
  return bytes;
}

function getYandexArchiveTotalPages() {
  for (const node of document.querySelectorAll('[class*="ShortPagination"], [class*="Pagination"]')) {
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    const m = text.match(/(\d{1,5})\s*\/\s*(\d{1,5})/);
    if (m) return parseInt(m[2], 10);
  }
  const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  const bm = bodyText.match(/\b(\d{1,5})\s*\/\s*(\d{1,5})\b/);
  if (bm) return parseInt(bm[2], 10);
  return null;
}

function getYandexArchiveCurrentPage() {
  for (const input of document.querySelectorAll('input')) {
    const val = (input.value || '').trim();
    if (!/^\d{1,5}$/.test(val)) continue;
    const rect = input.getBoundingClientRect();
    if (rect.width < 20 || rect.width > 120 || rect.height < 20 || rect.height > 80) continue;
    const ctx = (input.parentElement?.textContent || '') +
                (input.parentElement?.parentElement?.textContent || '');
    if (/\/\s*\d{1,5}/.test(ctx) || /ShortPagination/i.test(input.className || '')) {
      return parseInt(val, 10);
    }
  }
  const urlM = location.pathname.match(/\/(\d+)\/?$/);
  if (urlM) return parseInt(urlM[1], 10);
  return 1;
}

function collectYandexPageImageUrls() {
  const result = [];
  const seen   = new Set();
  for (const img of document.querySelectorAll('img')) {
    const src = img.getAttribute('src') || img.src || '';
    if (!src || src.startsWith('data:') || src.startsWith('blob:') || seen.has(src)) continue;
    const w = img.naturalWidth  || img.width  || 0;
    const h = img.naturalHeight || img.height || 0;
    const isDocSize = w >= 300 && h >= 400;
    const isYaCDN   = /avatars\.mds\.yandex|storage\.yandexcloud|\/archive\//.test(src);
    if (isDocSize || isYaCDN) { seen.add(src); result.push({ url: src, w, h }); }
  }
  return result.sort((a, b) => (b.w * b.h) - (a.w * a.h));
}

// ── ЦГА Москвы / МНА ─────────────────────────────────────────────────────────

function isCgamosPage() {
  return ['cgamos.ru', 'www.cgamos.ru', 'mos-nha.ru', 'www.mos-nha.ru']
    .includes(location.hostname);
}

function getCgamosViewerType() {
  if (
    document.querySelector('img[src*="ImageFile.ashx"]') ||
    document.querySelector('img[src*="ImageFilePart.ashx"]')
  ) return 'arsvo';
  return 'dom';
}

function getCgamosGuid() {
  const GUID_RE = /[?&][Ii]d=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  for (const sel of ['img[src*="ImageFile.ashx"]', 'img[src*="ImageFilePart.ashx"]',
                     'input[type="hidden"][id*="fileId"]', 'input[type="hidden"][id*="FileId"]']) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const src = el.getAttribute('src') || el.value || '';
    const m   = src.match(GUID_RE) || src.match(/^[0-9a-f-]{36}$/i);
    if (m) return m[1] || m[0];
  }
  return null;
}

function getCgamosDocId() {
  const m = location.pathname.match(/\/(?:syl|unit|delo|fund|fond|doc)\/(\d+)/i) ||
            location.search.match(/[?&](?:id|unitId|ItemId)=(\d+)/i);
  if (m) return m[1];

  const parts = location.pathname.split('/').filter(Boolean).reverse();
  for (const p of parts) {
    if (/^\d+$/.test(p)) return p;
  }
  return 'doc_' + Date.now();
}

function collectCgamosPageImageUrls() {
  const result = [];
  const seen   = new Set();
  for (const img of document.querySelectorAll('img')) {
    const src = img.getAttribute('src') || img.src || '';
    if (!src || src.startsWith('data:') || seen.has(src)) continue;
    const w = img.naturalWidth  || img.width  || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w >= 400 && h >= 500) {
      seen.add(src);
      result.push({ url: src, w, h });
    }
  }
  return result;
}

function getCgamosCurrentPage() {
  const tb = document.querySelector('input[id*="_tbCurrentPage"]');
  if (tb) {
    const n = parseInt(tb.value);
    if (!isNaN(n) && n > 0) return n;
  }
  const tileImg = document.querySelector('img[src*="ImageFile.ashx"][src*="page="]');
  if (tileImg) {
    const m = (tileImg.getAttribute('src') || '').match(/[?&]page=(\d+)/);
    if (m) return parseInt(m[1]) + 1;
  }
  return 1;
}

// ── ЦГА Москвы — SPA-вьювер ───────────────────────────────────────────────────

const CGAMOS_SPA_PATHS = /\/(metric-books|skazki|ispovedalnye_vedomosti|obyski|cemetery|books-of-moscow-maternity-hospitals|l-dela|posemeynye-spiski|inye-konfessii)\//i;

function isCgamosSpaPage() {
  return isCgamosPage() && CGAMOS_SPA_PATHS.test(location.pathname);
}

function getCgamosSpaTotal() {
  const countNode = document.querySelector(
    '.inventory-count-picture.ref-count-picture, .inventory-count-picture, .ref-count-picture'
  );
  if (countNode) {
    const m = (countNode.textContent || '').match(/(\d{1,5})/);
    if (m) return parseInt(m[1], 10);
  }
  const body = ((document.body?.innerText || '') + (document.body?.textContent || '')).replace(/\s+/g, ' ');
  const m1 = body.match(/\b(\d{1,5})\s*из\s*(\d{1,5})\b/i);
  if (m1) return parseInt(m1[2], 10);
  const m2 = body.match(/\b(\d{1,5})\s*\/\s*(\d{1,5})\b/);
  if (m2) return parseInt(m2[2], 10);
  return null;
}

function getCgamosSpaPagerInput() {
  let best = null, bestScore = -1;
  for (const inp of document.querySelectorAll('input')) {
    const val = (inp.value || '').trim();
    if (!/^\d{1,5}$/.test(val)) continue;
    const rect = inp.getBoundingClientRect();
    if (rect.width < 20 || rect.width > 160 || rect.height < 20 || rect.height > 80) continue;
    if (rect.top < 0 || rect.left < 0) continue;
    const ctx = (inp.parentElement?.textContent || '') + (inp.parentElement?.parentElement?.textContent || '');
    let score = 1000 - Math.min(rect.top, 1000);
    if (/\/\s*\d{1,5}/.test(ctx)) score += 1000;
    if (score > bestScore) { bestScore = score; best = inp; }
  }
  return best;
}

function getCgamosSpaCurrent() {
  const inp = getCgamosSpaPagerInput();
  if (inp) { const n = parseInt(inp.value || ''); if (!isNaN(n) && n > 0) return n; }
  return 1;
}

function goToCgamosPage(pageNumber) {
  const inp = getCgamosSpaPagerInput();
  if (!inp) return false;
  inp.focus();
  inp.value = String(pageNumber);
  inp.dispatchEvent(new Event('input',  { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  inp.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
  inp.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
  inp.blur();
  return true;
}

function extractCgamosRenderedImage() {
  function visibleArea(rect) {
    const vw = window.innerWidth  || document.documentElement.clientWidth  || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    return Math.max(0, Math.min(vw, rect.right)  - Math.max(0, rect.left)) *
           Math.max(0, Math.min(vh, rect.bottom) - Math.max(0, rect.top));
  }

  const candidates = [...document.querySelectorAll('canvas, img')]
    .map(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 150 || rect.height < 150) return null;
      const va = visibleArea(rect);
      if (va <= 0) return null;
      return { el, score: va + (el.tagName === 'CANVAS' ? 25000 : 0) };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) return null;
  const best = candidates[0].el;
  try {
    if (best.tagName === 'CANVAS') return best.toDataURL('image/jpeg', 0.95);
    const cv = document.createElement('canvas');
    cv.width  = best.naturalWidth  || best.width;
    cv.height = best.naturalHeight || best.height;
    cv.getContext('2d').drawImage(best, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', 0.95);
  } catch (e) {
    log('extractCgamosRenderedImage error:', e);
    return null;
  }
}

async function waitForCgamosSpaRender(targetPage, timeoutMs = 20000) {
  const startedAt = Date.now();
  const MIN_DATA_LEN = 50000;
  while (Date.now() - startedAt < timeoutMs) {
    if (isStopped) throw new Error('stopped');
    if (getCgamosSpaCurrent() === targetPage) {
      const dataUrl = extractCgamosRenderedImage();
      if (dataUrl && dataUrl.length > MIN_DATA_LEN) return dataUrl;
    }
    await sleep(400);
  }
  throw new Error(`Тайм-аут ожидания страницы ${targetPage}`);
}

function dataUrlToBytes(dataUrl) {
  const base64Index = dataUrl.indexOf('base64,');
  if (base64Index < 0) throw new Error('Неверный data-URL');
  const binary = atob(dataUrl.slice(base64Index + 7));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── КАИСА-Архив ────────────────────────────────────────────────────────────────

function isKaisaPage() {
  return !!(
    document.querySelector('img[src*="/imageViewer/image"]') ||
    document.querySelector('.viewer-canvas')
  );
}

function getKaisaImageUrls() {
  const seen = new Set();
  const result = [];

  for (const img of document.querySelectorAll('[class*="viewer-list"] img, .viewer-list img')) {
    const src = img.getAttribute('data-original') || img.getAttribute('src') || '';
    if (src && src.includes('imageViewer') && !seen.has(src)) {
      seen.add(src);
      result.push(src);
    }
  }

  if (!result.length) {
    for (const img of document.querySelectorAll('img[src*="imageViewer/image"]')) {
      const src = img.getAttribute('src') || '';
      if (src && !seen.has(src)) {
        seen.add(src);
        result.push(src);
      }
    }
  }

  return result;
}

function getKaisaTotalPages() {
  const title = document.querySelector('.viewer-title, [id*="viewerTitle"]');
  if (title) {
    const m = (title.textContent || '').match(/(\d+)\s+из\s+(\d+)/);
    if (m) return parseInt(m[2], 10);
  }
  const urls = getKaisaImageUrls();
  return urls.length || null;
}

function getKaisaCurrentPage() {
  const title = document.querySelector('.viewer-title, [id*="viewerTitle"]');
  if (title) {
    const m = (title.textContent || '').match(/(\d+)\s+из\s+(\d+)/);
    if (m) return parseInt(m[1], 10);
  }
  return 1;
}

function getKaisaDocId() {
  const m = location.pathname.match(/\/(?:documents|document|unit|delo|imageViewer\/show)\/(\d+)/i) ||
            location.search.match(/[?&](?:objectId|id|documentId)=(\d+)/i);
  if (m) return m[1];
  const parts = location.pathname.split('/').filter(Boolean).reverse();
  for (const p of parts) { if (/^\d+$/.test(p)) return p; }
  return 'doc_' + Date.now();
}

// ── Скачать весь документ — КАИСА ────────────────────────────────────────────

async function downloadAllKaisa(overrideFrom = null, overrideTo = null) {
  if (isRunning) return;
  isRunning = true; isPaused = false; isStopped = false;

  const cfg      = await ensureSettings();
  const docId    = getKaisaDocId();
  const titleRaw = getTitleFromPage();
  const folderName = `${sanitizeForFilename(titleRaw || 'kaisa')}_${docId}`;

  throttle.configure(cfg.delayMs, cfg.adaptiveSpeed);
  throttle.reset();
  dlSemaphore.setLimit(cfg.concurrentDownloads ?? DEFAULTS.concurrentDownloads);
  setIcon('active');

  try {
    sendStatus('КАИСА: сбор изображений со страницы…');
    const imgUrls = getKaisaImageUrls();

    if (!imgUrls.length) {
      sendDone('КАИСА: изображения не найдены. Откройте страницу просмотра документа.');
      return;
    }

    const totalPages = imgUrls.length;
    const from  = Math.max(1, overrideFrom ?? 1) - 1;
    const to    = Math.min(totalPages, overrideTo ?? totalPages) - 1;
    const total = to - from + 1;
    const padWidth = String(totalPages).length || 3;
    const failedPages = [];

    sendStatus(cfg.createFolders ? `Папка: ${folderName}` : 'Файлы в корне загрузок');
    if (cfg.createFolders) {
      downloadMetadata(folderName, docId, totalPages, titleRaw, null).catch(() => {});
    }

    for (let i = from; i <= to; i++) {
      await waitIfPaused();
      const pageNum = i + 1;
      sendProgress(i - from + 1, total);
      sendStatus(`КАИСА: скачивание стр. ${pageNum} / ${totalPages}`);

      const filename = cfg.createFolders
        ? `${folderName}/${pad(pageNum, padWidth)}.jpg`
        : `kaisa_${docId}_p${pad(pageNum, padWidth)}.jpg`;

      const rawUrl = imgUrls[i];
      const absUrl = rawUrl.startsWith('http') ? rawUrl : `${location.origin}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;

      const success = await downloadWithSemaphore(absUrl, filename);
      if (!success) {
        failedPages.push(pageNum);
        if (cfg.adaptiveSpeed) throttle.onRateLimit(0);
      } else {
        throttle.onSuccess();
      }

      await sleep(throttle.delay);
    }

    if (cfg.createFolders && failedPages.length > 0) downloadErrorLog(folderName, failedPages);

    const failedNote = failedPages.length ? ` (пропущено: ${failedPages.length})` : '';
    sendDone(`Готово: ${total - failedPages.length} стр.${failedNote}`, { failedCount: failedPages.length });

    saveHistory({ unit: docId, title: titleRaw || `Документ ${docId}`,
      pages: total - failedPages.length, timestamp: Date.now(), url: location.href, format: 'jpg' });

  } catch (e) {
    if (e.message === 'stopped') sendDone('Остановлено');
    else { console.error('[RAD] downloadAllKaisa:', e); sendDone('Ошибка: ' + e.message); }
  } finally {
    _cleanupAfterDownload();
  }
}

// ── Генерация PDF — КАИСА ─────────────────────────────────────────────────────

async function generatePDFKaisa(overrideFrom = null, overrideTo = null) {
  if (isRunning) return;
  isRunning = true; isPaused = false; isStopped = false;

  const cfg    = await ensureSettings();
  const docId  = getKaisaDocId();
  const titleRaw = getTitleFromPage();

  throttle.configure(cfg.delayMs, cfg.adaptiveSpeed);
  throttle.reset();
  setIcon('active');

  try {
    const imgUrls = getKaisaImageUrls();
    if (!imgUrls.length) { sendDone('PDF/КАИСА: изображения не найдены.'); return; }

    const from  = Math.max(1, overrideFrom ?? 1) - 1;
    const to    = Math.min(imgUrls.length, overrideTo ?? imgUrls.length) - 1;
    const total = to - from + 1;

    if (total > PDF_PAGE_HARD_LIMIT) {
      sendDone(`PDF: слишком много страниц (${total}). Максимум ${PDF_PAGE_HARD_LIMIT}.`);
      return;
    }

    const filename  = `${sanitizeForFilename(titleRaw)}_${docId}.pdf`;
    const pagesData = [];
    const failedNums = new Set();

    for (let i = from; i <= to; i++) {
      await waitIfPaused();
      const pageNum = i + 1;
      sendProgress(i - from + 1, total);
      sendStatus(`PDF/КАИСА: страница ${pageNum} / ${imgUrls.length}`);

      let bytes = await imgCacheGet(docId, pageNum);
      if (!bytes) {
        try {
          const rawUrl = imgUrls[i];
          const absUrl = rawUrl.startsWith('http') ? rawUrl : `${location.origin}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;
          const res = await fetch(absUrl);
          if (res.ok) {
            bytes = new Uint8Array(await res.arrayBuffer());
            imgCachePut(docId, pageNum, bytes);
            throttle.onSuccess();
          } else { throttle.onRateLimit(res.status); failedNums.add(pageNum); }
        } catch (e) { log('PDF/КАИСА error p' + pageNum, e); failedNums.add(pageNum); }
      }

      if (bytes) pagesData.push({ bytes, ...parseJpegHeader(bytes) });
      await sleep(throttle.delay);
    }

    if (!pagesData.length) { sendDone('PDF/КАИСА: нет данных для сборки'); return; }

    sendStatus(`PDF: сборка ${pagesData.length} страниц…`);
    const pdfBytes = await buildPDFViaWorker(pagesData, (c,t) => sendStatus(`PDF: ${c}/${t} стр…`));
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 60_000);
    imgCacheClear(docId).catch(() => {});

    const failNote = failedNums.size ? ` (пропущено: ${failedNums.size})` : '';
    sendDone(`PDF готов: ${pagesData.length} стр.${failNote}`,
      { isPDF: true, failedCount: failedNums.size });
    saveHistory({ unit: docId, title: titleRaw || `Документ ${docId}`,
      pages: pagesData.length, timestamp: Date.now(), url: location.href, format: 'pdf' });

  } catch (e) {
    if (e.message === 'stopped') sendDone('PDF: остановлено');
    else { console.error('[RAD] generatePDFKaisa:', e); sendDone('PDF: ошибка — ' + e.message); }
  } finally {
    isRunning = false; isPaused = false; isStopped = false;
    setIcon('inactive');
  }
}

// ── Универсальный определитель адаптера ──────────────────────────────────────

function getAdapterInfo() {
  if (isKaisaPage()) {
    const unitId = getKaisaDocId();
    return { type: 'kaisa', unitId };
  }
  if (isYandexArchivePage()) {
    const unitId = getYandexArchiveDocId();
    return { type: 'yandex', unitId };
  }
  if (isCgamosSpaPage()) {
    const unitId = getCgamosDocId();
    const total  = getCgamosSpaTotal();
    return { type: 'cgamos-spa', unitId, total };
  }
  if (isCgamosPage()) {
    const vType  = getCgamosViewerType();
    const unitId = getCgamosDocId();
    if (vType === 'arsvo') {
      const guid = getCgamosGuid();
      if (!guid) return null;
      return { type: 'cgamos-arsvo', unitId, guid };
    }
    return unitId ? { type: 'cgamos-dom', unitId } : null;
  }
  if (isVrrPage()) {
    const unitId = getVrrUnitId();
    return unitId ? { type: 'vrr', unitId } : null;
  }
  if (isArsvoPage()) {
    const guid   = getArsvoGuid();
    if (!guid) return null;
    const unitId = getArsvoUnitId() || guid.replace(/-/g, '').slice(0, 12);
    return { type: 'arsvo', unitId, guid };
  }
  const unitId = getUnitId();
  return unitId ? { type: 'yar', unitId } : null;
}

// ── Определение номера архива ─────────────────────────────────────────────────

async function detectArchiveNum(unit) {
  if (cachedArchNum) return cachedArchNum;

  const fromPath = location.pathname.match(/\/archive(\d+)\//)?.[1];
  if (fromPath) { cachedArchNum = fromPath; return fromPath; }
  const hostname = location.hostname;
  const known = ARCHIVE_NUM_MAP[hostname];
  if (known) {
    const ok = await testImage(
      `${location.origin}/archive${known}/${getArchiveImageSuffix()}/${unit}?n=1&_ts=${Date.now()}`, 4000
    );
    if (ok) { cachedArchNum = known; return known; }
  }

  log('archiveNum not in pathname or map, probing…');
  for (const n of ARCHIVE_PROBE_CANDIDATES) {
    if (n === known) continue;
    const ok = await testImage(
      `${location.origin}/archive${n}/${getArchiveImageSuffix()}/${unit}?n=1&_ts=${Date.now()}`, 4000
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

const downloadResolvers = new Map();

async function downloadWithSemaphore(url, filename) {
  await dlSemaphore.acquire();

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

// ── Бинарный поиск числа страниц ───────────────────────────────────────────────

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
  if (archNum != null) {
    try {
      const res = await fetch(imageUrl(unit, archNum, 1));
      if (res.ok) sha256 = await sha256Hex(await res.arrayBuffer());
    } catch (e) {
      log('SHA-256 fetch error:', e);
    }
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

const HISTORY_KEY     = 'rad_history';
const HISTORY_MAX_LEN = 10000;

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

// ── PDF: Worker-based assembly ────────────────────────────────────────────────

async function buildPDFViaWorker(pages, progressCb) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(chrome.runtime.getURL('pdf-worker.js'));
    } catch (e) {
      log('PDF Worker недоступен, используем синхронную сборку:', e.message);
      resolve(buildPDF(pages));
      return;
    }

    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        progressCb?.(data.current, data.total);
      } else if (data.type === 'done') {
        worker.terminate();
        resolve(new Uint8Array(data.buffer));
      } else if (data.type === 'error') {
        worker.terminate();
        reject(new Error(data.message));
      }
    };

    worker.onerror = (e) => {
      worker.terminate();
      log('PDF Worker error, falling back:', e.message);
      try { resolve(buildPDF(pages)); } catch(fe) { reject(fe); }
    };

    worker.postMessage({ type: 'BUILD', pages });
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

// ── Вспомогательный финализатор ───────────────────────────────────────────────

function _cleanupAfterDownload() {
  isRunning = false; isPaused = false; isStopped = false;
  dlSemaphore.drain();
  downloadResolvers.forEach(fn => fn(false));
  downloadResolvers.clear();
  setIcon('inactive');
}

// ── Генерация PDF ─────────────────────────────────────────────────────────────

async function generatePDF(overrideFrom = null, overrideTo = null) {
  if (isRunning) return;
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

    if (total > PDF_PAGE_HARD_LIMIT) {
      sendDone(
        `PDF: слишком много страниц (${total}). Максимум ${PDF_PAGE_HARD_LIMIT} за раз — ` +
        'задайте диапазон в слайдере или используйте режим JPG.'
      );
      return;
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

        if (fetchedBytes) bytes = fetchedBytes;
        else failedNums.add(p);
      }

      if (bytes) pagesData.push({ bytes, ...parseJpegHeader(bytes) });
      await sleep(throttle.delay);
    }

    if (!pagesData.length) { sendDone('PDF: нет данных для сборки'); return; }

    sendStatus(`PDF: сборка ${pagesData.length} страниц…`);
    const pdfBytes = await buildPDFViaWorker(pagesData, (c,t) => sendStatus(`PDF: ${c}/${t} стр…`));

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
    else { console.error('[RAD] generatePDF:', e); sendDone('PDF: ошибка — ' + e.message); }
  } finally {
    isRunning = false; isPaused = false; isStopped = false;
    setIcon('inactive');
  }
}

// ── Генерация PDF — VRR ───────────────────────────────────────────────────────

async function generatePDFVRR(overrideFrom = null, overrideTo = null) {
  if (isRunning) return;
  isRunning = true; isPaused = false; isStopped = false;

  const cfg    = await ensureSettings();
  const unitId = getVrrUnitId();

  if (!unitId) {
    sendDone('PDF: не удалось определить документ VRR');
    isRunning = false; setIcon('inactive'); return;
  }

  throttle.configure(cfg.delayMs, cfg.adaptiveSpeed);
  throttle.reset();
  setIcon('active');

  try {
    const offsets    = getVrrPageOffsets(unitId);
    const totalKnown = getVrrTotalPages();
    const titleRaw   = getTitleFromPage();

    if (!offsets.length) {
      sendDone('PDF: миниатюры не загружены. Прокрутите ленту страниц до конца и повторите.');
      return;
    }

    if (totalKnown > offsets.length) {
      sendStatus(`VRR: найдено ${offsets.length} из ${totalKnown} стр. — прокрутите ленту миниатюр.`);
      await sleep(2500);
    }

    sendStatus('VRR: определение способа загрузки…');
    const directPrefix = await probeVrrDirectPrefix(unitId, offsets[0]);
    const useCanvas    = directPrefix === '';
    const canvas       = useCanvas ? getVrrCanvas() : null;

    if (useCanvas && !canvas) {
      sendDone('PDF/VRR: canvas вьювер не найден. Откройте документ и повторите.');
      return;
    }

    const filename = `${sanitizeForFilename(titleRaw)}_unit_${unitId}.pdf`;
    const from0 = overrideFrom != null ? overrideFrom - 1 : 0;
    const to0   = overrideTo   != null ? Math.min(overrideTo - 1, offsets.length - 1) : offsets.length - 1;
    const total  = to0 - from0 + 1;

    if (total > PDF_PAGE_HARD_LIMIT) {
      sendDone(`PDF: слишком много страниц (${total}). Максимум ${PDF_PAGE_HARD_LIMIT}.`);
      return;
    }

    const pagesData  = [];
    const failedNums = new Set();
    let   prevFingerprint = canvas ? getVrrCanvasFingerprint(canvas) : '';

    for (let i = from0; i <= to0; i++) {
      await waitIfPaused();
      const pageNum = i + 1;
      sendProgress(i - from0 + 1, total);
      sendStatus(`PDF/VRR: страница ${pageNum} / ${offsets.length}`);

      let bytes = await imgCacheGet(unitId, i);

      if (!bytes) {
        if (useCanvas) {
          try {
            if (!navigateVrrToOffset(unitId, offsets[i])) {
              failedNums.add(pageNum); continue;
            }
            const dataUrl = await waitForVrrCanvasRender(canvas, prevFingerprint);
            prevFingerprint = getVrrCanvasFingerprint(canvas);
            bytes = dataUrlToBytes(dataUrl);
            imgCachePut(unitId, i, bytes);
            throttle.onSuccess();
          } catch (e) {
            if (e.message === 'stopped') throw e;
            log('PDF/VRR canvas error p' + pageNum, e);
            failedNums.add(pageNum);
          }
        } else {
          try {
            const res = await fetch(vrrDirectImageUrl(unitId, offsets[i]));
            if (res.ok) {
              bytes = new Uint8Array(await res.arrayBuffer());
              imgCachePut(unitId, i, bytes);
              throttle.onSuccess();
            } else {
              throttle.onRateLimit(res.status);
              failedNums.add(pageNum);
            }
          } catch (e) {
            log('PDF/VRR fetch error p' + pageNum, e);
            failedNums.add(pageNum);
          }
        }
      }

      if (bytes) pagesData.push({ bytes, ...parseJpegHeader(bytes) });
      await sleep(useCanvas ? Math.max(throttle.delay, 400) : throttle.delay);
    }

    if (!pagesData.length) { sendDone('PDF/VRR: нет данных для сборки'); return; }

    sendStatus(`PDF: сборка ${pagesData.length} страниц…`);
    const pdfBytes = await buildPDFViaWorker(pagesData, (c,t) => sendStatus(`PDF: ${c}/${t} стр…`));
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 60_000);
    imgCacheClear(unitId).catch(() => {});

    const failNote = failedNums.size ? ` (пропущено: ${failedNums.size})` : '';
    sendDone(`PDF готов: ${pagesData.length} стр.${failNote}`,
      { isPDF: true, failedCount: failedNums.size });

    saveHistory({ unit: unitId, title: titleRaw || `Документ ${unitId}`,
      pages: pagesData.length, timestamp: Date.now(), url: location.href, format: 'pdf' });

  } catch (e) {
    if (e.message === 'stopped') sendDone('PDF: остановлено');
    else { console.error('[RAD] generatePDFVRR:', e); sendDone('PDF: ошибка — ' + e.message); }
  } finally {
    isRunning = false; isPaused = false; isStopped = false;
    setIcon('inactive');
  }
}

// ── Генерация PDF — ЭЛАР ──────────────────────────────────────────────────────

async function generatePDFARSVO(overrideFrom = null, overrideTo = null) {
  if (isRunning) return;
  isRunning = true; isPaused = false; isStopped = false;

  const cfg    = await ensureSettings();
  const guid   = getArsvoGuid();
  const unitId = getArsvoUnitId() || (guid ? guid.replace(/-/g, '').slice(0, 12) : null);

  if (!guid) {
    sendDone('PDF: не удалось определить идентификатор документа ЭЛАР');
    isRunning = false; setIcon('inactive'); return;
  }

  throttle.configure(cfg.delayMs, cfg.adaptiveSpeed);
  throttle.reset();
  setIcon('active');

  try {
    sendStatus('PDF/ЭЛАР: определение количества страниц…');
    const totalPages = await findTotalPagesARSVO(guid, cfg.maxPages, t => sendStatus(`PDF: ${t}`));

    if (!totalPages) { sendDone('PDF/ЭЛАР: страницы не найдены'); return; }

    const titleRaw = getTitleFromPage();
    const filename  = `${sanitizeForFilename(titleRaw)}_unit_${unitId}.pdf`;

    const from = overrideFrom != null ? overrideFrom : 1;
    const to   = overrideTo   != null ? Math.min(overrideTo, totalPages) : totalPages;
    const total = to - from + 1;

    if (total > PDF_PAGE_HARD_LIMIT) {
      sendDone(`PDF: слишком много страниц (${total}). Максимум ${PDF_PAGE_HARD_LIMIT}.`);
      return;
    }

    const pagesData  = [];
    const failedNums = new Set();

    for (let p = from; p <= to; p++) {
      await waitIfPaused();
      sendProgress(p - from + 1, total);
      sendStatus(`PDF/ЭЛАР: страница ${p} / ${totalPages}` +
        (cfg.adaptiveSpeed ? ` (${throttle.delay} мс)` : ''));

      let bytes = await imgCacheGet(unitId, p);
      if (bytes) {
        throttle.onSuccess();
      } else if (isElarSingleTileMode()) {
        try {
          const res = await fetch(elarSingleTileUrl(guid, p - 1));
          if (res.ok) {
            bytes = new Uint8Array(await res.arrayBuffer());
            imgCachePut(unitId, p, bytes);
            throttle.onSuccess();
          } else {
            throttle.onRateLimit(res.status);
            failedNums.add(p);
          }
        } catch (e) {
          log('PDF/ЭЛАР fetch error p' + p, e);
          failedNums.add(p);
        }
      } else {
        try {
          const dataUrl = await stitchArsvoPageOnCanvas(guid, p - 1,
            t => sendStatus(`PDF/ЭЛАР: ${t}`));
          if (dataUrl) {
            bytes = dataUrlToBytes(dataUrl);
            imgCachePut(unitId, p, bytes);
            throttle.onSuccess();
          } else { failedNums.add(p); }
        } catch (e) {
          if (e.message === 'stopped') throw e;
          log('PDF/ЭЛАР stitch error p' + p, e);
          failedNums.add(p);
        }
      }

      if (bytes) pagesData.push({ bytes, ...parseJpegHeader(bytes) });
      await sleep(throttle.delay);
    }

    if (!pagesData.length) { sendDone('PDF/ЭЛАР: нет данных для сборки'); return; }

    sendStatus(`PDF: сборка ${pagesData.length} страниц…`);
    const pdfBytes = await buildPDFViaWorker(pagesData, (c,t) => sendStatus(`PDF: ${c}/${t} стр…`));
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 60_000);
    imgCacheClear(unitId).catch(() => {});

    const failNote = failedNums.size ? ` (пропущено: ${failedNums.size})` : '';
    sendDone(`PDF готов: ${pagesData.length} стр.${failNote}`,
      { isPDF: true, failedCount: failedNums.size });

    saveHistory({ unit: unitId, title: titleRaw || `Документ ${unitId}`,
      pages: pagesData.length, timestamp: Date.now(), url: location.href, format: 'pdf' });

  } catch (e) {
    if (e.message === 'stopped') sendDone('PDF: остановлено');
    else { console.error('[RAD] generatePDFЭЛАР:', e); sendDone('PDF: ошибка — ' + e.message); }
  } finally {
    isRunning = false; isPaused = false; isStopped = false;
    setIcon('inactive');
  }
}

// ── Генерация PDF — Яндекс Архив ─────────────────────────────────────────────

async function generatePDFYandex(overrideFrom = null, overrideTo = null) {
  if (isRunning) return;
  isRunning = true; isPaused = false; isStopped = false;

  const cfg    = await ensureSettings();
  const docId  = getYandexArchiveDocId();
  const titleRaw = getTitleFromPage();

  throttle.configure(cfg.delayMs, cfg.adaptiveSpeed);
  throttle.reset();
  setIcon('active');

  try {
    sendStatus('Яндекс Архив: определение числа страниц…');
    const totalDetected = getYandexArchiveTotalPages();

    if (!totalDetected) {
      sendDone('PDF: не удалось определить число страниц. Откройте документ и повторите.');
      return;
    }

    const from  = Math.max(1, overrideFrom ?? 1);
    const to    = Math.min(totalDetected, overrideTo ?? totalDetected);
    const total = to - from + 1;

    if (total > PDF_PAGE_HARD_LIMIT) {
      sendDone(`PDF: слишком много страниц (${total}). Максимум ${PDF_PAGE_HARD_LIMIT}.`);
      return;
    }

    const filename   = `${sanitizeForFilename(titleRaw)}_${docId}.pdf`;
    const pagesData  = [];
    const failedNums = new Set();

    for (let p = from; p <= to; p++) {
      await waitIfPaused();
      sendProgress(p - from + 1, total);
      sendStatus(`PDF/Яндекс: переход к стр. ${p} / ${to}…`);

      let bytes = await imgCacheGet(docId, p);
      if (!bytes) {
        try {
          if (getYandexArchiveCurrentPage() !== p) {
            if (navigateYandexToPage(p)) await sleep(800);
          }
          sendStatus(`PDF/Яндекс: ожидание скана стр. ${p}…`);
          const imageUrl = await waitForYandexPageRender(p, 25000);

          if (imageUrl.startsWith('data:')) {
            bytes = dataUrlToBytes(imageUrl);
          } else {
            const res = await fetch(imageUrl, { credentials: 'include' });
            if (res.ok) bytes = new Uint8Array(await res.arrayBuffer());
            else throw new Error(`HTTP ${res.status}`);
          }

          if (bytes && !looksLikeHtmlBytes(bytes)) {
            imgCachePut(docId, p, bytes);
            throttle.onSuccess();
          } else {
            bytes = null;
            throw new Error('получен HTML или пустой ответ');
          }
        } catch (e) {
          if (e.message === 'stopped') throw e;
          log('PDF/Yandex error p' + p, e);
          sendStatus(`PDF/Яндекс: пропуск стр. ${p} — ${e.message}`);
          throttle.onRateLimit(0);
          failedNums.add(p);
        }
      }

      if (bytes) pagesData.push({ bytes, ...parseJpegHeader(bytes) });
      await sleep(Math.max(throttle.delay, 400));
    }

    if (!pagesData.length) { sendDone('PDF/Яндекс: нет данных для сборки'); return; }

    sendStatus(`PDF: сборка ${pagesData.length} страниц…`);
    const pdfBytes = await buildPDFViaWorker(pagesData, (c,t) => sendStatus(`PDF: ${c}/${t} стр…`));
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 60_000);
    imgCacheClear(docId).catch(() => {});

    const failNote = failedNums.size ? ` (пропущено: ${failedNums.size})` : '';
    sendDone(`PDF готов: ${pagesData.length} стр.${failNote}`,
      { isPDF: true, failedCount: failedNums.size });

    saveHistory({ unit: docId, title: titleRaw || `Документ ${docId}`,
      pages: pagesData.length, timestamp: Date.now(), url: location.href, format: 'pdf' });

  } catch (e) {
    if (e.message === 'stopped') sendDone('PDF: остановлено');
    else { console.error('[RAD] generatePDFYandex:', e); sendDone('PDF: ошибка — ' + e.message); }
  } finally {
    isRunning = false; isPaused = false; isStopped = false;
    setIcon('inactive');
  }
}

// ── Генерация PDF — ЦГА Москвы ───────────────────────────────────────────────

async function generatePDFCgamosArsvo(guid, unitId, overrideFrom, overrideTo) {
  const cfg = await ensureSettings();

  sendStatus('ЦГА Москвы: определение количества страниц…');
  const totalPages = await findTotalPagesARSVO(guid, cfg.maxPages, t => sendStatus(`ЦГА: ${t}`));
  if (!totalPages) { sendDone('PDF/ЦГА: страницы не найдены'); return; }

  const titleRaw = getTitleFromPage();
  const filename  = `${sanitizeForFilename(titleRaw)}_${unitId}.pdf`;
  const from  = overrideFrom ?? 1;
  const to    = overrideTo   != null ? Math.min(overrideTo, totalPages) : totalPages;
  const total = to - from + 1;

  if (total > PDF_PAGE_HARD_LIMIT) {
    sendDone(`PDF: слишком много страниц (${total}). Максимум ${PDF_PAGE_HARD_LIMIT}.`);
    return;
  }

  const pagesData  = [];
  const failedNums = new Set();

  for (let p = from; p <= to; p++) {
    await waitIfPaused();
    sendProgress(p - from + 1, total);
    sendStatus(`PDF/ЦГА: страница ${p} / ${totalPages}`);

    let bytes = await imgCacheGet(unitId, p);
    if (!bytes) {
      if (isElarSingleTileMode()) {
        try {
          const res = await fetch(elarSingleTileUrl(guid, p - 1));
          if (res.ok) {
            bytes = new Uint8Array(await res.arrayBuffer());
            imgCachePut(unitId, p, bytes);
            throttle.onSuccess();
          } else { throttle.onRateLimit(res.status); failedNums.add(p); }
        } catch (e) { log('PDF/ЦГА fetch error p' + p, e); failedNums.add(p); }
      } else {
        try {
          const res = await fetch(arsvoImageUrl(guid, p - 1));
          if (res.ok) {
            bytes = new Uint8Array(await res.arrayBuffer());
            imgCachePut(unitId, p, bytes);
            throttle.onSuccess();
          } else { throttle.onRateLimit(res.status); failedNums.add(p); }
        } catch (e) { log('PDF/ЦГА fetch error p' + p, e); failedNums.add(p); }
      }
    }
    if (bytes) pagesData.push({ bytes, ...parseJpegHeader(bytes) });
    await sleep(throttle.delay);
  }

  if (!pagesData.length) { sendDone('PDF/ЦГА: нет данных для сборки'); return; }

  sendStatus(`PDF: сборка ${pagesData.length} страниц через Worker…`);
  const pdfBytes = await buildPDFViaWorker(pagesData, (cur, tot) => {
    sendStatus(`PDF: сборка ${cur} / ${tot} страниц…`);
  });
  const blob = new Blob([pdfBytes], { type: 'application/pdf' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.style.display = 'none';
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 60_000);
  imgCacheClear(unitId).catch(() => {});

  const failNote = failedNums.size ? ` (пропущено: ${failedNums.size})` : '';
  sendDone(`PDF готов: ${pagesData.length} стр.${failNote}`,
    { isPDF: true, failedCount: failedNums.size });
  saveHistory({ unit: unitId, title: titleRaw || `Документ ${unitId}`,
    pages: pagesData.length, timestamp: Date.now(), url: location.href, format: 'pdf' });
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
    isRunning = false; setIcon('inactive'); return;
  }

  throttle.configure(cfg.delayMs, cfg.adaptiveSpeed);
  throttle.reset();
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
    // Зондирование каждые 20 страниц остаётся как запасной механизм для
    // получения точного HTTP-статуса (нужен для корректного throttle.onRateLimit)
    const PROBE_EVERY = 20;

    for (let p = pFrom; p <= total; p++) {
      await waitIfPaused();
      sendProgress(p - pFrom + 1, total - pFrom + 1);
      sendStatus(`Скачивание ${p} / ${total}` +
        (cfg.adaptiveSpeed ? ` (${throttle.delay} мс)` : ''));

      if (cfg.adaptiveSpeed && p > pFrom && (p - pFrom) % PROBE_EVERY === 0) {
        await probeUrl(imageUrl(unit, archNum, p));
      }

      const filename = cfg.createFolders
        ? `${folderName}/${pad(p, padWidth)}.jpg`
        : `unit_${unit}_p${pad(p, padWidth)}.jpg`;

      const success = await downloadWithSemaphore(imageUrl(unit, archNum, p), filename);
      if (!success) {
        failedPages.push(p);
        if (cfg.adaptiveSpeed) throttle.onRateLimit(0);
      } else {
        throttle.onSuccess();
      }

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
    else { console.error('[RAD] downloadAll:', e); sendDone('Ошибка: ' + e.message); }
  } finally {
    _cleanupAfterDownload();
  }
}

// ── Скачать весь документ — VRR ───────────────────────────────────────────────

async function downloadAllVRR(overrideFrom = null, overrideTo = null) {
  if (isRunning) return;
  isRunning = true; isPaused = false; isStopped = false;

  const cfg    = await ensureSettings();
  const unitId = getVrrUnitId();

  if (!unitId) {
    sendDone('Не удалось определить документ VRR');
    isRunning = false; setIcon('inactive'); return;
  }

  throttle.configure(cfg.delayMs, cfg.adaptiveSpeed);
  throttle.reset();
  dlSemaphore.setLimit(1);
  setIcon('active');

  try {
    const offsets    = getVrrPageOffsets(unitId);
    const totalKnown = getVrrTotalPages();
    const titleRaw   = getTitleFromPage();
    const folderName = `${sanitizeForFilename(titleRaw)}_unit_${unitId}`;

    if (!offsets.length) {
      sendDone('Страницы не найдены. Прокрутите ленту миниатюр в просмотрщике и повторите.');
      return;
    }

    if (totalKnown > offsets.length) {
      sendStatus(`VRR: загружено ${offsets.length} из ${totalKnown} миниатюр. Прокрутите ленту страниц до конца.`);
      await sleep(3000);
    }

    sendStatus('VRR: определение способа загрузки…');
    const directPrefix = await probeVrrDirectPrefix(unitId, offsets[0]);
    const useCanvas    = directPrefix === '';
    const canvas       = useCanvas ? getVrrCanvas() : null;

    if (useCanvas && !canvas) {
      sendDone('VRR: canvas вьювер не найден. Откройте документ и повторите.');
      return;
    }

    const from0 = overrideFrom != null ? overrideFrom - 1 : 0;
    const to0   = overrideTo   != null ? Math.min(overrideTo - 1, offsets.length - 1) : offsets.length - 1;
    const total  = to0 - from0 + 1;
    const padWidth = String(offsets.length).length || 3;
    const failedPages = [];

    sendStatus(cfg.createFolders ? `Папка: ${folderName}` : 'Файлы в корне загрузок');
    if (cfg.createFolders) {
      downloadMetadata(folderName, unitId, offsets.length, titleRaw, null).catch(e => log('meta:', e));
    }

    let prevFingerprint = canvas ? getVrrCanvasFingerprint(canvas) : '';

    for (let i = from0; i <= to0; i++) {
      await waitIfPaused();
      const pageNum = i + 1;
      sendProgress(i - from0 + 1, total);

      const filename = cfg.createFolders
        ? `${folderName}/${pad(pageNum, padWidth)}.jpg`
        : `unit_${unitId}_p${pad(pageNum, padWidth)}.jpg`;

      if (useCanvas) {
        sendStatus(`VRR: переход к стр. ${pageNum} / ${offsets.length}…`);
        try {
          if (!navigateVrrToOffset(unitId, offsets[i])) {
            log(`VRR: thumbnail for offset ${offsets[i]} not found`);
            failedPages.push(pageNum);
            continue;
          }
          const dataUrl = await waitForVrrCanvasRender(canvas, prevFingerprint);
          prevFingerprint = getVrrCanvasFingerprint(canvas);

          chrome.runtime.sendMessage({ type: 'DOWNLOAD', url: dataUrl, filename });
          throttle.onSuccess();
          await sleep(300);
        } catch (e) {
          log('VRR canvas error p' + pageNum, e);
          if (e.message === 'stopped') throw e;
          sendStatus(`VRR: ошибка стр. ${pageNum} — ${e.message}`);
          failedPages.push(pageNum);
          if (cfg.adaptiveSpeed) throttle.onRateLimit(0);
        }
      } else {
        sendStatus(`VRR: скачивание стр. ${pageNum} / ${offsets.length}`);
        const success = await downloadWithSemaphore(vrrDirectImageUrl(unitId, offsets[i]), filename);
        if (!success) {
          failedPages.push(pageNum);
          if (cfg.adaptiveSpeed) throttle.onRateLimit(0);
        } else {
          throttle.onSuccess();
        }
      }

      if (pageNum % 10 === 0) {
        saveResumeState(unitId, { lastPage: pageNum, totalPages: offsets.length, folderName, fromPage: from0 + 1 });
      }

      await sleep(useCanvas ? Math.max(throttle.delay, 400) : throttle.delay);
    }

    if (cfg.createFolders && failedPages.length > 0) downloadErrorLog(folderName, failedPages);
    clearResumeState(unitId);

    const failedNote = failedPages.length ? ` (пропущено: ${failedPages.length})` : '';
    sendDone(`Готово: ${total - failedPages.length} стр.${failedNote}`, { failedCount: failedPages.length });

    saveHistory({ unit: unitId, title: titleRaw || `Документ ${unitId}`,
      pages: total - failedPages.length, timestamp: Date.now(), url: location.href, format: 'jpg' });

  } catch (e) {
    if (e.message === 'stopped') sendDone('Остановлено');
    else { console.error('[RAD] downloadAllVRR:', e); sendDone('Ошибка: ' + e.message); }
  } finally {
    _cleanupAfterDownload();
  }
}

// ── Скачать весь документ — ЭЛАР ─────────────────────────────────────────────

async function downloadAllARSVO(overrideFrom = null, overrideTo = null) {
  if (isRunning) return;
  isRunning = true; isPaused = false; isStopped = false;

  const cfg    = await ensureSettings();
  const guid   = getArsvoGuid();
  const unitId = getArsvoUnitId() || (guid ? guid.replace(/-/g, '').slice(0, 12) : null);

  if (!guid) {
    sendDone('Не удалось определить идентификатор документа ЭЛАР');
    isRunning = false; setIcon('inactive'); return;
  }

  throttle.configure(cfg.delayMs, cfg.adaptiveSpeed);
  throttle.reset();
  dlSemaphore.setLimit(cfg.concurrentDownloads ?? DEFAULTS.concurrentDownloads);
  setIcon('active');

  try {
    const titleRaw   = getTitleFromPage();
    const folderName = `${sanitizeForFilename(titleRaw)}_unit_${unitId}`;

    let totalPages, pFrom, isResuming = false;

    if (overrideFrom === null) {
      const saved = await getResumeState(unitId);
      if (saved?.lastPage && saved?.totalPages) {
        isResuming = true;
        pFrom      = saved.lastPage + 1;
        totalPages = saved.totalPages;
        const ageMin = Math.round((Date.now() - (saved.savedAt ?? 0)) / 60000);
        sendStatus(`Продолжение с стр. ${pFrom} / ${totalPages} (${ageMin} мин. назад)…`);
        await sleep(1200);
      }
    }

    if (!isResuming) {
      sendStatus('ЭЛАР: определение количества страниц…');
      totalPages = await findTotalPagesARSVO(guid, cfg.maxPages, t => sendStatus(t));

      if (!totalPages) {
        sendDone('Страницы не найдены'); clearResumeState(unitId); return;
      }

      pFrom = overrideFrom != null ? overrideFrom : 1;
      if (overrideTo != null) totalPages = Math.min(overrideTo, totalPages);

      sendStatus(cfg.createFolders ? `Папка: ${folderName}` : 'Файлы в корне загрузок');
      if (cfg.createFolders) {
        downloadMetadata(folderName, unitId, totalPages, titleRaw, null).catch(e => log('meta:', e));
      }
    }

    const padWidth    = String(totalPages).length || 3;
    const failedPages = [];

    for (let p = pFrom; p <= totalPages; p++) {
      await waitIfPaused();
      sendProgress(p - pFrom + 1, totalPages - pFrom + 1);
      sendStatus(`Скачивание ${p} / ${totalPages}` +
        (cfg.adaptiveSpeed ? ` (${throttle.delay} мс)` : ''));

      const filename = cfg.createFolders
        ? `${folderName}/${pad(p, padWidth)}.jpg`
        : `unit_${unitId}_p${pad(p, padWidth)}.jpg`;

      if (isElarSingleTileMode()) {
        const success = await downloadWithSemaphore(elarSingleTileUrl(guid, p - 1), filename);
        if (!success) {
          failedPages.push(p);
          if (cfg.adaptiveSpeed) throttle.onRateLimit(0);
        } else {
          throttle.onSuccess();
        }
      } else {
        sendStatus(`ЭЛАР: сшивка стр. ${p} / ${totalPages}…`);
        try {
          const dataUrl = await stitchArsvoPageOnCanvas(guid, p - 1, t => sendStatus(t));
          if (dataUrl) {
            chrome.runtime.sendMessage({ type: 'DOWNLOAD', url: dataUrl, filename });
            throttle.onSuccess();
            await sleep(400);
          } else {
            failedPages.push(p);
            if (cfg.adaptiveSpeed) throttle.onRateLimit(0);
          }
        } catch (e) {
          if (e.message === 'stopped') throw e;
          log('ЭЛАР stitch error p' + p, e); failedPages.push(p);
          if (cfg.adaptiveSpeed) throttle.onRateLimit(0);
        }
      }

      if (p % 10 === 0) {
        saveResumeState(unitId, { lastPage: p, totalPages, folderName, fromPage: pFrom });
      }

      await sleep(throttle.delay);
    }

    if (cfg.createFolders && failedPages.length > 0) downloadErrorLog(folderName, failedPages);
    clearResumeState(unitId);

    const failedNote = failedPages.length ? ` (пропущено: ${failedPages.length})` : '';
    sendDone(`Готово: ${totalPages - pFrom + 1 - failedPages.length} стр.${failedNote}`,
      { failedCount: failedPages.length });

    saveHistory({ unit: unitId, title: titleRaw || `Документ ${unitId}`,
      pages: totalPages - pFrom + 1 - failedPages.length,
      timestamp: Date.now(), url: location.href, format: 'jpg' });

  } catch (e) {
    if (e.message === 'stopped') sendDone('Остановлено');
    else { console.error('[RAD] downloadAllЭЛАР:', e); sendDone('Ошибка: ' + e.message); }
  } finally {
    _cleanupAfterDownload();
  }
}

// ── Яндекс Архив: SPA-навигация ──────────────────────────────────────────────

function getYandexPagerInput() {
  for (const inp of document.querySelectorAll('input')) {
    const val = (inp.value || '').trim();
    if (!/^\d{1,5}$/.test(val)) continue;
    const rect = inp.getBoundingClientRect();
    if (rect.width < 20 || rect.width > 140 || rect.height < 16 || rect.height > 80) continue;
    const ctx = (inp.parentElement?.textContent || '') + (inp.parentElement?.parentElement?.textContent || '');
    if (/\/\s*\d{1,5}/.test(ctx)) return inp;
  }
  return null;
}

function navigateYandexToPage(pageNumber) {
  const inp = getYandexPagerInput();
  if (!inp) return false;
  inp.focus();
  inp.value = String(pageNumber);
  inp.dispatchEvent(new Event('input',  { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  inp.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
  inp.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
  inp.blur();
  return true;
}

async function waitForYandexPageRender(targetPage, timeoutMs = 25000) {
  const MIN_CANVAS_BYTES = 8000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (isStopped) throw new Error('stopped');

    const pagerOk = getYandexArchiveCurrentPage() === targetPage;

    if (pagerOk) {
      let bestUrl = null;
      for (const canvas of document.querySelectorAll('canvas')) {
        const w = canvas.width  || 0;
        const h = canvas.height || 0;
        if (w < 300 || h < 300) continue;
        try {
          const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
          if (dataUrl && dataUrl.length >= MIN_CANVAS_BYTES) {
            bestUrl = dataUrl;
            break;
          }
        } catch { /* tainted canvas */ }
      }
      if (bestUrl) return bestUrl;

      const domResult = extractBestImageFromLiveDom();
      if (domResult?.url && !domResult.isCanvas && isAllowedYandexCandidate(domResult.url)) {
        return domResult.url;
      }
    }

    await sleep(400);
  }
  throw new Error(`Яндекс Архив: тайм-аут ожидания страницы ${targetPage}`);
}

// ── Скачать весь документ — Яндекс Архив ─────────────────────────────────────

async function downloadAllYandex(overrideFrom = null, overrideTo = null) {
  if (isRunning) return;
  isRunning = true; isPaused = false; isStopped = false;

  const cfg      = await ensureSettings();
  const docId    = getYandexArchiveDocId();
  const titleRaw = getTitleFromPage();
  const folderName = `${sanitizeForFilename(titleRaw || 'ya_archive')}_${docId}`;

  throttle.configure(cfg.delayMs, cfg.adaptiveSpeed);
  throttle.reset();
  dlSemaphore.setLimit(1);
  setIcon('active');

  try {
    sendStatus('Яндекс Архив: определение числа страниц…');
    const totalDetected = getYandexArchiveTotalPages();

    if (!totalDetected) {
      sendDone('Яндекс Архив: не удалось определить число страниц. Откройте документ и повторите.');
      return;
    }

    const from  = Math.max(1, overrideFrom ?? 1);
    const to    = Math.min(totalDetected, overrideTo ?? totalDetected);
    const total = to - from + 1;
    const padWidth = String(totalDetected).length || 3;
    const failedPages = [];

    sendStatus(cfg.createFolders ? `Папка: ${folderName}` : 'Файлы в корне загрузок');
    if (cfg.createFolders) {
      downloadMetadata(folderName, docId, totalDetected, titleRaw, null).catch(() => {});
    }

    for (let p = from; p <= to; p++) {
      await waitIfPaused();
      sendProgress(p - from + 1, total);
      sendStatus(`Яндекс Архив: переход к стр. ${p} / ${to}…`);

      try {
        if (getYandexArchiveCurrentPage() !== p) {
          if (!navigateYandexToPage(p)) {
            sendStatus(`Яндекс Архив: пагинатор не найден (стр. ${p})`);
            failedPages.push(p); continue;
          }
          await sleep(800);
        }

        sendStatus(`Яндекс Архив: ожидание скана стр. ${p}…`);
        const imageUrl = await waitForYandexPageRender(p, 25000);

        const filename = cfg.createFolders
          ? `${folderName}/${pad(p, padWidth)}.jpg`
          : `ya_${docId}_p${pad(p, padWidth)}.jpg`;

        chrome.runtime.sendMessage({ type: 'DOWNLOAD', url: imageUrl, filename });
        throttle.onSuccess();
      } catch (e) {
        if (e.message === 'stopped') throw e;
        log('Yandex page error p' + p, e);
        sendStatus(`Яндекс Архив: ошибка стр. ${p} — ${e.message}`);
        if (cfg.adaptiveSpeed) throttle.onRateLimit(0);
        failedPages.push(p);
      }

      await sleep(Math.max(throttle.delay, 500));
    }

    if (cfg.createFolders && failedPages.length > 0) downloadErrorLog(folderName, failedPages);

    const failedNote = failedPages.length ? ` (пропущено: ${failedPages.length})` : '';
    sendDone(`Готово: ${total - failedPages.length} стр.${failedNote}`, { failedCount: failedPages.length });

    saveHistory({ unit: docId, title: titleRaw || `Документ ${docId}`,
      pages: total - failedPages.length, timestamp: Date.now(), url: location.href, format: 'jpg' });

  } catch (e) {
    if (e.message === 'stopped') sendDone('Остановлено');
    else { console.error('[RAD] downloadAllYandex:', e); sendDone('Ошибка: ' + e.message); }
  } finally {
    _cleanupAfterDownload();
  }
}

// ── Скачать весь документ — ЦГА Москвы ───────────────────────────────────────

async function downloadAllCgamos(overrideFrom = null, overrideTo = null) {
  if (isRunning) return;
  isRunning = true; isPaused = false; isStopped = false;

  const cfg      = await ensureSettings();
  const vType    = getCgamosViewerType();
  const docId    = getCgamosDocId();
  const titleRaw = getTitleFromPage();
  const folderName = `${sanitizeForFilename(titleRaw || 'cgamos')}_${docId}`;

  throttle.configure(cfg.delayMs, cfg.adaptiveSpeed);
  throttle.reset();
  dlSemaphore.setLimit(cfg.concurrentDownloads ?? DEFAULTS.concurrentDownloads);
  setIcon('active');

  try {
    if (vType === 'arsvo') {
      const guid = getCgamosGuid();
      if (!guid) { sendDone('ЦГА: не удалось определить идентификатор документа'); return; }

      sendStatus('ЦГА Москвы: определение количества страниц…');
      let totalPages = await findTotalPagesARSVO(guid, cfg.maxPages, t => sendStatus(`ЦГА: ${t}`));
      if (!totalPages) { sendDone('ЦГА: страницы не найдены'); return; }

      const pFrom = overrideFrom ?? 1;
      if (overrideTo) totalPages = Math.min(overrideTo, totalPages);

      sendStatus(cfg.createFolders ? `Папка: ${folderName}` : 'Файлы в корне загрузок');
      if (cfg.createFolders) {
        downloadMetadata(folderName, docId, totalPages, titleRaw, null).catch(() => {});
      }

      const padWidth    = String(totalPages).length || 3;
      const failedPages = [];

      for (let p = pFrom; p <= totalPages; p++) {
        await waitIfPaused();
        sendProgress(p - pFrom + 1, totalPages - pFrom + 1);
        sendStatus(`ЦГА Москвы: скачивание стр. ${p} / ${totalPages}`);

        const filename = cfg.createFolders
          ? `${folderName}/${pad(p, padWidth)}.jpg`
          : `cgamos_${docId}_p${pad(p, padWidth)}.jpg`;

        const success = await downloadWithSemaphore(arsvoImageUrl(guid, p - 1), filename);
        if (!success) {
          failedPages.push(p);
          if (cfg.adaptiveSpeed) throttle.onRateLimit(0);
        } else {
          throttle.onSuccess();
        }

        if (p % 10 === 0) saveResumeState(docId, { lastPage: p, totalPages, folderName, fromPage: pFrom });
        await sleep(throttle.delay);
      }

      if (cfg.createFolders && failedPages.length > 0) downloadErrorLog(folderName, failedPages);
      clearResumeState(docId);

      const failedNote = failedPages.length ? ` (пропущено: ${failedPages.length})` : '';
      sendDone(`Готово: ${totalPages - pFrom + 1 - failedPages.length} стр.${failedNote}`,
        { failedCount: failedPages.length });

      saveHistory({ unit: docId, title: titleRaw || `Документ ${docId}`,
        pages: totalPages - pFrom + 1 - failedPages.length,
        timestamp: Date.now(), url: location.href, format: 'jpg' });

    } else {
      sendStatus('ЦГА Москвы: сбор изображений со страницы…');
      const pageImgs = collectCgamosPageImageUrls();

      if (!pageImgs.length) {
        sendDone('ЦГА: изображения не найдены. Откройте страницу просмотра документа.');
        return;
      }

      const from  = Math.max(1, overrideFrom ?? 1) - 1;
      const to    = Math.min(pageImgs.length, overrideTo ?? pageImgs.length) - 1;
      const total = to - from + 1;
      const padWidth = String(pageImgs.length).length || 3;
      const failedPages = [];

      if (cfg.createFolders) {
        downloadMetadata(folderName, docId, total, titleRaw, null).catch(() => {});
      }

      for (let i = from; i <= to; i++) {
        await waitIfPaused();
        const pageNum = i + 1;
        sendProgress(i - from + 1, total);
        sendStatus(`ЦГА Москвы: скачивание стр. ${pageNum} / ${pageImgs.length}`);

        const filename = cfg.createFolders
          ? `${folderName}/${pad(pageNum, padWidth)}.jpg`
          : `cgamos_${docId}_p${pad(pageNum, padWidth)}.jpg`;

        const success = await downloadWithSemaphore(pageImgs[i].url, filename);
        if (!success) {
          failedPages.push(pageNum);
          if (cfg.adaptiveSpeed) throttle.onRateLimit(0);
        } else {
          throttle.onSuccess();
        }
        await sleep(throttle.delay);
      }

      if (cfg.createFolders && failedPages.length > 0) downloadErrorLog(folderName, failedPages);

      const failedNote = failedPages.length ? ` (пропущено: ${failedPages.length})` : '';
      sendDone(`Готово: ${total - failedPages.length} стр.${failedNote}`, { failedCount: failedPages.length });

      saveHistory({ unit: docId, title: titleRaw || `Документ ${docId}`,
        pages: total - failedPages.length, timestamp: Date.now(), url: location.href, format: 'jpg' });
    }

  } catch (e) {
    if (e.message === 'stopped') sendDone('Остановлено');
    else { console.error('[RAD] downloadAllCgamos:', e); sendDone('Ошибка: ' + e.message); }
  } finally {
    _cleanupAfterDownload();
  }
}

// ── Скачать текущую страницу ──────────────────────────────────────────────────

async function downloadCurrent() {
  const cfg     = await ensureSettings();
  const adapter = getAdapterInfo();
  if (!adapter) { sendStatus('Не архивная страница'); return; }

  setIcon('active');

  if (adapter.type === 'vrr') {
    const offset   = getVrrCurrentOffset(adapter.unitId);
    const offsets  = getVrrPageOffsets(adapter.unitId);
    const pageIdx  = offsets.indexOf(offset);
    const pageNum  = pageIdx >= 0 ? pageIdx + 1 : 1;
    const titleRaw = getTitleFromPage();
    const folder   = `${sanitizeForFilename(titleRaw)}_unit_${adapter.unitId}`;
    const filename = cfg.createFolders
      ? `${folder}/${pad(pageNum, 3)}.jpg`
      : `unit_${adapter.unitId}_p${pad(pageNum, 3)}.jpg`;

    if (_vrrDirectPrefix) {
      chrome.runtime.sendMessage({ type: 'DOWNLOAD', url: vrrDirectImageUrl(adapter.unitId, offset), filename });
      sendStatus(`Скачана стр. ${pageNum}`);
    } else {
      const cv = getVrrCanvas();
      if (!cv) { sendStatus('VRR: canvas не найден'); return; }
      const dataUrl = cv.toDataURL('image/jpeg', 0.95);
      if (!dataUrl || dataUrl.length < 5000) { sendStatus('VRR: страница ещё не загружена'); return; }
      chrome.runtime.sendMessage({ type: 'DOWNLOAD', url: dataUrl, filename });
      sendStatus(`Скачана стр. ${pageNum} (canvas)`);
    }

  } else if (adapter.type === 'arsvo') {
    const p        = getArsvoCurrentPage();
    const titleRaw = getTitleFromPage();
    const folder   = `${sanitizeForFilename(titleRaw)}_unit_${adapter.unitId}`;
    const filename = cfg.createFolders
      ? `${folder}/${pad(p, 3)}.jpg`
      : `unit_${adapter.unitId}_p${pad(p, 3)}.jpg`;
    chrome.runtime.sendMessage({ type: 'DOWNLOAD', url: arsvoImageUrl(adapter.guid, p - 1), filename });
    sendStatus(`Скачана стр. ${p}`);

  } else if (adapter.type === 'yandex') {
    const curPage  = getYandexArchiveCurrentPage();
    const titleRaw = getTitleFromPage();
    const folder   = `${sanitizeForFilename(titleRaw)}_${adapter.unitId}`;
    const filename = cfg.createFolders
      ? `${folder}/${pad(curPage, 3)}.jpg`
      : `ya_${adapter.unitId}_p${pad(curPage, 3)}.jpg`;
    const domResult = extractBestImageFromLiveDom();
    if (domResult && domResult.url) {
      chrome.runtime.sendMessage({ type: 'DOWNLOAD', url: domResult.url, filename });
      sendStatus(`Яндекс Архив: скачана стр. ${curPage}${domResult.isCanvas ? ' (canvas)' : ''}`);
    } else {
      sendStatus('Яндекс Архив: изображение не найдено. Дождитесь полной загрузки скана.');
    }

  } else if (adapter.type === 'cgamos-spa') {
    const p        = getCgamosSpaCurrent();
    const dataUrl  = extractCgamosRenderedImage();
    if (!dataUrl) { sendStatus('ЦГА Москвы: скан ещё не отрендерен, подождите'); return; }
    const titleRaw = getTitleFromPage();
    const folder   = `${sanitizeForFilename(titleRaw)}_${adapter.unitId}`;
    const filename = cfg.createFolders
      ? `${folder}/${pad(p, 3)}.jpg`
      : `cgamos_${adapter.unitId}_p${pad(p, 3)}.jpg`;
    chrome.runtime.sendMessage({ type: 'DOWNLOAD', url: dataUrl, filename });
    sendStatus(`ЦГА Москвы: скачана стр. ${p}`);

  } else if (adapter.type === 'kaisa') {
    const imgUrls  = getKaisaImageUrls();
    const curPage  = getKaisaCurrentPage();
    const img      = imgUrls[curPage - 1] || imgUrls[0];
    if (!img) { sendStatus('КАИСА: изображение не найдено'); return; }
    const titleRaw = getTitleFromPage();
    const folder   = `${sanitizeForFilename(titleRaw)}_${adapter.unitId}`;
    const filename = cfg.createFolders
      ? `${folder}/${pad(curPage, 3)}.jpg`
      : `kaisa_${adapter.unitId}_p${pad(curPage, 3)}.jpg`;
    const absUrl = img.startsWith('http') ? img : `${location.origin}${img.startsWith('/') ? '' : '/'}${img}`;
    chrome.runtime.sendMessage({ type: 'DOWNLOAD', url: absUrl, filename });
    sendStatus(`КАИСА: скачана стр. ${curPage}`);

  } else if (adapter.type === 'cgamos-arsvo') {
    const p        = getCgamosCurrentPage();
    const titleRaw = getTitleFromPage();
    const folder   = `${sanitizeForFilename(titleRaw)}_${adapter.unitId}`;
    const filename = cfg.createFolders
      ? `${folder}/${pad(p, 3)}.jpg`
      : `cgamos_${adapter.unitId}_p${pad(p, 3)}.jpg`;
    chrome.runtime.sendMessage({ type: 'DOWNLOAD', url: arsvoImageUrl(adapter.guid, p - 1), filename });
    sendStatus(`ЦГА Москвы: скачана стр. ${p}`);

  } else if (adapter.type === 'cgamos-dom') {
    const pageImgs = collectCgamosPageImageUrls();
    const img      = pageImgs[0];
    if (!img) { sendStatus('ЦГА Москвы: страница не найдена'); return; }
    const titleRaw = getTitleFromPage();
    const folder   = `${sanitizeForFilename(titleRaw)}_${adapter.unitId}`;
    const filename = cfg.createFolders
      ? `${folder}/page_current.jpg`
      : `cgamos_${adapter.unitId}_current.jpg`;
    chrome.runtime.sendMessage({ type: 'DOWNLOAD', url: img.url, filename });
    sendStatus('ЦГА Москвы: скачана текущая страница');

  } else {
    const archNum  = await detectArchiveNum(adapter.unitId);
    const titleRaw = getTitleFromPage();
    const folder   = `${sanitizeForFilename(titleRaw)}_unit_${adapter.unitId}`;
    const p        = detectCurrentPage();
    const filename = cfg.createFolders
      ? `${folder}/${pad(p, 3)}.jpg`
      : `unit_${adapter.unitId}_p${pad(p, 3)}.jpg`;
    chrome.runtime.sendMessage({ type: 'DOWNLOAD', url: imageUrl(adapter.unitId, archNum, p), filename });
    sendStatus(`Скачана стр. ${p}`);
  }

  setTimeout(() => setIcon('inactive'), 1200);
}

// ── Обработчик сообщений от popup / background ────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.type) return;

  switch (msg.type) {
    case 'DOWNLOAD_ALL': {
      const adapter = getAdapterInfo();
      if (!adapter) { sendDone('Не архивная страница'); break; }
      const from = msg.fromPage ?? null, to = msg.toPage ?? null;
      if      (adapter.type === 'vrr')         downloadAllVRR(from, to);
      else if (adapter.type === 'arsvo')        downloadAllARSVO(from, to);
      else if (adapter.type === 'yandex')       downloadAllYandex(from, to);
      else if (adapter.type === 'kaisa')        downloadAllKaisa(from, to);
      else if (adapter.type === 'cgamos-spa')   downloadAllCgamosSpa(from, to);
      else if (adapter.type === 'cgamos-arsvo' ||
               adapter.type === 'cgamos-dom')   downloadAllCgamos(from, to);
      else                                       downloadAll(from, to);
      break;
    }

    case 'DOWNLOAD_CURRENT':
      downloadCurrent(); break;

    case 'GENERATE_PDF': {
      const adapter = getAdapterInfo();
      if (!adapter) { sendDone('Не архивная страница'); break; }
      const from = msg.fromPage ?? null, to = msg.toPage ?? null;
      if      (adapter.type === 'vrr')         generatePDFVRR(from, to);
      else if (adapter.type === 'arsvo')        generatePDFARSVO(from, to);
      else if (adapter.type === 'yandex')       generatePDFYandex(from, to);
      else if (adapter.type === 'kaisa')        generatePDFKaisa(from, to);
      else if (adapter.type === 'cgamos-spa')   generatePDFCgamosSpa(from, to);
      else if (adapter.type === 'cgamos-arsvo') {
        isRunning = true; isPaused = false; isStopped = false;
        throttle.configure(
          (settingsCache?.delayMs ?? DEFAULTS.delayMs),
          (settingsCache?.adaptiveSpeed ?? false)
        );
        throttle.reset(); setIcon('active');
        generatePDFCgamosArsvo(adapter.guid, adapter.unitId, from, to)
          .catch(e => {
            if (e.message !== 'stopped') sendDone('PDF: ошибка — ' + e.message);
          })
          .finally(() => {
            isRunning = false; isPaused = false; isStopped = false;
            setIcon('inactive');
          });
      }
      else if (adapter.type === 'cgamos-dom')   generatePDFYandex(from, to);
      else                                        generatePDF(from, to);
      break;
    }

    case 'PAUSE':
      if (isRunning && !isPaused) { isPaused = true; sendStatus('Пауза'); } break;
    case 'RESUME':
      if (isRunning && isPaused) { isPaused = false; sendStatus('Продолжение…'); } break;
    case 'STOP':
      if (isRunning) { isStopped = true; isPaused = false; sendStatus('Остановка…'); } break;

    case 'DOWNLOAD_DONE': {
      const fn = downloadResolvers.get(msg.downloadId);
      if (fn) {
        downloadResolvers.delete(msg.downloadId);
        fn(msg.success);
      }
      break;
    }

    case 'GET_STATE': {
      const adapter  = getAdapterInfo();
      const unit     = adapter?.unitId ?? null;
      const curPage  = detectCurrentPage();

      let previewUrl = null;
      if (adapter?.type === 'vrr') {
        const offs = getVrrPageOffsets(unit);
        const cv = getVrrCanvas();
        if (cv) {
          try {
            const d = cv.toDataURL('image/jpeg', 0.7);
            if (d && d.length > 5000) previewUrl = d;
          } catch { /* tainted canvas — fallback */ }
        }
        if (!previewUrl && offs.length > 0) previewUrl = vrrThumbUrl(unit, offs[0]);
      } else if (adapter?.type === 'arsvo') {
        if (adapter.guid) previewUrl = arsvoImageUrl(adapter.guid, curPage - 1);
      } else if (adapter?.type === 'yar' && cachedArchNum) {
        previewUrl = imageUrl(unit, cachedArchNum, curPage);
      } else if (adapter?.type === 'cgamos-spa') {
        const dataUrl = extractCgamosRenderedImage();
        if (dataUrl && dataUrl.length > 5000) previewUrl = dataUrl;
      } else if (adapter?.type === 'cgamos-arsvo' && adapter.guid) {
        previewUrl = arsvoImageUrl(adapter.guid, curPage - 1);
      } else if (adapter?.type === 'kaisa') {
        const imgs = getKaisaImageUrls();
        if (imgs.length) {
          const raw = imgs[0];
          previewUrl = raw.startsWith('http') ? raw : `${location.origin}${raw.startsWith('/') ? '' : '/'}${raw}`;
        }
      } else if (adapter?.type === 'yandex') {
        const domResult = extractBestImageFromLiveDom();
        if (domResult?.url) previewUrl = domResult.url;
      }

      const respond = rs => sendResponse({
        isRunning, isPaused, currentPage: curPage,
        isArchivePage: !!adapter, unit,
        title:      getTitleFromPage(),
        previewUrl,
        resumeState: rs
      });
      if (unit) getResumeState(unit).then(respond);
      else      respond(null);
      return true;
    }

    case 'GET_METADATA': {
      const adapter = getAdapterInfo();
      if (!adapter) sendResponse({ error: 'not_archive_page' });
      else          sendResponse({ ok: true, data: getFullMetadata() });
      return true;
    }

    case 'CLEAR_RESUME': {
      const adapter = getAdapterInfo();
      if (adapter?.unitId) clearResumeState(adapter.unitId);
      break;
    }
  }
});

// ── Инициализация ─────────────────────────────────────────────────────────────

ensureSettings().then(async () => {
  try {
    const adapter = getAdapterInfo();
    if (adapter) {
      if (adapter.type === 'yar') {
        await detectArchiveNum(adapter.unitId);
      } else if (adapter.type === 'vrr') {
        const offsets = getVrrPageOffsets(adapter.unitId);
        if (offsets.length > 0) {
          probeVrrDirectPrefix(adapter.unitId, offsets[0]).catch(() => {});
        }
      }
      setIcon('active');
    } else {
      setIcon('inactive');
    }
  } catch (e) {
    log('init error:', e); setIcon('inactive');
  }
});

log('content-script loaded — Regional Archive Downloader v3.0.0');
