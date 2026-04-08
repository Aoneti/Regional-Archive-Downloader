const btnAll           = document.getElementById('btnAll');
const btnAllText       = document.getElementById('btnAllText');
const btnCurrent       = document.getElementById('btnCurrent');
const btnPDF           = document.getElementById('btnPDF');
const btnPause         = document.getElementById('btnPause');
const btnStop          = document.getElementById('btnStop');
const pauseIcon        = document.getElementById('pauseIcon');
const pauseLabel       = document.getElementById('pauseLabel');
const openOptions      = document.getElementById('openOptions');
const bannerNotArchive = document.getElementById('bannerNotArchive');
const summaryCard      = document.getElementById('summaryCard');
const summaryTitle     = document.getElementById('summaryTitle');
const summaryGrid      = document.getElementById('summaryGrid');
const toastEl          = document.getElementById('toast');
const statusEl         = document.getElementById('status');
const progressBar      = document.getElementById('progressBar');
const progressPct      = document.getElementById('progressPct');
const progressEta      = document.getElementById('progressEta');
const progressRole     = document.getElementById('progressRole');
const rangeTrack       = document.getElementById('rangeTrack');
const rangeFill        = document.getElementById('rangeFill');
const thumbStart       = document.getElementById('thumbStart');
const thumbEnd         = document.getElementById('thumbEnd');
const hintFrom         = document.getElementById('hintFrom');
const hintToWrap       = document.getElementById('hintToWrap');
const historySection   = document.getElementById('historySection');
const historyToggle    = document.getElementById('historyToggle');
const historyList      = document.getElementById('historyList');
const historyCount     = document.getElementById('historyCount');
const historyEmpty     = document.getElementById('historyEmpty');

// ── Состояние ──

let isRunning     = false;
let isPaused      = false;
let isArchivePage = false;
let isPDFMode     = false;

let rangeMax  = 1500;
const RANGE_MIN = 1;

let fromPage = 1;
let toPage   = null;

let downloadStartTime = null;
let downloadedPages   = 0;
let totalPages        = 0;

// ── Тема ──

const mq = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme(theme) {
  if (theme === 'auto') {
    document.documentElement.classList.toggle('dark', mq.matches);
  } else {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }
}

mq.addEventListener('change', () => {
  chrome.storage.sync.get({ theme: 'auto' }, items => applyTheme(items.theme));
});

// ── Toast ──

let toastTimer = null;

function showToast(text, durationMs = 2800) {
  if (toastTimer) clearTimeout(toastTimer);
  toastEl.textContent = text;
  toastEl.classList.add('show');
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
    toastTimer = null;
  }, durationMs);
}

// ── Итоговая карточка ──

function showSummary(kind, extra = {}) {
  const elapsed   = downloadStartTime ? Math.round((Date.now() - downloadStartTime) / 1000) : 0;
  const isStopped = kind === 'stopped';
  const isError   = kind === 'error';
  const isPDF     = kind === 'pdf';

  summaryTitle.textContent = isError   ? 'Ошибка загрузки'
    : isStopped              ? 'Загрузка остановлена'
    : isPDF                  ? 'PDF сформирован'
    :                          'Загрузка завершена';

  const items = [];
  if (downloadedPages > 0) items.push(['Загружено', `${downloadedPages} стр.`]);
  if (totalPages > 0 && downloadedPages < totalPages)
    items.push(['Всего найдено', `${totalPages} стр.`]);
  if (extra.failedCount > 0)
    items.push(['Пропущено', `${extra.failedCount} стр.`]);
  if (elapsed >= 3) {
    const min = Math.floor(elapsed / 60), sec = elapsed % 60;
    items.push(['Время', min > 0 ? `${min} мин ${sec} сек` : `${sec} сек`]);
  }
  if (elapsed >= 5 && downloadedPages > 1) {
    items.push(['Скорость', `${Math.round(downloadedPages / elapsed * 60)} стр/мин`]);
  }
  if (isPDF) items.push(['Формат', 'PDF-файл']);

  summaryGrid.innerHTML = items
    .map(([k, v]) => `<div class="summary-item">${k}: <strong>${v}</strong></div>`)
    .join('');

  summaryCard.classList.add('visible');
}

