import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = (await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '').replace(/^init\(\);/m, '');

function setup() {
  const elements = new Map();
  const state = { requests: [], images: [], saved: [], fail: null };
  const context = vm.createContext({
    console, crypto, state,
    localStorage: { getItem: () => null },
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { innerHTML: '', style: {}, querySelectorAll: () => [] });
      return elements.get(id);
    } },
    fetch: async (url, options) => {
      state.requests.push(JSON.parse(options.body));
      await state.wait;
      if (state.fail === 'network') throw new Error('Sin conexión');
      return { ok: true, json: async () => ({ ok: true, ticket: { tienda: 'Prueba', moneda: 'MXN', total: 100 } }) };
    }
  });
  vm.runInContext(source + `
    convertInfoToMxn = async info => info;
    storeTicketImages = async (id, images) => {
      if (state.fail === 'images') throw new Error('IndexedDB no disponible');
      state.images.push({ id, ...images });
    };
    saveLocalTickets = () => {
      if (state.fail === 'local') throw new Error('Sin espacio');
      state.saved = tickets.slice();
    };
    saveToCloud = async () => {};
    renderAll = () => {};
    resetPair();
  `, context);
  const run = code => vm.runInContext(code, context);
  const select = () => run(`Object.assign(currentPair, {ticketImage:'ticket-photo', voucherImage:'voucher-photo', ticketName:'ticket.jpg', voucherName:'voucher.jpg', status:'listo'}); renderPair();`);
  return { state, elements, run, select };
}

test('one pair is saved with both photos, clears on success and accepts the next pair', async () => {
  const { state, elements, run, select } = setup();
  select();
  assert.equal(elements.get('pair-scan-btn').disabled, false);
  assert.match(elements.get('pair-list').innerHTML, /Vista previa: Ticket/);
  await run('processPair()');
  assert.equal(state.saved.length, 1);
  assert.equal(state.images[0].ticketImage, 'ticket-photo');
  assert.equal(state.images[0].voucherImage, 'voucher-photo');
  assert.equal(run('currentPair.ticketImage'), null);
  assert.equal(run('currentPair.voucherImage'), null);
  assert.equal(elements.get('pair-scan-btn').disabled, true);
  assert.doesNotMatch(elements.get('pair-list').innerHTML, /<img|ticket.jpg|voucher.jpg/);
  select();
  await run('processPair()');
  assert.equal(state.saved.length, 2);
  assert.notEqual(state.saved[0].id, state.saved[1].id);
});

for (const fail of ['network', 'images', 'local']) {
  test(`${fail} failure keeps both photos and a retry saves one ticket`, async () => {
    const { state, elements, run, select } = setup();
    select();
    state.fail = fail;
    await run('processPair()');
    assert.equal(run('currentPair.ticketImage'), 'ticket-photo');
    assert.equal(run('currentPair.voucherImage'), 'voucher-photo');
    assert.equal(run('tickets.length'), 0);
    assert.equal(elements.get('pair-scan-btn').disabled, false);
    state.fail = null;
    await run('processPair()');
    assert.equal(state.saved.length, 1);
  });
}

test('incomplete or busy pairs cannot submit or replace photos during analysis', async () => {
  const { state, elements, run, select } = setup();
  await run('processPair()');
  assert.equal(state.requests.length, 0);
  select();
  let release;
  state.wait = new Promise(resolve => { release = resolve; });
  const pending = run('processPair()');
  assert.equal(elements.get('pair-scan-btn').disabled, true);
  assert.equal((elements.get('pair-list').innerHTML.match(/disabled/g) || []).length, 2);
  await run('processPair()');
  await run("loadPairImage({target:{files:[{name:'replacement.jpg'}]}}, 'ticket')");
  assert.equal(state.requests.length, 1);
  assert.equal(run('currentPair.ticketImage'), 'ticket-photo');
  release();
  await pending;
  assert.equal(state.saved.length, 1);
});
