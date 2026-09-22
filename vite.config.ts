import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			// adapter-node: la app corre como un proceso de Node dentro del
			// contenedor. El build queda en build/index.js y arranca con
			// `node build`, leyendo PORT, HOST y ORIGIN del entorno.
			adapter: adapter()
		})
	],
	server: { host: '127.0.0.1', port: 3737 }
});
