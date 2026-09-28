import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Datos } from './datos.ts';
import { diasEntre, hoy, sumarDias } from '../lib/fechas.ts';
import { episodios } from '../lib/episodios.ts';
import { resumir } from '../lib/resumen.ts';
import { nivel } from '../lib/glucosa.ts';
import { leerCarelink } from '../lib/server/carelink.ts';
import { CAFEINA_SIN_DATO, CONTEXTOS, RESCATE, TENDENCIAS } from '../lib/tipos.ts';

/**
 * Las herramientas del MCP. Todas leen lo mismo que la app y calculan con
 * las mismas funciones (`resumir`, `episodios`), así que lo que Claude
 * contesta cuadra con lo que Carlos ve en pantalla.
 */

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const json = (dato: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(dato, null, 2) }] });
const error = (texto: string) => ({ content: [{ type: 'text' as const, text: texto }], isError: true });

const LEER = { readOnlyHint: true, openWorldHint: false } as const;
const MAX_DIAS = 366;

/** Rango con defaults: sin nada, los últimos 7 días. */
function rango(desde?: string, hasta?: string): { desde: string; hasta: string } | { error: string } {
	const h = hasta ?? hoy();
	const d = desde ?? sumarDias(h, -6);
	if (d > h) return { error: `desde (${d}) es posterior a hasta (${h}).` };
	if (diasEntre(d, h) >= MAX_DIAS) return { error: `El rango máximo es de ${MAX_DIAS} días.` };
	return { desde: d, hasta: h };
}

const NOTA_CAMPOS =
	'Fechas y horas son locales de Ciudad de México. `gramos` son carbohidratos (la unidad común entre fuentes). ' +
	'`glucosa` es mg/dL al momento de la toma y `glucosa30` a los 30 min; null = no hay dato (CareLink solo guarda 24 h). ' +
	`cafeina en mg; ${CAFEINA_SIN_DATO} significa "trae cafeína pero no se sabe cuánta", nunca lo sumes como número.`;

