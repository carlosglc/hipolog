// Todas las fechas se guardan como 'YYYY-MM-DD' y las horas como 'HH:MM', en
// hora local. Nunca se construye un Date a partir de una cadena ISO: eso las
// interpreta en UTC y una toma de las 19:30 se corre de día.

export function partes(fecha: string): [number, number, number] {
	const [a, m, d] = fecha.split('-').map(Number);
	return [a, m, d];
}

/** Date local a mediodía: inmune a horario de verano al sumar días. */
export function aDate(fecha: string): Date {
	const [a, m, d] = partes(fecha);
	return new Date(a, m - 1, d, 12, 0, 0, 0);
}

export function aFecha(d: Date): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function hoy(): string {
	return aFecha(new Date());
}

export function ahora(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, '0');
	return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function sumarDias(fecha: string, n: number): string {
	const d = aDate(fecha);
	d.setDate(d.getDate() + n);
	return aFecha(d);
}

export function diasEntre(desde: string, hasta: string): number {
	return Math.round((aDate(hasta).getTime() - aDate(desde).getTime()) / 86_400_000);
}

const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** 'mié 21' */
export function etiquetaDia(fecha: string): string {
	const d = aDate(fecha);
	return `${DIAS[d.getDay()]} ${d.getDate()}`;
}

/** 'mié 21 sep' — o 'hoy' / 'ayer' cuando aplica. */
export function etiquetaLarga(fecha: string, hoyRef = hoy()): string {
	if (fecha === hoyRef) return 'hoy';
	if (fecha === sumarDias(hoyRef, -1)) return 'ayer';
	const d = aDate(fecha);
	return `${DIAS[d.getDay()]} ${d.getDate()} ${MESES[d.getMonth()]}`;
}

/** Madrugada, mañana, tarde, noche — para ver a qué hora pegan las bajas. */
export function franja(hora: string): string {
	const h = Number(hora.slice(0, 2));
	if (h < 6) return 'madrugada';
	if (h < 12) return 'mañana';
	if (h < 19) return 'tarde';
	return 'noche';
}
