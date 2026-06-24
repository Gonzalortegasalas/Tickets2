import { exportWeeklyZip } from './exportZip.js';
import { buildCodificacion, dateForFx, numberOrZero, roundMoney } from './exportHelpers.js';

const categories = ['Alimentos', 'Supermercado', 'Restaurante', 'Transporte', 'Gasolina', 'Salud', 'Farmacia', 'Tecnologia', 'Electronica', 'Hogar', 'Ferreteria', 'Ropa', 'Otro'];
const IMAGE_DB_NAME = 'tickets2-images';
const IMAGE_STORE_NAME = 'ticketImages';
const fxRateCache = new Map();
const knownPaymentAccounts = ['3139', '6679'];

let tickets = loadLocalTickets();
let ticketImage = null;
let batchQueue = [];
let batchRunning = false;
let pairQueue = [];
let pairRunning = false;
const customPaymentEditors = new Set();

const $ = (id) => document.getElementById(id);

init();

function init() {
  $('ticket-input').addEventListener('change', loadTicketSelection);
  $('clear-ticket').addEventListener('click', clearTicketImage);
  $('scan-btn').addEventListener('click', processTicketSelection);
  $('add-pair-btn').addEventListener('click', addPair);
  $('pair-scan-btn').addEventListener('click', processPairQueue);
  $('manual-btn').addEventListener('click', openManualDialog);
  $('save-manual').addEventListener('click', saveManualTicket);
  $('export-csv').addEventListener('click', exportCsv);
  $('export-zip').addEventListener('click', exportZip);
  $('reload-cloud').addEventListener('click', loadFromCloud);
  $('backup-json').addEventListener('click', backupJson);
  $('clear-all').addEventListener('click', clearAllTickets);

  document.querySelectorAll('.tab').forEach((button) => {
    button.addEventListener('click', () => switchView(button.dataset.view));
  });

  $('manual-category').innerHTML = categories.map((category) => `<option value="${category}">${category}</option>`).join('');
  $('manual-category').value = 'Restaurante';
  $('manual-date').valueAsDate = new Date();

  renderAll();
  addPair();
  ensureTicketsInMxn({ persist: true });
  loadFromCloud();
}

async function loadTicketSelection(event) {
  const files = [...(event.target.files || [])];
  if (!files.length) return;

  try {
    if (files.length === 1) {
      await loadSingleTicketImage(files[0]);
      return;
    }

    await loadBatchImages(files);
  } catch (error) {
    showAlert(error.message || 'No se pudo preparar la imagen.', true);
  }
}

async function loadSingleTicketImage(file) {
  resetBatchQueue();
  setStatus('Preparando imagen...');
  ticketImage = await compressImage(file, 1800, 0.82);
  $('ticket-preview').src = ticketImage;
  $('ticket-preview').hidden = false;
  $('clear-ticket').hidden = false;
  updateTicketActionButton();
  setStatus('Ticket listo para analizar');
}

async function loadBatchImages(files) {
  ticketImage = null;
  $('ticket-preview').hidden = true;
  $('ticket-preview').removeAttribute('src');
  batchQueue = files.map((file) => ({
    id: crypto.randomUUID ? crypto.randomUUID() : `batch-${Date.now()}-${Math.random()}`,
    name: file.name || 'Ticket',
    file,
    image: null,
    status: 'pendiente',
    error: null
  }));

  $('clear-ticket').hidden = false;
  updateTicketActionButton();
  renderBatchQueue();

  try {
    setStatus(`Preparando ${files.length} tickets...`);
    for (const item of batchQueue) {
      item.status = 'comprimiendo';
      renderBatchQueue();
      item.image = await compressImage(item.file, 1800, 0.82);
      item.file = null;
      item.status = 'pendiente';
      renderBatchQueue();
    }
    updateTicketActionButton();
    setStatus(`${batchQueue.length} tickets listos para analizar`);
  } catch (error) {
    setStatus('No se pudo preparar el lote', true);
    showAlert(error.message || 'No se pudieron preparar las imágenes.', true);
  }
}

