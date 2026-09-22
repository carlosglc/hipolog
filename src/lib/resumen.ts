import type { Compra, Toma } from './tipos.ts';
import { diasEntre, etiquetaDia, franja, hoy as hoyLocal, sumarDias } from './fechas.ts';

export type Resumen = ReturnType<typeof resumir>;

/**
 * Todo el cálculo vive aquí, sin tocar la base, para poder probarlo.
 * `carbsPorTableta` es 4 g en las tabletas que compra Carlos.
 */
export function resumir(
	tomas: Toma[],
	compras: Compra[],
	carbsPorTableta = 4,
	hoy = hoyLocal()
) {
	const compradas = compras.reduce((s, c) => s + c.tabletas, 0);
	const consumidas = tomas.reduce((s, t) => s + t.tabletas, 0);
	const existencias = compradas - consumidas;

	// Ritmo: promedio diario. La ventana son 30 días, pero si el historial es
	// más corto se usa lo que haya — si no, los primeros días parecen eternos.
	const primera = tomas.length ? tomas.map((t) => t.fecha).sort()[0] : hoy;
	const ventana = Math.max(1, Math.min(30, diasEntre(primera, hoy) + 1));
	const desde = sumarDias(hoy, -(ventana - 1));
	const enVentana = tomas.filter((t) => t.fecha >= desde);
	const tabletasVentana = enVentana.reduce((s, t) => s + t.tabletas, 0);
	const porDia = tabletasVentana / ventana;
	const porSemana = porDia * 7;

	const diasRestantes = porDia > 0 && existencias > 0 ? Math.floor(existencias / porDia) : null;
	const seAcabaEl = diasRestantes === null ? null : sumarDias(hoy, diasRestantes);

	// Costo: promedio ponderado sobre las compras donde sí se capturó precio.
	const conPrecio = compras.filter((c) => c.costo > 0 && c.tabletas > 0);
	const gastado = conPrecio.reduce((s, c) => s + c.costo, 0);
	const tabletasConPrecio = conPrecio.reduce((s, c) => s + c.tabletas, 0);
	const costoPorTableta = tabletasConPrecio ? gastado / tabletasConPrecio : null;
	const costoMensual = costoPorTableta === null ? null : costoPorTableta * porDia * 30;

	const deHoy = tomas.filter((t) => t.fecha === hoy);
	const desdeSemana = sumarDias(hoy, -6);
	const deSemana = tomas.filter((t) => t.fecha >= desdeSemana);

	// Serie de 14 días, con los días en cero incluidos: el hueco también informa.
	const serie = Array.from({ length: 14 }, (_, i) => {
		const fecha = sumarDias(hoy, i - 13);
		const dia = tomas.filter((t) => t.fecha === fecha);
		return {
			fecha,
			etiqueta: etiquetaDia(fecha),
			tabletas: dia.reduce((s, t) => s + t.tabletas, 0),
			eventos: dia.length
		};
	});

	const agrupar = (clave: (t: Toma) => string) => {
		const mapa = new Map<string, { llave: string; eventos: number; tabletas: number }>();
		for (const t of tomas) {
			const llave = clave(t) || '—';
			const fila = mapa.get(llave) ?? { llave, eventos: 0, tabletas: 0 };
			fila.eventos += 1;
			fila.tabletas += t.tabletas;
			mapa.set(llave, fila);
		}
		return [...mapa.values()].sort((a, b) => b.eventos - a.eventos);
	};

	return {
		hoy,
		carbsPorTableta,
		existencias,
		compradas,
		consumidas,
		ventana,
		porDia,
		porSemana,
		diasRestantes,
		seAcabaEl,
		costoPorTableta,
		costoMensual,
		hoyTabletas: deHoy.reduce((s, t) => s + t.tabletas, 0),
		hoyEventos: deHoy.length,
		semanaTabletas: deSemana.reduce((s, t) => s + t.tabletas, 0),
		semanaEventos: deSemana.length,
		serie,
		porContexto: agrupar((t) => t.contexto),
		porFranja: agrupar((t) => franja(t.hora))
	};
}
