import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CAFEINA_SIN_DATO, type Compra, type Fuente, type Toma } from '$lib/tipos';

// Una sola base SQLite. HIPOLOG_DB permite ponerla fuera del repo (en el
// homelab conviene: así `git pull` y los respaldos no se pisan).
export const ruta = resolve(process.env.HIPOLOG_DB ?? 'datos/hipolog.db');
mkdirSync(dirname(ruta), { recursive: true });

const db = new DatabaseSync(ruta);
db.exec(`
	PRAGMA journal_mode = WAL;
	CREATE TABLE IF NOT EXISTS tomas (
		id INTEGER PRIMARY KEY,
		fecha TEXT NOT NULL,
		hora TEXT NOT NULL,
		tabletas REAL NOT NULL,
		contexto TEXT NOT NULL DEFAULT '',
		glucosa INTEGER,
		tendencia TEXT NOT NULL DEFAULT '',
		nota TEXT NOT NULL DEFAULT '',
		creado TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS tomas_fecha ON tomas (fecha);
	CREATE TABLE IF NOT EXISTS compras (
		id INTEGER PRIMARY KEY,
		fecha TEXT NOT NULL,
		tabletas INTEGER NOT NULL,
		costo REAL NOT NULL DEFAULT 0,
		marca TEXT NOT NULL DEFAULT '',
		creado TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS ajustes (clave TEXT PRIMARY KEY, valor TEXT NOT NULL);
	-- Atajos de rescate que no son tabletas: un jugo, unos dulces, una fruta.
	-- Son preajustes que Carlos define una vez, NO un catálogo de alimentos:
	-- en una baja no se busca en una lista, se toca un botón.
	CREATE TABLE IF NOT EXISTS fuentes (
		id INTEGER PRIMARY KEY,
		nombre TEXT NOT NULL,
		gramos REAL NOT NULL,
		cafeina REAL NOT NULL DEFAULT 0,
		proposito TEXT NOT NULL DEFAULT 'rescate',
		orden INTEGER NOT NULL DEFAULT 0
	);
`);

// Migración: la columna llegó después de las primeras tomas. Guarda la
// glucosa 30 min DESPUÉS de la toma, que es lo que dice si las tabletas
// alcanzaron. CareLink solo conserva 24 h, así que si no se copia aquí,
// ese dato se pierde para siempre.
const columnas = db.prepare('PRAGMA table_info(tomas)').all() as unknown as { name: string }[];
const tiene = (c: string) => columnas.some((x) => x.name === c);
if (!tiene('glucosa30')) {
	db.exec('ALTER TABLE tomas ADD COLUMN glucosa30 INTEGER');
}

// Migración: un rescate puede no ser una tableta.
//
// `fuente` separa los dos trabajos que hacía la columna `tabletas`: el
// INVENTARIO (cuánto queda, a qué ritmo, cuándo se acaba) solo cuenta
// fuente='tableta', porque un jugo no sale del frasco. El LOG de
// hipoglucemias cuenta todo, porque una baja corregida con jugo sigue
// siendo una baja y hasta ahora era invisible.
//
// `gramos` es la unidad común: la corrección de una hipoglucemia se mide
// en gramos de carbohidrato, y la tableta es solo un vehículo de 4 g.
if (!tiene('fuente')) {
	db.exec("ALTER TABLE tomas ADD COLUMN fuente TEXT NOT NULL DEFAULT 'tableta'");
}
// Un gel a media corrida NO es una hipoglucemia: es combustible para que no
// baje. Contarlo como rescate inflaría el conteo de bajas y arruinaría la
// métrica de cuánto sube cada cosa, que solo tiene sentido partiendo de una
// baja real. El propósito separa las dos intenciones del mismo acto.
if (!tiene('proposito')) {
	db.exec("ALTER TABLE tomas ADD COLUMN proposito TEXT NOT NULL DEFAULT 'rescate'");
}
// El sabor importa: unos Gu traen cafeína y otros no.
if (!tiene('cafeina')) {
	db.exec('ALTER TABLE tomas ADD COLUMN cafeina REAL NOT NULL DEFAULT 0');
}
if (!tiene('gramos')) {
	db.exec('ALTER TABLE tomas ADD COLUMN gramos REAL');
	// Las filas viejas son todas tabletas: sus gramos se derivan del ajuste.
	const porTableta = Number(
		(db.prepare("SELECT valor FROM ajustes WHERE clave = 'carbs_por_tableta'").get() as
			| { valor: string }
			| undefined)?.valor ?? 4
	) || 4;
	db.prepare('UPDATE tomas SET gramos = tabletas * ? WHERE gramos IS NULL').run(porTableta);
}

// Inventario por fuente: una compra puede ser un bote de tabletas o un
// paquete de geles. En esta tabla `tabletas` significa UNIDADES de esa
// fuente — tabletas para las tabletas, geles para un Gu.
const colCompras = db.prepare('PRAGMA table_info(compras)').all() as unknown as { name: string }[];
if (!colCompras.some((c) => c.name === 'fuente')) {
	db.exec("ALTER TABLE compras ADD COLUMN fuente TEXT NOT NULL DEFAULT 'tableta'");
}

