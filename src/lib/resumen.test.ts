import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumir } from './resumen.ts';
import type { Compra, Toma } from './tipos.ts';

const toma = (fecha: string, hora: string, tabletas: number, contexto = ''): Toma => ({
	id: 0, fecha, hora, tabletas, gramos: tabletas * 4, fuente: 'tableta',
	proposito: 'rescate', cafeina: 0,
	contexto, glucosa: null, glucosa30: null, tendencia: '', nota: ''
});
/** Un rescate que no sale del frasco: no debe tocar el inventario. */
const otraFuente = (fecha: string, hora: string, gramos: number, nombre: string): Toma => ({
	id: 0, fecha, hora, tabletas: 0, gramos, fuente: nombre,
	proposito: 'rescate', cafeina: 0,
	contexto: '', glucosa: null, glucosa30: null, tendencia: '', nota: ''
});
/** Combustible: cuenta como evento del día pero NO como hipoglucemia. */
const combustible = (fecha: string, hora: string, gramos: number, nombre: string): Toma => ({
	id: 0, fecha, hora, tabletas: 0, gramos, fuente: nombre,
	proposito: 'combustible', cafeina: 0,
	contexto: 'ejercicio', glucosa: null, glucosa30: null, tendencia: '', nota: ''
});
const compra = (fecha: string, tabletas: number, costo = 0, fuente = 'tableta'): Compra => ({
	id: 0, fecha, tabletas, fuente, costo, marca: ''
});
/** Un gel del paquete: 1 evento = 1 unidad. */
const gu = (hora: string, sabor: string, gramos = 23, cafeina = 0): Toma => ({
	id: 0, fecha: '2026-09-22', hora, tabletas: 0, gramos, fuente: sabor,
	proposito: 'rescate', cafeina,
	contexto: 'ejercicio', glucosa: null, glucosa30: null, tendencia: '', nota: ''
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

test('un jugo cuenta como evento pero no descuenta del frasco', () => {
	const r = resumir(
		[toma('2026-09-21', '15:30', 2), otraFuente('2026-09-21', '18:00', 15, 'Jugo de caja')],
		[compra('2026-09-01', 50)], 4, '2026-09-21'
	);
	assert.equal(r.existencias, 48); // 50 − 2 tabletas, el jugo no resta
	assert.equal(r.consumidas, 2);
	assert.equal(r.hoyEventos, 2); // pero sí fue una baja más
	assert.equal(r.hoyGramos, 23); // 8 g de tabletas + 15 del jugo
	assert.equal(r.hoyTabletas, 2);
	assert.deepEqual(r.porFuente.map((f) => f.llave).sort(), ['Jugo de caja', 'tableta']);
});

test('el ritmo del inventario ignora las fuentes que no son tabletas', () => {
	const soloJugos = resumir(
		[otraFuente('2026-09-21', '18:00', 15, 'Jugo de caja')],
		[compra('2026-09-01', 50)], 4, '2026-09-21'
	);
	assert.equal(soloJugos.porDia, 0);
	assert.equal(soloJugos.diasRestantes, null); // no hay ritmo que proyectar
	assert.equal(soloJugos.existencias, 50);
});

test('el combustible no cuenta como hipoglucemia', () => {
	const r = resumir(
		[
			toma('2026-09-22', '13:00', 2, 'sin razón clara'),
			combustible('2026-09-22', '17:53', 22, 'Gu Lemon Sublime'),
			combustible('2026-09-22', '18:12', 22, 'Gu Strawberry Banana')
		],
		[compra('2026-09-01', 50)], 4, '2026-09-22'
	);
	assert.equal(r.hoyEventos, 3); // los tres pasaron
	assert.equal(r.hoyRescates, 1); // pero solo uno fue una baja
	assert.equal(r.hoyCombustible, 2);
	assert.equal(r.hoyGramos, 52); // 8 + 22 + 22
	// El patrón de las bajas ignora el combustible: si no, diría que te bajas
	// haciendo ejercicio cuando en realidad estabas evitándolo.
	assert.deepEqual(r.porContexto.map((c) => c.llave), ['sin razón clara']);
	assert.equal(r.existencias, 48); // ningún Gu sale del frasco
});

test('un paquete de Gu NO infla el stock de tabletas', () => {
	const r = resumir(
		[toma('2026-09-22', '13:00', 2)],
		[compra('2026-09-01', 50, 599), compra('2026-09-22', 5, 227.08, 'Gu Strawberry Banana')],
		4, '2026-09-22'
	);
	assert.equal(r.compradas, 50); // no 55
	assert.equal(r.existencias, 48);
	assert.equal(r.costoPorTableta, 11.98); // $599 / 50, sin el costo de los Gu
});

test('el inventario de Gu es por sabor: el paquete real de Carlos', () => {
	// 24 geles por $1090, y los 3 que se comió el 22/09/2026.
	const porGel = 1090 / 24;
	const paquete = [
		['Gu Lemon Sublime', 4], ['Gu Salted Watermelon', 5], ['Gu Strawberry Banana', 5],
		['Gu Jet Blackberry', 5], ['Gu Mandarin Orange', 5]
	].map(([f, n]) => compra('2026-09-22', n as number, (n as number) * porGel, f as string));
	const r = resumir(
		[gu('17:53', 'Gu Lemon Sublime', 22), gu('17:57', 'Gu Lemon Sublime', 22),
		 gu('18:12', 'Gu Strawberry Banana', 23)],
		[compra('2026-09-01', 50, 599), ...paquete], 4, '2026-09-22'
	);
	const de = (f: string) => r.inventario.find((i) => i.fuente === f)!;
	assert.equal(de('Gu Lemon Sublime').quedan, 2); // 4 − 2
	assert.equal(de('Gu Strawberry Banana').quedan, 4); // 5 − 1
	assert.equal(de('Gu Mandarin Orange').quedan, 5); // intactos
	assert.equal(r.inventario.reduce((s, i) => s + i.quedan, 0), 21);
	assert.ok(Math.abs(de('Gu Lemon Sublime').costoUnidad! - 45.4167) < 0.001);
	assert.equal(r.existencias, 50); // ningún Gu tocó las tabletas
	assert.equal(r.hoyGramos, 67); // 22 + 22 + 23
});

test('la cafeína sin dato se reporta aparte, no se suma', () => {
	const r = resumir(
		[gu('17:00', 'Gu Jet Blackberry', 23, -1), gu('18:00', 'Café', 10, 80), gu('19:00', 'Gu Lemon Sublime', 22, 0)],
		[], 4, '2026-09-22'
	);
	assert.deepEqual(r.hoyCafeina, { mg: 80, sinDato: 1 }); // nunca 79
});

test('las bajas del día y su patrón se cuentan por episodio, no por tap', () => {
	const r = resumir(
		[toma('2026-09-25', '03:21', 2, 'nocturna'), toma('2026-09-25', '03:21', 1, 'nocturna')],
		[compra('2026-09-01', 50)], 4, '2026-09-25'
	);
	assert.equal(r.hoyRescates, 1); // una baja, aunque fueron dos taps
	assert.equal(r.hoyEventos, 2); // los dos taps siguen existiendo
	assert.deepEqual(r.porFranja.map((f) => [f.llave, f.eventos]), [['madrugada', 1]]);
	assert.equal(r.existencias, 47); // el inventario sí cuenta las 3 tabletas
});

test('la serie trae 14 días, con ceros y el de hoy al final', () => {
	const r = resumir([toma('2026-09-21', '15:30', 2)], [], 4, '2026-09-21');
	assert.equal(r.serie.length, 14);
	assert.equal(r.serie[0].fecha, '2026-09-08');
	assert.equal(r.serie[0].tabletas, 0);
	assert.equal(r.serie.at(-1)?.fecha, '2026-09-21');
	assert.equal(r.serie.at(-1)?.tabletas, 2);
	assert.equal(r.serie.at(-1)?.gramos, 8);
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
