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
- Analizar ticket con comprobante: carga un solo par y revisa ambas vistas previas. Al guardarse, la selección se limpia para cargar el siguiente; si falla, conserva las fotos para reintentar. El total final toma el monto más alto confiable, normalmente el comprobante cuando incluye propina.
- Todos los montos se guardan y exportan en MXN. Si OpenAI detecta otra moneda, la app convierte con el tipo de cambio histórico por fecha.
- El CSV y el Excel del ZIP incluyen la columna `Codificacion` con formato `GOS [cuenta] año.mes.día - horaHRS - comercio - MXN$ monto`.
- El ZIP semanal crea una carpeta por codificación y dentro guarda un PDF con únicamente las imágenes del ticket y del comprobante cuando existe, una imagen por página. Los datos y cálculos se conservan en Excel. Si falta una imagen legible, se avisa fuera del PDF; no se generan PDFs vacíos.

## Trayectos y millas

- En Escanear, la tarjeta **Registrar millas** permite elegir **Solo ida** o **Ida y vuelta** y subir la captura de Google Maps desde **Elegir foto**, igual que los tickets. No solicita trayecto, fecha ni kilómetros manualmente: se lee y guarda automáticamente; si no hay fecha en la captura se usa la fecha local de hoy. Al guardar, limpia la selección para subir otra captura.
- Si la foto no se puede leer, se conserva para reintentar o reemplazarla por una captura más clara. **Editar trayecto** permite cambiar solo ida/ida y vuelta con **Guardar cambios**, o sustituir la foto para volver a analizarla.
- Se calcula `millas = km / 1.609344 × factor` y `pago MXN = redondear(millas × 10, 2)`, sin redondear primero la distancia. El factor es 1 para solo ida y 2 para ida y vuelta; los kilómetros de la captura se conservan sin duplicar. Los registros anteriores siguen siendo de solo ida.
- Los trayectos se guardan junto con los tickets y tienen filtro **MILLAS** y edición propia.
- Excel conserva sus columnas existentes y agrega el tipo de trayecto y factor del recorrido a kilómetros, millas y tarifa; la cuenta y la codificación usan **MILLAS**. Las celdas de millas e importe incluyen fórmulas y valores calculados. El CSV también indica el tipo y factor.
- El PDF de un trayecto contiene únicamente la captura. Si falta la foto, el ZIP conserva el registro en Excel y avisa en pantalla y en `avisos.txt`; no genera un PDF vacío.
- Las fotos siguen siendo locales: exporta desde el mismo dispositivo y navegador donde las guardaste.
- Validación: `npm test` y `npm run check`.

## Cambios principales frente a la versión anterior

- OpenAI es el único proveedor.
- La API key ya no se guarda en `localStorage`; vive como secret del Worker.
- El escaneo usa un endpoint único: `/api/scan`.
- La respuesta se fuerza con JSON schema para reducir errores de parseo.
- Ticket y comprobante se comprimen antes de enviarse.
- KV guarda datos estructurados, no imágenes grandes.
- El código está separado por responsabilidades para poder mantenerlo sin romper todo el archivo.
