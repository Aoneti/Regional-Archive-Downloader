const DEFAULTS = {
  createFolders:       true,
  delayMs:             250,
  maxPages:            1500,
  startFromCurrent:    true,
  concurrentDownloads: 4,
  adaptiveSpeed:       false,
  theme:               'auto'
};

const LIMITS = {
  delayMs:             { min: 0,   max: 3000 },
  maxPages:            { min: 1,   max: 5000 },
  concurrentDownloads: { min: 1,   max: 8    }
};

function $(id) { return document.getElementById(id); }

// ── Утилиты безопасности ─────────────────────────────────────────────────────
function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function safeHref(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

// ── Тема ──────────────────────────────────────────────────────────────────────

const mq = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme(theme) {
  if (theme === 'auto') {
    document.documentElement.classList.toggle('dark', mq.matches);
  } else {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }

  ['auto', 'light', 'dark'].forEach(t => {
    const btn = $(`theme${t.charAt(0).toUpperCase() + t.slice(1)}Btn`);
    if (!btn) return;
    btn.classList.toggle('active', t === theme);
    btn.setAttribute('aria-checked', String(t === theme));
  });
}

// ── Двусторонняя привязка слайдер ↔ число ────────────────────────────────────

function bindSliderNumber(sliderId, numberId, displayId, limitKey) {
  const slider  = $(sliderId);
  const number  = $(numberId);
  const display = displayId ? $(displayId) : null;
  const { min, max } = LIMITS[limitKey];

  function clamp(v) { return Math.max(min, Math.min(max, v)); }

  function update(value) {
    const v = clamp(Math.round(Number(value)));
    slider.value = v; number.value = v;
    if (display) display.textContent = v;
    if (numberId === 'delayMs') syncPresets(v);
  }

  slider.addEventListener('input',  () => update(slider.value));
  number.addEventListener('change', () => update(number.value));
  number.addEventListener('blur',   () => update(number.value));

  update(number.value || DEFAULTS[limitKey]);
}

// ── Пресеты задержки ──────────────────────────────────────────────────────────

function syncPresets(value) {
  document.querySelectorAll('.preset[data-target="delayMs"]').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.value) === value);
  });
}

// ── Адаптивная скорость — визуальная обратная связь ───────────────────────────

function syncAdaptiveUI(enabled) {
  const block  = $('adaptiveBlock');
  const note   = $('delayNote');
  const slider = $('delaySlider');
  const input  = $('delayMs');

  if (block) block.classList.toggle('on', enabled);
  if (note) note.style.display = enabled ? 'block' : 'none';
  if (slider) slider.classList.toggle('muted', enabled);
  if (input) input.classList.toggle('muted', enabled);
}

// ── Загрузка настроек ─────────────────────────────────────────────────────────

function load() {
  chrome.storage.sync.get(DEFAULTS, items => {
    $('createFolders').checked     = !!items.createFolders;
    $('startFromCurrent').checked  = !!items.startFromCurrent;
    $('adaptiveSpeed').checked     = !!items.adaptiveSpeed;
    $('delayMs').value             = items.delayMs             ?? DEFAULTS.delayMs;
    $('maxPages').value            = items.maxPages            ?? DEFAULTS.maxPages;
    $('concurrentDownloads').value = items.concurrentDownloads ?? DEFAULTS.concurrentDownloads;

    ['delayMs', 'maxPages', 'concurrentDownloads'].forEach(id => {
      $(id).dispatchEvent(new Event('change'));
    });

    applyTheme(items.theme || DEFAULTS.theme);
    syncAdaptiveUI(!!items.adaptiveSpeed);
  });
}

// ── Сохранение ────────────────────────────────────────────────────────────────

function clampField(id, key) {
  const raw = parseInt($(id).value, 10);
  if (isNaN(raw)) return null;
  return Math.max(LIMITS[key].min, Math.min(LIMITS[key].max, raw));
}

