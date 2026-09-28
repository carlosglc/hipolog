import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Response } from 'express';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { ProveedorHipolog, claveCorrecta, hashDeClave, redirectPermitido } from './auth.ts';

const CLAVE = 'abcde-fghjk-mnpqr-stuvw';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

function proveedor() {
	return new ProveedorHipolog(join(mkdtempSync(join(tmpdir(), 'hipolog-auth-')), 'auth.db'), hashDeClave(CLAVE));
}

/** Lo mínimo de un Response de express para capturar la página de login. */
function respuesta() {
	const r = { html: '', status(_: number) { return r; }, set(_: unknown) { return r; }, type(_: string) { return r; }, send(h: string) { r.html = h; return r; } };
	return r;
}

async function registrar(p: ProveedorHipolog, uris = [CALLBACK]) {
	return (await p.clientsStore.registerClient!({ redirect_uris: uris, token_endpoint_auth_method: 'none' } as never)) as OAuthClientInformationFull;
}

async function pedirCodigo(p: ProveedorHipolog, cliente: OAuthClientInformationFull) {
	const res = respuesta();
	await p.authorize(cliente, { codeChallenge: 'reto', redirectUri: CALLBACK, state: 'xyz' }, res as unknown as Response);
	const solicitud = /name="solicitud" value="([^"]+)"/.exec(res.html)![1];
	return { solicitud, res };
}

test('la clave se verifica contra su hash y no contra otra', () => {
	const h = hashDeClave(CLAVE);
	assert.ok(!h.includes('$'));
	assert.ok(claveCorrecta(CLAVE, h));
	assert.ok(!claveCorrecta('otra', h));
	assert.ok(!claveCorrecta(CLAVE, 'basura'));
});

test('solo claude.ai, claude.com y loopback pueden registrarse', async () => {
	assert.ok(redirectPermitido(CALLBACK));
	assert.ok(redirectPermitido('http://localhost:33418/callback'));
	assert.ok(!redirectPermitido('https://evil.example/callback'));
	assert.ok(!redirectPermitido('https://claude.ai.evil.example/api/mcp/auth_callback'));
	await assert.rejects(registrar(proveedor(), ['https://evil.example/cb']), /no permitido/);
});

test('flujo completo: login, código de un solo uso, token, refresco rotado', async () => {
	const p = proveedor();
	const cliente = await registrar(p);
	const { solicitud } = await pedirCodigo(p, cliente);

	const malo = p.login(solicitud, 'nop');
	assert.ok('error' in malo && malo.status === 401);

	const ok = p.login(solicitud, CLAVE);
	assert.ok('redirigir' in ok);
	const url = new URL(ok.redirigir);
	assert.equal(url.origin + url.pathname, CALLBACK);
	assert.equal(url.searchParams.get('state'), 'xyz');
	const codigo = url.searchParams.get('code')!;

	// La solicitud ya se usó.
	assert.ok('error' in p.login(solicitud, CLAVE));

	assert.equal(await p.challengeForAuthorizationCode(cliente, codigo), 'reto');
	const t = await p.exchangeAuthorizationCode(cliente, codigo, undefined, CALLBACK);
	await assert.rejects(p.exchangeAuthorizationCode(cliente, codigo), /inválido/);

	const info = await p.verifyAccessToken(t.access_token);
	assert.equal(info.clientId, cliente.client_id);
	await assert.rejects(p.verifyAccessToken('inventado'), /inválido/);

	const t2 = await p.exchangeRefreshToken(cliente, t.refresh_token!);
	await assert.rejects(p.exchangeRefreshToken(cliente, t.refresh_token!), /inválido/);
	assert.ok(await p.verifyAccessToken(t2.access_token));

	await p.revokeToken(cliente, { token: t2.access_token });
	await assert.rejects(p.verifyAccessToken(t2.access_token));
});

test('un código de otro cliente o con otro redirect no sirve', async () => {
	const p = proveedor();
	const a = await registrar(p);
	const b = await registrar(p);
	const { solicitud } = await pedirCodigo(p, a);
	const r = p.login(solicitud, CLAVE);
	assert.ok('redirigir' in r);
	const codigo = new URL(r.redirigir).searchParams.get('code')!;
	await assert.rejects(p.exchangeAuthorizationCode(b, codigo), /inválido/);
	await assert.rejects(p.exchangeAuthorizationCode(a, codigo, undefined, 'https://claude.com/api/mcp/auth_callback'), /redirect_uri/);
});

test('cinco claves malas bloquean, incluso con la buena', async () => {
	const p = proveedor();
	const cliente = await registrar(p);
	const { solicitud } = await pedirCodigo(p, cliente);
	for (let i = 0; i < 5; i++) p.login(solicitud, 'mala');
	const r = p.login(solicitud, CLAVE);
	assert.ok('error' in r && r.status === 429);
});

test('la página de login escapa el nombre del cliente', async () => {
	const p = proveedor();
	const cliente = { ...(await registrar(p)), client_name: '<script>x</script>' };
	const { res } = await pedirCodigo(p, cliente);
	assert.ok(!res.html.includes('<script>x'));
});
