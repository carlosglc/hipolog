import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import {
	InvalidClientMetadataError,
	InvalidGrantError,
	InvalidTokenError
} from '@modelcontextprotocol/sdk/server/auth/errors.js';

/**
 * OAuth para un solo usuario: Carlos.
 *
 * claude.ai solo se conecta a servidores MCP remotos por OAuth, así que esto
 * no es opcional: sin ello, cualquiera con la URL leería un registro médico.
 * El SDK pone los endpoints, valida PKCE y el registro dinámico; aquí va lo
 * que es de hipolog: quién puede registrarse, la contraseña y dónde se
 * guardan los tokens.
 *
 * Los tokens se guardan HASHEADOS en su propia base (`mcp-auth.db`), no en
 * la de las tomas: el esquema de la app no se toca, y un volcado de esta
 * base no sirve para entrar.
 */

/** A dónde puede regresar un login. Lo demás se rechaza al registrarse. */
const REDIRECTS_PERMITIDOS = [
	'https://claude.ai/api/mcp/auth_callback',
	'https://claude.com/api/mcp/auth_callback'
];
const esLoopback = (uri: string) => {
	try {
		const u = new URL(uri);
		return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
	} catch {
		return false;
	}
};
export const redirectPermitido = (uri: string) => REDIRECTS_PERMITIDOS.includes(uri) || esLoopback(uri);

const ACCESO_S = 60 * 60; // 1 h
const REFRESCO_S = 60 * 60 * 24 * 60; // 60 días
const CODIGO_S = 5 * 60;
const SOLICITUD_MS = 10 * 60 * 1000;
const MAX_FALLOS = 5;
const BLOQUEO_MS = 15 * 60 * 1000;

const token = () => randomBytes(32).toString('base64url');
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const segundos = () => Math.floor(Date.now() / 1000);

/** 'scrypt:<sal>:<hash>' en base64url. Sin '$', que Compose interpola. */
export function hashDeClave(clave: string): string {
	const sal = randomBytes(16);
	return `scrypt:${sal.toString('base64url')}:${scryptSync(clave, sal, 32).toString('base64url')}`;
}

export function claveCorrecta(clave: string, guardado: string): boolean {
	const [alg, sal, h] = guardado.split(':');
	if (alg !== 'scrypt' || !sal || !h) return false;
	const esperado = Buffer.from(h, 'base64url');
	const dado = scryptSync(clave, Buffer.from(sal, 'base64url'), esperado.length);
	return timingSafeEqual(dado, esperado);
}

type Solicitud = { clientId: string; params: AuthorizationParams; expira: number };

export class ProveedorHipolog implements OAuthServerProvider {
	private readonly db: DatabaseSync;
	private readonly solicitudes = new Map<string, Solicitud>();
	private readonly claveHash: string;
	private fallos: number[] = [];

