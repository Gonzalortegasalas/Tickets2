export function buildCodificacion(info) {
  const f = parseFecha(info.fecha);
  const h = parseHora(info.hora || '');
  const monto = numberOrZero(info.total);
  const montoStr = monto % 1 === 0 ? monto.toFixed(0) : monto.toFixed(2);
  const horaStr = info.hora ? `${h.horas}.${String(h.mins).padStart(2, '0')}` : '0.00';
  return `GOS [${getCuenta(info)}] ${f.anio}.${String(f.mes).padStart(2, '0')}.${String(f.dia).padStart(2, '0')} - ${horaStr}HRS - ${nombreCorto(info.tienda)} - MXN$ ${montoStr}`;
}

export function getCuenta(info) {
  const digits = String(info.tarjeta || '').replace(/\D/g, '');
  return digits ? digits.slice(-4) : 'EFVO';
}

export function nombreCorto(tienda) {
  return String(tienda || 'Ticket').split(',')[0].split('.')[0].trim().slice(0, 24) || 'Ticket';
}

export function parseFecha(fecha) {
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

export function parseHora(hora) {
  const match = String(hora || '').match(/(\d{1,2})[:.](\d{2})/);
  return {
    horas: match ? Number(match[1]) : 0,
    mins: match ? Number(match[2]) : 0
  };
}

export function parseFechaToDate(fecha, fallback) {
  const f = parseFecha(fecha);
  const date = new Date(f.anio, f.mes - 1, f.dia);
  if (!Number.isNaN(date.getTime())) return date;
  return fallback ? new Date(fallback) : new Date();
}

export function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function fmtDate(date) {
  return date.toISOString().slice(0, 10);
}

export function sanitizeFolderName(name) {
  return name.replace(/[<>:"/\\|?*]/g, '-').slice(0, 150);
}

export function dateForFx(fecha) {
  const f = parseFecha(fecha);
  return `${f.anio}-${String(f.mes).padStart(2, '0')}-${String(f.dia).padStart(2, '0')}`;
}

export function roundMoney(value) {
  return Math.round(numberOrZero(value) * 100) / 100;
}

export function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
