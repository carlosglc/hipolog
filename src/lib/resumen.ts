import { CAFEINA_SIN_DATO, RESCATE, TABLETA, type Compra, type Toma } from './tipos.ts';
import { diasEntre, etiquetaDia, franja, hoy as hoyLocal, sumarDias } from './fechas.ts';
import { episodios, type Episodio } from './episodios.ts';

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
	// El inventario SOLO cuenta tabletas: un jugo no sale del frasco. El resto
	// del resumen —eventos, franjas, contextos, la serie— cuenta todo, porque
	// una baja corregida con jugo sigue siendo una baja.
	const deTabletas = tomas.filter((t) => t.fuente === TABLETA);
	// Las compras también son por fuente: un paquete de 24 Gu metido aquí sin
	// filtrar inflaría el stock de tabletas en 24.
	const comprasTabletas = compras.filter((c) => (c.fuente ?? TABLETA) === TABLETA);
	const compradas = comprasTabletas.reduce((s, c) => s + c.tabletas, 0);
	const consumidas = deTabletas.reduce((s, t) => s + t.tabletas, 0);
	const existencias = compradas - consumidas;

	// Ritmo: promedio diario. La ventana son 30 días, pero si el historial es
	// más corto se usa lo que haya — si no, los primeros días parecen eternos.
	const primera = deTabletas.length ? deTabletas.map((t) => t.fecha).sort()[0] : hoy;
	const ventana = Math.max(1, Math.min(30, diasEntre(primera, hoy) + 1));
	const desde = sumarDias(hoy, -(ventana - 1));
	const enVentana = deTabletas.filter((t) => t.fecha >= desde);
	const tabletasVentana = enVentana.reduce((s, t) => s + t.tabletas, 0);
	const porDia = tabletasVentana / ventana;
	const porSemana = porDia * 7;

	const diasRestantes = porDia > 0 && existencias > 0 ? Math.floor(existencias / porDia) : null;
	const seAcabaEl = diasRestantes === null ? null : sumarDias(hoy, diasRestantes);

	// Costo: promedio ponderado sobre las compras donde sí se capturó precio.
	const conPrecio = comprasTabletas.filter((c) => c.costo > 0 && c.tabletas > 0);
	const gastado = conPrecio.reduce((s, c) => s + c.costo, 0);
	const tabletasConPrecio = conPrecio.reduce((s, c) => s + c.tabletas, 0);
	const costoPorTableta = tabletasConPrecio ? gastado / tabletasConPrecio : null;
	const costoMensual = costoPorTableta === null ? null : costoPorTableta * porDia * 30;

	// Inventario de todo lo que no es tableta: cada evento consume UNA unidad
	// (un gel, una caja de jugo). Si tomaste dos, son dos taps.
	const fuentesConCompra = [
		...new Set(compras.map((c) => c.fuente ?? TABLETA).filter((f) => f !== TABLETA))
	];
	const inventario = fuentesConCompra
		.map((fuente) => {
			const deEsta = compras.filter((c) => c.fuente === fuente);
			const comprado = deEsta.reduce((s, c) => s + c.tabletas, 0);
			const consumido = tomas.filter((t) => t.fuente === fuente).length;
			const conCosto = deEsta.filter((c) => c.costo > 0 && c.tabletas > 0);
			const unidadesConCosto = conCosto.reduce((s, c) => s + c.tabletas, 0);
			return {
				fuente,
				comprado,
				consumido,
				quedan: comprado - consumido,
				costoUnidad: unidadesConCosto
					? conCosto.reduce((s, c) => s + c.costo, 0) / unidadesConCosto
					: null
			};
		})
		.sort((a, b) => a.fuente.localeCompare(b.fuente));

	// La cafeína desconocida NO se suma como −1 ni como 0: se reporta aparte.
	// «Tomaste 40 mg» cuando en realidad fueron 40 más un gel sin dato es falso.
	const cafeinaDe = (filas: Toma[]) => ({
		mg: filas.reduce((s, t) => s + (t.cafeina > 0 ? t.cafeina : 0), 0),
		sinDato: filas.filter((t) => t.cafeina === CAFEINA_SIN_DATO).length
	});

	// Solo los rescates son hipoglucemias. El combustible de una corrida se
	// cuenta aparte o inflaría el conteo de bajas del día.
	const rescates = tomas.filter((t) => t.proposito === RESCATE);
	// Una baja registrada en varios taps (+2 y luego +1) sigue siendo UNA baja.
	const bajas = episodios(rescates);

	const deHoy = tomas.filter((t) => t.fecha === hoy);
	const desdeSemana = sumarDias(hoy, -6);
	const deSemana = tomas.filter((t) => t.fecha >= desdeSemana);

	// Serie de 14 días, con los días en cero incluidos: el hueco también
	// informa. Va en GRAMOS, que es lo único comparable entre un jugo y una
	// tableta; las tabletas se guardan aparte para el desglose.
	const serie = Array.from({ length: 14 }, (_, i) => {
		const fecha = sumarDias(hoy, i - 13);
		const dia = tomas.filter((t) => t.fecha === fecha);
		return {
			fecha,
			etiqueta: etiquetaDia(fecha),
			gramos: dia.reduce((s, t) => s + t.gramos, 0),
			gramosRescate: dia
				.filter((t) => t.proposito === RESCATE)
				.reduce((s, t) => s + t.gramos, 0),
			tabletas: dia.filter((t) => t.fuente === TABLETA).reduce((s, t) => s + t.tabletas, 0),
			eventos: dia.length
		};
	});

	// El patrón de las bajas (a qué hora, en qué contexto) se cuenta por
	// episodio: dos taps de la misma baja no son dos bajas a las 3 de la mañana.
	const agruparBajas = (clave: (e: Episodio) => string) => {
		const mapa = new Map<string, { llave: string; eventos: number; gramos: number }>();
		for (const e of bajas) {
			const llave = clave(e) || '—';
			const fila = mapa.get(llave) ?? { llave, eventos: 0, gramos: 0 };
			fila.eventos += 1;
			fila.gramos += e.gramos;
			mapa.set(llave, fila);
		}
		return [...mapa.values()].sort((a, b) => b.eventos - a.eventos);
	};

	const agrupar = (clave: (t: Toma) => string, filas: Toma[] = tomas) => {
		const mapa = new Map<string, { llave: string; eventos: number; gramos: number }>();
		for (const t of filas) {
			const llave = clave(t) || '—';
			const fila = mapa.get(llave) ?? { llave, eventos: 0, gramos: 0 };
			fila.eventos += 1;
			fila.gramos += t.gramos;
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
		hoyTabletas: deHoy.filter((t) => t.fuente === TABLETA).reduce((s, t) => s + t.tabletas, 0),
		hoyGramos: deHoy.reduce((s, t) => s + t.gramos, 0),
		hoyEventos: deHoy.length,
		hoyRescates: bajas.filter((e) => e.fecha === hoy).length,
		hoyCombustible: deHoy.filter((t) => t.proposito !== RESCATE).length,
		hoyCafeina: cafeinaDe(deHoy),
		semanaCafeina: cafeinaDe(deSemana),
		inventario,
		semanaGramos: deSemana.reduce((s, t) => s + t.gramos, 0),
		semanaEventos: deSemana.length,
		serie,
		// El patrón de las bajas: solo rescates. Un gel de media corrida no
		// dice nada sobre a qué horas te pega una hipoglucemia.
		porContexto: agruparBajas((e) => e.contexto),
		porFranja: agruparBajas((e) => franja(e.hora)),
		porFuente: agrupar((t) => t.fuente)
	};
}
