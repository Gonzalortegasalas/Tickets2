export const KM_PER_MILE = 1.609344;
export const MXN_PER_MILE = 10;

export function calculateMileage(kilometers, roundTrip = false) {
  const km = Number(kilometers);
  if (!Number.isFinite(km) || km <= 0) throw new Error('Ingresa una distancia en km mayor que cero.');
  const miles = km / KM_PER_MILE * (roundTrip ? 2 : 1);
  // Round only the payment, never the distance used to calculate it.
  return { km, miles, rate: MXN_PER_MILE, total: Math.round(miles * MXN_PER_MILE * 100) / 100 };
}

export function buildMileageInfo({ km, date, route, destinationAddress, roundTrip = false }) {
  const values = calculateMileage(km, roundTrip);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('Indica la fecha del trayecto.');
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(year, month - 1, day);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) {
    throw new Error('Indica una fecha válida.');
  }
  return {
    tipo: 'millas', tienda: String(route || '').trim() || 'Trayecto Google Maps',
    fecha: `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`,
    categoria: 'Millas', moneda: 'MXN', tarjeta: null, items: [],
    kilometros: values.km, millas: values.miles, tarifa_milla: values.rate, total: values.total,
    ida_vuelta: Boolean(roundTrip),
    direccion_destino: typeof destinationAddress === 'string' ? destinationAddress.trim() || null : null,
    notas: 'Trayecto registrado con captura de Google Maps'
  };
}