	constructor(ruta: string, claveHash: string) {
		this.claveHash = claveHash;
		this.db = new DatabaseSync(ruta);
		this.db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS clientes (client_id TEXT PRIMARY KEY, datos TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS codigos (
				hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, challenge TEXT NOT NULL,
				redirect_uri TEXT NOT NULL, resource TEXT, expira INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS tokens (
				hash TEXT PRIMARY KEY, tipo TEXT NOT NULL, client_id TEXT NOT NULL,
				resource TEXT, expira INTEGER NOT NULL
			);
		`);
	}

	get clientsStore(): OAuthRegisteredClientsStore {
		return {
			getClient: (id) => {
				const fila = this.db.prepare('SELECT datos FROM clientes WHERE client_id = ?').get(id) as
					| { datos: string }
					| undefined;
				return fila ? (JSON.parse(fila.datos) as OAuthClientInformationFull) : undefined;
			},
			registerClient: (cliente) => {
				const malos = cliente.redirect_uris.filter((u) => !redirectPermitido(String(u)));
				if (malos.length) {
					throw new InvalidClientMetadataError(`redirect_uri no permitido: ${malos.join(', ')}`);
				}
				// El SDK ya generó el client_id; el tipo no lo refleja.
				const conId = cliente as Partial<OAuthClientInformationFull>;
				const completo = { ...cliente, client_id: conId.client_id ?? randomUUID() } as OAuthClientInformationFull;
				this.db
					.prepare('INSERT INTO clientes (client_id, datos) VALUES (?, ?)')
					.run(completo.client_id, JSON.stringify(completo));
				return completo;
			}
		};
	}

	/** GET /authorize ya validado por el SDK: se guarda la petición y se pide la clave. */
	async authorize(cliente: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
		this.limpiar();
		const id = token();
		this.solicitudes.set(id, { clientId: cliente.client_id, params, expira: Date.now() + SOLICITUD_MS });
		res.status(200).set(CABECERAS_LOGIN).type('html').send(paginaLogin(id, cliente.client_name));
	}

	/**
	 * POST /login. Todo lo de la petición se quedó del lado del servidor: el
	 * formulario solo trae el id de la solicitud y la clave, así que no hay
	 * redirect_uri ni challenge que alterar en el camino.
	 */
	login(solicitudId: string, clave: string): { redirigir: string } | { error: string; status: number } {
		this.limpiar();
		const sol = this.solicitudes.get(solicitudId);
		if (!sol) return { error: 'La solicitud expiró. Vuelve a conectar desde Claude.', status: 400 };

		const ahora = Date.now();
		this.fallos = this.fallos.filter((t) => ahora - t < BLOQUEO_MS);
		if (this.fallos.length >= MAX_FALLOS) {
			return { error: 'Demasiados intentos. Espera 15 minutos.', status: 429 };
		}
		if (!claveCorrecta(clave, this.claveHash)) {
			this.fallos.push(ahora);
			return { error: 'Contraseña incorrecta.', status: 401 };
		}
		this.fallos = [];
		this.solicitudes.delete(solicitudId);

		const codigo = token();
		this.db
			.prepare('INSERT INTO codigos (hash, client_id, challenge, redirect_uri, resource, expira) VALUES (?, ?, ?, ?, ?, ?)')
			.run(hash(codigo), sol.clientId, sol.params.codeChallenge, sol.params.redirectUri,
				sol.params.resource?.href ?? null, segundos() + CODIGO_S);
		const destino = new URL(sol.params.redirectUri);
		destino.searchParams.set('code', codigo);
		if (sol.params.state !== undefined) destino.searchParams.set('state', sol.params.state);
		return { redirigir: destino.href };
	}

	private codigo(cliente: OAuthClientInformationFull, codigo: string) {
		const fila = this.db.prepare('SELECT * FROM codigos WHERE hash = ?').get(hash(codigo)) as
			| { client_id: string; challenge: string; redirect_uri: string; resource: string | null; expira: number }
			| undefined;
		if (!fila || fila.client_id !== cliente.client_id || fila.expira < segundos()) {
			throw new InvalidGrantError('Código inválido o expirado');
		}
		return fila;
	}

	async challengeForAuthorizationCode(cliente: OAuthClientInformationFull, codigo: string) {
		return this.codigo(cliente, codigo).challenge;
	}

	async exchangeAuthorizationCode(
		cliente: OAuthClientInformationFull,
		codigo: string,
		_verifier?: string,
		redirectUri?: string
	): Promise<OAuthTokens> {
		const fila = this.codigo(cliente, codigo);
		// Un código se usa una vez: se borra antes de emitir nada.
		this.db.prepare('DELETE FROM codigos WHERE hash = ?').run(hash(codigo));
		if (redirectUri !== undefined && !redirectUriMatches(redirectUri, fila.redirect_uri)) {
			throw new InvalidGrantError('redirect_uri distinto al de la autorización');
		}
		return this.emitir(cliente.client_id, fila.resource);
	}

	async exchangeRefreshToken(cliente: OAuthClientInformationFull, refresco: string): Promise<OAuthTokens> {
		const fila = this.db
			.prepare("SELECT * FROM tokens WHERE hash = ? AND tipo = 'refresh'")
			.get(hash(refresco)) as { client_id: string; resource: string | null; expira: number } | undefined;
		if (!fila || fila.client_id !== cliente.client_id || fila.expira < segundos()) {
			throw new InvalidGrantError('Refresh token inválido o expirado');
		}
		// Rotación: el refresh usado deja de servir.
		this.db.prepare('DELETE FROM tokens WHERE hash = ?').run(hash(refresco));
		return this.emitir(cliente.client_id, fila.resource);
	}

	async verifyAccessToken(acceso: string): Promise<AuthInfo> {
		const fila = this.db
			.prepare("SELECT * FROM tokens WHERE hash = ? AND tipo = 'access'")
			.get(hash(acceso)) as { client_id: string; resource: string | null; expira: number } | undefined;
		if (!fila || fila.expira < segundos()) throw new InvalidTokenError('Token inválido o expirado');
		return {
			token: acceso,
			clientId: fila.client_id,
			scopes: [],
			expiresAt: fila.expira,
			resource: fila.resource ? new URL(fila.resource) : undefined
		};
	}

	async revokeToken(cliente: OAuthClientInformationFull, req: { token: string }) {
		this.db.prepare('DELETE FROM tokens WHERE hash = ? AND client_id = ?').run(hash(req.token), cliente.client_id);
	}

	private emitir(clientId: string, resource: string | null): OAuthTokens {
		const acceso = token();
		const refresco = token();
		const ins = this.db.prepare('INSERT INTO tokens (hash, tipo, client_id, resource, expira) VALUES (?, ?, ?, ?, ?)');
		ins.run(hash(acceso), 'access', clientId, resource, segundos() + ACCESO_S);
		ins.run(hash(refresco), 'refresh', clientId, resource, segundos() + REFRESCO_S);
		return { access_token: acceso, token_type: 'Bearer', expires_in: ACCESO_S, refresh_token: refresco };
	}

	private limpiar() {
		const ahora = Date.now();
		for (const [id, s] of this.solicitudes) if (s.expira < ahora) this.solicitudes.delete(id);
		this.db.prepare('DELETE FROM codigos WHERE expira < ?').run(segundos());
		this.db.prepare('DELETE FROM tokens WHERE expira < ?').run(segundos());
	}
}

/** La página de login no carga nada de fuera y no se deja meter en un iframe. */
export const CABECERAS_LOGIN = {
	'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
	'X-Frame-Options': 'DENY',
	'Cache-Control': 'no-store',
	'Referrer-Policy': 'no-referrer'
};

const escapar = (s: string) =>
	s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function paginaLogin(solicitudId: string, cliente?: string, error?: string): string {
	return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>hipolog · conectar</title>
<style>
body{font:16px system-ui,sans-serif;max-width:22rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fafafa}
@media (prefers-color-scheme:dark){body{color:#eee;background:#161616}input{background:#222;color:#eee;border-color:#444}}
h1{font-size:1.3rem}p{color:#777;line-height:1.4}.error{color:#c0392b}
input,button{font:inherit;width:100%;box-sizing:border-box;padding:.7rem;margin-top:.5rem;border-radius:8px}
input{border:1px solid #ccc}button{border:0;background:#2563eb;color:#fff;font-weight:600}
</style></head><body>
<h1>Conectar hipolog</h1>
<p>${escapar(cliente ?? 'Una app')} quiere leer tu registro de hipoglucemias y poder agregar tomas. No puede editar ni borrar.</p>
${error ? `<p class="error">${escapar(error)}</p>` : ''}
<form method="post" action="/login">
<input type="hidden" name="solicitud" value="${escapar(solicitudId)}">
<input type="password" name="clave" autocomplete="current-password" placeholder="Contraseña" autofocus required>
<button type="submit">Permitir</button>
</form></body></html>`;
}
