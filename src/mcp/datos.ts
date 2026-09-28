import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { ahora, hoy } from '../lib/fechas.ts';
import {
	CONTEXTOS,
	COMBUSTIBLE,
	RESCATE,
	TABLETA,
	TENDENCIAS,
	type Compra,
	type Fuente,
	type Toma
} from '../lib/tipos.ts';

/**
 * La base de hipolog vista desde el servidor MCP.
 *
 * Dos conexiones a propósito. Todas las consultas van por `lectura`, que se
 * abre con readOnly: aunque una herramienta tuviera un bug, SQLite rechaza
 * cualquier UPDATE o DELETE. `escritura` existe para UNA sola sentencia, el
 * INSERT de `registrar`; no hay nada más que la use. Editar y borrar se hace
 * desde la app, con Carlos viendo la pantalla.
 *
 * No importa `$lib/server/db`: ese módulo migra el esquema y siembra
 * preajustes al cargarse, y eso le toca a la app, no a un segundo proceso.
 */
export class Datos {
	readonly lectura: DatabaseSync;
	private readonly escritura: DatabaseSync;

	constructor(ruta: string) {
		this.lectura = new DatabaseSync(ruta, { readOnly: true });
		this.escritura = new DatabaseSync(ruta);
		// La app escribe al mismo tiempo; en vez de fallar con SQLITE_BUSY, espera.
		this.lectura.exec('PRAGMA busy_timeout = 3000');
		this.escritura.exec('PRAGMA busy_timeout = 3000');
	}

	tomas(desde: string, hasta: string): Toma[] {
		return this.lectura
			.prepare('SELECT * FROM tomas WHERE fecha BETWEEN ? AND ? ORDER BY fecha, hora, id')
			.all(desde, hasta) as unknown as Toma[];
	}

	todasLasTomas(): Toma[] {
		return this.lectura
			.prepare('SELECT * FROM tomas ORDER BY fecha DESC, hora DESC, id DESC')
			.all() as unknown as Toma[];
	}

	compras(): Compra[] {
		return this.lectura
			.prepare('SELECT * FROM compras ORDER BY fecha DESC, id DESC')
			.all() as unknown as Compra[];
	}

	fuentes(): Fuente[] {
		return this.lectura
			.prepare('SELECT * FROM fuentes ORDER BY orden, id')
			.all() as unknown as Fuente[];
	}

	ajuste(clave: string, porDefecto: string): string {
		const fila = this.lectura.prepare('SELECT valor FROM ajustes WHERE clave = ?').get(clave) as
			| { valor: string }
			| undefined;
		return fila?.valor ?? porDefecto;
	}

	carbsPorTableta(): number {
		return Number(this.ajuste('carbs_por_tableta', '4')) || 4;
	}

	/**
	 * Agrega una toma con las mismas reglas que los botones de la app: una
	 * tableta vale `carbs_por_tableta` gramos, y un preajuste (un Gu, un jugo)
	 * es UNA unidad con sus gramos y su cafeína. Si ya hay una toma de la misma
	 * fuente a la misma hora, no inserta: el 26/09/2026 un reenvío dejó dos
	 * filas idénticas y hubo que borrarlas a mano.
	 */
	registrar(e: EntradaToma, ahoraRef = { fecha: hoy(), hora: ahora() }): Resultado {
		const fecha = e.fecha ?? ahoraRef.fecha;
		const hora = e.hora ?? ahoraRef.hora;
		if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return { error: `Fecha inválida: ${fecha}. Usa YYYY-MM-DD.` };
		if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) return { error: `Hora inválida: ${hora}. Usa HH:MM, 24 h.` };
		if (fecha + hora > ahoraRef.fecha + ahoraRef.hora) {
			return {
				error: `${fecha} ${hora} está en el futuro (ahora son las ${ahoraRef.hora} del ${ahoraRef.fecha}, hora de México).`
			};
		}