function compressImage(file, maxEdge, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('No se pudo leer la imagen.'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('La imagen no se pudo abrir.'));
      image.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function processTicketSelection() {
  if (batchQueue.length) {
    await processBatchQueue();
    return;
  }
  await scanTicket();
}

async function scanTicket() {
  if (!ticketImage) return;

  $('scan-btn').disabled = true;
  $('scan-btn').textContent = 'Analizando...';
  $('scan-result').innerHTML = '<div class="alert ok">Leyendo ticket con OpenAI...</div>';

  try {
    const response = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticketImage, voucherImage: null })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'No se pudo escanear el ticket.');
    }

    const info = await convertInfoToMxn(data.ticket);
    const ticket = buildTicket(info);
    await storeTicketImages(ticket.id, { ticketImage, voucherImage: null });
    tickets.unshift(ticket);
    saveLocalTickets();
    await saveToCloud({ upserts: [ticket] });
    showScanResult(ticket);
    clearTicketImage(false);
    renderAll();
    setStatus('Ticket guardado');
  } catch (error) {
    showAlert(error.message || 'Error escaneando ticket.', true);
  } finally {
    updateTicketActionButton();
  }
}

async function processBatchQueue() {
  if (!batchQueue.length || batchRunning) return;

  batchRunning = true;
  $('scan-btn').disabled = true;
  $('scan-btn').textContent = 'Analizando...';
  $('scan-result').innerHTML = '<div class="alert ok">Analizando lote de tickets...</div>';

  let saved = 0;
  let failed = 0;

  for (const item of batchQueue) {
    if (!item.image || item.status === 'guardado') continue;

    item.status = 'analizando';
    item.error = null;
    renderBatchQueue();
    setStatus(`Analizando ${saved + failed + 1} de ${batchQueue.length}...`);

    try {
      const response = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketImage: item.image, voucherImage: null })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data?.error?.message || 'No se pudo escanear este ticket.');
      }

      const info = await convertInfoToMxn(data.ticket);
      const ticket = buildTicket(info);
      await storeTicketImages(ticket.id, { ticketImage: item.image, voucherImage: null });
      tickets.unshift(ticket);
      saveLocalTickets();
      await saveToCloud({ upserts: [ticket] });
      item.status = 'guardado';
      item.ticketId = ticket.id;
      saved += 1;
    } catch (error) {
      item.status = 'error';
      item.error = error.message || 'Error';
      failed += 1;
    }

    renderBatchQueue();
    renderAll();
  }

  batchRunning = false;
  updateTicketActionButton();
  $('scan-result').innerHTML = `<div class="alert ${failed ? 'error' : 'ok'}">Lote terminado: ${saved} guardados, ${failed} con error.</div>`;
  setStatus(`Lote terminado: ${saved} guardados, ${failed} con error`, Boolean(failed));
}

function renderBatchQueue() {
  const list = $('batch-list');
  if (!batchQueue.length) {
    list.hidden = true;
    list.innerHTML = '';
    return;
  }

  list.hidden = false;
  list.innerHTML = batchQueue.map((item) => {
    const label = batchStatusLabel(item);
    return `
      <div class="batch-item">
        <span class="batch-name">${escapeHtml(item.name)}</span>
        <span class="batch-status ${label.className}" title="${escapeHtml(item.error || label.text)}">${escapeHtml(label.text)}</span>
      </div>
    `;
  }).join('');
}

function updateTicketActionButton() {
  if (batchRunning) {
    $('scan-btn').disabled = true;
    $('scan-btn').textContent = 'Analizando...';
    return;
  }

  if (batchQueue.length) {
    const hasPending = batchQueue.some((item) => item.image && item.status !== 'guardado');
    $('scan-btn').textContent = batchQueue.length === 1 ? 'Analizar un ticket' : 'Analizar varios tickets';
    $('scan-btn').disabled = !hasPending;
    return;
  }

  $('scan-btn').textContent = 'Analizar un ticket';
  $('scan-btn').disabled = !ticketImage;
}

function resetBatchQueue() {
  batchQueue = [];
  renderBatchQueue();
}

function batchStatusLabel(item) {
  if (item.status === 'comprimiendo') return { text: 'Comprimiendo', className: 'running' };
  if (item.status === 'analizando') return { text: 'Analizando', className: 'running' };
  if (item.status === 'guardado') return { text: 'Guardado', className: 'done' };
  if (item.status === 'error') return { text: 'Error', className: 'error' };
  return { text: 'Pendiente', className: '' };
}

function addPair() {
  pairQueue.push({
    id: crypto.randomUUID ? crypto.randomUUID() : `pair-${Date.now()}-${Math.random()}`,
    ticketImage: null,
    voucherImage: null,
    ticketName: '',
    voucherName: '',
    status: 'pendiente',
    error: null
  });
  renderPairQueue();
}