function save() {
  const delayMs             = clampField('delayMs',             'delayMs');
  const maxPages            = clampField('maxPages',            'maxPages');
  const concurrentDownloads = clampField('concurrentDownloads', 'concurrentDownloads');

  if (delayMs === null || maxPages === null || concurrentDownloads === null) {
    showMsg('Некорректные значения', 'error'); return;
  }

  $('delayMs').value             = delayMs;
  $('maxPages').value            = maxPages;
  $('concurrentDownloads').value = concurrentDownloads;

  const activeThemeBtn = document.querySelector('.theme-btn.active');
  const theme          = activeThemeBtn?.dataset.theme ?? DEFAULTS.theme;

  const toSave = {
    createFolders:       !!$('createFolders').checked,
    delayMs,
    maxPages,
    startFromCurrent:    !!$('startFromCurrent').checked,
    concurrentDownloads,
    adaptiveSpeed:       !!$('adaptiveSpeed').checked,
    theme
  };

  chrome.storage.sync.set(toSave, () => {
    if (chrome.runtime.lastError) { showMsg('Ошибка сохранения', 'error'); return; }
    showMsg('Сохранено');
    applyTheme(theme);
    chrome.runtime.sendMessage(
      { type: 'SETTINGS_UPDATED', settings: toSave },
      () => void chrome.runtime.lastError
    );
  });
}

function resetDefaults() {
  chrome.storage.sync.set(DEFAULTS, () => {
    if (chrome.runtime.lastError) { showMsg('Ошибка сброса', 'error'); return; }
    showMsg('Сброшено');
    load();
    chrome.runtime.sendMessage(
      { type: 'SETTINGS_UPDATED', settings: DEFAULTS },
      () => void chrome.runtime.lastError
    );
  });
}

// ── Сообщение обратной связи ──────────────────────────────────────────────────

function showMsg(text, kind = 'ok') {
  const el = $('msg');
  el.textContent = text; el.className = 'msg msg--' + kind;
  setTimeout(() => {
    if (el.textContent === text) { el.textContent = ''; el.className = 'msg'; }
  }, 2500);
}

// ── Инициализация ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {

  mq.addEventListener('change', () => {
    const active = document.querySelector('.theme-btn.active');
    if (active?.dataset.theme === 'auto') applyTheme('auto');
  });

  // Theme buttons
  $('themeAutoBtn') .addEventListener('click', () => applyTheme('auto'));
  $('themeLightBtn').addEventListener('click', () => applyTheme('light'));
  $('themeDarkBtn') .addEventListener('click', () => applyTheme('dark'));

  // Slider ↔ number bindings
  bindSliderNumber('delaySlider',      'delayMs',             'delayVal',      'delayMs');
  bindSliderNumber('maxPagesSlider',   'maxPages',            'maxPagesVal',   'maxPages');
  bindSliderNumber('concurrentSlider', 'concurrentDownloads', 'concurrentVal', 'concurrentDownloads');

  // Preset buttons
  document.querySelectorAll('.preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.target);
      if (!input) return;
      input.value = Number(btn.dataset.value);
      input.dispatchEvent(new Event('change'));
    });
  });

  // Adaptive speed toggle
  $('adaptiveSpeed').addEventListener('change', function () {
    syncAdaptiveUI(this.checked);
  });

  // Load saved settings and bind action buttons
  load();
  $('saveBtn') .addEventListener('click', save);
  $('resetBtn').addEventListener('click', resetDefaults);
});

// ── Управление проектами и заметками ─────────────────────────────────────────

const PROJECT_COLORS = ['#7FBE00', '#3b82f6', '#f59e0b', '#ef4444'];
const PROJECTS_KEY   = 'rad_projects';

function loadProjectsMgmt() {
  chrome.storage.local.get({ [PROJECTS_KEY]: [] }, data => {
    const projects = Array.isArray(data[PROJECTS_KEY]) ? data[PROJECTS_KEY] : [];
    renderProjectsMgmt(projects);
  });
}

function saveProjectsMgmt(projects, cb) {
  chrome.storage.local.set({ [PROJECTS_KEY]: projects }, cb);
}

