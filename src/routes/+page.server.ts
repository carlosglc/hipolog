import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import * as db from '$lib/server/db';
import { resumir } from '$lib/resumen';
import { ahora, hoy } from '$lib/fechas';
import { CAFEINA_SIN_DATO, TABLETA } from '$lib/tipos';
import { leerCarelink } from '$lib/server/carelink';
import { aMinutos, masCercana, nivel, subidaPorFuente, tendenciaCalculada, type Lectura } from '$lib/glucosa';
import type { Toma } from '$lib/tipos';

const num = (v: FormDataEntryValue | null) => {
	const n = Number(String(v ?? '').trim().replace(',', '.'));
	return Number.isFinite(n) ? n : null;
};
const texto = (v: FormDataEntryValue | null) => String(v ?? '').trim().slice(0, 200);
const esFecha = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const esHora = (s: string) => /^\d{2}:\d{2}$/.test(s);

/**
 * Fecha y hora de un registro.
 *
 * Los campos de «Otra hora» viven en el mismo formulario que los botones
 * rápidos y se envían aunque el panel esté cerrado, con la hora en que se
 * CARGÓ la página. Un tap a las 17:53 en una página abierta desde las 17:50
 * quedaba registrado a las 17:50 — y en el iPhone, que congela las páginas en
 * segundo plano, el desfase puede ser de horas. Por eso solo se respetan
 * cuando se usó el botón del panel (detallado=1); el tap rápido usa la hora
 * del servidor, que es cuando de verdad pasó.
 */
function momento(f: FormData): { fecha: string; hora: string } | { error: string } {
	if (texto(f.get('detallado')) !== '1') return { fecha: hoy(), hora: ahora() };
	const fecha = texto(f.get('fecha')) || hoy();
	const hora = texto(f.get('hora')) || ahora();
	if (!esFecha(fecha) || !esHora(hora)) return { error: 'Fecha u hora con formato inválido.' };
	return { fecha, hora };
}

/**
 * Cafeína de un preajuste. Vacío significa «trae, pero no sé cuánta»; un 0
 * explícito significa «no trae». Son dos cosas distintas y no se confunden.
 */
function cafeinaDe(f: FormData): number {
	if (texto(f.get('traeCafeina')) !== '1') return 0;
	const mg = num(f.get('cafeina'));
	return mg !== null && mg > 0 ? mg : CAFEINA_SIN_DATO;
}