export function crearServidor(datos: Datos): McpServer {
	const s = new McpServer({ name: 'hipolog', version: '1.0.0' });

	s.registerTool(
		'tomas',
		{
			title: 'Tomas',
			description:
				'Lista cada toma registrada (tabletas de glucosa, geles, jugos) entre dos fechas, un renglón por tap. ' +
				'Sin fechas: los últimos 7 días. Para contar hipoglucemias usa `episodios`: varios taps seguidos son una sola baja. ' +
				NOTA_CAMPOS,
			inputSchema: {
				desde: fecha.optional().describe('Primer día, inclusive'),
				hasta: fecha.optional().describe('Último día, inclusive. Default: hoy')
			},
			annotations: LEER
		},
		async ({ desde, hasta }) => {
			const r = rango(desde, hasta);
			if ('error' in r) return error(r.error);
			const filas = datos.tomas(r.desde, r.hasta).map(({ ...t }) => {
				delete (t as { cliente_id?: unknown }).cliente_id;
				return t;
			});
			return json({ ...r, total: filas.length, tomas: filas });
		}
	);

	s.registerTool(
		'episodios',
		{
			title: 'Episodios (hipoglucemias)',
			description:
				'Agrupa las tomas en episodios: taps a 15 min o menos uno del otro son UNA misma corrección. ' +
				'Es la forma correcta de contar bajas. Por default solo rescates (el combustible de una corrida no es una baja). ' +
				'`glucosa` es la del primer tap y `glucosa30` la de 30 min después del ÚLTIMO. ' +
				NOTA_CAMPOS,
			inputSchema: {
				desde: fecha.optional().describe('Primer día, inclusive. Default: hace 6 días'),
				hasta: fecha.optional().describe('Último día, inclusive. Default: hoy'),
				incluir_combustible: z.boolean().optional().describe('true para incluir también el combustible')
			},
			annotations: LEER
		},
		async ({ desde, hasta, incluir_combustible }) => {
			const r = rango(desde, hasta);
			if ('error' in r) return error(r.error);
			const filas = datos.tomas(r.desde, r.hasta).filter((t) => incluir_combustible || t.proposito === RESCATE);
			const eps = episodios(filas).map((e) => ({
				fecha: e.fecha,
				hora: e.hora,
				gramos: e.gramos,
				fuentes: e.fuentes,
				contexto: e.contexto,
				ejercicio: e.ejercicio,
				glucosa: e.glucosa,
				glucosa30: e.glucosa30,
				taps: e.tomas.map((t) => ({ id: t.id, hora: t.hora, fuente: t.fuente, tabletas: t.tabletas, gramos: t.gramos, proposito: t.proposito }))
			}));
			return json({ ...r, total: eps.length, episodios: eps });
		}
	);

	s.registerTool(
		'resumen',
		{
			title: 'Resumen e inventario',
			description:
				'Lo mismo que el tablero de la app: tabletas que quedan, cuántos días duran al ritmo actual, ritmo por semana, ' +
				'costo, hoy y la semana, inventario de otras fuentes, serie de 14 días en gramos, y en qué franjas y contextos ' +
				'pegan las bajas (contadas por episodio). ' + NOTA_CAMPOS,
			inputSchema: {},
			annotations: LEER
		},
		async () => json(resumir(datos.todasLasTomas(), datos.compras(), datos.carbsPorTableta()))
	);

	s.registerTool(
		'sensor',
		{
			title: 'Glucosa del sensor',
			description:
				'Glucosa actual y lecturas recientes del sensor (CareLink, cada 5 min). Solo existen las últimas 24 h: ' +
				'para días anteriores usa glucosa/glucosa30 de `tomas`. Rango: <70 bajo, 70–180 en rango, >180 alto.',
			inputSchema: {
				horas: z.number().int().min(0).max(24).optional().describe('Horas de lecturas a incluir. Default 3; 0 = solo la actual')
			},
			annotations: { ...LEER, openWorldHint: true }
		},
		async ({ horas }) => {
			const e = await leerCarelink();
			if (!e) return error('El sensor no respondió: el proxy de CareLink está caído, tarda o no está configurado.');
			const h = horas ?? 3;
			// Minutos absolutos desde el día de la última lectura, para cruzar medianoche.
			const fin = e.lecturas.at(-1);
			const abs = (l: { fecha: string; minutos: number }) => diasEntre(fin!.fecha, l.fecha) * 1440 + l.minutos;
			const lecturas = fin && h > 0
				? e.lecturas.filter((l) => abs(fin) - abs(l) <= h * 60).map(({ fecha, hora, sg }) => ({ fecha, hora, sg }))
				: [];
			return json({ sg: e.sg, flecha: e.flecha, nivel: nivel(e.sg), fecha: e.fecha, hora: e.hora, lecturas });
		}
	);

	s.registerTool(
		'preajustes',
		{
			title: 'Preajustes',
			description:
				'Las fuentes de rescate que no son tabletas (geles Gu, jugo, dulces), con sus gramos y cafeína. ' +
				'Sus nombres son los valores válidos de `fuente` en `registrar_toma`, además de "tableta". ' +
				`Los gramos por tableta son un ajuste aparte. cafeina ${CAFEINA_SIN_DATO} = trae, sin dato de cuánta.`,
			inputSchema: {},
			annotations: LEER
		},
		async () =>
			json({
				gramos_por_tableta: datos.carbsPorTableta(),
				preajustes: datos.fuentes().map(({ nombre, gramos, cafeina, proposito }) => ({ nombre, gramos, cafeina, proposito }))
			})
	);

	s.registerTool(
		'registrar_toma',
		{
			title: 'Registrar una toma',
			description:
				'Agrega UNA toma al registro, igual que un tap en la app. Solo agrega: no edita ni borra (eso se hace en la app). ' +
				'Es un registro médico: antes de llamarla, confirma con Carlos la fecha, la hora y la cantidad; no adivines. ' +
				'Fecha y hora son locales de Ciudad de México y por default son ahora. ' +
				'Con fuente "tableta" pasa `tabletas`; los gramos se calculan solos. Con un preajuste (ver `preajustes`) ' +
				'es UNA unidad y no lleva `tabletas`: dos geles son dos llamadas. ' +
				'"rescate" = ya iba bajo; "combustible" = para no bajar (p. ej. un gel a media corrida). ' +
				'No registra si ya hay una toma de la misma fuente a la misma hora, salvo con aunque_se_repita. ' +
				'La glucosa se puede omitir: la app la copia del sensor sola si la toma es de las últimas 24 h.',
			inputSchema: {
				fuente: z.string().optional().describe('"tableta" (default) o el nombre exacto de un preajuste'),
				tabletas: z.number().positive().max(30).optional().describe('Solo con fuente "tableta". Acepta medias: 0.5'),
				proposito: z.enum(['rescate', 'combustible']).optional().describe('Default "rescate"'),
				fecha: fecha.optional().describe('Default: hoy'),
				hora: z.string().regex(/^\d{2}:\d{2}$/, 'HH:MM').optional().describe('HH:MM, 24 h. Default: ahora'),
				contexto: z.enum(['', ...CONTEXTOS]).optional(),
				tendencia: z.enum(TENDENCIAS).optional().describe('Flechas del sensor al momento de la toma'),
				glucosa: z.number().int().min(20).max(600).optional().describe('mg/dL al momento, si Carlos la sabe'),
				nota: z.string().max(200).optional(),
				aunque_se_repita: z.boolean().optional().describe('Solo si Carlos confirmó que fueron dos tomas iguales a la misma hora')
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
		},
		async ({ aunque_se_repita, ...e }) => {
			const r = datos.registrar({ ...e, aunqueSeRepita: aunque_se_repita });
			if ('error' in r) return error(r.previa ? `${r.error}\n${JSON.stringify(r.previa, null, 2)}` : r.error);
			const t = r.toma;
			const que = t.fuente === 'tableta' ? `${t.tabletas} tableta${t.tabletas === 1 ? '' : 's'}` : t.fuente;
			return {
				content: [
					{ type: 'text' as const, text: `Registrado: ${que} (${t.gramos} g, ${t.proposito}) el ${t.fecha} a las ${t.hora}. id ${t.id}.` },
					{ type: 'text' as const, text: JSON.stringify(t, null, 2) }
				]
			};
		}
	);

	return s;
}
