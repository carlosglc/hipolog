import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	enviarPendiente, guardarBandeja, leerBandeja, momentoLocal, nuevoId, type Pendiente
} from './bandeja.ts';

/** Un almacén en memoria con la misma interfaz que localStorage. */
const almacen = () => {
	const m = new Map<string, string>();
	return {
		getItem: (k: string) => m.get(k) ?? null,
		setItem: (k: string, v: string) => void m.set(k, v),
		removeItem: (k: string) => void m.delete(k),
		clear: () => m.clear(),
		key: () => null,
		length: 0
	} as Storage;
};

// El tap de las 17:19 del 26/09/2026, el primero que se perdió sin señal.
const tap = (o: Partial<Pendiente> = {}): Pendiente => ({
	id: '4f6c2b1e-7d3a-4e8b-9c1f-2a5d6e7f8a9b',
	accion: 'registrar',
	campos: { tabletas: '2', proposito: 'rescate' },
	fecha: '2026-09-26',
	hora: '17:19',
	etiqueta: '+2 tabletas',
	creado: '2026-09-26T23:19:00.000Z',
	...o
});

test('el identificador es un UUID v4 que el servidor acepta', () => {
	const id = nuevoId();
	assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	assert.match(id, /^[a-z0-9-]{8,64}$/); // la validación de clienteIdDe en el servidor
	assert.notEqual(nuevoId(), nuevoId());
});

test('la hora es la local del teléfono, no UTC', () => {
	// new Date(año, mes, día, h, m) se interpreta en la zona local del proceso.
	assert.deepEqual(momentoLocal(new Date(2026, 8, 26, 17, 19)), { fecha: '2026-09-26', hora: '17:19' });
	assert.deepEqual(momentoLocal(new Date(2026, 8, 26, 0, 5)), { fecha: '2026-09-26', hora: '00:05' });
});

test('la bandeja sobrevive guardar y leer, y un almacén roto se lee vacío', () => {
	const a = almacen();
	assert.deepEqual(leerBandeja(a), []);
	assert.equal(guardarBandeja([tap(), tap({ id: 'otro-id-12345', hora: '17:25' })], a), true);
	assert.deepEqual(leerBandeja(a).map((p) => p.hora), ['17:19', '17:25']);

	a.setItem('hipolog:bandeja:v1', '{esto no es json');
	assert.deepEqual(leerBandeja(a), []);
	a.setItem('hipolog:bandeja:v1', JSON.stringify([{ basura: true }, tap()]));
	assert.equal(leerBandeja(a).length, 1); // lo que no parece un tap se descarta

	const roto = { ...almacen(), setItem: () => { throw new Error('QuotaExceededError'); } } as Storage;
	assert.equal(guardarBandeja([tap()], roto), false); // la UI tiene que avisar
	assert.deepEqual(leerBandeja(undefined), []);
});

test('manda la hora del tap, el identificador y los campos', async () => {
	let enviado: FormData | null = null;
	let url = '';
	const r = await enviarPendiente(tap(), {
		fetchFn: (async (u: string, init: RequestInit) => {
			url = u;
			enviado = init.body as FormData;
			return new Response(JSON.stringify({ type: 'success', status: 200 }));
		}) as typeof fetch
	});
	assert.deepEqual(r, { estado: 'enviado' });
	assert.equal(url, '?/registrar');
	const f = enviado as unknown as FormData;
	assert.equal(f.get('hora'), '17:19'); // la del tap, no la de cuando llegó la señal
	assert.equal(f.get('fecha'), '2026-09-26');
	assert.equal(f.get('detallado'), '1');
	assert.equal(f.get('cliente_id'), '4f6c2b1e-7d3a-4e8b-9c1f-2a5d6e7f8a9b');
	assert.equal(f.get('tabletas'), '2');
});

test('sin red, atorado o con un error raro, el tap se queda: nunca se tira', async () => {
	const falla = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
	assert.equal((await enviarPendiente(tap(), { fetchFn: falla })).estado, 'sin-red');

	const atorado = ((_u: string, init: RequestInit) =>
		new Promise((_, rechazar) => init.signal!.addEventListener('abort', () => rechazar(init.signal!.reason)))
	) as unknown as typeof fetch;
	assert.equal((await enviarPendiente(tap(), { fetchFn: atorado, timeoutMs: 50 })).estado, 'sin-red');

	const prohibido = (async () => new Response('Cross-site POST form submissions are forbidden', { status: 403 })) as typeof fetch;
	assert.deepEqual(await enviarPendiente(tap(), { fetchFn: prohibido }), { estado: 'sin-red', detalle: 'respuesta 403' });
});

test('si el servidor dice que los datos están mal, se reporta en vez de reintentar para siempre', async () => {
	const invalido = (async () =>
		new Response(JSON.stringify({ type: 'failure', status: 400, data: '[]' }), { status: 400 })) as typeof fetch;
	assert.equal((await enviarPendiente(tap(), { fetchFn: invalido })).estado, 'rechazado');
});
