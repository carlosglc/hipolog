import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Datos } from './datos.ts';

// El esquema como lo deja la app después de todas sus migraciones.
function base(): string {
	const ruta = join(mkdtempSync(join(tmpdir(), 'hipolog-mcp-')), 'hipolog.db');
	const db = new DatabaseSync(ruta);
	db.exec(`
		PRAGMA journal_mode = WAL;
		CREATE TABLE tomas (id INTEGER PRIMARY KEY, fecha TEXT NOT NULL, hora TEXT NOT NULL, tabletas REAL NOT NULL,
			contexto TEXT NOT NULL DEFAULT '', glucosa INTEGER, tendencia TEXT NOT NULL DEFAULT '', nota TEXT NOT NULL DEFAULT '',
			creado TEXT NOT NULL, glucosa30 INTEGER, fuente TEXT NOT NULL DEFAULT 'tableta', proposito TEXT NOT NULL DEFAULT 'rescate',
			cafeina REAL NOT NULL DEFAULT 0, gramos REAL, cliente_id TEXT);
		CREATE UNIQUE INDEX tomas_cliente_id ON tomas (cliente_id);
		CREATE TABLE compras (id INTEGER PRIMARY KEY, fecha TEXT NOT NULL, tabletas INTEGER NOT NULL, costo REAL NOT NULL DEFAULT 0,
			marca TEXT NOT NULL DEFAULT '', creado TEXT NOT NULL, fuente TEXT NOT NULL DEFAULT 'tableta');
		CREATE TABLE ajustes (clave TEXT PRIMARY KEY, valor TEXT NOT NULL);
		CREATE TABLE fuentes (id INTEGER PRIMARY KEY, nombre TEXT NOT NULL, gramos REAL NOT NULL, cafeina REAL NOT NULL DEFAULT 0,
			proposito TEXT NOT NULL DEFAULT 'rescate', orden INTEGER NOT NULL DEFAULT 0);
		INSERT INTO ajustes VALUES ('carbs_por_tableta', '4');
		INSERT INTO fuentes (nombre, gramos, cafeina, orden) VALUES ('Gu Jet Blackberry', 23, -1, 1), ('Jugo de caja', 15, 0, 2);
	`);
	db.close();
	return ruta;
}

const AHORA = { fecha: '2026-09-27', hora: '18:00' };

test('una tableta vale carbs_por_tableta gramos y la marca queda como del MCP', () => {
	const d = new Datos(base());
	const r = d.registrar({ tabletas: 2, fecha: '2026-09-27', hora: '17:30' }, AHORA);
	assert.ok('toma' in r);
	assert.equal(r.toma.gramos, 8);
	assert.equal(r.toma.fuente, 'tableta');
	assert.equal(r.toma.proposito, 'rescate');
	assert.match(String((r.toma as { cliente_id?: string }).cliente_id), /^mcp-/);
});

test('sin fecha ni hora usa ahora', () => {
	const d = new Datos(base());
	const r = d.registrar({ tabletas: 1 }, AHORA);
	assert.ok('toma' in r);
	assert.equal(r.toma.fecha, '2026-09-27');
	assert.equal(r.toma.hora, '18:00');
});

test('un preajuste es una unidad con sus gramos y su cafeína, sin importar mayúsculas', () => {
	const d = new Datos(base());
	const r = d.registrar({ fuente: 'gu jet blackberry', proposito: 'combustible', hora: '07:10' }, AHORA);
	assert.ok('toma' in r);
	assert.equal(r.toma.fuente, 'Gu Jet Blackberry');
	assert.equal(r.toma.tabletas, 0);
	assert.equal(r.toma.gramos, 23);
	assert.equal(r.toma.cafeina, -1);
	assert.equal(r.toma.proposito, 'combustible');
});

test('rechaza un preajuste que no existe y dice cuáles sí', () => {
	const r = new Datos(base()).registrar({ fuente: 'Gatorade' }, AHORA);
	assert.ok('error' in r);
	assert.match(r.error, /Jugo de caja/);
});

test('un preajuste no acepta cantidad', () => {
	const r = new Datos(base()).registrar({ fuente: 'Jugo de caja', tabletas: 2 }, AHORA);
	assert.ok('error' in r);
});

test('tableta sin cantidad, fuera de rango, u hora futura: no se registra', () => {
	const d = new Datos(base());
	assert.ok('error' in d.registrar({}, AHORA));
	assert.ok('error' in d.registrar({ tabletas: 31 }, AHORA));
	assert.ok('error' in d.registrar({ tabletas: 2, hora: '18:01' }, AHORA));
	assert.ok('error' in d.registrar({ tabletas: 2, fecha: '2026-09-28', hora: '01:00' }, AHORA));
	assert.ok('error' in d.registrar({ tabletas: 2, hora: '24:00' }, AHORA));
	assert.ok('error' in d.registrar({ tabletas: 2, glucosa: 900 }, AHORA));
	assert.ok('error' in d.registrar({ tabletas: 2, contexto: 'corriendo' }, AHORA));
	assert.equal(d.tomas('2026-01-01', '2026-12-31').length, 0);
});

test('la misma fuente a la misma hora no se duplica sin confirmación', () => {
	const d = new Datos(base());
	assert.ok('toma' in d.registrar({ tabletas: 2, hora: '17:28' }, AHORA));
	const otra = d.registrar({ tabletas: 2, hora: '17:28' }, AHORA);
	assert.ok('error' in otra && otra.previa);
	assert.ok('toma' in d.registrar({ tabletas: 2, hora: '17:28', aunqueSeRepita: true }, AHORA));
	// Otra fuente a la misma hora sí es otra toma.
	assert.ok('toma' in d.registrar({ fuente: 'Jugo de caja', hora: '17:28' }, AHORA));
	assert.equal(d.tomas('2026-09-27', '2026-09-27').length, 3);
});

test('la conexión de lectura no puede escribir', () => {
	const d = new Datos(base());
	d.registrar({ tabletas: 2, hora: '10:00' }, AHORA);
	assert.throws(() => d.lectura.exec('DELETE FROM tomas'), /readonly/i);
	assert.throws(() => d.lectura.exec("UPDATE tomas SET hora = '11:00'"), /readonly/i);
	assert.equal(d.tomas('2026-09-27', '2026-09-27').length, 1);
});
