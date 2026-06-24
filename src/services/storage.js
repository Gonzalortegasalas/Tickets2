const INDEX_KEY = 'tickets:index';
const TICKET_PREFIX = 'ticket:';

export async function loadTickets(kv) {
  const indexRaw = await kv.get(INDEX_KEY);
  if (!indexRaw) return [];

  let ids;
  try {
    ids = JSON.parse(indexRaw);
  } catch {
    ids = [];
  }

  const records = await Promise.all(
    ids.map(async (id) => {
      const raw = await kv.get(`${TICKET_PREFIX}${id}`);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })
  );

  return records
    .filter(Boolean)
    .sort((a, b) => new Date(b.savedAt || 0) - new Date(a.savedAt || 0));
}

export async function saveTicketsPatch(kv, { upserts, deletes }) {
  const indexRaw = await kv.get(INDEX_KEY);
  const currentIds = indexRaw ? JSON.parse(indexRaw) : [];
  const index = new Set(Array.isArray(currentIds) ? currentIds : []);

  for (const ticket of upserts) {
    if (!ticket?.id) continue;
    await kv.put(`${TICKET_PREFIX}${ticket.id}`, JSON.stringify(ticket));
    index.add(ticket.id);
  }

  for (const id of deletes) {
    if (!id) continue;
    await kv.delete(`${TICKET_PREFIX}${id}`);
    index.delete(id);
  }

  await kv.put(INDEX_KEY, JSON.stringify([...index]));
}
