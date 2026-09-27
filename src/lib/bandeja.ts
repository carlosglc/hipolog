// La bandeja de salida: cada tap se guarda PRIMERO en el teléfono y después
// se intenta mandar. Si no hay señal, si la petición se atora o si el teléfono
// cierra la app, el tap sigue guardado y se reenvía solo cuando vuelva la red.
//
// Nació corriendo alrededor del Reclusorio Sur el 26/09/2026: sin señal, tres
// de cuatro rescates quedaron solo en la memoria de Carlos, y el que sí salió
// llegó tres minutos tarde y duplicado. De ahí las dos reglas de este módulo:
//
//   1. La hora la pone el teléfono al momento del tap, no el servidor cuando
//      por fin le llega.
//   2. Cada tap lleva un identificador único, para que un reenvío de la red
//      no se registre dos veces (el servidor ignora los repetidos).

export type Pendiente = {
	id: string;
	accion: 'registrar' | 'registrarFuente';
	campos: Record<string, string>;
	fecha: string; // 'YYYY-MM-DD' local, del momento del tap
	hora: string; // 'HH:MM' local, del momento del tap
	etiqueta: string; // lo que se muestra: «+2 tabletas», «Gu Lemon Sublime»
	creado: string; // ISO, solo para depurar
};

const CLAVE = 'hipolog:bandeja:v1';

const esPendiente = (x: unknown): x is Pendiente => {
	const p = x as Pendiente;
	return (
		!!p &&
		typeof p.id === 'string' &&
		(p.accion === 'registrar' || p.accion === 'registrarFuente') &&
		typeof p.fecha === 'string' &&
		typeof p.hora === 'string' &&
		typeof p.campos === 'object'
	);
};

/** Lo que hay en la bandeja. Un almacén roto o ausente se lee como vacío. */
export function leerBandeja(almacen: Storage | undefined = globalThis.localStorage): Pendiente[] {
	try {
		const crudo = almacen?.getItem(CLAVE);
		const v: unknown = crudo ? JSON.parse(crudo) : [];
		return Array.isArray(v) ? v.filter(esPendiente) : [];
	} catch {
		return [];
	}
}

/** `false` si el teléfono no dejó guardar (navegación privada, almacén lleno). */
export function guardarBandeja(
	items: Pendiente[],
	almacen: Storage | undefined = globalThis.localStorage
): boolean {
	try {
		if (!almacen) return false;
		almacen.setItem(CLAVE, JSON.stringify(items));
		return true;
	} catch {
		return false;
	}
}

/**
 * Identificador único por tap (UUID v4).
 *
 * No usa `crypto.randomUUID()` porque solo existe en páginas https, y hipolog
 * también se abre por http. `getRandomValues` existe en los dos casos.
 */
export function nuevoId(cripto: Pick<Crypto, 'getRandomValues'> = globalThis.crypto): string {
	const b = cripto.getRandomValues(new Uint8Array(16));
	b[6] = (b[6] & 0x0f) | 0x40; // versión 4
	b[8] = (b[8] & 0x3f) | 0x80; // variante RFC 4122
	const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Fecha y hora LOCALES del teléfono, en el formato de la base. */
export function momentoLocal(d: Date): { fecha: string; hora: string } {
	const p = (n: number) => String(n).padStart(2, '0');
	return {
		fecha: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
		hora: `${p(d.getHours())}:${p(d.getMinutes())}`
	};
}

export type Resultado =
	| { estado: 'enviado' }
	| { estado: 'rechazado'; detalle: string }
	| { estado: 'sin-red'; detalle?: string };

/**
 * Manda un tap pendiente a la acción de SvelteKit.
 *
 * - `enviado`: el servidor lo guardó, o ya lo tenía (un reenvío).
 * - `rechazado`: el servidor dijo que los datos están mal. Reintentar no sirve.
 * - `sin-red`: no hubo respuesta, se atoró, o vino algo inesperado (un 403,
 *   un 500). Se queda en la bandeja y se reintenta: ante la duda, un tap
 *   NUNCA se tira.
 */
export async function enviarPendiente(
	p: Pendiente,
	{ fetchFn = globalThis.fetch, url = `?/${p.accion}`, timeoutMs = 10_000 } = {}
): Promise<Resultado> {
	const fd = new FormData();
	for (const [k, v] of Object.entries(p.campos)) fd.set(k, v);
	fd.set('fecha', p.fecha);
	fd.set('hora', p.hora);
	fd.set('detallado', '1'); // la hora que manda el teléfono es la buena
	fd.set('cliente_id', p.id);

	let res: Response;
	try {
		res = await fetchFn(url, {
			method: 'POST',
			body: fd,
			headers: { 'x-sveltekit-action': 'true', accept: 'application/json' },
			signal: AbortSignal.timeout(timeoutMs)
		});
	} catch {
		return { estado: 'sin-red' };
	}

	let cuerpo: { type?: string } | null = null;
	try {
		cuerpo = (await res.json()) as { type?: string };
	} catch {
		// no era JSON: un 403 de texto, un proxy, una página de error
	}
	if (cuerpo?.type === 'success') return { estado: 'enviado' };
	if (cuerpo?.type === 'failure') return { estado: 'rechazado', detalle: 'el servidor rechazó los datos' };
	return { estado: 'sin-red', detalle: `respuesta ${res.status}` };
}