const propositoDe = (f: FormData) =>
	texto(f.get('proposito')) === 'combustible' ? 'combustible' : 'rescate';

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
		fuentes: db.fuentes(),
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
		subida: subidaPorFuente(db.tomas())
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
		.map((t) => ({
			x: x(t.fecha, aMinutos(t.hora)),
			tabletas: t.tabletas,
			gramos: t.gramos,
			fuente: t.fuente,
			proposito: t.proposito,
			hora: t.hora,
			id: t.id
		}))
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
		const cuando = momento(f);
		if ('error' in cuando) return fail(400, cuando);
		const { fecha, hora } = cuando;
		const glucosa = num(f.get('glucosa'));
		// El propósito lo decide la pantalla, no la fuente: el mismo Gu puede
		// ser combustible en una corrida y rescate cuando algo se descontrola.
		const proposito = propositoDe(f);
		const carbs = Number(db.ajuste('carbs_por_tableta', '4')) || 4;
		db.agregarToma({
			fecha,
			hora,
			tabletas,
			gramos: tabletas * carbs,
			fuente: 'tableta',
			proposito,
			cafeina: 0,
			contexto: texto(f.get('contexto')),
			glucosa: glucosa !== null && glucosa >= 20 && glucosa <= 600 ? Math.round(glucosa) : null,
			tendencia: texto(f.get('tendencia')),
			nota: texto(f.get('nota'))
		});
		// La glucosa se copia sola en el próximo load, desde la curva del
		// sensor. El tap no espera a la red.
		return { ok: `${tabletas} tableta${tabletas === 1 ? '' : 's'} a las ${hora}` };
	},

	/** Un tap en un preajuste: un Gu, una caja de jugo. Una unidad. */
	registrarFuente: async ({ request }) => {
		const f = await request.formData();
		const id = num(f.get('fuenteId'));
		const fuente = id === null ? undefined : db.fuente(id);
		if (!fuente) return fail(400, { error: 'Ese preajuste ya no existe.' });
		const cuando = momento(f);
		if ('error' in cuando) return fail(400, cuando);
		const glucosa = num(f.get('glucosa'));
		db.agregarToma({
			...cuando,
			tabletas: 0,
			gramos: fuente.gramos,
			fuente: fuente.nombre,
			proposito: propositoDe(f),
			cafeina: fuente.cafeina,
			contexto: texto(f.get('contexto')),
			glucosa: glucosa !== null && glucosa >= 20 && glucosa <= 600 ? Math.round(glucosa) : null,
			tendencia: texto(f.get('tendencia')),
			nota: texto(f.get('nota'))
		});
		return { ok: `${fuente.nombre} · ${fuente.gramos} g a las ${cuando.hora}` };
	},

	agregarFuente: async ({ request }) => {
		const f = await request.formData();
		const nombre = texto(f.get('nombre')).slice(0, 40);
		const gramos = num(f.get('gramos'));
		if (!nombre) return fail(400, { error: 'Ponle nombre.' });
		if (gramos === null || gramos <= 0 || gramos > 200) {
			return fail(400, { error: 'Gramos de carbohidrato fuera de rango.' });
		}
		db.agregarFuente(nombre, gramos, cafeinaDe(f), 'rescate');
		return { ok: `${nombre} agregado` };
	},

	actualizarFuente: async ({ request }) => {
		const f = await request.formData();
		const id = num(f.get('id'));
		const gramos = num(f.get('gramos'));
		if (id === null || gramos === null || gramos <= 0 || gramos > 200) {
			return fail(400, { error: 'Gramos de carbohidrato fuera de rango.' });
		}
		db.actualizarFuente(id, gramos, cafeinaDe(f));
		return { ok: 'Preajuste actualizado' };
	},

	borrarFuente: async ({ request }) => {
		const id = num((await request.formData()).get('id'));
		if (id === null) return fail(400, { error: 'Falta el id.' });
		db.borrarFuente(id);
		return { ok: 'Preajuste borrado' };
	},

	borrar: async ({ request }) => {
		const id = num((await request.formData()).get('id'));
		if (id === null) return fail(400, { error: 'Falta el id.' });
		db.borrarToma(id);
		return { ok: 'Registro borrado' };
	},

	comprar: async ({ request }) => {
		const f = await request.formData();
		const fuente = texto(f.get('fuente')) || TABLETA;
		let tabletas: number;
		if (fuente === TABLETA) {
			const frascos = num(f.get('frascos')) ?? 1;
			const porFrasco = num(f.get('porFrasco'));
			if (porFrasco === null || porFrasco <= 0 || frascos <= 0) {
				return fail(400, { error: '¿Cuántos frascos y de cuántas tabletas?' });
			}
			tabletas = Math.round(frascos * porFrasco);
			// El tamaño del frasco se recuerda para la próxima compra.
			db.guardarAjuste('tabletas_por_frasco', String(Math.round(porFrasco)));
		} else {
			const unidades = num(f.get('unidades'));
			if (unidades === null || unidades <= 0) return fail(400, { error: '¿Cuántas unidades?' });
			tabletas = Math.round(unidades);
		}
		const fecha = texto(f.get('fecha')) || hoy();
		if (!esFecha(fecha)) return fail(400, { error: 'Fecha inválida.' });
		db.agregarCompra({
			fecha,
			tabletas,
			fuente,
			costo: Math.max(0, num(f.get('costo')) ?? 0),
			marca: texto(f.get('marca'))
		});
		return { ok: `+${tabletas} ${fuente === TABLETA ? 'tabletas' : fuente} al inventario` };
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