async function loadPairImage(event, pairId, kind) {
  const file = event.target.files?.[0];
  if (!file) return;

  const pair = pairQueue.find((item) => item.id === pairId);
  if (!pair) return;

  try {
    pair.status = 'comprimiendo';
    pair.error = null;
    renderPairQueue();
    const dataUrl = await compressImage(file, 1800, 0.82);
    if (kind === 'ticket') {
      pair.ticketImage = dataUrl;
      pair.ticketName = file.name || 'Ticket';
    } else {
      pair.voucherImage = dataUrl;
      pair.voucherName = file.name || 'Comprobante';
    }
    pair.status = pairReady(pair) ? 'listo' : 'pendiente';
    renderPairQueue();
  } catch (error) {
    pair.status = 'error';
    pair.error = error.message || 'No se pudo preparar la imagen.';
    renderPairQueue();
  }
}

async function processPairQueue() {
  const readyPairs = pairQueue.filter((pair) => pairReady(pair) && pair.status !== 'guardado');
  if (!readyPairs.length || pairRunning) return;

  pairRunning = true;
  $('pair-scan-btn').disabled = true;
  $('scan-btn').disabled = true;
  $('scan-result').innerHTML = '<div class="alert ok">Analizando pares ticket + comprobante...</div>';

  let saved = 0;
  let failed = 0;

  for (const pair of readyPairs) {
    pair.status = 'analizando';
    pair.error = null;
    renderPairQueue();
    setStatus(`Analizando par ${saved + failed + 1} de ${readyPairs.length}...`);

    try {
      const response = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketImage: pair.ticketImage, voucherImage: pair.voucherImage })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data?.error?.message || 'No se pudo escanear este par.');
      }

      const info = await convertInfoToMxn(data.ticket);
      const ticket = buildTicket(info);
      await storeTicketImages(ticket.id, { ticketImage: pair.ticketImage, voucherImage: pair.voucherImage });
      tickets.unshift(ticket);
      saveLocalTickets();
      await saveToCloud({ upserts: [ticket] });
      pair.status = 'guardado';
      pair.ticketId = ticket.id;
      saved += 1;
    } catch (error) {
      pair.status = 'error';
      pair.error = error.message || 'Error';
      failed += 1;
    }

    renderPairQueue();
    renderAll();
  }

  pairRunning = false;
  updateTicketActionButton();
  renderPairQueue();
  $('scan-result').innerHTML = `<div class="alert ${failed ? 'error' : 'ok'}">Pares terminados: ${saved} guardados, ${failed} con error.</div>`;
  setStatus(`Pares terminados: ${saved} guardados, ${failed} con error`, Boolean(failed));
}

function removePair(pairId) {
  pairQueue = pairQueue.filter((pair) => pair.id !== pairId);
  if (!pairQueue.length) addPair();
  else renderPairQueue();
}