function hideSummary() {
  summaryCard.classList.remove('visible');
}

// ── Баннер «не та страница» ──

function setArchivePage(isArchive) {
  isArchivePage = isArchive;
  bannerNotArchive.classList.toggle('warn', !isArchive);
  bannerNotArchive.style.display = isArchive ? 'none' : 'flex';
  btnAll.disabled     = !isArchive || isRunning;
  btnCurrent.disabled = !isArchive || isRunning;
  btnPDF.disabled     = !isArchive || isRunning;
}

// ── Dual-thumb range slider ──

function xToPage(clientX) {
  const rect  = rangeTrack.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  return Math.round(RANGE_MIN + ratio * (rangeMax - RANGE_MIN));
}

function pageToPercent(page) {
  return ((page - RANGE_MIN) / (rangeMax - RANGE_MIN) * 100).toFixed(2) + '%';
}

function updateRangeUI() {
  const lo = fromPage;
  const hi = toPage ?? rangeMax;

  thumbStart.style.left = pageToPercent(lo);
  thumbEnd.style.left   = pageToPercent(hi);
  rangeFill.style.left  = pageToPercent(lo);
  rangeFill.style.width = ((hi - lo) / (rangeMax - RANGE_MIN) * 100).toFixed(2) + '%';

  hintFrom.textContent = lo;

  const isAutoEnd = (toPage === null || hi >= rangeMax);
  hintToWrap.innerHTML = isAutoEnd
    ? `до <strong>конца</strong>`
    : `до стр. <strong>${hi}</strong>`;

  thumbStart.setAttribute('aria-valuenow', lo);
  thumbStart.setAttribute('aria-valuemax', hi - 1);
  thumbEnd.setAttribute('aria-valuenow', hi);
  thumbEnd.setAttribute('aria-valuemin', lo + 1);
  thumbEnd.setAttribute('aria-valuemax', rangeMax);
}

function bindThumb(thumb, which) {
  thumb.addEventListener('pointerdown', e => {
    if (isRunning || !isArchivePage) return;
    e.preventDefault();
    thumb.setPointerCapture(e.pointerId);
    thumb.classList.add('dragging');
  });

  thumb.addEventListener('pointermove', e => {
    if (!thumb.hasPointerCapture(e.pointerId)) return;
    const page = xToPage(e.clientX);
    if (which === 'start') {
      fromPage = Math.max(RANGE_MIN, Math.min(page, (toPage ?? rangeMax) - 1));
    } else {
      const raw = Math.max(fromPage + 1, Math.min(page, rangeMax));
      toPage = raw >= rangeMax ? null : raw;
    }
    updateRangeUI();
  });

  thumb.addEventListener('pointerup', e => {
    if (!thumb.hasPointerCapture(e.pointerId)) return;
    thumb.classList.remove('dragging');
    thumb.releasePointerCapture(e.pointerId);
  });

  thumb.addEventListener('keydown', e => {
    if (isRunning || !isArchivePage) return;
    const step   = e.shiftKey ? 10 : 1;
    const isLeft = e.key === 'ArrowLeft', isRight = e.key === 'ArrowRight';
    if (!isLeft && !isRight) return;
    e.preventDefault();

    if (which === 'start') {
      fromPage = isRight
        ? Math.min(fromPage + step, (toPage ?? rangeMax) - 1)
        : Math.max(fromPage - step, RANGE_MIN);
    } else {
      const cur  = toPage ?? rangeMax;
      const next = isRight ? cur + step : cur - step;
      toPage = next >= rangeMax ? null : Math.max(fromPage + 1, Math.min(next, rangeMax));
    }
    updateRangeUI();
  });
}

bindThumb(thumbStart, 'start');
bindThumb(thumbEnd,   'end');

rangeTrack.addEventListener('dblclick', () => {
  if (isRunning || !isArchivePage) return;
  fromPage = 1; toPage = null;
  updateRangeUI();
  sendToActiveTab({ type: 'CLEAR_RESUME' });
  showToast('Диапазон и прогресс сброшены', 1600);
});

