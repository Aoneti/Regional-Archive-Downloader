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

  // Archives accordion
  const archivesToggle = $('archivesToggle');
  const archivesList   = $('archivesList');
  if (archivesToggle && archivesList) {
    archivesToggle.addEventListener('click', () => {
      const isOpen = archivesList.classList.toggle('visible');
      archivesToggle.classList.toggle('open', isOpen);
      archivesToggle.setAttribute('aria-expanded', String(isOpen));
    });
  }

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

  // Remove old cards
  list.querySelectorAll('.project-mgmt-item').forEach(el => el.remove());
  empty.style.display = projects.length ? 'none' : 'block';

  projects.forEach((proj, idx) => {
    const color     = proj.color || PROJECT_COLORS[0];
    const statusLbl = proj.status === 'done' ? '✓ Готово' : '● В работе';
    const units     = proj.units || [];

    const el = document.createElement('div');
    el.className = 'project-mgmt-item';

    el.innerHTML = `
      <div class="project-mgmt-head">
        <span class="project-color-dot" data-idx="${idx}" style="background:${color}" title="Выбрать цвет"></span>
        <span class="project-mgmt-name">${proj.name}</span>
        <span class="project-mgmt-status ${proj.status === 'done' ? '' : 'active'}" data-idx="${idx}">${statusLbl}</span>
        <button class="project-mgmt-del" data-idx="${idx}" title="Удалить проект" aria-label="Удалить">✕</button>
      </div>
      <div class="color-picker-row" id="colorPicker_${idx}" style="display:none">
        ${PROJECT_COLORS.map(c =>
          `<span class="color-swatch${color === c ? ' selected' : ''}" style="background:${c}" data-color="${c}" data-idx="${idx}"></span>`
        ).join('')}
      </div>
      <div class="project-units-mgmt">
        ${units.map(u => {
          const url = proj.unitUrls?.[u];
          return `<span class="project-unit-mgmt-tag">
            ${url ? `<a class="project-unit-mgmt-link" href="${url}" target="_blank" title="Открыть документ">${u} ↗</a>`
                  : `<span>${u}</span>`}
            <button class="project-unit-remove" data-unit="${u}" data-idx="${idx}" title="Исключить дело">✕</button>
          </span>`;
        }).join('')}
      </div>
    `;

    // Toggle color picker
    el.querySelector('.project-color-dot').addEventListener('click', () => {
      const picker = document.getElementById(`colorPicker_${idx}`);
      picker.style.display = picker.style.display === 'none' ? 'flex' : 'none';
    });

    // Select color
    el.querySelectorAll('.color-swatch').forEach(sw => {
      sw.addEventListener('click', () => {
        const i = parseInt(sw.dataset.idx);
        const c = sw.dataset.color;
        chrome.storage.local.get({ [PROJECTS_KEY]: [] }, d => {
          const ps = Array.isArray(d[PROJECTS_KEY]) ? d[PROJECTS_KEY] : [];
          ps[i].color = c;
          saveProjectsMgmt(ps, () => renderProjectsMgmt(ps));
        });
      });
    });

    // Toggle status
    el.querySelector('.project-mgmt-status').addEventListener('click', e => {
      const i = parseInt(e.currentTarget.dataset.idx);
      chrome.storage.local.get({ [PROJECTS_KEY]: [] }, d => {
        const ps = Array.isArray(d[PROJECTS_KEY]) ? d[PROJECTS_KEY] : [];
        ps[i].status = ps[i].status === 'done' ? 'active' : 'done';
        saveProjectsMgmt(ps, () => renderProjectsMgmt(ps));
      });
    });

    // Remove project
    el.querySelector('.project-mgmt-del').addEventListener('click', e => {
      const i = parseInt(e.currentTarget.dataset.idx);
      if (!confirm(`Удалить проект «${projects[i].name}»?`)) return;
      chrome.storage.local.get({ [PROJECTS_KEY]: [] }, d => {
        const ps = Array.isArray(d[PROJECTS_KEY]) ? d[PROJECTS_KEY] : [];
        ps.splice(i, 1);
        saveProjectsMgmt(ps, () => renderProjectsMgmt(ps));
      });
    });

    // Remove unit from project
    el.querySelectorAll('.project-unit-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const i    = parseInt(btn.dataset.idx);
        const unit = btn.dataset.unit;
        chrome.storage.local.get({ [PROJECTS_KEY]: [] }, d => {
          const ps = Array.isArray(d[PROJECTS_KEY]) ? d[PROJECTS_KEY] : [];
          ps[i].units = (ps[i].units || []).filter(u => u !== unit);
          if (ps[i].unitUrls) delete ps[i].unitUrls[unit];
          saveProjectsMgmt(ps, () => renderProjectsMgmt(ps));
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

  chrome.storage.local.get(null, all => {
    const results = [];
    for (const [key, val] of Object.entries(all)) {
      if (!key.startsWith('rad_notes_')) continue;
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

      const snippet = text.length > 150 ? text.slice(0, 150) + '…' : text;

      el.innerHTML = `
        <div class="notes-mgmt-head">
          <span class="notes-mgmt-unit">Unit ${unit}</span>
          <button class="notes-mgmt-del" data-key="${key}" title="Удалить заметку" aria-label="Удалить">✕</button>
        </div>
        <div class="notes-mgmt-snippet">${snippet}</div>
        ${tags.length ? `<div class="notes-mgmt-tags">${tags.map(t => `<span class="notes-mgmt-tag">${t}</span>`).join('')}</div>` : ''}
      `;

      el.querySelector('.notes-mgmt-del').addEventListener('click', e => {
        const k = e.currentTarget.dataset.key;
        if (!confirm('Удалить заметку?')) return;
        chrome.storage.local.remove(k, () => loadNotesMgmt(query));
      });

      list.appendChild(el);
    });
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