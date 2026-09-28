import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { buildMileageInfo, calculateMileage } from '../public/mileage.js';
import { buildCodificacion, dateForFx, numberOrZero } from '../public/exportHelpers.js';

const source = (await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '').replace(/^init\(\);/m, '');

function setup() {
  const elements = new Map();
  const state = { requests: [], saved: [], images: [], fail: null, route: { kilometros: 100, trayecto: 'A → B', direccion_destino: 'Calle Prueba 123, Centro', fecha: null } };
  const context = vm.createContext({
    console, crypto, state, buildMileageInfo, calculateMileage, buildCodificacion, dateForFx, numberOrZero,
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
  assert.equal(state.saved[0].info.direccion_destino, 'Calle Prueba 123, Centro');
  assert.equal(dateForFx(state.saved[0].info.fecha), date);
  assert.equal(state.images[0].ticketImage, 'route-photo');
  assert.equal(run('mileageImage'), null);
  assert.equal(elements.get('mileage-preview').hidden, true);
  assert.equal(elements.get('mileage-image').value, '');
  assert.equal(elements.get('mileage-analyze').disabled, true);
  assert.equal(run('mileageRoundTrip'), false);
  assert.equal(elements.get('mileage-destination').value, '');
  state.route.fecha = '2026-09-20';
  state.route.direccion_destino = null;
  await upload();
  assert.equal(state.saved.length, 2);
  assert.equal(state.saved[0].info.total, 621.37);
  assert.equal(state.saved[0].info.fecha, '20/09/2026');
  assert.equal(state.saved[0].info.direccion_destino, null);
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
  assert.equal(elements.get('mileage-date').disabled, true);
  run('selectMileageTrip(true)');
  await upload();
  await run('saveMileage({preventDefault(){}})');
  release();
  await pending;
  assert.equal(state.requests.length, 1);
  assert.equal(state.saved.length, 1);
  assert.equal(state.saved[0].info.ida_vuelta, false);
});

test('manual date survives upload preparation and retry without being replaced by the image date', async () => {
  const { state, elements, run, upload } = setup();
  run('resetMileageCapture()');
  elements.get('mileage-date').value = '2026-08-12';
  run('mileageDateManual = true');
  state.route.fecha = '2026-09-28';
  state.fail = 'network';
  await upload();
  assert.equal(elements.get('mileage-date').value, '2026-08-12');
  state.fail = null;
  await run('analyzeMileageImage()');
  assert.equal(state.saved[0].info.fecha, '12/08/2026');
  assert.equal(run('mileageDateManual'), false);
});

test('editing the date without a local photo preserves the record, distance and image storage', async () => {
  const { state, elements, run, upload } = setup();
  run('resetMileageCapture()');
  run('selectMileageTrip(true)');
  await upload();
  const original = state.saved[0];
  run('getTicketImages = async () => null');
  await run('editMileage(tickets[0].id)');
  assert.equal(elements.get('mileage-save').disabled, false);
  elements.get('mileage-date').value = '2026-08-15';
  await run('saveMileage({preventDefault(){}})');
  assert.equal(state.saved.length, 1);
  assert.equal(state.saved[0].id, original.id);
  assert.equal(state.saved[0].info.fecha, '15/08/2026');
  assert.equal(state.saved[0].info.total, original.info.total);
  assert.equal(state.saved[0].info.kilometros, original.info.kilometros);
  assert.equal(state.saved[0].info.direccion_destino, original.info.direccion_destino);
  assert.equal(state.images.length, 1);
});

test('replacing an edited route photo keeps its date, and an invalid date cannot overwrite the record', async () => {
  const { state, elements, run, upload } = setup();
  run('resetMileageCapture()');
  await upload();
  await run('editMileage(tickets[0].id)');
  elements.get('mileage-date').value = '2026-08-15';
  state.route.fecha = '2026-09-28';
  state.route.direccion_destino = 'Otro destino 456';
  await upload();
  assert.equal(state.saved.length, 1);
  assert.equal(state.saved[0].info.fecha, '15/08/2026');
  assert.equal(state.saved[0].info.direccion_destino, 'Otro destino 456');
  await run('editMileage(tickets[0].id)');
  elements.get('mileage-date').value = '';
  await run('saveMileage({preventDefault(){}})');
  assert.equal(state.saved[0].info.fecha, '15/08/2026');
  assert.match(elements.get('mileage-message').textContent, /fecha/);
});

test('replacing a route with no visible address clears the old destination', async () => {
  const { state, run, upload } = setup();
  run('resetMileageCapture()');
  await upload();
  await run('editMileage(tickets[0].id)');
  delete state.route.direccion_destino;
  await upload();
  assert.equal(state.saved.length, 1);
  assert.equal(state.saved[0].info.direccion_destino, null);
});

test('destination text is escaped on cards and preserved as one quoted CSV field', async () => {
  const { state, run, upload } = setup();
  run('resetMileageCapture()');
  state.route.direccion_destino = 'Calle <Prueba> 123, local "B"';
  await upload();
  const card = run('renderMileageCard(tickets[0])');
  assert.match(card, /Dirección del destino: Calle &lt;Prueba&gt; 123/);
  assert.ok(!card.includes('<Prueba>'));
  run('downloadBlob = (content) => { state.csv = content; }; exportCsv();');
  const lines = state.csv.split('\n');
  assert.match(lines[0], /"Direccion del destino"$/);
  assert.match(lines[1], /"Calle <Prueba> 123, local ""B"""$/);
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
