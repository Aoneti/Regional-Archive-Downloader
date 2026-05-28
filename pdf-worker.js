// ── PDF Worker ────────────────────────────────────────────────────────────

'use strict';

// ── Streaming state ───────────────────────────────────────────────────────────

let _session = null;

function createSession() {
  const enc    = new TextEncoder();
  const chunks = [];
  const xref   = {};
  let   pos    = 0;
  let   pageIndex  = 0;
  const pageIds    = [];

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

  // Заголовок файла
  write('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n');

  return {
    addPage(bytes, w, h, cs) {
      const i       = pageIndex++;
      const pageId  = 3 + i * 3;
      const xobjId  = 4 + i * 3;
      const cntId   = 5 + i * 3;

      pageIds.push(pageId);

      obj(xobjId, () => {
        write(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} `);
        write(`/ColorSpace ${cs} /BitsPerComponent 8 `);
        write(`/Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`);
        write(bytes);
        write('\nendstream');
      });

      const stream = enc.encode(`q ${w} 0 0 ${h} 0 0 cm /Im Do Q`);
      obj(cntId, () => {
        write(`<< /Length ${stream.length} >>\nstream\n`);
        write(stream);
        write('\nendstream');
      });

      obj(pageId, () => {
        write(`<< /Type /Page /Parent 2 0 R `);
        write(`/MediaBox [0 0 ${w} ${h}] `);
        write(`/Resources << /XObject << /Im ${xobjId} 0 R >> >> `);
        write(`/Contents ${cntId} 0 R >>`);
      });
    },

    get pageCount() { return pageIndex; },

    finish() {
      if (pageIndex === 0) throw new Error('PDF: нет страниц для сборки');
      obj(1, () => write('<< /Type /Catalog /Pages 2 0 R >>'));
      const kidRefs = pageIds.map(id => `${id} 0 R`).join(' ');
      obj(2, () => write(`<< /Type /Pages /Kids [${kidRefs}] /Count ${pageIndex} >>`));
      const xrefStart = pos;
      const objCount  = 3 + pageIndex * 3;
      write(`xref\n0 ${objCount}\n`);
      write('0000000000 65535 f\r\n');
      for (let id = 1; id < objCount; id++) {
        write(`${String(xref[id] ?? 0).padStart(10, '0')} 00000 n\r\n`);
      }
      write(`trailer\n<< /Size ${objCount} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);
      const totalBytes = chunks.reduce((s, c) => s + c.length, 0);
      const out = new Uint8Array(totalBytes);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return out;
    }
  };
}

// ── Обработчик сообщений ──────────────────────────────────────────────────────

self.onmessage = function(e) {
  const msg = e.data;
  if (!msg?.type) return;

  // ── Потоковый режим ────────────────────────────────────────────────────────

  if (msg.type === 'START') {
    try {
      _session = createSession();
    } catch (err) {
      _session = null;
      self.postMessage({ type: 'error', message: err.message });
    }
    return;
  }

  if (msg.type === 'PAGE') {
    if (!_session) {
      self.postMessage({ type: 'error', message: 'PDF сессия не инициализирована' });
      return;
    }
    try {
      const bytes = new Uint8Array(msg.buffer);
      if (!bytes || bytes.length === 0) {
        self.postMessage({ type: 'error', message: `PDF: страница ${_session.pageCount + 1} пустая` });
        return;
      }
      if (typeof msg.w !== 'number' || msg.w <= 0 ||
          typeof msg.h !== 'number' || msg.h <= 0) {
        self.postMessage({ type: 'error', message: `PDF: неверные размеры страницы ${_session.pageCount + 1} (${msg.w}×${msg.h})` });
        return;
      }
      _session.addPage(bytes, msg.w, msg.h, msg.cs || '/DeviceRGB');
      // Прогресс: current = сколько страниц добавлено
      self.postMessage({ type: 'progress', current: _session.pageCount, total: 0 });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message });
    }
    return;
  }

  if (msg.type === 'FINISH') {
    if (!_session) {
      self.postMessage({ type: 'error', message: 'PDF сессия не инициализирована' });
      return;
    }
    try {
      const result = _session.finish();
      _session = null;
      self.postMessage({ type: 'done', buffer: result.buffer }, [result.buffer]);
    } catch (err) {
      _session = null;
      self.postMessage({ type: 'error', message: err.message });
    }
    return;
  }

  // ── Пакетный режим ──────────────────────────────────────

  if (msg.type === 'BUILD') {
    const pages = msg.pages;
    try {
      const result = buildPDFBulk(pages, (current, total) => {
        self.postMessage({ type: 'progress', current, total });
      });
      self.postMessage({ type: 'done', buffer: result.buffer }, [result.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message });
    }
    return;
  }
};

// ── Пакетная сборка PDF ────────────

function buildPDFBulk(pages, progressCb) {
  const enc    = new TextEncoder();
  const chunks = [];
  const xref   = {};
  let   pos    = 0;
  const total  = pages.length;

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
    const pageId  = 3 + i * 3;
    const xobjId  = 4 + i * 3;
    const cntId   = 5 + i * 3;

    obj(xobjId, () => {
      write(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} `);
      write(`/ColorSpace ${cs} /BitsPerComponent 8 `);
      write(`/Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`);
      write(bytes);
      write('\nendstream');
    });

    const stream = enc.encode(`q ${w} 0 0 ${h} 0 0 cm /Im Do Q`);
    obj(cntId, () => {
      write(`<< /Length ${stream.length} >>\nstream\n`);
      write(stream);
      write('\nendstream');
    });

    obj(pageId, () => {
      write(`<< /Type /Page /Parent 2 0 R `);
      write(`/MediaBox [0 0 ${w} ${h}] `);
      write(`/Resources << /XObject << /Im ${xobjId} 0 R >> >> `);
      write(`/Contents ${cntId} 0 R >>`);
    });

    if ((i + 1) % 10 === 0 || i === total - 1) {
      progressCb(i + 1, total);
    }
  }

  const xrefStart = pos;
  const objCount  = 3 + pages.length * 3;
  write(`xref\n0 ${objCount}\n`);
  write('0000000000 65535 f\r\n');
  for (let id = 1; id < objCount; id++) {
    write(`${String(xref[id] ?? 0).padStart(10, '0')} 00000 n\r\n`);
  }
  write(`trailer\n<< /Size ${objCount} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

  const totalBytes = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(totalBytes);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}