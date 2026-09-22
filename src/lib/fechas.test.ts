import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aFecha, diasEntre, etiquetaLarga, franja, sumarDias } from './fechas.ts';

test('sumar días cruza fin de mes y año bisiesto sin correrse', () => {
	assert.equal(sumarDias('2026-03-01', -1), '2026-02-28');
	assert.equal(sumarDias('2026-12-31', 1), '2027-01-01');
	assert.equal(sumarDias('2024-02-28', 1), '2024-02-29');
});

test('una fecha YYYY-MM-DD se lee local: ida y vuelta sin perder el día', () => {
	// El bug clásico es new Date('2026-09-21') → UTC → 20 de septiembre en México.
	assert.equal(aFecha(new Date(2026, 8, 21, 0, 30)), '2026-09-21');
	assert.equal(aFecha(new Date(2026, 8, 21, 23, 30)), '2026-09-21');
	assert.equal(diasEntre('2026-09-01', '2026-09-21'), 20);
});

test('hoy y ayer se nombran, el resto lleva fecha', () => {
	assert.equal(etiquetaLarga('2026-09-21', '2026-09-21'), 'hoy');
	assert.equal(etiquetaLarga('2026-09-20', '2026-09-21'), 'ayer');
	assert.equal(etiquetaLarga('2026-09-18', '2026-09-21'), 'vie 18 sep');
});

test('las franjas parten el día donde importa para las bajas', () => {
	assert.equal(franja('03:10'), 'madrugada');
	assert.equal(franja('09:00'), 'mañana');
	assert.equal(franja('15:30'), 'tarde');
	assert.equal(franja('19:30'), 'noche');
});
