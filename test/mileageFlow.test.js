import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { buildMileageInfo, calculateMileage } from '../public/mileage.js';
import { dateForFx, numberOrZero } from '../public/exportHelpers.js';

const source = (await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '').replace(/^init\(\);/m, '');

function setup() {
  const elements = new Map();
  const state = { requests: [], saved: [], images: [], fail: null, route: { kilometros: 100, trayecto: 'A → B', fecha: null } };
  const context = vm.createContext({
    console, crypto, state, buildMileageInfo, calculateMileage, dateForFx, numberOrZero,
    localStorage: { getItem: () => null },
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, {
        value: '', style: {}, setAttribute(name, value) { this[name] = value; }, removeAttribute() {},
        reset() {}, scrollIntoView() {}
      });
      return elements.get(id);
    } },
    fetch: async (url, options) => {
      state.requests.push({ url, body: JSON.parse(options.body) });
      await state.wait;
      if (state.fail === 'network') throw new Error('Sin conexión');
      return { ok: true, json: async () => ({ ok: true, route: state.route }) };
    }
  });
  vm.runInContext(source + `
    compressImage = async () => { if (state.fail === 'compression') throw new Error('Foto inválida'); return 'route-photo'; };
    storeTicketImages = async (id, images) => {
      if (state.fail === 'images') throw new Error('IndexedDB no disponible');
      state.images.push({ id, ...images });
    };
    getTicketImages = async () => ({ ticketImage: 'route-photo' });
    saveLocalTickets = () => {
      if (state.fail === 'local') throw new Error('Sin espacio');
      state.saved = tickets.slice();
    };
    saveToCloud = async () => {};
    renderAll = () => {};
    switchView = () => {};
    setStatus = message => { state.status = message; };
  `, context);
  const run = code => vm.runInContext(code, context);
  const upload = () => run('loadMileageImage({target:{files:[{}]}})');
  return { state, elements, run, upload };
}

test('upload automatically reads and saves a round trip with its photo and today fallback', async () => {
  const { state, elements, run, upload } = setup();
  run('resetMileageCapture()');
  const date = elements.get('mileage-date').value;
  run('selectMileageTrip(true)');
  await upload();
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].url, '/api/scan-mileage');
  assert.equal(state.requests[0].body.routeImage, 'route-photo');
  assert.equal(state.saved.length, 1);
  assert.equal(state.saved[0].info.ida_vuelta, true);
  assert.equal(state.saved[0].info.total, 1242.74);
  assert.equal(dateForFx(state.saved[0].info.fecha), date);
  assert.equal(state.images[0].ticketImage, 'route-photo');
  assert.equal(run('mileageImage'), null);
  assert.equal(elements.get('mileage-preview').hidden, true);
  assert.equal(elements.get('mileage-image').value, '');
  assert.equal(elements.get('mileage-analyze').disabled, true);
  assert.equal(run('mileageRoundTrip'), false);
  state.route.fecha = '2026-09-20';
  await upload();
  assert.equal(state.saved.length, 2);
  assert.equal(state.saved[0].info.total, 621.37);
  assert.equal(state.saved[0].info.fecha, '20/09/2026');
});

for (const fail of ['network', 'images', 'local']) {
  test(`${fail} failure preserves photo and retries without duplicate mileage records`, async () => {
    const { state, elements, run, upload } = setup();
    run('resetMileageCapture()');
    state.fail = fail;
    await upload();
    assert.equal(run('tickets.length'), 0);
    assert.equal(run('mileageImage'), 'route-photo');
    assert.equal(elements.get('mileage-preview').hidden, false);
    assert.equal(elements.get('mileage-analyze').disabled, false);
    state.fail = null;
    await run('analyzeMileageImage()');
    assert.equal(state.saved.length, 1);
  });
}

test('unreadable distance is not saved; a replacement photo can be analyzed without manual fields', async () => {
  const { state, elements, run, upload } = setup();
  run('resetMileageCapture()');
  state.route.kilometros = null;
  await upload();
  assert.equal(state.saved.length, 0);
  assert.equal(elements.get('mileage-preview').hidden, false);
  assert.match(elements.get('mileage-message').textContent, /Reintenta/);
  state.route.kilometros = 1.609344;
  await upload();
  assert.equal(state.saved[0].info.total, 10);
});

test('busy scan locks trip choice and prevents duplicate uploads and saves', async () => {
  const { state, elements, run, upload } = setup();
  run('resetMileageCapture()');
  let release;
  state.wait = new Promise(resolve => { release = resolve; });
  const pending = upload();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get('mileage-round-trip').disabled, true);
  run('selectMileageTrip(true)');
  await upload();
  await run('saveMileage({preventDefault(){}})');
  release();
  await pending;
  assert.equal(state.requests.length, 1);
  assert.equal(state.saved.length, 1);
  assert.equal(state.saved[0].info.ida_vuelta, false);
});

test('editing a round trip keeps the base kilometers and saves changes without doubling twice', async () => {
  const { state, run, upload } = setup();
  run('resetMileageCapture()');
  run('selectMileageTrip(true)');
  await upload();
  await run('editMileage(tickets[0].id)');
  await run('saveMileage({preventDefault(){}})');
  assert.equal(state.saved.length, 1);
  assert.equal(state.saved[0].info.total, 1242.74);
  await run('editMileage(tickets[0].id)');
  run('selectMileageTrip(false)');
  await run('saveMileage({preventDefault(){}})');
  assert.equal(state.saved.length, 1);
  assert.equal(state.saved[0].info.total, 621.37);
});

test('clearing a failed capture removes the photo and cannot save an empty record', async () => {
  const { state, elements, run, upload } = setup();
  run('resetMileageCapture()');
  state.fail = 'network';
  await upload();
  run('resetMileageCapture()');
  await run('analyzeMileageImage()');
  assert.equal(state.requests.length, 1);
  assert.equal(run('mileageImage'), null);
  assert.equal(elements.get('mileage-preview').hidden, true);
  assert.equal(elements.get('mileage-analyze').disabled, true);
  assert.equal(state.saved.length, 0);
});
