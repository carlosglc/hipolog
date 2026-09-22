import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import * as db from '$lib/server/db';
import { resumir } from '$lib/resumen';
import { ahora, hoy } from '$lib/fechas';
import { leerCarelink } from '$lib/server/carelink';
import { aMinutos, masCercana, nivel, subidaPorTableta, tendenciaCalculada, type Lectura } from '$lib/glucosa';
import type { Toma } from '$lib/tipos';

const num = (v: FormDataEntryValue | null) => {
	const n = Number(String(v ?? '').trim().replace(',', '.'));
	return Number.isFinite(n) ? n : null;
};
const texto = (v: FormDataEntryValue | null) => String(v ?? '').trim().slice(0, 200);
const esFecha = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const esHora = (s: string) => /^\d{2}:\d{2}$/.test(s);

export const load: PageServerLoad = async () => {
	const carbs = Number(db.ajuste('carbs_por_tableta', '4')) || 4;
	const compras = db.compras();

	// El sensor es opcional: si no hay CARELINK_URL o el proxy no responde,
	// `estado` es null y la página se ve exactamente igual que sin sensor.
	const estado = await leerCarelink();
	if (estado) rellenarDesdeElSensor(estado.lecturas);

	const tomas = db.tomas();
	const curva = estado ? construirCurva(estado.lecturas, tomas) : null;

	return {
		tomas,
		compras,
		resumen: resumir(tomas, compras, carbs),
		tabletasPorFrasco: Number(db.ajuste('tabletas_por_frasco', '10')) || 10,
		ahora: ahora(),
		sensor: estado && {
			sg: estado.sg,
			flecha: estado.flecha,
			hora: estado.hora,
			fecha: estado.fecha,
			nivel: nivel(estado.sg),
			// Si CareLink manda NONE, la sacamos de las lecturas.
			calculada: estado.flecha ? null : tendenciaCalculada(estado.lecturas)
		},
		curva,
		subida: subidaPorTableta(db.tomas())
	};
};

/**
 * Copia a la base la glucosa de cada toma reciente: la del momento y la de
 * 30 min después. Se hace al cargar, no con un temporizador, para que
 * sobreviva a reinicios del contenedor — la ventana de 24 h del proxy da de
 * sobra para alcanzar cualquier toma del día.
 */
function rellenarDesdeElSensor(lecturas: Lectura[]) {
	if (!lecturas.length) return;
	const ultima = lecturas.at(-1)!;
	for (const t of db.tomas()) {
		if (t.glucosa !== null && t.glucosa30 !== null) continue;
		if (t.fecha < lecturas[0].fecha) break; // más viejo que la ventana del sensor
		const enElMomento = t.glucosa ?? masCercana(lecturas, t.fecha, t.hora)?.sg ?? null;
		// A los 30 min: solo si esos 30 min ya pasaron dentro de la ventana.
		const min30 = aMinutos(t.hora) + 30;
		const hhmm = `${String(Math.floor(min30 / 60) % 24).padStart(2, '0')}:${String(min30 % 60).padStart(2, '0')}`;
		const cruzaMedianoche = min30 >= 1440;
		const despues =
			t.glucosa30 ??
			(cruzaMedianoche
				? null
				: t.fecha < ultima.fecha || min30 <= ultima.minutos
					? (masCercana(lecturas, t.fecha, hhmm)?.sg ?? null)
					: null);
		if (enElMomento !== null || despues !== null) {
			db.completarGlucosa(t.id, enElMomento, despues);
		}
	}
}

/** Las 24 h de curva más las tomas encima: las dos historias en un mismo eje. */
function construirCurva(lecturas: Lectura[], tomas: Toma[]) {
	if (!lecturas.length) return null;
	// Eje en minutos, anclado al día de la primera lectura: la ventana de 24 h
	// cae siempre en dos fechas, así que el segundo día suma 1440.
	const dia0 = lecturas[0].fecha;
	const x = (fecha: string, minutos: number) => (fecha === dia0 ? minutos : minutos + 1440);

	const puntos = lecturas.map((l) => ({ x: x(l.fecha, l.minutos), sg: l.sg, hora: l.hora }));
	const x0 = puntos[0].x;
	const x1 = puntos.at(-1)!.x;

	const marcas = tomas
		.map((t) => ({ x: x(t.fecha, aMinutos(t.hora)), tabletas: t.tabletas, hora: t.hora, id: t.id }))
		.filter((m) => m.x >= x0 && m.x <= x1);

	return { puntos, marcas, x0, x1, dia0 };
}

export const actions: Actions = {
	registrar: async ({ request }) => {
		const f = await request.formData();
		const tabletas = num(f.get('tabletas'));
		if (tabletas === null || tabletas <= 0 || tabletas > 30) {
			return fail(400, { error: 'Número de tabletas fuera de rango.' });
		}
		const fecha = texto(f.get('fecha')) || hoy();
		const hora = texto(f.get('hora')) || ahora();
		if (!esFecha(fecha) || !esHora(hora)) {
			return fail(400, { error: 'Fecha u hora con formato inválido.' });
		}
		const glucosa = num(f.get('glucosa'));
		db.agregarToma({
			fecha,
			hora,
			tabletas,
			contexto: texto(f.get('contexto')),
			glucosa: glucosa !== null && glucosa >= 20 && glucosa <= 600 ? Math.round(glucosa) : null,
			tendencia: texto(f.get('tendencia')),
			nota: texto(f.get('nota'))
		});
		// La glucosa se copia sola en el próximo load, desde la curva del
		// sensor. El tap no espera a la red.
		return { ok: `${tabletas} tableta${tabletas === 1 ? '' : 's'} a las ${hora}` };
	},

	borrar: async ({ request }) => {
		const id = num((await request.formData()).get('id'));
		if (id === null) return fail(400, { error: 'Falta el id.' });
		db.borrarToma(id);
		return { ok: 'Registro borrado' };
	},

	comprar: async ({ request }) => {
		const f = await request.formData();
		const frascos = num(f.get('frascos')) ?? 1;
		const porFrasco = num(f.get('porFrasco'));
		if (porFrasco === null || porFrasco <= 0 || frascos <= 0) {
			return fail(400, { error: '¿Cuántos frascos y de cuántas tabletas?' });
		}
		const tabletas = Math.round(frascos * porFrasco);
		const fecha = texto(f.get('fecha')) || hoy();
		if (!esFecha(fecha)) return fail(400, { error: 'Fecha inválida.' });
		db.agregarCompra({
			fecha,
			tabletas,
			costo: Math.max(0, num(f.get('costo')) ?? 0),
			marca: texto(f.get('marca'))
		});
		// El tamaño del frasco se recuerda para la próxima compra.
		db.guardarAjuste('tabletas_por_frasco', String(Math.round(porFrasco)));
		return { ok: `+${tabletas} tabletas al inventario` };
	},

	borrarCompra: async ({ request }) => {
		const id = num((await request.formData()).get('id'));
		if (id === null) return fail(400, { error: 'Falta el id.' });
		db.borrarCompra(id);
		return { ok: 'Compra borrada' };
	},

	ajustes: async ({ request }) => {
		const carbs = num((await request.formData()).get('carbs'));
		if (carbs === null || carbs <= 0 || carbs > 50) {
			return fail(400, { error: 'Carbohidratos por tableta fuera de rango.' });
		}
		db.guardarAjuste('carbs_por_tableta', String(carbs));
		return { ok: `Ahora cada tableta cuenta como ${carbs} g` };
	}
};