// Migración de la tabla de preajustes, que nació sin estas dos columnas.
const colFuentes = db.prepare('PRAGMA table_info(fuentes)').all() as unknown as { name: string }[];
if (!colFuentes.some((c) => c.name === 'cafeina')) {
	db.exec('ALTER TABLE fuentes ADD COLUMN cafeina REAL NOT NULL DEFAULT 0');
}
if (!colFuentes.some((c) => c.name === 'proposito')) {
	db.exec("ALTER TABLE fuentes ADD COLUMN proposito TEXT NOT NULL DEFAULT 'rescate'");
}

// Preajustes iniciales, solo la primera vez. Se editan desde la UI.
//
// Son los sabores del paquete de Gu que Carlos compró el 22/09/2026. La
// cafeína sí/no viene del empaque y es certeza. Los miligramos no: van como
// CAFEINA_SIN_DATO, que la UI muestra como «con cafeína» sin inventar número.
// De los gramos solo Strawberry Banana (23) está confirmado contra etiqueta.
if (!(db.prepare('SELECT COUNT(*) AS n FROM fuentes').get() as { n: number }).n) {
	const ins = db.prepare(
		'INSERT INTO fuentes (nombre, gramos, cafeina, proposito, orden) VALUES (?, ?, ?, ?, ?)'
	);
	ins.run('Gu Lemon Sublime', 22, 0, 'rescate', 1);
	ins.run('Gu Salted Watermelon', 23, 0, 'rescate', 2);
	ins.run('Gu Strawberry Banana', 23, 0, 'rescate', 3);
	ins.run('Gu Jet Blackberry', 23, CAFEINA_SIN_DATO, 'rescate', 4);
	ins.run('Gu Mandarin Orange', 23, CAFEINA_SIN_DATO, 'rescate', 5);
	ins.run('Jugo de caja', 15, 0, 'rescate', 6);
	ins.run('Dulces', 10, 0, 'rescate', 7);
}

export function ajuste(clave: string, porDefecto: string): string {
	const fila = db.prepare('SELECT valor FROM ajustes WHERE clave = ?').get(clave) as
		| { valor: string }
		| undefined;
	return fila?.valor ?? porDefecto;
}

export function guardarAjuste(clave: string, valor: string): void {
	db.prepare(
		'INSERT INTO ajustes (clave, valor) VALUES (?, ?) ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor'
	).run(clave, valor);
}

export function fuentes(): Fuente[] {
	return db
		.prepare('SELECT * FROM fuentes ORDER BY orden, id')
		.all() as unknown as Fuente[];
}

export function agregarFuente(
	nombre: string,
	gramos: number,
	cafeina: number,
	proposito: string
): void {
	const max = (db.prepare('SELECT COALESCE(MAX(orden), 0) AS m FROM fuentes').get() as { m: number }).m;
	db.prepare(
		'INSERT INTO fuentes (nombre, gramos, cafeina, proposito, orden) VALUES (?, ?, ?, ?, ?)'
	).run(nombre, gramos, cafeina, proposito, max + 1);
}

export function fuente(id: number): Fuente | undefined {
	return db.prepare('SELECT * FROM fuentes WHERE id = ?').get(id) as unknown as Fuente | undefined;
}

/** Para corregir los gramos o la cafeína cuando Carlos los lee en la etiqueta. */
export function actualizarFuente(id: number, gramos: number, cafeina: number): void {
	db.prepare('UPDATE fuentes SET gramos = ?, cafeina = ? WHERE id = ?').run(gramos, cafeina, id);
}

export function borrarFuente(id: number): void {
	db.prepare('DELETE FROM fuentes WHERE id = ?').run(id);
}

export function tomas(): Toma[] {
	return db
		.prepare('SELECT * FROM tomas ORDER BY fecha DESC, hora DESC, id DESC')
		.all() as unknown as Toma[];
}

/** Devuelve el id insertado, para poder completarlo después con la glucosa. */
export function agregarToma(t: Omit<Toma, 'id' | 'glucosa30'>): number {
	const res = db.prepare(
		`INSERT INTO tomas (fecha, hora, tabletas, gramos, fuente, proposito, cafeina, contexto, glucosa, tendencia, nota, creado)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		t.fecha,
		t.hora,
		t.tabletas,
		t.gramos,
		t.fuente,
		t.proposito,
		t.cafeina,
		t.contexto,
		t.glucosa,
		t.tendencia,
		t.nota,
		new Date().toISOString()
	);
	return Number(res.lastInsertRowid);
}

/** Completa una toma con lo que dijo el sensor. Solo rellena lo que falta. */
export function completarGlucosa(id: number, glucosa: number | null, glucosa30: number | null): void {
	db.prepare(
		`UPDATE tomas
		    SET glucosa   = COALESCE(glucosa, ?),
		        glucosa30 = COALESCE(glucosa30, ?)
		  WHERE id = ?`
	).run(glucosa, glucosa30, id);
}

export function borrarToma(id: number): void {
	db.prepare('DELETE FROM tomas WHERE id = ?').run(id);
}

export function compras(): Compra[] {
	return db
		.prepare('SELECT * FROM compras ORDER BY fecha DESC, id DESC')
		.all() as unknown as Compra[];
}

export function agregarCompra(c: Omit<Compra, 'id'>): void {
	db.prepare(
		'INSERT INTO compras (fecha, tabletas, fuente, costo, marca, creado) VALUES (?, ?, ?, ?, ?, ?)'
	).run(c.fecha, c.tabletas, c.fuente, c.costo, c.marca, new Date().toISOString());
}

export function borrarCompra(id: number): void {
	db.prepare('DELETE FROM compras WHERE id = ?').run(id);
}
