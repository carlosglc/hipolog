import { DatabaseSync } from 'node:sqlite';

/**
 * Enganche OPCIONAL con glucose-pipeline.
 *
 * Estado del 21/09/2026: ese proyecto TODAVÍA NO EXPONE UN REST API
 * (`api/`, `core/`, `ingest/` solo tienen .gitkeep; el README marca
 * "[ ] REST API" sin palomear). Lo único que corre es `mcp/server.py`,
 * un servidor MCP por stdio — no se puede consultar por HTTP desde aquí.
 *
 * Así que esto NO inventa un endpoint: queda apagado salvo que exista
 * GLUCOSA_URL. El contrato que espera son las mismas llaves que YA
 * devuelve la herramienta `get_current_glucose()` del MCP:
 *
 *     { "glucose_mgdl": 61, "trend": "<cadena del vendor>", ... }
 *
 * `trend` se guarda tal cual llegue. El enum real de CareLink
 * (`lastSGTrend`) no está documentado en ese repo, y adivinarlo sería
 * meter datos falsos en un registro médico. Cuando lo conozcas, mapéalo
 * en FLECHAS de abajo y se verá como flecha en la UI.
 */

const FLECHAS: Record<string, string> = {
	// Rellenar con los valores reales que devuelva lastSGTrend, p. ej.:
	// DOWN_DOUBLE: '↓↓'
};

export type Lectura = { glucosa: number | null; tendencia: string };

/** null si no hay integración configurada, si falla, o si tarda demasiado. */
export async function leerGlucosa(): Promise<Lectura | null> {
	const url = process.env.GLUCOSA_URL;
	if (!url) return null;

	const corte = AbortSignal.timeout(Number(process.env.GLUCOSA_TIMEOUT_MS ?? 1500));
	try {
		const res = await fetch(url, {
			signal: corte,
			headers: process.env.GLUCOSA_TOKEN
				? { Authorization: `Bearer ${process.env.GLUCOSA_TOKEN}` }
				: {}
		});
		if (!res.ok) return null;
		const j = (await res.json()) as Record<string, unknown>;
		const mgdl = Number(j.glucose_mgdl);
		const trend = typeof j.trend === 'string' ? j.trend : '';
		return {
			glucosa: Number.isFinite(mgdl) && mgdl >= 20 && mgdl <= 600 ? Math.round(mgdl) : null,
			tendencia: FLECHAS[trend] ?? trend
		};
	} catch {
		// Registrar la toma nunca depende de esto. Si el API no está, no pasó nada.
		return null;
	}
}

/**
 * Completa una toma ya guardada, en segundo plano. Se lanza sin await para
 * que el tap del botón responda de inmediato aunque el API tarde.
 */
export function enriquecerEnSegundoPlano(id: number, ruta: string): void {
	if (!process.env.GLUCOSA_URL) return;
	void leerGlucosa()
		.then((lectura) => {
			if (!lectura || (lectura.glucosa === null && !lectura.tendencia)) return;
			const db = new DatabaseSync(ruta);
			try {
				db.prepare(
					`UPDATE tomas
					    SET glucosa = COALESCE(glucosa, ?),
					        tendencia = CASE WHEN tendencia = '' THEN ? ELSE tendencia END
					  WHERE id = ?`
				).run(lectura.glucosa, lectura.tendencia, id);
			} finally {
				db.close();
			}
		})
		.catch(() => {});
}
