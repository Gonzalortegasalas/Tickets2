import {
  buildCodificacion,
  dateForFx,
  fmtDate,
  getCuenta,
  getMonday,
  numberOrZero,
  parseFechaToDate,
  roundMoney,
  sanitizeFolderName
} from './exportHelpers.js';

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
    const usedFolderNames = new Map();

    for (const ticket of weekTickets) {
      const codificacion = buildCodificacion(ticket.exportInfo);
      const folderName = uniqueFolderName(sanitizeFolderName(codificacion), usedFolderNames);
      const ticketFolder = weekZip.folder(folderName);
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

function uniqueFolderName(baseName, usedNames) {
  const safeBase = baseName || 'Ticket';
  const count = usedNames.get(safeBase) || 0;
  usedNames.set(safeBase, count + 1);
  return count === 0 ? safeBase : `${safeBase} (${count + 1})`;
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
    ...(numberOrZero(info.total_ticket) || numberOrZero(info.total_comprobante) ? [
      ['Total ticket', `MXN$ ${numberOrZero(info.total_ticket).toFixed(2)}`],
      ['Total comprobante', `MXN$ ${numberOrZero(info.total_comprobante).toFixed(2)}`],
      ['Propina', `MXN$ ${numberOrZero(info.propina).toFixed(2)}`],
      ['Fuente total', info.fuente_total || 'ticket']
    ] : []),
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
    'Total ticket',
    'Total comprobante',
    'Propina',
    'Fuente total',
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
      numberOrZero(info.total_ticket) || '',
      numberOrZero(info.total_comprobante) || '',
      numberOrZero(info.propina) || '',
      info.fuente_total || '',
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
    { wch: 14 },
    { wch: 18 },
    { wch: 12 },
    { wch: 14 },
    { wch: 15 },
    { wch: 14 },
    { wch: 14 },
    { wch: 18 }
  ];
  window.XLSX.utils.book_append_sheet(wb, ws, 'Gastos');
  return wb;
}

function imageType(dataUrl) {
  if (dataUrl.startsWith('data:image/png')) return 'PNG';
  if (dataUrl.startsWith('data:image/webp')) return 'WEBP';
  return 'JPEG';
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
