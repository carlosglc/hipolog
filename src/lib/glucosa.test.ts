import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	aMinutos, flechaDe, masCercana, nivel, normalizarLecturas, partirTimestamp, subidaPorTableta
} from './glucosa.ts';

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

test('la subida por tableta promedia solo los eventos con antes y después', () => {
	const r = subidaPorTableta([
		{ tabletas: 2, glucosa: 60, glucosa30: 100 }, // +20 por tableta
		{ tabletas: 4, glucosa: 55, glucosa30: 135 }, // +20 por tableta
		{ tabletas: 2, glucosa: 70, glucosa30: null }, // sin desenlace: no cuenta
		{ tabletas: 1, glucosa: null, glucosa30: 90 }
	]);
	assert.deepEqual(r, { porTableta: 20, eventos: 2 });
	assert.equal(subidaPorTableta([{ tabletas: 2, glucosa: null, glucosa30: null }]), null);
});
