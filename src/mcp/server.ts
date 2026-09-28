import express from 'express';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CABECERAS_LOGIN, ProveedorHipolog, paginaLogin } from './auth.ts';
import { Datos } from './datos.ts';
import { crearServidor } from './herramientas.ts';

/**
 * Servidor MCP remoto de hipolog, para conectarlo como conector de claude.ai.
 *
 *   MCP_URL_PUBLICA   https://homie-lab.tail48b215.ts.net:8443  (la de Funnel)
 *   MCP_CLAVE_HASH    sale de `node src/mcp/clave.ts`
 *   HIPOLOG_DB        la base de la app
 *   MCP_AUTH_DB       clientes y tokens de OAuth, aparte
 *   CARELINK_URL      el proxy del sensor, igual que la app
 *
 * Sin estado entre peticiones: cada POST a /mcp arma su servidor y su
 * transporte. Un reinicio del contenedor no tira ninguna sesión.
 */

const requerida = (n: string) => {
	const v = process.env[n];
	if (!v) throw new Error(`Falta ${n}`);
	return v;
};

const publica = new URL(requerida('MCP_URL_PUBLICA'));
const urlMcp = new URL('/mcp', publica);
const proveedor = new ProveedorHipolog(process.env.MCP_AUTH_DB ?? '/datos/mcp-auth.db', requerida('MCP_CLAVE_HASH'));
const datos = new Datos(process.env.HIPOLOG_DB ?? '/datos/hipolog.db');

const app = express();
// Todo entra por Funnel (tailscaled en el host, un salto). Sin esto, el
// límite de peticiones del SDK vería una sola IP para todo internet.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
	mcpAuthRouter({
		provider: proveedor,
		issuerUrl: publica,
		resourceServerUrl: urlMcp,
		resourceName: 'hipolog'
	})
);

app.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
	const solicitud = String(req.body?.solicitud ?? '');
	const r = proveedor.login(solicitud, String(req.body?.clave ?? ''));
	if ('redirigir' in r) return res.redirect(302, r.redirigir);
	res.status(r.status).set(CABECERAS_LOGIN).type('html').send(paginaLogin(solicitud, undefined, r.error));
});

app.post(
	'/mcp',
	requireBearerAuth({ verifier: proveedor, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(urlMcp) }),
	express.json({ limit: '256kb' }),
	async (req, res) => {
		const servidor = crearServidor(datos);
		const transporte = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
		res.on('close', () => {
			transporte.close();
			servidor.close();
		});
		await servidor.connect(transporte);
		await transporte.handleRequest(req, res, req.body);
	}
);

// Sin sesiones no hay stream de servidor ni nada que cerrar.
app.all('/mcp', (_req, res) => {
	res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Solo POST' }, id: null });
});

app.get('/salud', (_req, res) => {
	res.type('text').send('ok');
});

const puerto = Number(process.env.PORT ?? 3001);
app.listen(puerto, '0.0.0.0', () => {
	console.log(`hipolog-mcp en :${puerto}, público como ${urlMcp.href}`);
});