function renderProjectsMgmt(projects) {
  const list  = document.getElementById('projectsMgmtList');
  const empty = document.getElementById('projectsMgmtEmpty');
  if (!list) return;

  // Удаляем старые карточки, оставляем empty-заглушку
  list.querySelectorAll('.project-mgmt-item').forEach(el => el.remove());
  empty.style.display = projects.length ? 'none' : 'block';

  projects.forEach((proj, idx) => {
    const color     = PROJECT_COLORS.includes(proj.color) ? proj.color : PROJECT_COLORS[0];
    const isDone    = proj.status === 'done';
    const units     = Array.isArray(proj.units) ? proj.units : [];

    // ── Корневой элемент карточки ──────────────────────────────────────────
    const el = document.createElement('div');
    el.className = 'project-mgmt-item';

    // ── Заголовок карточки ─────────────────────────────────────────────────
    const head = document.createElement('div');
    head.className = 'project-mgmt-head';

    const colorDot = document.createElement('span');
    colorDot.className = 'project-color-dot';
    colorDot.dataset.idx = idx;
    colorDot.style.background = color;
    colorDot.title = 'Выбрать цвет';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'project-mgmt-name';
    nameSpan.textContent = proj.name; // безопасно: textContent

    const statusSpan = document.createElement('span');
    statusSpan.className = `project-mgmt-status${isDone ? '' : ' active'}`;
    statusSpan.dataset.idx = idx;
    statusSpan.textContent = isDone ? '✓ Готово' : '● В работе';

    const delBtn = document.createElement('button');
    delBtn.className = 'project-mgmt-del';
    delBtn.dataset.idx = idx;
    delBtn.title = 'Удалить проект';
    delBtn.setAttribute('aria-label', 'Удалить');
    delBtn.textContent = '✕';

    head.append(colorDot, nameSpan, statusSpan, delBtn);

    // ── Пикер цвета ────────────────────────────────────────────────────────
    const pickerRow = document.createElement('div');
    pickerRow.className = 'color-picker-row';
    pickerRow.id = `colorPicker_${idx}`;
    pickerRow.style.display = 'none';

    PROJECT_COLORS.forEach(c => {
      const sw = document.createElement('span');
      sw.className = `color-swatch${color === c ? ' selected' : ''}`;
      sw.style.background = c;
      sw.dataset.color = c;
      sw.dataset.idx = idx;
      pickerRow.appendChild(sw);
    });

    // ── Список дел (units) ─────────────────────────────────────────────────
    const unitsDiv = document.createElement('div');
    unitsDiv.className = 'project-units-mgmt';

    units.forEach(u => {
      const unitStr = String(u);
      const rawUrl  = proj.unitUrls?.[unitStr];
      const href    = safeHref(rawUrl); // FIX: проверяем схему URL

      const tag = document.createElement('span');
      tag.className = 'project-unit-mgmt-tag';

      if (href) {
        const link = document.createElement('a');
        link.className = 'project-unit-mgmt-link';
        link.href = href;           // безопасно: прошёл safeHref
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.title = 'Открыть документ';
        link.textContent = `${unitStr} ↗`; // безопасно: textContent
        tag.appendChild(link);
      } else {
        const plain = document.createElement('span');
        plain.textContent = unitStr; // безопасно: textContent
        tag.appendChild(plain);
      }

      const removeBtn = document.createElement('button');
      removeBtn.className = 'project-unit-remove';
      removeBtn.dataset.unit = unitStr;
      removeBtn.dataset.idx = idx;
      removeBtn.title = 'Исключить дело';
      removeBtn.textContent = '✕';
      tag.appendChild(removeBtn);

      unitsDiv.appendChild(tag);
    });

    el.append(head, pickerRow, unitsDiv);

    // ── Обработчики событий ────────────────────────────────────────────────

    colorDot.addEventListener('click', () => {
      pickerRow.style.display = pickerRow.style.display === 'none' ? 'flex' : 'none';
    });

    pickerRow.querySelectorAll('.color-swatch').forEach(sw => {
      sw.addEventListener('click', () => {
        const i = parseInt(sw.dataset.idx);
        const c = sw.dataset.color;
        if (!PROJECT_COLORS.includes(c)) return;
        chrome.storage.local.get({ [PROJECTS_KEY]: [] }, d => {
          const ps = Array.isArray(d[PROJECTS_KEY]) ? d[PROJECTS_KEY] : [];
          if (ps[i]) {
            ps[i].color = c;
            saveProjectsMgmt(ps, () => renderProjectsMgmt(ps));
          }
        });
      });
    });

    statusSpan.addEventListener('click', e => {
      const i = parseInt(e.currentTarget.dataset.idx);
      chrome.storage.local.get({ [PROJECTS_KEY]: [] }, d => {
        const ps = Array.isArray(d[PROJECTS_KEY]) ? d[PROJECTS_KEY] : [];
        if (ps[i]) {
          ps[i].status = ps[i].status === 'done' ? 'active' : 'done';
          saveProjectsMgmt(ps, () => renderProjectsMgmt(ps));
        }
      });
    });

    delBtn.addEventListener('click', e => {
      const i = parseInt(e.currentTarget.dataset.idx);
      if (!confirm(`Удалить проект «${proj.name}»?`)) return;
      chrome.storage.local.get({ [PROJECTS_KEY]: [] }, d => {
        const ps = Array.isArray(d[PROJECTS_KEY]) ? d[PROJECTS_KEY] : [];
        ps.splice(i, 1);
        saveProjectsMgmt(ps, () => renderProjectsMgmt(ps));
      });
    });

    unitsDiv.querySelectorAll('.project-unit-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const i    = parseInt(btn.dataset.idx);
        const unit = btn.dataset.unit;
        chrome.storage.local.get({ [PROJECTS_KEY]: [] }, d => {
          const ps = Array.isArray(d[PROJECTS_KEY]) ? d[PROJECTS_KEY] : [];
          if (ps[i]) {
            ps[i].units = (ps[i].units || []).filter(u => String(u) !== unit);
            if (ps[i].unitUrls) delete ps[i].unitUrls[unit];
            saveProjectsMgmt(ps, () => renderProjectsMgmt(ps));
          }
        });
      });
    });

    list.appendChild(el);
  });
}

