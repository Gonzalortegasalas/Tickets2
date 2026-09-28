import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateMileage, buildMileageInfo } from '../public/mileage.js';
import { getCuenta } from '../public/exportHelpers.js';
import worker from '../src/worker.js';
import { scanMileageWithOpenAI } from '../src/services/openai.js';
import { loadTickets, saveTicketsPatch } from '../src/services/storage.js';

test('kilometers convert without rounding miles before the payment', () => {
  assert.deepEqual(calculateMileage(1.609344), { km: 1.609344, miles: 1, rate: 10, total: 10 });
  assert.equal(calculateMileage(100).total, 621.37);
  for (const km of [0, -1, '', null, Infinity, 'invalid']) assert.throws(() => calculateMileage(km));
  assert.throws(() => buildMileageInfo({ km: 10, date: '2026-02-30' }));
  assert.throws(() => buildMileageInfo({ km: 10 }));
  assert.equal(getCuenta(buildMileageInfo({ km: 10, date: '2026-09-22' })), 'MILLAS');
  assert.equal(getCuenta({ tarjeta: null }), 'EFVO');
  assert.equal(getCuenta({ tarjeta: '3139' }), '3139');
});

test('mileage records survive KV round trips with their typed metadata', async () => {
  const records = new Map();
  const kv = { get: async (key) => records.get(key), put: async (key, value) => records.set(key, value) };
  const ticket = { id: 'route', info: buildMileageInfo({ km: 100, date: '2026-09-22', route: 'Origen → destino', roundTrip: true }) };
  await saveTicketsPatch(kv, { upserts: [ticket], deletes: [] });
  assert.deepEqual(await loadTickets(kv), [ticket]);
});

test('round trip doubles unrounded miles and pays both legs without doubling stored kilometers', () => {
  const info = buildMileageInfo({ km: 100, date: '2026-09-28', roundTrip: true });
  assert.equal(info.kilometros, 100);
  assert.equal(info.millas, calculateMileage(100).miles * 2);
  assert.equal(info.total, 1242.74);
  assert.equal(info.ida_vuelta, true);
  assert.equal(calculateMileage(1.609344, true).total, 20);
  assert.equal(buildMileageInfo({ km: 100, date: '2026-09-28' }).ida_vuelta, false);
});

test('route scanning uses its own schema and endpoint, preserving receipt scanning', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const result = body.text.format.name === 'mileage_scan'
      ? { kilometros: 16.09344, trayecto: 'A → B', fecha: null, notas: null }
      : { tienda: 'Tienda', total: 100, moneda: 'MXN' };
    return Response.json({ output: [{ content: [{ text: JSON.stringify(result) }] }] });
  });
  const env = { OPENAI_API_KEY: 'test-only', OPENAI_MODEL: 'test-model' };
  const post = (path, body) => new Request(`https://example.test${path}`, { method: 'POST', body: JSON.stringify(body) });
  const routeResponse = await worker.fetch(post('/api/scan-mileage', { routeImage: 'data:image/png;base64,test' }), env);
  assert.equal(routeResponse.status, 200);
  assert.equal((await routeResponse.json()).route.kilometros, 16.09344);
  assert.equal(requests[0].model, 'test-model');
  assert.equal(requests[0].store, false);
  assert.equal(requests[0].text.format.strict, true);
  const receiptResponse = await worker.fetch(post('/api/scan', { ticketImage: 'data:image/png;base64,test' }), env);
  assert.equal((await receiptResponse.json()).ticket.total, 100);
  assert.equal(requests[1].text.format.name, 'ticket_scan');
  assert.equal((await worker.fetch(post('/api/scan-mileage', {}), env)).status, 400);
  assert.equal((await worker.fetch(post('/api/scan-mileage', {}), {})).status, 500);
});

test('ambiguous, invalid, refused and failed route responses are handled safely', async (t) => {
  for (const value of [null, -4, '12']) {
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ output_text: JSON.stringify({ kilometros: value }) }));
    assert.equal((await scanMileageWithOpenAI({ apiKey: 'test', model: 'test', routeImage: 'test' })).kilometros, null);
    mock.mock.restore();
  }
  const refusal = t.mock.method(globalThis, 'fetch', async () => Response.json({ output: [{ content: [{ type: 'refusal', refusal: 'Cannot read' }] }] }));
  await assert.rejects(scanMileageWithOpenAI({ apiKey: 'test', model: 'test', routeImage: 'test' }), /manualmente/);
  refusal.mock.restore();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'Unavailable' } }, { status: 503 }));
  await assert.rejects(scanMileageWithOpenAI({ apiKey: 'test', model: 'test', routeImage: 'test' }), /Unavailable/);
});
