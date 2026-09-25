import { diasEntre } from './fechas.ts';
import type { Toma } from './tipos.ts';

/**
 * Un episodio es una baja, aunque se haya registrado en varios taps.
 *
 * Nació de un caso real, el 25/09/2026 a las 03:21. No hay botón +3, así que
 * 3 tabletas se registraron como +2 y +1 con dos segundos de diferencia.
 * Contadas por separado, la app decía que hubo dos bajas, y cada fila se
 * atribuía toda la subida de 55 a 62 como si solo sus tabletas la hubieran
 * causado: +26 por 15 g una, +13 la otra. La cuenta real con los 12 g era +9.
 *
 * Los taps se agrupan cuando cada uno llega a VENTANA minutos o menos del
 * anterior: una segunda dosis dentro de ese lapso es parte de la misma
 * corrección. El historial sigue mostrando cada tap; esto solo cambia las
 * métricas.
 */
export const VENTANA_EPISODIO_MIN = 15;

export type Episodio = {
	tomas: Toma[];
	fecha: string; // la del primer tap
	hora: string;
	gramos: number;
	fuentes: string[]; // distintas, en orden de aparición
	contexto: string; // el primero que no esté vacío
	ejercicio: boolean; // si algún tap fue durante ejercicio
	glucosa: number | null; // al empezar la corrección
	glucosa30: number | null; // 30 min después de la ÚLTIMA dosis
};

// Minutos desde una fecha fija, para comparar taps de días distintos sin
// construir un Date: una baja que cruza la medianoche sigue siendo una.
const REF = '2000-01-01';
const minutoAbsoluto = (t: Toma) =>
	diasEntre(REF, t.fecha) * 1440 + Number(t.hora.slice(0, 2)) * 60 + Number(t.hora.slice(3, 5));

export function episodios(tomas: Toma[], ventanaMin = VENTANA_EPISODIO_MIN): Episodio[] {
	const orden = tomas
		.map((t) => ({ t, m: minutoAbsoluto(t) }))
		.sort((a, b) => a.m - b.m || a.t.id - b.t.id);

	const grupos: { t: Toma; m: number }[][] = [];
	for (const x of orden) {
		const actual = grupos.at(-1);
		if (actual && x.m - actual.at(-1)!.m <= ventanaMin) actual.push(x);
		else grupos.push([x]);
	}

	return grupos.map((g) => {
		const ts = g.map((x) => x.t);
		return {
			tomas: ts,
			fecha: ts[0].fecha,
			hora: ts[0].hora,
			gramos: ts.reduce((s, t) => s + t.gramos, 0),
			fuentes: [...new Set(ts.map((t) => t.fuente))],
			contexto: ts.find((t) => t.contexto)?.contexto ?? '',
			ejercicio: ts.some((t) => t.contexto === 'ejercicio'),
			glucosa: ts.find((t) => t.glucosa !== null)?.glucosa ?? null,
			// Estrictamente la del último tap. Tomar la de uno anterior mediría
			// antes de que la última dosis alcanzara a actuar.
			glucosa30: ts.at(-1)!.glucosa30
		};
	});
}
