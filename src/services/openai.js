const RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tienda: { type: ['string', 'null'] },
    fecha: { type: ['string', 'null'], description: 'DD/MM/YYYY, never today unless printed on receipt' },
    hora: { type: ['string', 'null'], description: 'HH:MM 24-hour format' },
    categoria: {
      type: 'string',
      enum: ['Alimentos', 'Supermercado', 'Restaurante', 'Transporte', 'Gasolina', 'Salud', 'Farmacia', 'Tecnologia', 'Electronica', 'Hogar', 'Ferreteria', 'Ropa', 'Otro']
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          nombre: { type: ['string', 'null'] },
          precio: { type: 'number' }
        },
        required: ['nombre', 'precio']
      }
    },
    subtotal: { type: 'number' },
    impuestos: { type: 'number' },
    total: { type: 'number' },
    moneda: { type: 'string', enum: ['MXN', 'USD', 'EUR', 'GBP', 'CAD', 'Otro'] },
    moneda_original: { type: ['string', 'null'] },
    total_original: { type: 'number' },
    tarjeta: { type: ['string', 'null'], description: 'Last four card digits only' },
    direccion: { type: ['string', 'null'] },
    notas: { type: ['string', 'null'] },
    confianza: { type: 'number', minimum: 0, maximum: 1 }
  },
  required: [
    'tienda',
    'fecha',
    'hora',
    'categoria',
    'items',
    'subtotal',
    'impuestos',
    'total',
    'moneda',
    'moneda_original',
    'total_original',
    'tarjeta',
    'direccion',
    'notas',
    'confianza'
  ]
};

export async function scanReceiptWithOpenAI({ apiKey, model, ticketImage, voucherImage }) {
  const content = [
    {
      type: 'input_text',
      text: buildPrompt(Boolean(voucherImage))
    },
    imageInput(ticketImage)
  ];

  if (voucherImage) {
    content.push(imageInput(voucherImage));
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      store: false,
      max_output_tokens: 1800,
      input: [
        {
          role: 'user',
          content
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'ticket_scan',
          strict: true,
          schema: RECEIPT_SCHEMA
        }
      }
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `OpenAI respondió ${response.status}`;
    const error = new Error(message);
    error.code = data?.error?.code || 'openai_error';
    throw error;
  }

  const text = extractOutputText(data);
  if (!text) {
    throw new Error('OpenAI no devolvió texto parseable.');
  }

  try {
    return normalizeTicket(JSON.parse(text));
  } catch {
    throw new Error('OpenAI devolvió JSON inválido.');
  }
}

function imageInput(dataUrl) {
  return {
    type: 'input_image',
    image_url: dataUrl,
    detail: 'auto'
  };
}

function extractOutputText(data) {
  if (typeof data.output_text === 'string') return data.output_text.trim();

  return (data.output || [])
    .flatMap((item) => item.content || [])
    .map((part) => part.text || '')
    .join('')
    .trim();
}

function normalizeTicket(ticket) {
  const normalized = {
    tienda: ticket.tienda || null,
    fecha: ticket.fecha || null,
    hora: ticket.hora || null,
    categoria: ticket.categoria || 'Otro',
    items: Array.isArray(ticket.items) ? ticket.items : [],
    subtotal: numberOrZero(ticket.subtotal),
    impuestos: numberOrZero(ticket.impuestos),
    total: numberOrZero(ticket.total),
    moneda: ticket.moneda || 'MXN',
    moneda_original: ticket.moneda_original || null,
    total_original: numberOrZero(ticket.total_original),
    tarjeta: cleanCard(ticket.tarjeta),
    direccion: ticket.direccion || null,
    notas: ticket.notas || null,
    confianza: Math.max(0, Math.min(1, numberOrZero(ticket.confianza)))
  };

  normalized.items = normalized.items.map((item) => ({
    nombre: item?.nombre || null,
    precio: numberOrZero(item?.precio)
  }));

  if (!normalized.total && normalized.items.length) {
    normalized.total = Math.round(normalized.items.reduce((sum, item) => sum + item.precio, 0) * 100) / 100;
  }

  return normalized;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function cleanCard(value) {
  if (!value) return null;
  const digits = String(value).replace(/\D/g, '');
  return digits ? digits.slice(-4) : null;
}

function buildPrompt(hasVoucher) {
  return `Read the receipt image carefully and extract expense data for a Spanish-speaking user in Mexico.

Return only the JSON required by the schema.

Rules:
- Read the printed receipt date. Do not use today's date unless it is printed.
- Use DD/MM/YYYY for fecha and HH:MM for hora.
- Match each item with the price on the same horizontal line.
- Prefer the final charged amount. ${hasVoucher ? 'There is a second image with the card voucher; use its TOTAL as the final total when readable, and use the receipt for store/items/date.' : 'Use the receipt TOTAL as the final total.'}
- If a voucher shows CONSUMO/PROPINA/TOTAL, total must be the voucher TOTAL.
- Extract only the last 4 digits for tarjeta if visible.
- Currency detection matters: use MXN only when the receipt is Mexican pesos; detect USD/EUR when printed.
- If uncertain, keep the best value and explain briefly in notas.
- Set confianza from 0 to 1 based on image readability and extraction certainty.`;
}
