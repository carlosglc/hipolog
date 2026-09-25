import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	aMinutos, flechaDe, masCercana, nivel, normalizarLecturas, partirTimestamp, subidaPorFuente,
	tendenciaCalculada
} from './glucosa.ts';
import { episodios } from './episodios.ts';
import type { Toma } from './tipos.ts';

test('sg = 0 es un hueco, no un cero', () => {
	// Tal cual viene en los volcados de CareLink cuando no hay lectura aún.
	const l = normalizarLecturas([
		{ sg: 0, sensorState: 'NO_DATA_FROM_PUMP', timestamp: '2026-09-21T19:25:00' },
		{ sg: 61, sensorState: 'NO_ERROR_MESSAGE', timestamp: '2026-09-21T19:30:00' }
	]);
	assert.equal(l.length, 1);
	assert.deepEqual(l[0], { fecha: '2026-09-21', hora: '19:30', minutos: 1170, sg: 61 });
});

test('el timestamp de CareLink se parte como local, sin Date', () => {
	assert.deepEqual(partirTimestamp('2026-09-10T22:47:31'), { fecha: '2026-09-10', hora: '22:47' });
	assert.equal(partirTimestamp('basura'), null);
	assert.equal(aMinutos('19:30'), 1170);
});

test('las flechas se deducen del nombre y lo desconocido se muestra crudo', () => {
	assert.equal(flechaDe('DOWN'), '↓');          // observado en los volcados
	assert.equal(flechaDe('UP'), '↑');            // observado en los volcados
	assert.equal(flechaDe('DOWN_DOUBLE'), '↓↓');
	assert.equal(flechaDe('UP_TRIPLE'), '↑↑↑');
	assert.equal(flechaDe('NONE'), '');
	assert.equal(flechaDe(null), '');
	assert.equal(flechaDe('ALGO_NUEVO'), 'ALGO_NUEVO');
});

test('un hueco del sensor no se rellena con una lectura lejana', () => {
	const l = normalizarLecturas([
		{ sg: 80, timestamp: '2026-09-21T19:00:00' },
		{ sg: 95, timestamp: '2026-09-21T20:00:00' }
	]);
	assert.equal(masCercana(l, '2026-09-21', '19:03')?.sg, 80);
	assert.equal(masCercana(l, '2026-09-21', '19:30'), null); // 30 min de distancia
	assert.equal(masCercana(l, '2026-09-20', '19:00'), null); // otro día
});

test('los límites parten en bajo, rango y alto', () => {
	assert.equal(nivel(61), 'bajo');
	assert.equal(nivel(69), 'bajo');
	assert.equal(nivel(70), 'rango');
	assert.equal(nivel(180), 'rango');
	assert.equal(nivel(181), 'alto');
	assert.equal(nivel(null), 'sin');
});

/** Una toma de rescate con la glucosa ya rellenada por el sensor. */
const rescate = (
	hora: string, gramos: number, fuente: string, glucosa: number | null, glucosa30: number | null,
	contexto = '', fecha = '2026-09-21'
): Toma => ({
	id: 0, fecha, hora, tabletas: fuente === 'tableta' ? gramos / 4 : 0, gramos, fuente,
	proposito: 'rescate', cafeina: 0, contexto, glucosa, glucosa30, tendencia: '', nota: ''
});

test('la subida se normaliza a 15 g y compara entre fuentes', () => {
	// Los tres rescates reales del 21/09/2026, más un jugo.
	const r = subidaPorFuente(episodios([
		rescate('15:30', 8, 'tableta', 74, 96, 'antes de comer'),
		rescate('19:30', 16, 'tableta', 134, 97, 'ejercicio'),
		rescate('21:49', 16, 'tableta', 68, 142),
		rescate('22:40', 15, 'Jugo de caja', 62, 140)
	]));
	assert.equal(r?.enEjercicio, 1); // la de ejercicio no entra al cálculo
	const tab = r?.fuentes.find((f) => f.fuente === 'tableta');
	assert.equal(tab?.eventos, 2);
	assert.equal(tab?.por15g, 55.3125); // mediana de 41.25 y 69.375
	assert.equal(r?.fuentes.find((f) => f.fuente === 'Jugo de caja')?.por15g, 78);
});

test('+2 y +1 en la misma baja cuentan como UNA, con los 12 g juntos', () => {
	// El caso real del 25/09/2026, 03:21: sin botón +3, dos taps en el mismo minuto.
	const r = subidaPorFuente(episodios([
		rescate('03:21', 8, 'tableta', 55, 62, '', '2026-09-25'),
		rescate('03:21', 4, 'tableta', 55, 62, '', '2026-09-25')
	]));
	const tab = r?.fuentes.find((f) => f.fuente === 'tableta');
	assert.equal(tab?.eventos, 1); // una baja, no dos
	assert.equal(tab?.por15g, 8.75); // (62 − 55) ÷ 12 g × 15, no +26 ni +13
});

test('una baja que mezcla fuentes no se le atribuye a ninguna', () => {
	const r = subidaPorFuente(episodios([
		rescate('10:00', 8, 'tableta', 60, 90),
		rescate('10:05', 23, 'Gu Strawberry Banana', 60, 110)
	]));
	assert.equal(r, null);
});

test('sin bajas en reposo no se inventa un número', () => {
	assert.equal(subidaPorFuente(episodios([rescate('19:30', 16, 'tableta', 134, 97, 'ejercicio')])), null);
	assert.equal(subidaPorFuente(episodios([rescate('15:30', 8, 'tableta', null, null)])), null);
});

test('la tendencia calculada usa la pendiente de los últimos minutos', () => {
	const serie = (valores: number[]) =>
		normalizarLecturas(
			valores.map((sg, i) => ({ sg, timestamp: `2026-09-21T23:${String(10 + i * 5).padStart(2, '0')}:00` }))
		);
	// 15 mg/dL en 15 min = 1 por minuto → una flecha
	assert.equal(tendenciaCalculada(serie([100, 105, 110, 115]))?.flecha, '↑');
	// 45 en 15 min = 3 por minuto → tres flechas abajo
	assert.equal(tendenciaCalculada(serie([145, 130, 115, 100]))?.flecha, '↓↓↓');
	// casi plano
	assert.equal(tendenciaCalculada(serie([120, 121, 120, 122]))?.flecha, '→');
	assert.equal(tendenciaCalculada([]), null);
});

test('la ventana de la tendencia cruza la medianoche sin romperse', () => {
	const l = normalizarLecturas([
		{ sg: 120, timestamp: '2026-09-21T23:50:00' },
		{ sg: 110, timestamp: '2026-09-21T23:55:00' },
		{ sg: 100, timestamp: '2026-09-22T00:00:00' }
	]);
	const t = tendenciaCalculada(l);
	assert.equal(t?.flecha, '↓↓');
	assert.ok(Math.abs(t!.porMinuto + 2) < 1e-9); // −2 mg/dL por minuto
});