// ── ETA ──

function updateETA() {
  if (!downloadStartTime || totalPages <= 1 || downloadedPages < 2) {
    progressEta.textContent = ''; return;
  }
  const elapsed = (Date.now() - downloadStartTime) / 1000;
  if (elapsed < 3) { progressEta.textContent = ''; return; }

  const speed     = downloadedPages / elapsed;
  const remaining = totalPages - downloadedPages;
  const etaSec    = speed > 0 ? remaining / speed : 0;
  const etaText   = etaSec >= 60
    ? `~${Math.ceil(etaSec / 60)} мин`
    : `~${Math.ceil(etaSec)} сек`;

  progressEta.textContent = `${etaText} • ${Math.round(speed * 60)} стр/мин`;
}

// ── Утилиты UI ──

function setStatus(text) { statusEl.textContent = text || ''; }

function setProgress(percent, current, total) {
  const pct = Math.max(0, Math.min(100, percent));
  progressBar.style.width = pct + '%';
  progressPct.textContent = pct > 0 ? pct + '%' : '';
  progressRole.setAttribute('aria-valuenow', pct);
  if (current != null && total != null) {
    downloadedPages = current; totalPages = total; updateETA();
  }
}

function setRunningUI(running, paused) {
  isRunning = running; isPaused = paused;

  btnAll.disabled     = running || !isArchivePage;
  btnCurrent.disabled = running || !isArchivePage;
  btnPDF.disabled     = running || !isArchivePage;
  btnPause.disabled   = !running;
  btnStop.disabled    = !running;

  pauseIcon.textContent  = paused ? '▶' : '⏸';
  pauseLabel.textContent = paused ? 'Продолжить' : 'Пауза';

  progressBar.classList.toggle('active', running && !paused);
  thumbStart.classList.toggle('disabled', running);
  thumbEnd.classList.toggle('disabled',   running);

  if (!running) {
    downloadStartTime       = null;
    progressEta.textContent = '';
    progressPct.textContent = '';
    isPDFMode               = false;
    btnAllText.textContent  = 'Скачать документ';
    btnAll.classList.remove('searching');
  }
}

// ── Отправка в активный таб ──

function sendToActiveTab(message, cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (!tabs?.[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, message, cb);
  });
}

// ── История загрузок ───

