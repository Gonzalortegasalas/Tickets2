import { json } from '../services/http.js';
import { scanReceiptWithOpenAI, scanMileageWithOpenAI } from '../services/openai.js';

export async function handleMileageScan(request, env) {
  if (!env.OPENAI_API_KEY) {
    return json({ error: { code: 'missing_openai_key', message: 'No está configurada la lectura de imágenes. Ingresa los kilómetros manualmente.' } }, 500);
  }
  const body = await request.json().catch(() => null);
  if (typeof body?.routeImage !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(body.routeImage)) {
    return json({ error: { code: 'missing_route_image', message: 'Adjunta una captura del trayecto.' } }, 400);
  }
  const route = await scanMileageWithOpenAI({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL || 'gpt-5.4-mini', routeImage: body.routeImage });
  return json({ ok: true, route });
}

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
