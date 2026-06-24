# Tickets2

App móvil sencilla para escanear tickets con OpenAI, guardar gastos localmente y sincronizar con Cloudflare KV.

## Estructura

```txt
public/
  index.html      Interfaz principal
  styles.css      Estilos móviles
  app.js          Lógica del navegador
  exportHelpers.js Codificación, fechas, cuentas y moneda
  exportZip.js    Exportación semanal ZIP, PDF y Excel

src/
  worker.js       Router principal de Cloudflare Worker
  routes/
    ai.js         Endpoint /api/scan
    kv.js         Endpoints /kv/load y /kv/save
    fx.js         Endpoint /fx/:currency/:date
  services/
    openai.js     Llamada a OpenAI Responses API y schema JSON
    storage.js    Lectura/escritura de tickets en KV
    http.js       JSON y CORS compartidos

Ticketsgithub2.txt
  Versión anterior en un solo archivo, conservada como referencia.
```

## Configuración

1. Instala dependencias:

```bash
npm install
```

2. Crea un namespace KV en Cloudflare y reemplaza el `id` en `wrangler.toml`.

3. Configura tu API key de OpenAI como secret:

```bash
npx wrangler secret put OPENAI_API_KEY
```

4. Ejecuta local:

```bash
npm run dev
```

5. Despliega:

```bash
npm run deploy
```

## Modelo

El modelo se configura en `wrangler.toml`:

```toml
[vars]
OPENAI_MODEL = "gpt-5.4-mini"
```

Usa un modelo mini para mantener costo bajo. Si necesitas más precisión en tickets difíciles, cambia `OPENAI_MODEL` por un modelo más fuerte.

## Flujo local

- Escanea uno o más tickets: sube una foto para analizar un ticket, o varias fotos para analizar varios tickets sin comprobante.
- Analizar varios tickets con comprobantes: agrega pares de ticket + comprobante; el total final toma el monto más alto confiable, normalmente el comprobante cuando incluye propina.
- Todos los montos se guardan y exportan en MXN. Si OpenAI detecta otra moneda, la app convierte con el tipo de cambio histórico por fecha.
- El CSV y el Excel del ZIP incluyen la columna `Codificacion` con formato `GOS [cuenta] año.mes.día - horaHRS - comercio - MXN$ monto`.
- El ZIP semanal crea una carpeta por codificación y dentro guarda un PDF con imagen del ticket, comprobante cuando existe y resumen.

## Cambios principales frente a la versión anterior

- OpenAI es el único proveedor.
- La API key ya no se guarda en `localStorage`; vive como secret del Worker.
- El escaneo usa un endpoint único: `/api/scan`.
- La respuesta se fuerza con JSON schema para reducir errores de parseo.
- Ticket y comprobante se comprimen antes de enviarse.
- KV guarda datos estructurados, no imágenes grandes.
- El código está separado por responsabilidades para poder mantenerlo sin romper todo el archivo.
