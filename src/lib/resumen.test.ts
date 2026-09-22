import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumir } from './resumen.ts';
import type { Compra, Toma } from './tipos.ts';

const toma = (fecha: string, hora: string, tabletas: number, contexto = ''): Toma => ({
	id: 0, fecha, hora, tabletas, contexto, glucosa: null, tendencia: '', nota: ''
});
const compra = (fecha: string, tabletas: number, costo = 0): Compra => ({
	id: 0, fecha, tabletas, costo, marca: ''
});

test('el stock es lo comprado menos lo consumido', () => {
	const r = resumir([toma('2026-09-21', '15:30', 2), toma('2026-09-21', '19:30', 4)],
		[compra('2026-09-01', 50)], 4, '2026-09-21');
	assert.equal(r.existencias, 44);
	assert.equal(r.hoyTabletas, 6);
	assert.equal(r.hoyEventos, 2);
});

test('el ritmo usa la ventana real cuando el historial es corto', () => {
	// Una sola toma hoy: la ventana es 1 día, no 30.
	const r = resumir([toma('2026-09-21', '19:30', 6)], [compra('2026-09-21', 30)], 4, '2026-09-21');
	assert.equal(r.ventana, 1);
	assert.equal(r.porDia, 6);
	assert.equal(r.porSemana, 42);
	assert.equal(r.diasRestantes, 4); // 24 restantes / 6 por día
	assert.equal(r.seAcabaEl, '2026-09-25');
});

test('el promedio de 30 días reparte entre los días sin tomas', () => {
	const tomas = [toma('2026-08-25', '10:00', 4), toma('2026-09-20', '22:00', 2)];
	const r = resumir(tomas, [compra('2026-08-01', 60)], 4, '2026-09-21');
	assert.equal(r.ventana, 28); // 25 ago → 21 sep, tope de 30
	assert.equal(r.consumidas, 6);
	assert.ok(Math.abs(r.porDia - 6 / 28) < 1e-9);
});

test('sin compras no hay proyección ni costo, pero no truena', () => {
	const r = resumir([toma('2026-09-21', '15:30', 2)], [], 4, '2026-09-21');
	assert.equal(r.existencias, -2);
	assert.equal(r.diasRestantes, null);
	assert.equal(r.seAcabaEl, null);
	assert.equal(r.costoPorTableta, null);
	assert.equal(r.costoMensual, null);
});

test('el costo mensual sale del promedio ponderado de las compras con precio', () => {
	const r = resumir([toma('2026-09-21', '15:30', 2)],
		[compra('2026-09-01', 50, 250), compra('2026-09-10', 10)], 4, '2026-09-21');
	assert.equal(r.costoPorTableta, 5); // el frasco sin precio no diluye el promedio
	assert.equal(r.costoMensual, 300); // 2/día × 30 × $5
});

test('la serie trae 14 días, con ceros y el de hoy al final', () => {
	const r = resumir([toma('2026-09-21', '15:30', 2)], [], 4, '2026-09-21');
	assert.equal(r.serie.length, 14);
	assert.equal(r.serie[0].fecha, '2026-09-08');
	assert.equal(r.serie[0].tabletas, 0);
	assert.equal(r.serie.at(-1)?.fecha, '2026-09-21');
	assert.equal(r.serie.at(-1)?.tabletas, 2);
});

test('agrupa por contexto y por franja horaria', () => {
	const r = resumir([
		toma('2026-09-21', '15:30', 2, 'antes de comer'),
		toma('2026-09-21', '19:30', 4, 'ejercicio'),
		toma('2026-09-20', '03:10', 3, 'nocturna')
	], [], 4, '2026-09-21');
	assert.deepEqual(r.porContexto.map((c) => c.llave).sort(),
		['antes de comer', 'ejercicio', 'nocturna']);
	assert.deepEqual(r.porFranja.map((f) => f.llave).sort(),
		['madrugada', 'noche', 'tarde']);
});