function renderPairQueue() {
  const list = $('pair-list');
  list.innerHTML = pairQueue.map((pair, index) => {
    const label = pairStatusLabel(pair);
    return `
      <div class="pair-item">
        <div class="pair-head">
          <strong>Par ${index + 1}</strong>
          <button class="mini-btn danger" data-pair-remove="${pair.id}" type="button">Quitar</button>
        </div>
        <div class="pair-grid">
          <label class="pair-picker">
            <input data-pair-input="${pair.id}" data-kind="ticket" type="file" accept="image/*">
            <span>Ticket</span>
            <small>${escapeHtml(pair.ticketName || 'Seleccionar foto')}</small>
          </label>
          <label class="pair-picker">
            <input data-pair-input="${pair.id}" data-kind="voucher" type="file" accept="image/*">
            <span>Comprobante</span>
            <small>${escapeHtml(pair.voucherName || 'Seleccionar foto')}</small>
          </label>
        </div>
        <div class="pair-status ${label.className}" title="${escapeHtml(pair.error || label.text)}">${escapeHtml(label.text)}</div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('input[data-pair-input]').forEach((input) => {
    input.addEventListener('change', (event) => loadPairImage(event, input.dataset.pairInput, input.dataset.kind));
  });
  list.querySelectorAll('button[data-pair-remove]').forEach((button) => {
    button.addEventListener('click', () => removePair(button.dataset.pairRemove));
  });

  $('pair-scan-btn').disabled = pairRunning || !pairQueue.some((pair) => pairReady(pair) && pair.status !== 'guardado');
}

function pairReady(pair) {
  return Boolean(pair.ticketImage && pair.voucherImage);
}

function pairStatusLabel(pair) {
  if (pair.status === 'comprimiendo') return { text: 'Comprimiendo', className: 'running' };
  if (pair.status === 'analizando') return { text: 'Analizando', className: 'running' };
  if (pair.status === 'guardado') return { text: 'Guardado', className: 'done' };
  if (pair.status === 'error') return { text: pair.error || 'Error', className: 'error' };
  if (!pair.ticketImage && !pair.voucherImage) return { text: 'Faltan ticket y comprobante', className: '' };
  if (!pair.ticketImage) return { text: 'Falta ticket', className: '' };
  if (!pair.voucherImage) return { text: 'Falta comprobante', className: '' };
  return { text: 'Listo', className: 'done' };
}

function buildTicket(info) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : `ticket-${Date.now()}`,
    info,
    savedAt: now,
    updatedAt: now
  };
}

function showScanResult(ticket) {
  const info = ticket.info;
  $('scan-result').innerHTML = `
    <article class="ticket-card">
      <div class="ticket-row">
        <div>
          <h3 class="ticket-title">${escapeHtml(info.tienda || 'Comercio')}</h3>
          <p class="ticket-meta">${escapeHtml(info.categoria || 'Otro')} · ${escapeHtml(info.fecha || 'Sin fecha')}</p>
        </div>
        <div class="ticket-total">${formatCurrency(info.total)}</div>
      </div>
      ${info.notas ? `<p class="ticket-meta">${escapeHtml(info.notas)}</p>` : ''}
      <div class="alert ok">Guardado correctamente</div>
    </article>`;
}

function clearTicketImage(clearResult = true) {
  ticketImage = null;
  $('ticket-input').value = '';
  $('ticket-preview').hidden = true;
  $('ticket-preview').removeAttribute('src');
  $('clear-ticket').hidden = true;
  resetBatchQueue();
  updateTicketActionButton();
  if (clearResult) $('scan-result').innerHTML = '';
}

function renderAll() {
  renderTickets();
  renderSummary();
}

function renderTickets() {
  const list = $('tickets-list');
  if (!tickets.length) {
    list.innerHTML = '<div class="empty">Escanea o registra tu primer ticket.</div>';
    return;
  }

  list.innerHTML = tickets.map((ticket) => {
    const info = ticket.info;
    const paymentValue = paymentSelectValue(ticket);
    const customValue = paymentDigits(info.tarjeta);
    const currencyValue = currencySelectValue(info);
    const conversionMeta = info.moneda_original ? `Original: ${info.moneda_original} ${numberOrZero(info.total_original).toFixed(2)}${info.tipo_cambio ? ` · TC ${info.tipo_cambio}` : ''}` : '';
    const items = (info.items || []).slice(0, 8).map((item) => `
      <div class="item">
        <span>${escapeHtml(item.nombre || 'Producto')}</span>
        <span>${formatCurrency(item.precio)}</span>
      </div>
    `).join('');

    return `
      <article class="ticket-card">
        <div class="ticket-row">
          <div>
            <h3 class="ticket-title">${escapeHtml(info.tienda || 'Comercio')}</h3>
            <p class="ticket-meta">${escapeHtml(info.categoria || 'Otro')} · ${escapeHtml(info.fecha || 'Sin fecha')} ${info.tarjeta ? `· ${escapeHtml(info.tarjeta)}` : ''}</p>
            ${conversionMeta ? `<p class="ticket-meta">${escapeHtml(conversionMeta)}</p>` : ''}
          </div>
          <div class="ticket-total">${formatCurrency(info.total)}</div>
        </div>
        ${items ? `<div class="items">${items}</div>` : ''}
        <div class="ticket-actions">
          <div class="payment-control">
            <label>
              <span>Cuenta</span>
              <select data-action="payment-select" data-id="${ticket.id}">
                <option value="cash" ${paymentValue === 'cash' ? 'selected' : ''}>Efectivo</option>
                <option value="3139" ${paymentValue === '3139' ? 'selected' : ''}>3139</option>
                <option value="6679" ${paymentValue === '6679' ? 'selected' : ''}>6679</option>
                <option value="other" ${paymentValue === 'other' ? 'selected' : ''}>Otro...</option>
              </select>
            </label>
            ${paymentValue === 'other' ? `
              <input class="payment-input" data-payment-input="${ticket.id}" type="text" inputmode="numeric" maxlength="4" placeholder="4 dígitos" value="${escapeHtml(customValue)}">
              <button class="mini-btn" data-action="payment-save" data-id="${ticket.id}" type="button">Guardar</button>
            ` : ''}
          </div>
          <label class="currency-control">
            <span>Moneda del monto</span>
            <select data-action="currency-select" data-id="${ticket.id}">
              <option value="MXN" ${currencyValue === 'MXN' ? 'selected' : ''}>MXN</option>
              <option value="EUR" ${currencyValue === 'EUR' ? 'selected' : ''}>EUR</option>
            </select>
          </label>
          <button class="mini-btn" data-action="duplicate" data-id="${ticket.id}" type="button">Duplicar</button>
          <button class="mini-btn danger" data-action="delete" data-id="${ticket.id}" type="button">Eliminar</button>
        </div>
      </article>
    `;
  }).join('');

  list.querySelectorAll('button[data-action]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.action === 'delete') deleteTicket(button.dataset.id);
      if (button.dataset.action === 'duplicate') duplicateTicket(button.dataset.id);
      if (button.dataset.action === 'payment-save') saveCustomPayment(button.dataset.id);
    });
  });

  list.querySelectorAll('select[data-action="payment-select"]').forEach((select) => {
    select.addEventListener('change', () => handlePaymentSelect(select.dataset.id, select.value));
  });

  list.querySelectorAll('select[data-action="currency-select"]').forEach((select) => {
    select.addEventListener('change', () => handleCurrencySelect(select.dataset.id, select.value));
  });

  list.querySelectorAll('input[data-payment-input]').forEach((input) => {
    input.addEventListener('input', () => {
      input.value = paymentDigits(input.value);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') saveCustomPayment(input.dataset.paymentInput);
    });
  });
}

function paymentSelectValue(ticket) {
  if (customPaymentEditors.has(ticket.id)) return 'other';
  const digits = paymentDigits(ticket.info.tarjeta);
  if (!digits) return 'cash';
  return knownPaymentAccounts.includes(digits) ? digits : 'other';
}

function paymentDigits(value) {
  return String(value || '').replace(/\D/g, '').slice(-4);
}

function handlePaymentSelect(id, value) {
  if (value === 'other') {
    customPaymentEditors.add(id);
    renderTickets();
    return;
  }

  customPaymentEditors.delete(id);
  updateTicketPayment(id, value === 'cash' ? null : value);
}

function saveCustomPayment(id) {
  const input = [...document.querySelectorAll('input[data-payment-input]')].find((element) => element.dataset.paymentInput === id);
  const digits = paymentDigits(input?.value);
  if (digits.length !== 4) {
    showAlert('Ingresa 4 dígitos para la cuenta.', true);
    input?.focus();
    return;
  }

  customPaymentEditors.delete(id);
  updateTicketPayment(id, digits);
}

function updateTicketPayment(id, account) {
  const ticket = tickets.find((item) => item.id === id);
  if (!ticket) return;

  ticket.info.tarjeta = account || null;
  ticket.updatedAt = new Date().toISOString();
  saveLocalTickets();
  saveToCloud({ upserts: [ticket] });
  renderAll();
  setStatus(account ? `Cuenta actualizada a ${account}` : 'Cuenta actualizada a efectivo');
}

function currencySelectValue(info) {
  const original = String(info.moneda_original || '').toUpperCase();
  if (original === 'EUR') return 'EUR';
  return 'MXN';
}

async function handleCurrencySelect(id, currency) {
  const ticket = tickets.find((item) => item.id === id);
  if (!ticket) return;

  try {
    setStatus(`Corrigiendo moneda a ${currency}...`);
    ticket.info = currency === 'EUR'
      ? await convertCurrentTicketFromCurrency(ticket.info, 'EUR')
      : normalizeTicketAsMxn(ticket.info);
    ticket.updatedAt = new Date().toISOString();
    saveLocalTickets();
    await saveToCloud({ upserts: [ticket] });
    renderAll();
    setStatus(currency === 'EUR' ? 'Ticket convertido de EUR a MXN' : 'Ticket marcado como MXN');
  } catch (error) {
    showAlert(error.message || 'No se pudo corregir la moneda.', true);
    renderTickets();
  }
}

async function convertCurrentTicketFromCurrency(info, currency) {
  const date = dateForFx(info.fecha);
  const fx = await getHistoricalRate(currency, date);
  const original = snapshotCurrentAmounts(info);
  const converted = scaleTicketAmounts(info, fx.rate);

  converted.moneda = 'MXN';
  converted.moneda_original = currency;
  converted.total_original = original.total;
  converted.tipo_cambio = fx.rate;
  converted.fecha_tipo_cambio = fx.date || date;
  converted.fuente_tipo_cambio = fx.source || 'frankfurter';
  converted.notas = appendUniqueNote(
    converted.notas,
    `Corregido manualmente: monto original ${currency} ${original.total.toFixed(2)} convertido a MXN con TC ${fx.rate} (${converted.fecha_tipo_cambio})`
  );

  return converted;
}

function normalizeTicketAsMxn(info) {
  const originalTotal = numberOrZero(info.total_original);
  let normalized = { ...info };

  if (originalTotal > 0 && numberOrZero(info.total) > 0) {
    normalized = scaleTicketAmounts(info, originalTotal / numberOrZero(info.total));
  }

  normalized.moneda = 'MXN';
  normalized.moneda_original = null;
  normalized.total_original = 0;
  normalized.tipo_cambio = null;
  normalized.fecha_tipo_cambio = null;
  normalized.fuente_tipo_cambio = null;
  normalized.notas = appendUniqueNote(normalized.notas, 'Corregido manualmente: monto marcado como MXN');
  return normalized;
}

function snapshotCurrentAmounts(info) {
  return {
    total: numberOrZero(info.total),
    subtotal: numberOrZero(info.subtotal),
    impuestos: numberOrZero(info.impuestos),
    total_ticket: numberOrZero(info.total_ticket),
    total_comprobante: numberOrZero(info.total_comprobante),
    propina: numberOrZero(info.propina)
  };
}

function scaleTicketAmounts(info, factor) {
  const scaled = {
    ...info,
    total: roundMoney(numberOrZero(info.total) * factor),
    subtotal: roundMoney(numberOrZero(info.subtotal) * factor),
    impuestos: roundMoney(numberOrZero(info.impuestos) * factor),
    total_ticket: roundMoney(numberOrZero(info.total_ticket) * factor),
    total_comprobante: roundMoney(numberOrZero(info.total_comprobante) * factor),
    propina: roundMoney(numberOrZero(info.propina) * factor)
  };

  if (Array.isArray(info.items)) {
    scaled.items = info.items.map((item) => ({
      ...item,
      precio: roundMoney(numberOrZero(item.precio) * factor)
    }));
  }

  return scaled;
}

function renderSummary() {
  const total = tickets.reduce((sum, ticket) => sum + Number(ticket.info.total || 0), 0);
  const byCategory = new Map();
  tickets.forEach((ticket) => {
    const category = ticket.info.categoria || 'Otro';
    byCategory.set(category, (byCategory.get(category) || 0) + Number(ticket.info.total || 0));
  });

  $('stat-count').textContent = String(tickets.length);
  $('stat-total').textContent = formatCurrency(total);
  $('stat-categories').textContent = String(byCategory.size);
  $('stat-average').textContent = formatCurrency(tickets.length ? total / tickets.length : 0);

  const bars = $('category-bars');
  if (!byCategory.size) {
    bars.innerHTML = '<div class="empty">Guarda tickets para ver estadísticas.</div>';
    return;
  }

  const max = Math.max(...byCategory.values());
  bars.innerHTML = `<div class="bar-card">${
    [...byCategory.entries()].sort((a, b) => b[1] - a[1]).map(([category, value]) => `
      <div class="bar-line">
        <div class="bar-label"><span>${escapeHtml(category)}</span><strong>${formatCurrency(value)}</strong></div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.round((value / max) * 100)}%"></div></div>
      </div>
    `).join('')
  }</div>`;
}

async function loadFromCloud() {
  try {
    setStatus('Sincronizando...');
    const response = await fetch('/kv/load');
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data?.error?.message || 'No se pudo cargar Cloudflare KV.');
    if (data.configured && Array.isArray(data.tickets)) {
      const merged = new Map(tickets.map((ticket) => [ticket.id, ticket]));
      data.tickets.forEach((ticket) => merged.set(ticket.id, ticket));
      tickets = [...merged.values()].sort((a, b) => new Date(b.savedAt || 0) - new Date(a.savedAt || 0));
      await ensureTicketsInMxn();
      saveLocalTickets();
      renderAll();
      setStatus('Sincronizado con Cloudflare');
    } else {
      setStatus('Modo local: KV no configurado');
    }
  } catch (error) {
    setStatus('Modo local: Cloudflare no respondió', true);
  }
}

async function saveToCloud(patch) {
  try {
    const response = await fetch('/kv/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data?.error?.message || 'No se pudo guardar en KV.');
    setStatus('Guardado en Cloudflare');
  } catch {
    setStatus('Guardado localmente', true);
  }
}

function deleteTicket(id) {
  const ticket = tickets.find((item) => item.id === id);
  if (!ticket || !confirm(`Eliminar ticket de ${ticket.info.tienda || 'este comercio'}?`)) return;
  tickets = tickets.filter((item) => item.id !== id);
  saveLocalTickets();
  deleteTicketImages(id);
  saveToCloud({ upserts: [], deletes: [id] });
  renderAll();
}

async function duplicateTicket(id) {
  const source = tickets.find((item) => item.id === id);
  if (!source) return;
  const copy = buildTicket(structuredClone(source.info));
  const sourceImages = await getTicketImages(id);
  if (sourceImages) await storeTicketImages(copy.id, sourceImages);
  tickets.unshift(copy);
  saveLocalTickets();
  saveToCloud({ upserts: [copy] });
  renderAll();
}

function openManualDialog() {
  $('manual-store').value = '';
  $('manual-total').value = '';
  $('manual-card').value = '';
  $('manual-date').valueAsDate = new Date();
  $('manual-dialog').showModal();
}

function saveManualTicket() {
  const total = Number($('manual-total').value);
  if (!Number.isFinite(total) || total < 0) {
    showAlert('Ingresa un total válido.', true);
    return;
  }

  const info = {
    tienda: $('manual-store').value.trim() || 'Comercio',
    fecha: isoToDisplayDate($('manual-date').value),
    hora: null,
    categoria: $('manual-category').value || 'Otro',
    items: [],
    subtotal: total,
    impuestos: 0,
    total,
    total_ticket: total,
    total_comprobante: 0,
    propina: 0,
    fuente_total: 'ticket',
    moneda: 'MXN',
    moneda_original: null,
    total_original: 0,
    tarjeta: $('manual-card').value.trim() || null,
    direccion: null,
    notas: 'Capturado manualmente',
    confianza: 1
  };

  const ticket = buildTicket(info);
  tickets.unshift(ticket);
  saveLocalTickets();
  saveToCloud({ upserts: [ticket] });
  $('manual-dialog').close();
  renderAll();
  showAlert('Ticket manual guardado.', false);
}

function switchView(view) {
  document.querySelectorAll('.view').forEach((section) => section.classList.toggle('active', section.id === `view-${view}`));
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  const titles = { scan: 'Escanear Ticket', tickets: 'Mis Tickets', summary: 'Resumen', settings: 'Configuración' };
  $('page-title').textContent = titles[view] || 'Tickets IA';
  renderAll();
}

function exportCsv() {
  if (!tickets.length) return;
  const rows = [
    ['Colaborador', 'Fecha', 'Tienda', 'Categoria', 'Total MXN', 'Moneda', 'Tarjeta', 'Codificacion', 'Total ticket', 'Total comprobante', 'Propina', 'Fuente total', 'Notas'],
    ...tickets.map((ticket) => [
      'GOS',
      ticket.info.fecha || '',
      ticket.info.tienda || '',
      ticket.info.categoria || '',
      ticket.info.total || 0,
      ticket.info.moneda || 'MXN',
      ticket.info.tarjeta || '',
      buildCodificacion(ticket.info),
      ticket.info.total_ticket || '',
      ticket.info.total_comprobante || '',
      ticket.info.propina || '',
      ticket.info.fuente_total || '',
      ticket.info.notas || ''
    ])
  ];
  downloadBlob(toCsv(rows), 'tickets.csv', 'text/csv;charset=utf-8');
}

async function exportZip() {
  if (!tickets.length) return;
  const button = $('export-zip');
  button.disabled = true;
  button.textContent = 'Generando ZIP...';
  setStatus('Generando ZIP semanal...');

  try {
    await exportWeeklyZip(tickets, getTicketImages);
    setStatus('ZIP generado');
  } catch (error) {
    showAlert(error.message || 'No se pudo generar el ZIP.', true);
    setStatus('No se pudo generar el ZIP', true);
  } finally {
    button.disabled = false;
    button.textContent = 'Exportar ZIP semanal';
  }
}

function backupJson() {
  downloadBlob(JSON.stringify(tickets, null, 2), `tickets-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
}

function clearAllTickets() {
  if (!tickets.length || !confirm('Borrar todos los tickets de este dispositivo?')) return;
  const ids = tickets.map((ticket) => ticket.id);
  tickets = [];
  saveLocalTickets();
  clearAllTicketImages();
  saveToCloud({ upserts: [], deletes: ids });
  renderAll();
}

function toCsv(rows) {
  return rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\n');
}

function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

function loadLocalTickets() {
  try {
    const parsed = JSON.parse(localStorage.getItem('tickets_v3') || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLocalTickets() {
  localStorage.setItem('tickets_v3', JSON.stringify(tickets));
}

async function ensureTicketsInMxn({ persist = false } = {}) {
  let changed = false;

  for (const ticket of tickets) {
    try {
      const before = JSON.stringify(ticket.info);
      ticket.info = await convertInfoToMxn(ticket.info);
      if (JSON.stringify(ticket.info) !== before) {
        ticket.updatedAt = new Date().toISOString();
        changed = true;
      }
    } catch (error) {
      console.warn('No se pudo convertir ticket a MXN:', error);
    }
  }

  if (changed) {
    tickets = tickets.sort((a, b) => new Date(b.savedAt || 0) - new Date(a.savedAt || 0));
    saveLocalTickets();
    renderAll();
    if (persist) saveToCloud({ upserts: tickets });
  }
}

async function convertInfoToMxn(info) {
  if (info.moneda === 'MXN') {
    return { ...info, moneda: 'MXN' };
  }

  const sourceCurrency = getSourceCurrency(info);
  if (sourceCurrency === 'MXN') {
    return { ...info, moneda: 'MXN' };
  }

  const date = dateForFx(info.fecha);
  const fx = await getHistoricalRate(sourceCurrency, date);
  const originalTotal = numberOrZero(info.total_original) || numberOrZero(info.total);
  const converted = {
    ...info,
    moneda: 'MXN',
    moneda_original: info.moneda_original || sourceCurrency,
    total_original: originalTotal,
    total: roundMoney(originalTotal * fx.rate),
    subtotal: roundMoney(numberOrZero(info.subtotal) * fx.rate),
    impuestos: roundMoney(numberOrZero(info.impuestos) * fx.rate),
    total_ticket: roundMoney(numberOrZero(info.total_ticket) * fx.rate),
    total_comprobante: roundMoney(numberOrZero(info.total_comprobante) * fx.rate),
    propina: roundMoney(numberOrZero(info.propina) * fx.rate),
    tipo_cambio: fx.rate,
    fecha_tipo_cambio: fx.date || date,
    fuente_tipo_cambio: fx.source || 'frankfurter'
  };

  if (Array.isArray(info.items)) {
    converted.items = info.items.map((item) => ({
      ...item,
      precio: roundMoney(numberOrZero(item.precio) * fx.rate)
    }));
  }

  converted.notas = appendUniqueNote(
    converted.notas,
    `Convertido a MXN desde ${sourceCurrency} con TC ${fx.rate} (${converted.fecha_tipo_cambio})`
  );

  return converted;
}

function getSourceCurrency(info) {
  if (info.moneda && info.moneda !== 'MXN') {
    const currency = String(info.moneda).toUpperCase();
    return /^[A-Z]{3}$/.test(currency) ? currency : 'MXN';
  }
  if (info.moneda_original && info.moneda_original !== 'MXN') {
    const currency = String(info.moneda_original).toUpperCase();
    return /^[A-Z]{3}$/.test(currency) ? currency : 'MXN';
  }
  return 'MXN';
}

async function getHistoricalRate(currency, date) {
  const key = `${currency}:${date}`;
  if (fxRateCache.has(key)) return fxRateCache.get(key);

  const response = await fetch(`/fx/${currency}/${date}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.rate) {
    throw new Error(`No se pudo convertir ${currency} a MXN para ${date}.`);
  }

  fxRateCache.set(key, data);
  return data;
}

function appendUniqueNote(notes, note) {
  if (notes && notes.includes(note)) return notes;
  return notes ? `${notes} | ${note}` : note;
}

function openImageDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IMAGE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(IMAGE_STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('No se pudo abrir IndexedDB.'));
  });
}

async function storeTicketImages(id, images) {
  const db = await openImageDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_STORE_NAME, 'readwrite');
    tx.objectStore(IMAGE_STORE_NAME).put({
      id,
      ticketImage: images.ticketImage || null,
      voucherImage: images.voucherImage || null,
      savedAt: new Date().toISOString()
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('No se pudo guardar la imagen local.'));
  });
}

async function getTicketImages(id) {
  const db = await openImageDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_STORE_NAME, 'readonly');
    const request = tx.objectStore(IMAGE_STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('No se pudo leer la imagen local.'));
  });
}

async function deleteTicketImages(id) {
  const db = await openImageDb();
  return new Promise((resolve) => {
    const tx = db.transaction(IMAGE_STORE_NAME, 'readwrite');
    tx.objectStore(IMAGE_STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function clearAllTicketImages() {
  const db = await openImageDb();
  return new Promise((resolve) => {
    const tx = db.transaction(IMAGE_STORE_NAME, 'readwrite');
    tx.objectStore(IMAGE_STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

function setStatus(message, isError = false) {
  $('sync-status').textContent = message;
  $('sync-status').style.color = isError ? 'var(--danger)' : 'var(--muted)';
}

function showAlert(message, isError) {
  $('scan-result').innerHTML = `<div class="alert ${isError ? 'error' : 'ok'}">${escapeHtml(message)}</div>`;
}

function formatCurrency(value) {
  return `MXN$ ${numberOrZero(value).toFixed(2)}`;
}

function isoToDisplayDate(iso) {
  if (!iso) return null;
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
