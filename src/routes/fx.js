import { json } from '../services/http.js';

export async function handleFx(url) {
  const currency = url.pathname.replace('/fx/', '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    return json({ error: { code: 'bad_currency', message: 'Moneda inválida.' } }, 400);
  }

  const response = await fetch(`https://open.er-api.com/v6/latest/${currency}`, {
    headers: { Accept: 'application/json' }
  });
  const data = await response.json();

  if (!response.ok || !data?.rates?.MXN) {
    return json({ error: { code: 'fx_failed', message: 'No se pudo obtener el tipo de cambio.' } }, 502);
  }

  return json({
    base: currency,
    target: 'MXN',
    rate: data.rates.MXN,
    updated: data.time_last_update_utc || null
  });
}
