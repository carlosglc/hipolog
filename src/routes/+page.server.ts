import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import * as db from '$lib/server/db';
import { resumir } from '$lib/resumen';
import { ahora, hoy } from '$lib/fechas';
import { enriquecerEnSegundoPlano } from '$lib/server/glucosa';

const num = (v: FormDataEntryValue | null) => {
	const n = Number(String(v ?? '').trim().replace(',', '.'));
	return Number.isFinite(n) ? n : null;
};
const texto = (v: FormDataEntryValue | null) => String(v ?? '').trim().slice(0, 200);
const esFecha = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const esHora = (s: string) => /^\d{2}:\d{2}$/.test(s);

export const load: PageServerLoad = () => {
	const carbs = Number(db.ajuste('carbs_por_tableta', '4')) || 4;
	const tomas = db.tomas();
	const compras = db.compras();
	return {
		tomas,
		compras,
		resumen: resumir(tomas, compras, carbs),
		tabletasPorFrasco: Number(db.ajuste('tabletas_por_frasco', '10')) || 10,
		ahora: ahora()
	};
};

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
		const id = db.agregarToma({
			fecha,
			hora,
			tabletas,
			contexto: texto(f.get('contexto')),
			glucosa: glucosa !== null && glucosa >= 20 && glucosa <= 600 ? Math.round(glucosa) : null,
			tendencia: texto(f.get('tendencia')),
			nota: texto(f.get('nota'))
		});
		// Si el pipeline de glucosa está configurado y responde, completa la
		// toma después. Si no, el registro ya quedó guardado igual.
		if (fecha === hoy()) enriquecerEnSegundoPlano(id, db.ruta);
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
