import { json } from '../services/http.js';
import { scanReceiptWithOpenAI } from '../services/openai.js';

export async function handleScan(request, env) {
  if (!env.OPENAI_API_KEY) {
    return json({
      error: {
        code: 'missing_openai_key',
        message: 'Falta configurar OPENAI_API_KEY en Cloudflare Workers secrets.'
      }
    }, 500);
  }

  const body = await request.json().catch(() => null);
  if (!body || !body.ticketImage) {
    return json({
      error: {
        code: 'missing_ticket_image',
        message: 'Sube una foto del ticket antes de escanear.'
      }
    }, 400);
  }

  const result = await scanReceiptWithOpenAI({
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL || 'gpt-5.4-mini',
    ticketImage: body.ticketImage,
    voucherImage: body.voucherImage || null
  });

  return json({ ok: true, ticket: result });
}
