const categories = ['Alimentos', 'Supermercado', 'Restaurante', 'Transporte', 'Gasolina', 'Salud', 'Farmacia', 'Tecnologia', 'Electronica', 'Hogar', 'Ferreteria', 'Ropa', 'Otro'];
const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

let tickets = loadLocalTickets();
let ticketImage = null;
let voucherImage = null;
let batchQueue = [];
let batchRunning = false;

const $ = (id) => document.getElementById(id);

init();

function init() {
  $('ticket-input').addEventListener('change', (event) => loadImage(event, 'ticket'));
  $('voucher-input').addEventListener('change', (event) => loadImage(event, 'voucher'));
  $('batch-input').addEventListener('change', loadBatchImages);
  $('clear-ticket').addEventListener('click', clearTicketImage);
  $('clear-voucher').addEventListener('click', clearVoucherImage);
  $('scan-btn').addEventListener('click', scanTicket);
  $('batch-scan-btn').addEventListener('click', processBatchQueue);
  $('manual-btn').addEventListener('click', openManualDialog);
  $('save-manual').addEventListener('click', saveManualTicket);
  $('export-csv').addEventListener('click', exportCsv);
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
  loadFromCloud();
}

async function loadImage(event, kind) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    setStatus('Preparando imagen...');
    const dataUrl = await compressImage(file, 1800, 0.82);
    if (kind === 'ticket') {
      ticketImage = dataUrl;
      $('ticket-preview').src = dataUrl;
      $('ticket-preview').hidden = false;
      $('clear-ticket').hidden = false;
      $('scan-btn').disabled = false;
    } else {
      voucherImage = dataUrl;
      $('voucher-preview').src = dataUrl;
      $('voucher-preview').hidden = false;
      $('clear-voucher').hidden = false;
    }
    setStatus('Imagen lista');
  } catch (error) {
    showAlert(error.message || 'No se pudo preparar la imagen.', true);
  }
}

async function loadBatchImages(event) {
  const files = [...(event.target.files || [])];
  if (!files.length) return;

  batchQueue = files.map((file) => ({
    id: crypto.randomUUID ? crypto.randomUUID() : `batch-${Date.now()}-${Math.random()}`,
    name: file.name || 'Ticket',
    file,
    image: null,
    status: 'pendiente',
    error: null
  }));

  $('batch-scan-btn').disabled = true;
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
    $('batch-scan-btn').disabled = batchRunning || !batchQueue.length;
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

async function scanTicket() {
  if (!ticketImage) return;

  $('scan-btn').disabled = true;
  $('scan-btn').textContent = 'Analizando...';
  $('scan-result').innerHTML = '<div class="alert ok">Leyendo ticket con OpenAI...</div>';

  try {
    const response = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticketImage, voucherImage })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data?.error?.message || 'No se pudo escanear el ticket.');
    }

    const ticket = buildTicket(data.ticket);
    tickets.unshift(ticket);
    saveLocalTickets();
    await saveToCloud({ upserts: [ticket] });
    showScanResult(ticket);
    clearTicketImage(false);
    clearVoucherImage(false);
    renderAll();
    setStatus('Ticket guardado');
  } catch (error) {
    showAlert(error.message || 'Error escaneando ticket.', true);
  } finally {
    $('scan-btn').textContent = 'Analizar con OpenAI';
    $('scan-btn').disabled = !ticketImage;
  }
}

async function processBatchQueue() {
  if (!batchQueue.length || batchRunning) return;

  batchRunning = true;
  $('batch-scan-btn').disabled = true;
  $('scan-btn').disabled = true;
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

      const ticket = buildTicket(data.ticket);
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
  $('batch-scan-btn').disabled = !batchQueue.some((item) => item.status === 'pendiente' || item.status === 'error');
  $('scan-btn').disabled = !ticketImage;
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

function batchStatusLabel(item) {
  if (item.status === 'comprimiendo') return { text: 'Comprimiendo', className: 'running' };
  if (item.status === 'analizando') return { text: 'Analizando', className: 'running' };
  if (item.status === 'guardado') return { text: 'Guardado', className: 'done' };
  if (item.status === 'error') return { text: 'Error', className: 'error' };
  return { text: 'Pendiente', className: '' };
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
  $('scan-btn').disabled = true;
  if (clearResult) $('scan-result').innerHTML = '';
}

function clearVoucherImage() {
  voucherImage = null;
  $('voucher-input').value = '';
  $('voucher-preview').hidden = true;
  $('voucher-preview').removeAttribute('src');
  $('clear-voucher').hidden = true;
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
          </div>
          <div class="ticket-total">${formatCurrency(info.total)}</div>
        </div>
        ${items ? `<div class="items">${items}</div>` : ''}
        <div class="ticket-actions">
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
    });
  });
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
  saveToCloud({ upserts: [], deletes: [id] });
  renderAll();
}

function duplicateTicket(id) {
  const source = tickets.find((item) => item.id === id);
  if (!source) return;
  const copy = buildTicket(structuredClone(source.info));
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
    ['Colaborador', 'Fecha', 'Tienda', 'Categoria', 'Total', 'Moneda', 'Tarjeta', 'Notas'],
    ...tickets.map((ticket) => [
      'GOS',
      ticket.info.fecha || '',
      ticket.info.tienda || '',
      ticket.info.categoria || '',
      ticket.info.total || 0,
      ticket.info.moneda || 'MXN',
      ticket.info.tarjeta || '',
      ticket.info.notas || ''
    ])
  ];
  downloadBlob(toCsv(rows), 'tickets.csv', 'text/csv;charset=utf-8');
}

function backupJson() {
  downloadBlob(JSON.stringify(tickets, null, 2), `tickets-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
}

function clearAllTickets() {
  if (!tickets.length || !confirm('Borrar todos los tickets de este dispositivo?')) return;
  const ids = tickets.map((ticket) => ticket.id);
  tickets = [];
  saveLocalTickets();
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

function setStatus(message, isError = false) {
  $('sync-status').textContent = message;
  $('sync-status').style.color = isError ? 'var(--danger)' : 'var(--muted)';
}

function showAlert(message, isError) {
  $('scan-result').innerHTML = `<div class="alert ${isError ? 'error' : 'ok'}">${escapeHtml(message)}</div>`;
}

function formatCurrency(value) {
  return money.format(Number(value || 0));
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
