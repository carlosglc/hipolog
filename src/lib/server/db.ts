import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Compra, Toma } from '$lib/tipos';

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
`);

// Migración: la columna llegó después de las primeras tomas. Guarda la
// glucosa 30 min DESPUÉS de la toma, que es lo que dice si las tabletas
// alcanzaron. CareLink solo conserva 24 h, así que si no se copia aquí,
// ese dato se pierde para siempre.
const columnas = db.prepare('PRAGMA table_info(tomas)').all() as unknown as { name: string }[];
if (!columnas.some((c) => c.name === 'glucosa30')) {
	db.exec('ALTER TABLE tomas ADD COLUMN glucosa30 INTEGER');
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

export function tomas(): Toma[] {
	return db
		.prepare('SELECT * FROM tomas ORDER BY fecha DESC, hora DESC, id DESC')
		.all() as unknown as Toma[];
}

/** Devuelve el id insertado, para poder completarlo después con la glucosa. */
export function agregarToma(t: Omit<Toma, 'id' | 'glucosa30'>): number {
	const res = db.prepare(
		`INSERT INTO tomas (fecha, hora, tabletas, contexto, glucosa, tendencia, nota, creado)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		t.fecha,
		t.hora,
		t.tabletas,
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
		'INSERT INTO compras (fecha, tabletas, costo, marca, creado) VALUES (?, ?, ?, ?, ?)'
	).run(c.fecha, c.tabletas, c.costo, c.marca, new Date().toISOString());
}

export function borrarCompra(id: number): void {
	db.prepare('DELETE FROM compras WHERE id = ?').run(id);
}
