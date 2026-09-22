import { flechaDe, normalizarLecturas, partirTimestamp, type Lectura } from '$lib/glucosa';

/**
 * Lector del proxy REST de carelink-python-client
 * (`carelink_client2_proxy.py`, puerto 8081). Ese proceso baja de CareLink
 * cada 300 s y sirve lo último desde memoria, así que consultarlo es barato
 * y no golpea al vendor.
 *
 *   CARELINK_URL=http://homie-lab.local:8081
 *
 * Si la variable no está, si el proxy no responde, si tarda, o si el payload
 * viene raro: devuelve null y hipolog funciona exactamente igual que sin
 * integración. Registrar una toma NUNCA depende de esto.
 */

export type Estado = {
	sg: number | null;
	flecha: string;
	fecha: string;
	hora: string;
	lecturas: Lectura[];
};

let cache: { dato: Estado | null; at: number } | null = null;
const TTL_MS = 60_000; // el proxy se refresca cada 5 min; 1 min basta y sobra

export async function leerCarelink(): Promise<Estado | null> {
	const base = process.env.CARELINK_URL;
	if (!base) return null;
	if (cache && Date.now() - cache.at < TTL_MS) return cache.dato;

	let dato: Estado | null = null;
	try {
		const res = await fetch(`${base.replace(/\/$/, '')}/carelink/`, {
			signal: AbortSignal.timeout(Number(process.env.CARELINK_TIMEOUT_MS ?? 2500))
		});
		if (res.ok) {
			const json = (await res.json()) as Record<string, any>;
			// El proxy devuelve el recentData completo; el MCP usa patientData.
			const pd = json?.patientData ?? json;
			const lecturas = normalizarLecturas(pd?.sgs);
			const sgCrudo = Number(pd?.lastSG?.sg);
			const sg = Number.isFinite(sgCrudo) && sgCrudo > 0 ? sgCrudo : null;
			const p = partirTimestamp(String(pd?.lastSG?.timestamp ?? '')) ?? lecturas.at(-1) ?? null;
			if (p) {
				dato = {
					sg: sg ?? lecturas.at(-1)?.sg ?? null,
					flecha: flechaDe(pd?.lastSGTrend),
					fecha: p.fecha,
					hora: p.hora,
					lecturas
				};
			}
		}
	} catch {
		dato = null; // sensor fuera de alcance, proxy caído, red mala: da igual
	}
	cache = { dato, at: Date.now() };
	return dato;
}
