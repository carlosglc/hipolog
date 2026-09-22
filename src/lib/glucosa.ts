// Lógica pura sobre el payload de CareLink. Sin red, sin base: probable.
//
// El shape sale de los volcados reales en ~/Projects/carelink-python-client
// (data-2026*.json), no de adivinar:
//   lastSG      → { kind, version, sg, sensorState, timestamp }
//   sgs[]       → lo mismo, una cada 5 min, 288 = 24 h
//   lastSGTrend → cadena del vendor
//   timestamp   → ISO *naive*, ya en la zona del dispositivo ("2026-09-10T22:47:31")
//
// sg = 0 no es cero: es "todavía no hay lectura". Se normaliza a null aquí,
// una vez, igual que hace el servidor MCP del glucose-pipeline.

export type Lectura = { fecha: string; hora: string; minutos: number; sg: number };

export const LIMITE_BAJO = 70;
export const LIMITE_ALTO = 180;

/** Minutos desde la medianoche local, para comparar horas sin construir Dates. */
export function aMinutos(hora: string): number {
	return Number(hora.slice(0, 2)) * 60 + Number(hora.slice(3, 5));
}

/** '2026-09-10T22:47:31' → { fecha: '2026-09-10', hora: '22:47' }. Local, sin Date. */
export function partirTimestamp(ts: string): { fecha: string; hora: string } | null {
	const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(ts);
	return m ? { fecha: m[1], hora: m[2] } : null;
}

export function normalizarLecturas(sgs: unknown): Lectura[] {
	if (!Array.isArray(sgs)) return [];
	const out: Lectura[] = [];
	for (const s of sgs) {
		const sg = Number((s as Record<string, unknown>)?.sg);
		const ts = (s as Record<string, unknown>)?.timestamp;
		if (!sg || !Number.isFinite(sg) || typeof ts !== 'string') continue; // sg=0 → hueco
		const p = partirTimestamp(ts);
		if (!p) continue;
		out.push({ ...p, minutos: aMinutos(p.hora), sg });
	}
	return out.sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora));
}

/**
 * Flecha a partir de lastSGTrend. En los volcados solo aparecieron 'UP' y
 * 'DOWN'; el resto sigue el mismo patrón documentado por el vendor
 * (…_DOUBLE / …_TRIPLE), así que se deduce del nombre en lugar de inventar
 * una tabla. Lo que no reconoce, lo devuelve tal cual: mejor una cadena rara
 * visible que una flecha equivocada.
 */
export function flechaDe(trend: unknown): string {
	if (typeof trend !== 'string' || !trend || trend === 'NONE') return '';
	const t = trend.toUpperCase();
	const n = t.includes('TRIPLE') ? 3 : t.includes('DOUBLE') ? 2 : 1;
	if (t.startsWith('UP')) return '↑'.repeat(n);
	if (t.startsWith('DOWN')) return '↓'.repeat(n);
	if (t.includes('FLAT') || t.includes('STEADY')) return '→';
	return trend;
}

export function nivel(sg: number | null): 'bajo' | 'rango' | 'alto' | 'sin' {
	if (sg === null) return 'sin';
	if (sg < LIMITE_BAJO) return 'bajo';
	if (sg > LIMITE_ALTO) return 'alto';
	return 'rango';
}

/**
 * La lectura más cercana a una hora dada, dentro de una tolerancia.
 * Devuelve null si el sensor tenía un hueco ahí — un hueco no se rellena
 * con la lectura de hace media hora.
 */
export function masCercana(
	lecturas: Lectura[],
	fecha: string,
	hora: string,
	toleranciaMin = 8
): Lectura | null {
	const objetivo = aMinutos(hora);
	let mejor: Lectura | null = null;
	let mejorDist = Infinity;
	for (const l of lecturas) {
		if (l.fecha !== fecha) continue;
		const dist = Math.abs(l.minutos - objetivo);
		if (dist < mejorDist) {
			mejor = l;
			mejorDist = dist;
		}
	}
	return mejorDist <= toleranciaMin ? mejor : null;
}

/** Cuánto subió cada tableta, en mg/dL, promediando los eventos que tienen ambos datos. */
export function subidaPorTableta(
	eventos: { tabletas: number; glucosa: number | null; glucosa30: number | null }[]
): { porTableta: number; eventos: number } | null {
	const utiles = eventos.filter(
		(e) => e.glucosa !== null && e.glucosa30 !== null && e.tabletas > 0
	);
	if (!utiles.length) return null;
	const suma = utiles.reduce((s, e) => s + (e.glucosa30! - e.glucosa!) / e.tabletas, 0);
	return { porTableta: suma / utiles.length, eventos: utiles.length };
}
