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

/**
 * Tendencia calculada de las propias lecturas, para cuando CareLink manda
 * `lastSGTrend: "NONE"` (que es justo lo que mandaba la noche del 21/09/2026).
 *
 * Es la pendiente en mg/dL por minuto sobre los últimos ~15 minutos, con los
 * cortes de siempre: menos de 1 es plano, 1–2 una flecha, 2–3 dos, 3 o más
 * tres. Va marcada como calculada en la UI: no es lo que dice tu bomba, es lo
 * que dicen tus últimas tres lecturas.
 */
export function tendenciaCalculada(
	lecturas: Lectura[],
	ventanaMin = 16
): { flecha: string; porMinuto: number } | null {
	if (lecturas.length < 2) return null;
	const fin = lecturas.at(-1)!;
	// La lectura más vieja que siga dentro de la ventana, en el mismo día o el
	// anterior (la ventana de 24 h cruza medianoche).
	let ini: Lectura | null = null;
	for (let i = lecturas.length - 2; i >= 0; i--) {
		const l = lecturas[i];
		const dt = l.fecha === fin.fecha ? fin.minutos - l.minutos : fin.minutos + 1440 - l.minutos;
		if (dt > ventanaMin) break;
		ini = l;
	}
	if (!ini) return null;
	const dt = ini.fecha === fin.fecha ? fin.minutos - ini.minutos : fin.minutos + 1440 - ini.minutos;
	if (dt <= 0) return null;
	const r = (fin.sg - ini.sg) / dt;
	const a = Math.abs(r);
	const n = a >= 3 ? 3 : a >= 2 ? 2 : a >= 1 ? 1 : 0;
	return { flecha: n === 0 ? '→' : (r > 0 ? '↑' : '↓').repeat(n), porMinuto: r };
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

/**
 * Cuánto te sube cada fuente de rescate, normalizado a **15 g de
 * carbohidratos** — la ración de referencia para corregir una hipoglucemia.
 *
 * Los gramos son lo único comparable entre un jugo y una tableta, y por eso
 * son la unidad: así se puede contestar si el jugo levanta más que las
 * tabletas, que con la cuenta en tabletas era imposible.
 *
 * Dos decisiones que salieron de los datos reales del 21/09/2026:
 *
 * 1. **Solo cuentan los rescates**, y **las tomas durante ejercicio se
 *    cuentan aparte.** Esa tarde: 4 tabletas
 *    a las 19:30 con 134 mg/dL y dos flechas abajo terminaron en 97. Las
 *    tabletas no subieron nada; frenaron una caída. Meterlas al mismo promedio
 *    da un número en el que nadie debería apoyarse a las tres de la mañana.
 * 2. **Mediana, no promedio.** Con tres o cuatro eventos, un dato raro mueve
 *    el promedio entero.
 */
export function subidaPorFuente(
	eventos: {
		gramos: number;
		fuente: string;
		proposito: string;
		glucosa: number | null;
		glucosa30: number | null;
		contexto: string;
	}[]
): { fuentes: { fuente: string; por15g: number; eventos: number }[]; enEjercicio: number } | null {
	// Solo rescates: "cuánto me sube" solo tiene sentido partiendo de una baja.
	// Un gel tomado en 160 mg/dL para no bajar mide otra cosa por completo.
	const utiles = eventos.filter(
		(e) =>
			e.glucosa !== null &&
			e.glucosa30 !== null &&
			e.gramos > 0 &&
			e.proposito === 'rescate'
	);
	const reposo = utiles.filter((e) => e.contexto !== 'ejercicio');
	if (!reposo.length) return null;

	const porFuente = new Map<string, number[]>();
	for (const e of reposo) {
		const subida = ((e.glucosa30! - e.glucosa!) / e.gramos) * 15;
		porFuente.set(e.fuente, [...(porFuente.get(e.fuente) ?? []), subida]);
	}

	const fuentes = [...porFuente.entries()]
		.map(([fuente, v]) => {
			v.sort((a, b) => a - b);
			const m = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
			return { fuente, por15g: m, eventos: v.length };
		})
		.sort((a, b) => b.eventos - a.eventos);

	return { fuentes, enEjercicio: utiles.length - reposo.length };
}
