import { json } from '../services/http.js';
import { loadTickets, saveTicketsPatch } from '../services/storage.js';

export async function handleKvLoad(env) {
  if (!env.TICKETS_KV) {
    return json({ ok: true, configured: false, tickets: [] });
  }

  const tickets = await loadTickets(env.TICKETS_KV);
  return json({ ok: true, configured: true, tickets });
}

export async function handleKvSave(request, env) {
  if (!env.TICKETS_KV) {
    return json({
      ok: false,
      configured: false,
      error: { code: 'missing_kv', message: 'Falta configurar el binding TICKETS_KV.' }
    }, 500);
  }

  const body = await request.json().catch(() => ({}));
  const upserts = Array.isArray(body.upserts) ? body.upserts : [];
  const deletes = Array.isArray(body.deletes) ? body.deletes : [];
  await saveTicketsPatch(env.TICKETS_KV, { upserts, deletes });

  return json({ ok: true, configured: true });
}
