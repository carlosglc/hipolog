import { test } from 'node:test';
import assert from 'node:assert/strict';
import { episodios } from './episodios.ts';
import type { Toma } from './tipos.ts';

const tap = (fecha: string, hora: string, gramos: number, o: Partial<Toma> = {}): Toma => ({
	id: 0, fecha, hora, tabletas: gramos / 4, gramos, fuente: 'tableta', proposito: 'rescate',
	cafeina: 0, contexto: '', glucosa: null, glucosa30: null, tendencia: '', nota: '', ...o
});

test('dos taps en el mismo minuto son una sola baja', () => {
	const e = episodios([tap('2026-09-25', '03:21', 8), tap('2026-09-25', '03:21', 4)]);
	assert.equal(e.length, 1);
	assert.equal(e[0].gramos, 12);
	assert.equal(e[0].hora, '03:21');
});

test('a más de 15 minutos del tap anterior empieza otra baja', () => {
	const e = episodios([tap('2026-09-25', '03:00', 8), tap('2026-09-25', '03:16', 8)]);
	assert.equal(e.length, 2);
});

test('la ventana se mide contra el tap ANTERIOR, no contra el primero', () => {
	// 0, 10 y 20 min: cada uno está a 10 del anterior, así que es una sola corrección.
	const e = episodios([tap('2026-09-25', '03:00', 8), tap('2026-09-25', '03:10', 4), tap('2026-09-25', '03:20', 4)]);
	assert.equal(e.length, 1);
	assert.equal(e[0].gramos, 16);
});

test('una baja que cruza la medianoche sigue siendo una', () => {
	const e = episodios([tap('2026-09-24', '23:55', 8), tap('2026-09-25', '00:05', 4)]);
	assert.equal(e.length, 1);
	assert.equal(e[0].fecha, '2026-09-24'); // cuenta en el día en que empezó
});

test('el después es a los 30 min de la ÚLTIMA dosis, no de cualquiera', () => {
	const e = episodios([
		tap('2026-09-25', '03:00', 8, { glucosa: 55, glucosa30: 70 }),
		tap('2026-09-25', '03:10', 4, { glucosa: 58, glucosa30: null }) // aún no pasan 30 min
	]);
	assert.equal(e[0].glucosa, 55); // al empezar la corrección
	assert.equal(e[0].glucosa30, null); // no se toma el 70 del primer tap: mediría de más temprano
});

test('el ejercicio y las fuentes se heredan de cualquiera de sus taps', () => {
	const e = episodios([
		tap('2026-09-22', '17:53', 22, { fuente: 'Gu Lemon Sublime', contexto: 'ejercicio' }),
		tap('2026-09-22', '17:57', 22, { fuente: 'Gu Lemon Sublime', contexto: 'ejercicio' }),
		tap('2026-09-22', '18:12', 23, { fuente: 'Gu Strawberry Banana', contexto: 'ejercicio' })
	]);
	assert.equal(e.length, 1); // 17:53 → 17:57 → 18:12, cada uno a ≤ 15 min del anterior
	assert.equal(e[0].ejercicio, true);
	assert.deepEqual(e[0].fuentes, ['Gu Lemon Sublime', 'Gu Strawberry Banana']);
});