function relativeTime(ts) {
  const diff = Date.now() - ts;
  const min  = Math.floor(diff / 60_000);
  const hr   = Math.floor(diff / 3_600_000);
  const day  = Math.floor(diff / 86_400_000);
  if (diff < 60_000)   return 'только что';
  if (min  < 60)       return `${min} мин назад`;
  if (hr   < 24)       return `${hr} ч назад`;
  if (day  < 30)       return `${day} дн назад`;
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function renderHistory(entries) {
  historyCount.textContent = entries.length;

  const old = historyList.querySelectorAll('.history-item');
  old.forEach(el => el.remove());

  if (!entries.length) {
    historyEmpty.style.display = 'block';
    return;
  }
  historyEmpty.style.display = 'none';

  entries.slice(0, 8).forEach(entry => {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.setAttribute('role', 'listitem');

    const fmt   = (entry.format || 'jpg').toLowerCase();
    const title = entry.title || `Документ ${entry.unit}`;
    const short = title.length > 32 ? title.slice(0, 30) + '…' : title;
    const time  = relativeTime(entry.savedAt || entry.timestamp || 0);
    const pages = entry.pages ? `${entry.pages} стр.` : '';

    item.innerHTML = `
      <span class="history-fmt ${fmt}">${fmt.toUpperCase()}</span>
      <div class="history-info">
        <div class="history-title" title="${title.replace(/"/g, '&quot;')}">${short}</div>
        <div class="history-meta">${[pages, time].filter(Boolean).join(' · ')}</div>
      </div>
      <button class="history-open" title="Открыть документ в новой вкладке" aria-label="Открыть документ">↗</button>
    `;

    const openBtn = item.querySelector('.history-open');
    if (entry.url) {
      openBtn.addEventListener('click', () => chrome.tabs.create({ url: entry.url }));
    } else {
      openBtn.disabled = true; openBtn.style.opacity = '0.3';
    }

    historyList.appendChild(item);
  });
}

function loadHistory() {
  chrome.storage.local.get({ yar_history: [] }, data => {
    const entries = Array.isArray(data.yar_history) ? data.yar_history : [];
    renderHistory(entries);
  });
}

historyToggle.addEventListener('click', () => {
  const isOpen = historySection.classList.toggle('open');
  historyToggle.setAttribute('aria-expanded', String(isOpen));
  if (isOpen) loadHistory(); 
});

// ── Обработчики кнопок ──

btnAll.addEventListener('click', () => {
  if (isRunning || !isArchivePage) return;

  downloadStartTime = Date.now();
  downloadedPages   = 0;
  totalPages        = 0;
  isPDFMode         = false;
  hideSummary();

  setRunningUI(true, false);
  setStatus('Поиск страниц…');
  setProgress(0);
  btnAllText.textContent = 'Поиск…';
  btnAll.classList.add('searching');

  sendToActiveTab({
    type:     'DOWNLOAD_ALL',
    fromPage: fromPage > RANGE_MIN ? fromPage : null,
    toPage
  });
});

btnCurrent.addEventListener('click', () => {
  if (!isArchivePage) return;
  hideSummary();
  setStatus('Скачивание текущей страницы…');
  sendToActiveTab({ type: 'DOWNLOAD_CURRENT' });
});

btnPDF.addEventListener('click', () => {
  if (isRunning || !isArchivePage) return;

  downloadStartTime = Date.now();
  downloadedPages   = 0;
  totalPages        = 0;
  isPDFMode         = true;
  hideSummary();

  setRunningUI(true, false);
  setStatus('PDF: поиск страниц…');
  setProgress(0);
  btnAllText.textContent = 'PDF…';
  btnAll.classList.add('searching');

  sendToActiveTab({
    type:     'GENERATE_PDF',
    fromPage: fromPage > RANGE_MIN ? fromPage : null,
    toPage
  });
});

btnPause.addEventListener('click', () => {
  if (!isRunning) return;
  isPaused = !isPaused;

  pauseIcon.textContent  = isPaused ? '▶' : '⏸';
  pauseLabel.textContent = isPaused ? 'Продолжить' : 'Пауза';
  progressBar.classList.toggle('active', !isPaused);

  if (isPaused) {
    setStatus('Пауза');
    sendToActiveTab({ type: 'PAUSE' });
  } else {
    setStatus('Продолжение…');
    sendToActiveTab({ type: 'RESUME' });
  }
});

btnStop.addEventListener('click', () => {
  if (!isRunning) return;
  sendToActiveTab({ type: 'STOP' });
});

openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

const bannerArchivesLink = document.getElementById('bannerArchivesLink');
if (bannerArchivesLink) {
  bannerArchivesLink.addEventListener('click', e => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

// ── Клавиатурные сокращения ──

document.addEventListener('keydown', e => {
  if (e.target === thumbStart || e.target === thumbEnd) return;

  if (e.code === 'Space' && isRunning) {
    e.preventDefault(); btnPause.click();
  }
  if (e.code === 'Escape' && isRunning) {
    e.preventDefault(); btnStop.click();
  }
  if (e.altKey && e.code === 'KeyS') {
    e.preventDefault(); chrome.runtime.openOptionsPage();
  }
});

// ── Входящие сообщения ──

chrome.runtime.onMessage.addListener(msg => {
  if (!msg?.type) return;

  switch (msg.type) {

    case 'STATUS':
      setStatus(msg.text);
      if (
        msg.text &&
        (msg.text.startsWith('Скачивание') || msg.text.startsWith('PDF: загрузка')) &&
        btnAll.classList.contains('searching')
      ) {
        btnAllText.textContent = isPDFMode ? 'Загрузка страниц…' : 'Загрузка…';
        btnAll.classList.remove('searching');
      }
      if (msg.text?.startsWith('PDF: сборка')) {
        btnAllText.textContent = 'Сборка PDF…';
      }
      break;

    case 'PROGRESS':
      setProgress(msg.percent, msg.current, msg.total);
      break;

    case 'DONE': {
      const text      = msg.text || 'Готово';
      const isStopped = text.startsWith('Остановлено') || text.startsWith('PDF: остановлено');
      const isError   = text.startsWith('Ошибка') || text.startsWith('PDF: ошибка');
      const isPDF     = !!msg.isPDF;

      setStatus(text);
      setProgress(
        isStopped ? (downloadedPages / (totalPages || 1) * 100) : 100,
        downloadedPages, totalPages
      );
      setRunningUI(false, false);

      if (downloadedPages > 0 || isPDF) {
        showSummary(
          isStopped ? 'stopped' : isError ? 'error' : isPDF ? 'pdf' : 'done',
          { failedCount: msg.failedCount ?? 0 }
        );
      }

      const toastMsg = isError
        ? `Ошибка: ${text.replace(/^(Ошибка|PDF: ошибка)[: ]*/, '')}`
        : isStopped
          ? `Остановлено • ${downloadedPages} стр. скачано`
          : isPDF
            ? `PDF готов — ${text.replace('PDF готов: ', '')}`
            : msg.failedCount > 0
              ? `Готово — ${text.replace('Готово: ', '')} • пропущено: ${msg.failedCount}`
              : `Готово — ${text.replace('Готово: ', '')}`;

      showToast(toastMsg, isError ? 3500 : 2500);

      if (historySection.classList.contains('open')) loadHistory();
      break;
    }

    case 'SET_THEME':
      applyTheme(msg.theme);
      break;

    case 'SETTINGS_UPDATED':
      if (msg.settings?.theme != null) applyTheme(msg.settings.theme);
      if (msg.settings?.maxPages && msg.settings.maxPages !== rangeMax) {
        rangeMax = msg.settings.maxPages;
        if (toPage === null || toPage > rangeMax) toPage = null;
        updateRangeUI();
      }
      break;
  }
});

// ── Инициализация ──

(function init() {
  setRunningUI(false, false);
  setArchivePage(false);

  // ── Тема ──
  chrome.storage.sync.get({ theme: 'auto', maxPages: 1500 }, items => {
    applyTheme(items.theme);
    rangeMax = items.maxPages || 1500;
    thumbEnd.setAttribute('aria-valuemax', rangeMax);
    thumbStart.setAttribute('aria-valuemax', rangeMax);
    updateRangeUI();
  });

  // ── Счётчик истории ──
  chrome.storage.local.get({ yar_history: [] }, data => {
    const entries = Array.isArray(data.yar_history) ? data.yar_history : [];
    historyCount.textContent = entries.length;
    if (entries.length > 0) historySection.style.borderTopColor = '';
  });

  sendToActiveTab({ type: 'GET_STATE' }, state => {
    if (chrome.runtime.lastError) { setArchivePage(false); return; }
    if (!state)                   { setArchivePage(false); return; }

    setArchivePage(!!state.isArchivePage);

    if (state.resumeState && !state.isRunning && state.isArchivePage) {
      const rs      = state.resumeState;
      const ageMin  = Math.round((Date.now() - (rs.savedAt ?? 0)) / 60000);
      const resumePg = rs.lastPage + 1;
      if (resumePg > 1 && resumePg <= rangeMax) {
        fromPage = resumePg; updateRangeUI();
      }
      setStatus(
        `↩ Прервано на стр. ${rs.lastPage} из ${rs.totalPages} ` +
        `(${ageMin} мин. назад) — двойной клик по слайдеру для сброса`
      );
    } else if (state.currentPage && state.currentPage > 1) {
      fromPage = state.currentPage; updateRangeUI();
    }

    if (state.isRunning) {
      downloadStartTime      = Date.now();
      setRunningUI(true, state.isPaused);
      setStatus(state.isPaused ? 'Пауза' : 'Загрузка…');
      btnAllText.textContent = 'Загрузка…';
    }
  });
})();