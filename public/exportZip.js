export async function exportWeeklyZip(tickets, getTicketImages) {
  if (!tickets.length) throw new Error('No hay tickets para exportar.');

  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');

  const exportTickets = await prepareTicketsForMxnExport(tickets);
  const zip = new window.JSZip();
  const weeks = groupTicketsByWeek(exportTickets);

  for (const [weekFolder, weekTickets] of weeks) {
    const weekZip = zip.folder(weekFolder);

    for (const ticket of weekTickets) {
      const codificacion = buildCodificacion(ticket.exportInfo);
      const ticketFolder = weekZip.folder(sanitizeFolderName(codificacion));
      const images = await getTicketImages(ticket.id);
      const pdfBlob = await buildTicketPdf(ticket.exportInfo, images);
      ticketFolder.file('ticket.pdf', pdfBlob);
    }
  }

  const workbook = buildWorkbook(exportTickets);
  const excelArrayBuffer = window.XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  zip.file('gastos_GOS.xlsx', excelArrayBuffer);

  const blob = await zip.generateAsync({ type: 'blob' });
  const today = new Date().toISOString().slice(0, 10);
  downloadBlob(blob, `Tickets_GOS_${today}.zip`);
}

async function prepareTicketsForMxnExport(tickets) {
  const rateCache = new Map();

  return Promise.all(tickets.map(async (ticket) => {
    const exportInfo = { ...ticket.info };
    const sourceCurrency = getOriginalCurrency(ticket.info);
    const sourceAmount = getOriginalAmount(ticket.info, sourceCurrency);

    if (sourceCurrency === 'MXN') {
      exportInfo.moneda = 'MXN';
      exportInfo.total = roundMoney(numberOrZero(ticket.info.total || sourceAmount));
      exportInfo.moneda_original = ticket.info.moneda_original || null;
      exportInfo.total_original = numberOrZero(ticket.info.total_original || 0);
      return { ...ticket, exportInfo };
    }

    const date = dateForFx(ticket.info.fecha);
    const cacheKey = `${sourceCurrency}:${date}`;
    let fx = rateCache.get(cacheKey);
    if (!fx) {
      fx = await fetchHistoricalRate(sourceCurrency, date);
      rateCache.set(cacheKey, fx);
    }

    const totalMxn = roundMoney(sourceAmount * fx.rate);
    exportInfo.moneda = 'MXN';
    exportInfo.total = totalMxn;
    exportInfo.moneda_original = sourceCurrency;
    exportInfo.total_original = sourceAmount;
    exportInfo.tipo_cambio = fx.rate;
    exportInfo.fecha_tipo_cambio = fx.date || date;
    exportInfo.fuente_tipo_cambio = fx.source || 'frankfurter';
    exportInfo.notas = appendNote(
      exportInfo.notas,
      `Exportado en MXN con TC ${sourceCurrency}/MXN ${fx.rate} (${exportInfo.fecha_tipo_cambio})`
    );

    return { ...ticket, exportInfo };
  }));
}

function groupTicketsByWeek(tickets) {
  const weeks = new Map();
  for (const ticket of tickets) {
    const date = parseFechaToDate(ticket.exportInfo.fecha, ticket.savedAt);
    const monday = getMonday(date);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const key = `Tickets_${fmtDate(monday)}_al_${fmtDate(sunday)}`;
    if (!weeks.has(key)) weeks.set(key, []);
    weeks.get(key).push(ticket);
  }
  return weeks;
}

async function buildTicketPdf(info, images) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const width = doc.internal.pageSize.width;
  let y = 16;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text(info.tienda || 'Ticket', width / 2, y, { align: 'center' });
  y += 8;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(`${info.fecha || 'Sin fecha'} ${info.hora || ''} · ${info.categoria || 'Otro'}`, width / 2, y, { align: 'center' });
  y += 8;

  if (images?.ticketImage) {
    y = addImage(doc, images.ticketImage, 10, y, width - 20, 125) + 8;
  } else {
    doc.setTextColor(110, 117, 111);
    doc.text('Sin imagen local guardada para este ticket.', 10, y);
    doc.setTextColor(0, 0, 0);
    y += 8;
  }

  if (images?.voucherImage) {
    doc.setFont('helvetica', 'bold');
    doc.text('Comprobante', 10, y);
    y += 5;
    y = addImage(doc, images.voucherImage, 10, y, width - 20, 70) + 8;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text('Resumen', 10, y);
  y += 7;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);

  const lines = [
    ['Colaborador', 'GOS'],
    ['Total', `MXN$ ${numberOrZero(info.total).toFixed(2)}`],
    ...(info.moneda_original ? [
      ['Original', `${info.moneda_original} ${numberOrZero(info.total_original).toFixed(2)}`],
      ['Tipo de cambio', `${info.tipo_cambio || ''} (${info.fecha_tipo_cambio || ''})`]
    ] : []),
    ['Cuenta', getCuenta(info)],
    ['Codificacion', buildCodificacion(info)]
  ];

  for (const [label, value] of lines) {
    doc.setFont('helvetica', 'bold');
    doc.text(`${label}:`, 10, y);
    doc.setFont('helvetica', 'normal');
    doc.text(String(value || ''), 42, y, { maxWidth: width - 52 });
    y += 6;
  }

  if (Array.isArray(info.items) && info.items.length) {
    y += 2;
    doc.setFont('helvetica', 'bold');
    doc.text('Productos', 10, y);
    y += 6;
    doc.setFont('helvetica', 'normal');
    for (const item of info.items.slice(0, 25)) {
      if (y > 280) {
        doc.addPage();
        y = 16;
      }
      doc.text(String(item.nombre || 'Producto'), 10, y, { maxWidth: width - 45 });
      doc.text(`$${numberOrZero(item.precio).toFixed(2)}`, width - 10, y, { align: 'right' });
      y += 5;
    }
  }

  return doc.output('blob');
}

