// Carga los dos eventos del 21/09/2026 y un frasco de inventario.
// Idempotente: no duplica si ya están.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ruta = resolve(process.env.HIPOLOG_DB ?? 'datos/hipolog.db');
mkdirSync(dirname(ruta), { recursive: true });
const db = new DatabaseSync(ruta);

db.exec(`
	CREATE TABLE IF NOT EXISTS tomas (
		id INTEGER PRIMARY KEY, fecha TEXT NOT NULL, hora TEXT NOT NULL,
		tabletas REAL NOT NULL, contexto TEXT NOT NULL DEFAULT '', glucosa INTEGER,
		tendencia TEXT NOT NULL DEFAULT '', nota TEXT NOT NULL DEFAULT '', creado TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS compras (
		id INTEGER PRIMARY KEY, fecha TEXT NOT NULL, tabletas INTEGER NOT NULL,
		costo REAL NOT NULL DEFAULT 0, marca TEXT NOT NULL DEFAULT '', creado TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS ajustes (clave TEXT PRIMARY KEY, valor TEXT NOT NULL);
`);

const tomas = [
	{ fecha: '2026-09-21', hora: '15:30', tabletas: 2, contexto: 'antes de comer', tendencia: '', nota: 'cerca del límite bajo' },
	{ fecha: '2026-09-21', hora: '19:30', tabletas: 4, contexto: 'ejercicio', tendencia: '↓↓', nota: 'bajando durante el ejercicio' }
];

let nuevas = 0;
for (const t of tomas) {
	const existe = db
		.prepare('SELECT 1 FROM tomas WHERE fecha = ? AND hora = ?')
		.get(t.fecha, t.hora);
	if (existe) continue;
	db.prepare(
		`INSERT INTO tomas (fecha, hora, tabletas, contexto, glucosa, tendencia, nota, creado)
		 VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`
	).run(t.fecha, t.hora, t.tabletas, t.contexto, t.tendencia, t.nota, new Date().toISOString());
	nuevas++;
}

// Inventario inicial: ajústalo a lo que realmente compraste.
const hayCompras = db.prepare('SELECT COUNT(*) AS n FROM compras').get().n;
if (!hayCompras) {
	db.prepare(
		'INSERT INTO compras (fecha, tabletas, costo, marca, creado) VALUES (?, ?, ?, ?, ?)'
	).run('2026-09-21', 50, 0, '', new Date().toISOString());
	db.prepare("INSERT OR REPLACE INTO ajustes (clave, valor) VALUES ('tabletas_por_frasco', '10')").run();
}

console.log(`seed: ${nuevas} toma(s) nueva(s) en ${ruta}`);