		const proposito = e.proposito ?? RESCATE;
		if (proposito !== RESCATE && proposito !== COMBUSTIBLE) {
			return { error: `Propósito inválido: ${proposito}. Es "${RESCATE}" o "${COMBUSTIBLE}".` };
		}
		const contexto = e.contexto ?? '';
		if (contexto && !(CONTEXTOS as readonly string[]).includes(contexto)) {
			return { error: `Contexto inválido: ${contexto}. Opciones: ${CONTEXTOS.join(', ')}, o vacío.` };
		}
		const tendencia = e.tendencia ?? '';
		if (!(TENDENCIAS as readonly string[]).includes(tendencia)) {
			return { error: `Tendencia inválida: ${tendencia}. Opciones: ${TENDENCIAS.filter(Boolean).join(' ')}, o vacío.` };
		}
		const glucosa = e.glucosa ?? null;
		if (glucosa !== null && !(Number.isInteger(glucosa) && glucosa >= 20 && glucosa <= 600)) {
			return { error: `Glucosa fuera de rango: ${glucosa}. Entero entre 20 y 600 mg/dL.` };
		}
		const nota = (e.nota ?? '').trim().slice(0, 200);

		const nombre = (e.fuente ?? TABLETA).trim();
		let tabletas: number, gramos: number, cafeina: number, fuente: string;
		if (nombre.toLowerCase() === TABLETA) {
			const n = e.tabletas;
			if (n === undefined || !(n > 0 && n <= 30)) {
				return { error: 'Con fuente "tableta" hace falta `tabletas`, entre 0.5 y 30.' };
			}
			fuente = TABLETA;
			tabletas = n;
			gramos = n * this.carbsPorTableta();
			cafeina = 0;
		} else {
			const pre = this.fuentes().find((f) => f.nombre.toLowerCase() === nombre.toLowerCase());
			if (!pre) {
				const nombres = this.fuentes().map((f) => f.nombre);
				return { error: `No hay un preajuste llamado "${nombre}". Existen: ${[TABLETA, ...nombres].join(', ')}.` };
			}
			if (e.tabletas !== undefined) {
				return { error: `Un preajuste es una unidad (un gel, una caja). Para dos ${pre.nombre}, registra dos veces.` };
			}
			fuente = pre.nombre;
			tabletas = 0;
			gramos = pre.gramos;
			cafeina = pre.cafeina;
		}

		if (!e.aunqueSeRepita) {
			const previa = this.escritura
				.prepare('SELECT * FROM tomas WHERE fecha = ? AND hora = ? AND fuente = ?')
				.get(fecha, hora, fuente) as unknown as Toma | undefined;
			if (previa) {
				return {
					error:
						`Ya hay una toma de ${fuente} el ${fecha} a las ${hora} (id ${previa.id}). ` +
						'No la registré para no duplicarla. Si de verdad fueron dos, confírmalo con Carlos y repite con aunque_se_repita.',
					previa
				};
			}
		}

		// `cliente_id` con prefijo: así se distingue lo que entró por el MCP.
		const res = this.escritura
			.prepare(
				`INSERT INTO tomas (fecha, hora, tabletas, gramos, fuente, proposito, cafeina, contexto, glucosa, tendencia, nota, creado, cliente_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(fecha, hora, tabletas, gramos, fuente, proposito, cafeina, contexto, glucosa, tendencia, nota,
				new Date().toISOString(), `mcp-${randomUUID()}`);
		const toma = this.escritura
			.prepare('SELECT * FROM tomas WHERE id = ?')
			.get(res.lastInsertRowid) as unknown as Toma;
		return { toma };
	}

	cerrar(): void {
		this.lectura.close();
		this.escritura.close();
	}
}

export type EntradaToma = {
	fecha?: string;
	hora?: string;
	fuente?: string;
	tabletas?: number;
	proposito?: string;
	contexto?: string;
	tendencia?: string;
	glucosa?: number | null;
	nota?: string;
	aunqueSeRepita?: boolean;
};

export type Resultado = { toma: Toma } | { error: string; previa?: Toma };