function addImage(doc, dataUrl, x, y, maxWidth, maxHeight) {
  const props = doc.getImageProperties(dataUrl);
  const ratio = Math.min(maxWidth / props.width, maxHeight / props.height);
  const drawWidth = props.width * ratio;
  const drawHeight = props.height * ratio;
  const drawX = x + (maxWidth - drawWidth) / 2;
  const type = imageType(dataUrl);
  doc.addImage(dataUrl, type, drawX, y, drawWidth, drawHeight, undefined, 'FAST');
  return y + drawHeight;
}

function buildWorkbook(tickets) {
  const wb = window.XLSX.utils.book_new();
  const rows = [[
    'Colaborador',
    'Fecha',
    'Hora',
    'Establecimiento y descripcion corta',
    'Monto (MXN)',
    'Cuenta***',
    'Codificacion',
    'Moneda original',
    'Monto original',
    'Tipo de cambio',
    'Fecha tipo de cambio'
  ]];

  for (const ticket of tickets) {
    const info = ticket.exportInfo;
    rows.push([
      'GOS',
      info.fecha || '',
      info.hora || '',
      `${info.tienda || ''} (${info.categoria || 'Otro'})`,
      numberOrZero(info.total),
      getCuenta(info),
      buildCodificacion(info),
      info.moneda_original || '',
      info.moneda_original ? numberOrZero(info.total_original) : '',
      info.tipo_cambio || '',
      info.fecha_tipo_cambio || ''
    ]);
  }

  const ws = window.XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [
    { wch: 12 },
    { wch: 12 },
    { wch: 8 },
    { wch: 35 },
    { wch: 12 },
    { wch: 10 },
    { wch: 60 },
    { wch: 15 },
    { wch: 14 },
    { wch: 14 },
    { wch: 18 }
  ];
  window.XLSX.utils.book_append_sheet(wb, ws, 'Gastos');
  return wb;
}

function buildCodificacion(info) {
  const f = parseFecha(info.fecha);
  const h = parseHora(info.hora || '');
  const monto = numberOrZero(info.total);
  const montoStr = monto % 1 === 0 ? monto.toFixed(0) : monto.toFixed(2);
  const horaStr = info.hora ? `${h.horas}.${String(h.mins).padStart(2, '0')}` : '0.00';
  return `GOS [${getCuenta(info)}] ${f.anio}.${String(f.mes).padStart(2, '0')}.${String(f.dia).padStart(2, '0')} - ${horaStr}HRS - ${nombreCorto(info.tienda)} - MXN$ ${montoStr}`;
}

function getCuenta(info) {
  const digits = String(info.tarjeta || '').replace(/\D/g, '');
  return digits ? digits.slice(-4) : 'EFVO';
}

function nombreCorto(tienda) {
  return String(tienda || 'Ticket').split(',')[0].split('.')[0].trim().slice(0, 24) || 'Ticket';
}

function parseFecha(fecha) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(fecha))) {
    const [anio, mes, dia] = String(fecha).split('-').map(Number);
    return { anio, mes, dia };
  }
  const parts = String(fecha || '').split('/').map(Number);
  if (parts.length === 3 && parts.every(Boolean)) {
    return { dia: parts[0], mes: parts[1], anio: parts[2] };
  }
  const now = new Date();
  return { dia: now.getDate(), mes: now.getMonth() + 1, anio: now.getFullYear() };
}

function parseHora(hora) {
  const match = String(hora || '').match(/(\d{1,2})[:.](\d{2})/);
  return {
    horas: match ? Number(match[1]) : 0,
    mins: match ? Number(match[2]) : 0
  };
}

function parseFechaToDate(fecha, fallback) {
  const f = parseFecha(fecha);
  const date = new Date(f.anio, f.mes - 1, f.dia);
  if (!Number.isNaN(date.getTime())) return date;
  return fallback ? new Date(fallback) : new Date();
}

function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function fmtDate(date) {
  return date.toISOString().slice(0, 10);
}

function sanitizeFolderName(name) {
  return name.replace(/[<>:"/\\|?*]/g, '-').slice(0, 150);
}

function imageType(dataUrl) {
  if (dataUrl.startsWith('data:image/png')) return 'PNG';
  if (dataUrl.startsWith('data:image/webp')) return 'WEBP';
  return 'JPEG';
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function roundMoney(value) {
  return Math.round(numberOrZero(value) * 100) / 100;
}

function getOriginalCurrency(info) {
  const currency = String(info.moneda_original || info.moneda || 'MXN').toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : 'MXN';
}

function getOriginalAmount(info, sourceCurrency) {
  if (sourceCurrency !== 'MXN' && numberOrZero(info.total_original) > 0) {
    return numberOrZero(info.total_original);
  }
  return numberOrZero(info.total);
}

function dateForFx(fecha) {
  const f = parseFecha(fecha);
  return `${f.anio}-${String(f.mes).padStart(2, '0')}-${String(f.dia).padStart(2, '0')}`;
}

async function fetchHistoricalRate(currency, date) {
  const response = await fetch(`/fx/${currency}/${date}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.rate) {
    throw new Error(`No se pudo obtener tipo de cambio ${currency}/MXN para ${date}.`);
  }
  return data;
}

function appendNote(notes, note) {
  return notes ? `${notes} | ${note}` : note;
}

function loadScript(src) {
  if ([...document.scripts].some((script) => script.src === src)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
    document.head.appendChild(script);
  });
}

function downloadBlob(blob, filename) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}
