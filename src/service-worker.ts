/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

// El service worker que deja ABRIR hipolog sin señal. Registrar sin señal lo
// resuelve la bandeja (src/lib/bandeja.ts) con la página ya abierta; esto
// cubre el otro caso: tocar el ícono en medio del Reclusorio Sur, sin red, y
// que la app cargue en vez de quedarse en blanco.
//
// Solo existe en páginas https (o localhost): es regla del navegador. Por http
// SvelteKit ni lo registra, y la app funciona igual, sin esta capa.

import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `hipolog-${version}`;
// Sin archivos ocultos: static/.gitkeep existe en el disco pero el servidor lo
// contesta con 404, y un solo 404 hace fallar addAll y el service worker entero.
const ESTATICOS = new Set([...build, ...files.filter((f) => !f.split('/').pop()!.startsWith('.'))]);
const ESPERA_MS = 5000; // más que esto, en la calle, es «no hay red»

sw.addEventListener('install', (ev) => {
	ev.waitUntil(
		caches
			.open(CACHE)
			.then((c) => c.addAll([...ESTATICOS]))
			.then(() => sw.skipWaiting())
	);
});

sw.addEventListener('activate', (ev) => {
	// Las versiones viejas se van: su HTML apunta a archivos que ya no existen.
	ev.waitUntil(
		caches
			.keys()
			.then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => sw.clients.claim())
	);
});

/** Red primero; si no contesta a tiempo, lo último bueno que se guardó. */
async function redPrimero(req: Request, clave: string): Promise<Response> {
	const cache = await caches.open(CACHE);
	try {
		const res = await fetch(req, { signal: AbortSignal.timeout(ESPERA_MS) });
		if (res.ok && res.type === 'basic') await cache.put(clave, res.clone());
		return res;
	} catch {
		return (await cache.match(clave)) ?? Response.error();
	}
}

sw.addEventListener('fetch', (ev) => {
	const req = ev.request;
	// Solo GET. Los taps (POST) los maneja la bandeja, y la pregunta «¿hay red?»
	// que hace la página es un HEAD: si esto la contestara desde el caché, la
	// app creería que hay señal cuando no la hay.
	if (req.method !== 'GET') return;
	const url = new URL(req.url);
	if (url.origin !== sw.location.origin) return;

	// Los archivos de la app no cambian dentro de una versión: del caché.
	if (ESTATICOS.has(url.pathname)) {
		ev.respondWith(caches.match(req).then((r) => r ?? fetch(req)));
		return;
	}

	// La página: red primero, y sin señal la última que se cargó. Viene con la
	// hora en que se generó, así que dice «actualizado hace 40 min» y no miente.
	if (req.mode === 'navigate') {
		ev.respondWith(redPrimero(req, '/'));
		return;
	}

	// Los datos que pide la app al actualizarse sola. Sin esto, una
	// actualización sin señal terminaría en la página de error.
	if (url.pathname.endsWith('/__data.json')) {
		ev.respondWith(redPrimero(req, '/__data.json'));
	}
});