// ── Управление заметками ──────────────────────────────────────────────────────

function loadNotesMgmt(query) {
  const list  = document.getElementById('notesMgmtList');
  const empty = document.getElementById('notesMgmtEmpty');
  if (!list) return;

  list.querySelectorAll('.notes-mgmt-item').forEach(el => el.remove());
  const q = (query || '').toLowerCase().trim();
  
  chrome.storage.local.get({ rad_notes_index: null }, idxData => {
    const index = idxData.rad_notes_index;

    const fetchAndRender = (all) => {
      const results = [];
      for (const [key, val] of Object.entries(all)) {
        if (!key.startsWith('rad_notes_') || key === 'rad_notes_index') continue;
        const unit = key.replace('rad_notes_', '');
        const text = typeof val === 'object' && val !== null ? (val.text || '') : (val || '');
        const tags = typeof val === 'object' && val !== null ? (val.tags || []) : [];
        if (!text.trim()) continue;
        if (!q || text.toLowerCase().includes(q) || tags.some(t => t.includes(q))) {
          results.push({ unit, text, tags, key });
        }
      }

      empty.style.display = results.length ? 'none' : 'block';

      results.forEach(({ unit, text, tags, key }) => {
        const el = document.createElement('div');
        el.className = 'notes-mgmt-item';

        const head = document.createElement('div');
        head.className = 'notes-mgmt-head';

        const unitSpan = document.createElement('span');
        unitSpan.className = 'notes-mgmt-unit';
        unitSpan.textContent = `Unit ${unit}`;

        const delBtn = document.createElement('button');
        delBtn.className = 'notes-mgmt-del';
        delBtn.dataset.key = key;
        delBtn.title = 'Удалить заметку';
        delBtn.setAttribute('aria-label', 'Удалить');
        delBtn.textContent = '✕';

        head.append(unitSpan, delBtn);

        const snippet = text.length > 150 ? text.slice(0, 150) + '…' : text;
        const snippetDiv = document.createElement('div');
        snippetDiv.className = 'notes-mgmt-snippet';
        snippetDiv.textContent = snippet;

        el.append(head, snippetDiv);

        if (tags.length) {
          const tagsDiv = document.createElement('div');
          tagsDiv.className = 'notes-mgmt-tags';
          tags.forEach(t => {
            const tagSpan = document.createElement('span');
            tagSpan.className = 'notes-mgmt-tag';
            tagSpan.textContent = t;
            tagsDiv.appendChild(tagSpan);
          });
          el.appendChild(tagsDiv);
        }

        delBtn.addEventListener('click', e => {
          const k = e.currentTarget.dataset.key;
          if (!confirm('Удалить заметку?')) return;
          // Удаляем из индекса тоже
          const unitKey = k.replace('rad_notes_', '');
          chrome.storage.local.get({ rad_notes_index: [] }, d => {
            const idx = Array.isArray(d.rad_notes_index) ? d.rad_notes_index : [];
            chrome.storage.local.set({ rad_notes_index: idx.filter(u => u !== unitKey) }, () => {
              chrome.storage.local.remove(k, () => loadNotesMgmt(query));
            });
          });
        });

        list.appendChild(el);
      });
    };

    if (Array.isArray(index) && index.length > 0) {
      // Читаем только конкретные ключи заметок из индекса
      const keys = index.map(unit => `rad_notes_${unit}`);
      chrome.storage.local.get(keys, fetchAndRender);
    } else {
      // Fallback: индекса нет — читаем всё (legacy behaviour, но безопасно)
      chrome.storage.local.get(null, fetchAndRender);
    }
  });
}

// ── Инициализация management sections ────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadProjectsMgmt();
  loadNotesMgmt('');

  const notesMgmtSearch = document.getElementById('notesMgmtSearch');
  if (notesMgmtSearch) {
    let debounce = null;
    notesMgmtSearch.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => loadNotesMgmt(notesMgmtSearch.value), 250);
    });
  }
});