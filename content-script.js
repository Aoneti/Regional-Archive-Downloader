console.log('[Yar] content-script loaded (settings-aware)');

const DEFAULTS = {
  createFolders: true,
  delayMs: 250,
  maxPages: 1500,
  startFromCurrent: true,
  theme: 'light'
};

let settingsCache = Object.assign({}, DEFAULTS);

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

const TEST_TIMEOUT = 6000;

let isPaused = false;
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

function sendStatus(text) {
  chrome.runtime.sendMessage({ type: 'STATUS', text });
}

function sendProgress(cur, total) {
  const percent = total > 0 ? Math.round(cur / total * 100) : 0;
  chrome.runtime.sendMessage({ type: 'PROGRESS', percent });
}

function sendDone(text) {
  chrome.runtime.sendMessage({ type: 'DONE', text });
}

function setIcon(state) {
  chrome.runtime.sendMessage({ type: 'SET_ICON', state });
}

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
    } catch (e) {}
  }
  return 1;
}

function testImage(url, timeout = TEST_TIMEOUT) {
  return new Promise(resolve => {
    const img = new Image();
    let done = false;
    const t = setTimeout(() => {
      if (!done) { done = true; resolve(false); }
    }, timeout);

    img.onload = () => { if (!done) { done = true; clearTimeout(t); resolve(true); } };
    img.onerror = () => { if (!done) { done = true; clearTimeout(t); resolve(false); } };

    img.src = url + '&_ts=' + Date.now();
  });
}

async function findTotalPages(unit, start, maxPages, progressCb) {
  let last = 0;
  for (let i = start; i <= maxPages; i++) {
    await waitIfPaused();
    progressCb && progressCb(`Проверка страницы ${i}…`);
    const ok = await testImage(imageUrl(unit, i));
    if (!ok) break;
    last = i;
  }
  return last;
}

async function downloadAll() {
  if (isRunning) return;
  isRunning = true;
  isPaused = false;
  isStopped = false;

  const cfg = await getSettings();
  const unit = getUnitId();
  if (!unit) {
    sendDone('Не удалось определить unit');
    isRunning = false;
    setIcon('inactive');
    return;
  }

  const titleRaw = getTitleFromPage();
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

      chrome.runtime.sendMessage({
        type: 'DOWNLOAD',
        url: imageUrl(unit, p),
        filename
      });

      await sleep(cfg.delayMs);
    }

    sendDone(`Готово: ${total} стр.`);
  } catch (e) {
    sendDone(e.message === 'stopped' ? 'Остановлено' : 'Ошибка: ' + e.message);
  } finally {
    isRunning = false;
    isPaused = false;
    isStopped = false;
    setIcon('inactive');
  }
}

async function downloadCurrent() {
  const cfg = await getSettings();
  const unit = getUnitId();
  if (!unit) {
    sendStatus('Unit не определён');
    return;
  }

  const titleRaw = getTitleFromPage();
  const folderName = `${sanitizeForFilename(titleRaw)}_unit_${unit}`;
  const p = detectCurrentPage();

  setIcon('active');

  const filename = cfg.createFolders
    ? `${folderName}/${pad(p, 3)}.jpg`
    : `unit_${unit}_p${pad(p, 3)}.jpg`;

  chrome.runtime.sendMessage({
    type: 'DOWNLOAD',
    url: imageUrl(unit, p),
    filename
  });

  sendStatus(`Скачана стр. ${p}`);
  setTimeout(() => setIcon('inactive'), 1200);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'DOWNLOAD_ALL') downloadAll();
  if (msg.type === 'DOWNLOAD_CURRENT') downloadCurrent();
  if (msg.type === 'PAUSE') { if (isRunning) { isPaused = true; sendStatus('Пауза'); } }
  if (msg.type === 'RESUME') { if (isRunning) { isPaused = false; sendStatus('Продолжение…'); } }
  if (msg.type === 'STOP') { if (isRunning) { isStopped = true; isPaused = false; sendStatus('Остановка…'); } }
});

getSettings().then(cfg => {
  try {
    const unit = getUnitId();
    setIcon(unit ? 'active' : 'inactive');
  } catch (e) {
    setIcon('inactive');
  }
});
