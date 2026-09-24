import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			// adapter-node: la app corre como un proceso de Node dentro del
			// contenedor. El build queda en build/index.js y arranca con
			// `node build`, leyendo PORT, HOST y ORIGIN del entorno.
			adapter: adapter(),

			// Las direcciones por las que Carlos abre la app. Hacen falta porque
			// adapter-node, sin ORIGIN fijo, SUPONE https al armar el origen de la
			// app (handler.js: `|| 'https'`), y aquí todo entra por http: la
			// protección CSRF rechazaba con 403 todos los taps, en cualquier red.
			//
			// No se arregla fijando ORIGIN, porque solo admite una dirección y la
			// app se abre por varias. Y no se desactiva la protección: esta app no
			// tiene login, así que es de lo poco que impide que otra página haga
			// POST a tu registro. Un origen que no esté aquí sigue rebotando.
			csrf: {
				trustedOrigins: [
					'http://homie-lab.local:8477', // tu wifi, por nombre
					'http://192.168.1.87:8477', // tu wifi, por IP
					'http://homie-lab.tail48b215.ts.net', // Tailscale vía `tailscale serve`
					'http://homie-lab', // Tailscale, nombre corto de MagicDNS
					'http://100.90.40.124:8477' // Tailscale directo (sin serve)
				]
			}
		})
	],
	server: { host: '127.0.0.1', port: 3737 }
});
