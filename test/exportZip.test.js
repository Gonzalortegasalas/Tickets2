import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportWeeklyZip } from '../public/exportZip.js';
import { buildMileageInfo } from '../public/mileage.js';

function ticket(id, info = {}) {
  return { id, info: { tienda: 'Tienda', fecha: '22/09/2026', total: 100, moneda: 'MXN', ...info } };
}

function setup(t) {
  const state = { files: new Map(), pdfs: [], rows: [], scripts: [], timers: new Map(), clicks: [], revoked: [], requests: [] };
  class Zip {
    constructor(prefix = '') { this.prefix = prefix; }
    folder(name) { return new Zip(`${this.prefix}${name}/`); }
    file(name, content) { state.files.set(`${this.prefix}${name}`, content); }
    async generateAsync() { return new Blob(['zip']); }
  }
  class Pdf {
    constructor() { this.internal = { pageSize: { width: 210, height: 297 } }; this.texts = []; this.images = []; this.page = 1; state.pdfs.push(this); }
    setFont() {}
    setFontSize() {}
    setTextColor() {}
    text(value, x, y) { this.texts.push({ value, y, page: this.page }); }
    addPage() { this.page++; }
    deletePage() { this.page--; }
    getImageProperties(image) {
      if (image === 'broken') throw new Error('Invalid image');
      return { width: 100, height: 1000 };
    }
    addImage(image, type, x, y, width, height) { if (image === 'decode-error') throw new Error('Decode failed'); this.image = image; this.images.push({ image, page: this.page, x, y, width, height }); }
    output() { return new Blob(['pdf']); }
  }
  const libraries = {
    JSZip: Zip,
    jspdf: { jsPDF: Pdf },
    XLSX: {
      utils: { book_new: () => ({}), aoa_to_sheet: (rows) => { state.rows = rows; state.sheet = {}; return state.sheet; }, book_append_sheet() {} },
      write: () => new ArrayBuffer(8)
    }
  };
  const window = { ...libraries };
  const document = {
    scripts: state.scripts,
    createElement(tag) {
      const element = { remove() { const index = state.scripts.indexOf(element); if (index >= 0) state.scripts.splice(index, 1); } };
      if (tag === 'a') element.click = () => state.clicks.push({ href: element.href, download: element.download });
      return element;
    },
    head: { appendChild(script) { state.scripts.push(script); state.onScript?.(script); } },
    body: { appendChild() {} }
  };
  t.mock.method(console, 'warn', () => {});
  for (const [key, value] of Object.entries({
    window, document,
    setTimeout: (callback, delay) => { const id = {}; state.timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => state.timers.delete(id),
    fetch: async (url) => { state.requests.push(url); return { ok: true, json: async () => ({ rate: 20, date: '2026-09-22' }) }; }
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
  }
  t.mock.method(URL, 'createObjectURL', () => 'blob:test');
  t.mock.method(URL, 'revokeObjectURL', (url) => state.revoked.push(url));
  return Object.assign(state, { window, libraries });
}

test('MXN totals are authoritative, including zero and original currency metadata', async (t) => {
  const state = setup(t);
  const tickets = [ticket('1', { moneda_original: 'NOR' }), ticket('2', { total: 0, moneda_original: 'EUR', total_original: 10 }), ticket('3', { moneda_original: 'EUR', total_original: 5, tipo_cambio: 20 })];
  const before = structuredClone(tickets);
  await exportWeeklyZip(tickets, async () => ({ ticketImage: 'data:image/jpeg;base64,valid' }));
  assert.deepEqual(state.requests, []);
  assert.deepEqual(state.rows.slice(1).map((row) => row[4]), [100, 0, 100]);
  assert.deepEqual(tickets, before);
  assert.equal(state.files.size, 4);
  assert.ok(state.files.has('gastos_GOS.xlsx'));
  const paths = [...state.files.keys()].filter((path) => path.endsWith('/ticket.pdf'));
  assert.equal(paths.length, 3);
  assert.ok(paths.every((path) => path.startsWith('Tickets_2026-09-21_al_2026-09-27/GOS ')));
  assert.ok(paths.some((path) => path.endsWith(' (2)/ticket.pdf')));
  assert.match(state.clicks[0].download, /^Tickets_GOS_\d{4}-\d{2}-\d{2}\.zip$/);
  assert.deepEqual(state.revoked, []);
  const cleanup = [...state.timers.values()].find((timer) => timer.delay === 60000);
  cleanup.callback();
  assert.deepEqual(state.revoked, ['blob:test']);
});

test('foreign currency conversion uses stored currency and shares historical requests', async (t) => {
  const state = setup(t);
  const tickets = [ticket('1', { moneda: 'EUR', moneda_original: 'NOR', total_original: 10, total_ticket: 8, total_comprobante: 10, propina: 2, items: [{ nombre: 'Producto', precio: 8 }] }), ticket('2', { moneda: 'EUR', total: 15 })];
  const before = structuredClone(tickets);
  await exportWeeklyZip(tickets, async () => null);
  assert.deepEqual(state.requests, ['/fx/EUR/2026-09-22']);
  assert.deepEqual(state.rows.slice(1).map((row) => row[4]), [200, 300]);
  assert.deepEqual(state.rows[1].slice(7, 10), [160, 200, 40]);
  assert.ok(state.pdfs.every((pdf) => pdf.texts.length === 0));
  assert.deepEqual(tickets, before);
});

test('legacy original currency fallback still converts', async (t) => {
  const state = setup(t);
  await exportWeeklyZip([ticket('1', { moneda: 'Otro', moneda_original: 'USD', total_original: 5 })], async () => null);
  assert.deepEqual(state.requests, ['/fx/USD/2026-09-22']);
  assert.equal(state.rows[1][4], 100);
});

test('failed FX conversion remains an error instead of exporting incorrect MXN amounts', async (t) => {
  const state = setup(t);
  globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
  await assert.rejects(exportWeeklyZip([ticket('1', { moneda: 'EUR' })], async () => null), /tipo de cambio EUR/);
  assert.equal(state.clicks.length, 0);
});

test('missing images, IndexedDB failures and corrupt images do not drop tickets', async (t) => {
  const state = setup(t);
  const { warnings } = await exportWeeklyZip(['missing', 'db', 'corrupt', 'decode'].map((id) => ticket(id)), async (id) => {
    if (id === 'db') throw new Error('IndexedDB unavailable');
    if (id === 'corrupt') return { ticketImage: 'broken', voucherImage: 'data:image/jpeg;base64,valid' };
    if (id === 'decode') return { ticketImage: 'data:image/jpeg;base64,valid', voucherImage: 'decode-error' };
    return null;
  });
  assert.equal(state.pdfs.length, 4);
  assert.equal(state.files.size, 4);
  assert.equal(state.rows.length, 5);
  assert.equal(warnings.length, 4);
  assert.ok(state.files.has('avisos.txt'));
  assert.equal([...state.files.keys()].filter((path) => path.endsWith('.pdf')).length, 2);
  assert.ok(state.pdfs.every((pdf) => pdf.texts.length === 0 && pdf.page === 1));
  assert.equal(state.pdfs[2].images.length, 1);
  assert.equal(state.pdfs[3].images.length, 1);
});

test('ticket and voucher use separate image-only pages within A4 bounds', async (t) => {
  const state = setup(t);
  await exportWeeklyZip([ticket('1', { total_ticket: 100, total_comprobante: 110, moneda_original: 'EUR', total_original: 5, items: [{ nombre: 'Producto', precio: 100 }] })], async () => ({ ticketImage: 'data:image/jpeg;base64,valid', voucherImage: 'data:image/jpeg;base64,valid' }));
  assert.equal(state.pdfs[0].page, 2);
  assert.equal(state.pdfs[0].texts.length, 0);
  assert.deepEqual(state.pdfs[0].images.map((image) => image.page), [1, 2]);
  assert.ok(state.pdfs[0].images.every(({ x, y, width, height }) => x >= 10 && y >= 10 && x + width <= 200 && y + height <= 287));
});

for (const library of ['JSZip', 'jspdf', 'XLSX']) {
  for (const failure of ['network', 'missing-global', 'timeout']) {
    test(`${library}: ${failure} failure allows a successful second export`, async (t) => {
      const state = setup(t);
      delete state.window[library];
      state.onScript = (script) => queueMicrotask(() => {
        if (failure === 'network') script.onerror();
        else if (failure === 'missing-global') script.onload();
        else [...state.timers.values()].find((timer) => timer.delay === 30000).callback();
      });
      await assert.rejects(exportWeeklyZip([ticket('1')], async () => null), /No se pudo cargar/);
      assert.equal(state.scripts.length, 0);
      assert.equal(state.timers.size, 0);
      state.onScript = (script) => queueMicrotask(() => { state.window[library] = state.libraries[library]; script.onload(); });
      await exportWeeklyZip([ticket('1')], async () => null);
      assert.equal(state.clicks.length, 1);
    });
  }
}

test('concurrent exports wait for the same pending script', async (t) => {
  const state = setup(t);
  delete state.window.JSZip;
  const first = exportWeeklyZip([ticket('1')], async () => null);
  const second = exportWeeklyZip([ticket('2')], async () => null);
  assert.equal(state.scripts.length, 1);
  assert.equal(state.clicks.length, 0);
  state.window.JSZip = state.libraries.JSZip;
  state.scripts[0].onload();
  await Promise.all([first, second]);
  assert.equal(state.clicks.length, 2);
});

test('a stale script tag without its global is replaced', async (t) => {
  const state = setup(t);
  delete state.window.JSZip;
  const old = { src: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', remove() { state.scripts.splice(state.scripts.indexOf(old), 1); } };
  state.scripts.push(old);
  state.onScript = (script) => queueMicrotask(() => { state.window.JSZip = state.libraries.JSZip; script.onload(); });
  await exportWeeklyZip([ticket('1')], async () => null);
  assert.equal(state.scripts.length, 1);
  assert.notEqual(state.scripts[0], old);
});

test('mileage exports image-only PDF and explicit Excel distance/payment formulas', async (t) => {
  const state = setup(t);
  const route = ticket('route', buildMileageInfo({ km: 100, date: '2026-09-22', route: 'Casa → oficina' }));
  await exportWeeklyZip([route, ticket('receipt')], async () => ({ ticketImage: 'data:image/png;base64,valid' }));
  assert.equal(state.rows[1][5], 'MILLAS');
  assert.equal(state.rows[1][4], 621.37);
  assert.equal(state.rows[1][15], 100);
  assert.equal(state.rows[1][17], 10);
  assert.equal(state.sheet.Q2.f, 'P2/1.609344');
  assert.equal(state.sheet.E2.f, 'ROUND(Q2*R2,2)');
  assert.equal(state.sheet.E2.v, 621.37);
  assert.equal(state.pdfs[0].texts.length, 0);
  assert.equal(state.pdfs[0].image, 'data:image/png;base64,valid');
  assert.equal(state.pdfs[1].texts.length, 0);
  assert.ok([...state.files.keys()].some((path) => path.includes('[MILLAS]')));
  assert.deepEqual(state.requests, []);
});

test('missing route evidence warns without creating a blank PDF or losing Excel rows', async (t) => {
  const state = setup(t);
  const { warnings } = await exportWeeklyZip([ticket('route', buildMileageInfo({ km: 10, date: '2026-09-22' }))], async () => null);
  assert.equal(warnings.length, 1);
  assert.equal([...state.files.keys()].filter((path) => path.endsWith('.pdf')).length, 0);
  assert.ok(state.files.has('avisos.txt'));
  assert.equal(state.rows.length, 2);
});

test('round-trip Excel labels and formulas apply the factor once; legacy trips remain one-way', async (t) => {
  const state = setup(t);
  const info = buildMileageInfo({ km: 100, date: '2026-09-22', roundTrip: true });
  const legacy = buildMileageInfo({ km: 100, date: '2026-09-22' });
  delete legacy.ida_vuelta;
  await exportWeeklyZip([ticket('round', info), ticket('legacy', legacy)], async () => ({ ticketImage: 'data:image/png;base64,valid' }));
  assert.equal(state.rows[1][18], 'Ida y vuelta');
  assert.equal(state.rows[1][19], 2);
  assert.equal(state.rows[1][15], 100);
  assert.equal(state.sheet.Q2.f, 'P2/1.609344*T2');
  assert.equal(state.sheet.E2.v, 1242.74);
  assert.equal(state.rows[2][18], 'Solo ida');
  assert.equal(state.sheet.E3.v, 621.37);
  assert.equal(state.pdfs[0].texts.length, 0);
});
