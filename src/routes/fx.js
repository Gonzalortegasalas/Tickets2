import { json } from '../services/http.js';

export async function handleFx(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const currency = (parts[1] || '').trim().toUpperCase();
  const date = (parts[2] || '').trim();
  if (!/^[A-Z]{3}$/.test(currency)) {
    return json({ error: { code: 'bad_currency', message: 'Moneda inválida.' } }, 400);
  }
  if (currency === 'MXN') {
    return json({ base: 'MXN', target: 'MXN', rate: 1, date: date || null, source: 'identity' });
  }

  const frankfurterUrl = historicalFxUrl(currency, date);
  const response = await fetch(frankfurterUrl, {
    headers: { Accept: 'application/json' }
  });
  const data = await response.json();

  if (!response.ok || !data?.rate) {
    return json({ error: { code: 'fx_failed', message: 'No se pudo obtener el tipo de cambio.' } }, 502);
  }

  return json({
    base: currency,
    target: 'MXN',
    rate: data.rate,
    date: data.date || date || null,
    source: 'frankfurter'
  });
}

function historicalFxUrl(currency, date) {
  const query = /^\d{4}-\d{2}-\d{2}$/.test(date) ? `?date=${date}` : '';
  return `https://api.frankfurter.dev/v2/rate/${currency}/MXN${query}`;
}
