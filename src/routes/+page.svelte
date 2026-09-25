<script lang="ts">
	import { enhance } from '$app/forms';
	import { etiquetaLarga, franja } from '$lib/fechas';
	import { CAFEINA_SIN_DATO, CONTEXTOS, TABLETA, TENDENCIAS } from '$lib/tipos';
	import { aMinutos, LIMITE_ALTO, LIMITE_BAJO } from '$lib/glucosa';
	import type { Toma } from '$lib/tipos';

	let { data, form } = $props();

	const r = $derived(data.resumen);
	const maxBarra = $derived(Math.max(1, ...r.serie.map((d) => d.gramos)));

	// El historial se agrupa por día; la lista plana es la "vista de tabla" del
	// mismo dato que dibuja la gráfica de arriba.
	const porDia = $derived(
		data.tomas.reduce<{ fecha: string; tomas: Toma[] }[]>((acc, t) => {
			const ultimo = acc.at(-1);
			if (ultimo && ultimo.fecha === t.fecha) ultimo.tomas.push(t);
			else acc.push({ fecha: t.fecha, tomas: [t] });
			return acc;
		}, [])
	);

	// --- Curva de 24 h -------------------------------------------------
	// Un solo eje: la glucosa. Las tomas NO son una segunda escala, son
	// marcas verticales sobre el mismo eje de tiempo.
	//
	// El SVG solo dibuja trazos y se estira con preserveAspectRatio="none";
	// TODO el texto (límites, horas, pastillas) es HTML encima, posicionado
	// en porcentajes. Así las letras se ven del mismo tamaño en un celular
	// de 360 px y en un monitor de 1400, en vez de encogerse o inflarse con
	// el viewBox.
	const SG_MIN = 40;
	const SG_MAX = 320;

	/** Glucosa → % desde arriba del área de dibujo. */
	const py = (sg: number) => {
		const v = Math.min(SG_MAX, Math.max(SG_MIN, sg));
		return (1 - (v - SG_MIN) / (SG_MAX - SG_MIN)) * 100;
	};
	/** Minuto del eje → % desde la izquierda. */
	const px = (x: number) => {
		const c = data.curva;
		if (!c) return 0;
		return ((x - c.x0) / Math.max(1, c.x1 - c.x0)) * 100;
	};

	// Un hueco del sensor se dibuja como hueco, no como una recta que lo cruza.
	const segmentos = $derived.by(() => {
		const c = data.curva;
		if (!c) return [];
		const out: string[] = [];
		let actual: string[] = [];
		let previo = -Infinity;
		for (const p of c.puntos) {
			if (p.x - previo > 15 && actual.length) {
				out.push(actual.join(' '));
				actual = [];
			}
			actual.push(`${px(p.x).toFixed(2)},${py(p.sg).toFixed(2)}`);
			previo = p.x;
		}
		if (actual.length) out.push(actual.join(' '));
		return out;
	});

	const marcasHora = $derived.by(() => {
		const c = data.curva;
		if (!c) return [];
		const t: { x: number; etiqueta: string }[] = [];
		for (let m = Math.ceil(c.x0 / 360) * 360; m <= c.x1; m += 360) {
			t.push({ x: px(m), etiqueta: `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}h` });
		}
		return t;
	});

	/** Las pastillas se salen del marco si la toma cae en el borde. */
	const dentro = (n: number) => Math.min(96, Math.max(4, n));
	// Tres Gu en 20 minutos dan tres pastillas encimadas. Las que caen a menos
	// de 8% de ancho de la anterior bajan un renglón, hasta tres niveles.
	const marcasApiladas = $derived.by(() => {
		const c = data.curva;
		if (!c) return [];
		const orden = [...c.marcas].sort((a, b) => a.x - b.x);
		const ult: number[] = [];
		return orden.map((m) => {
			const pos = px(m.x);
			let nivel = 0;
			while (nivel < 2 && ult[nivel] !== undefined && pos - ult[nivel] < 8) nivel++;
			ult[nivel] = pos;
			const etiqueta = m.fuente === TABLETA ? `+${decimal(m.tabletas)}` : `${decimal(m.gramos)}g`;
			return { ...m, pos, nivel, etiqueta };
		});
	});

	/** El globo es más ancho que una pastilla y necesita más margen. */
	const dentroGlobo = (n: number) => Math.min(90, Math.max(10, n));

	// Punto actual y sonda: el dedo o el cursor sobre la gráfica muestra el
	// valor de esa lectura. pointer* cubre mouse y touch con el mismo código.
	let sonda = $state<{ x: number; sg: number; hora: string } | null>(null);
	const actual = $derived(data.curva?.puntos.at(-1) ?? null);
	const mostrado = $derived(sonda ?? actual);
	const flechaAhora = $derived(data.sensor?.flecha || data.sensor?.calculada?.flecha || '');
	const flechaCalculada = $derived(!data.sensor?.flecha && !!data.sensor?.calculada);

	function sondear(e: PointerEvent) {
		const c = data.curva;
		if (!c) return;
		const caja = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const pct = ((e.clientX - caja.left) / caja.width) * 100;
		let mejor = null;
		let dist = Infinity;
		for (const p of c.puntos) {
			const d = Math.abs(px(p.x) - pct);
			if (d < dist) {
				dist = d;
				mejor = p;
			}
		}
		sonda = mejor;
	}

	// Hace cuánto llegó la última lectura, sin construir Dates.
	const minutosDesdeLectura = $derived.by(() => {
		if (!data.sensor) return null;
		const d = aMinutos(data.ahora) - aMinutos(data.sensor.hora);
		return d < 0 ? d + 1440 : d;
	});

	// La subida se mide en gramos, que es lo comparable entre un Gu y una
	// tableta. El tile muestra la de las tabletas, que es la fuente frecuente.
	const subidaTableta = $derived(data.subida?.fuentes.find((f) => f.fuente === 'tableta'));

	// Si el panel «Otra hora» está abierto, cualquier botón usa su fecha y
	// hora; cerrado, el servidor usa la hora real del tap. Ver momento().
	let panelAbierto = $state(false);

	// Qué fuente se está comprando: cambia los campos del formulario.
	let fuenteCompra = $state(TABLETA);

	/** «Gu Lemon Sublime» → { marca: 'Gu', sabor: 'Lemon Sublime' }. */
	const partirNombre = (n: string) =>
		n.startsWith('Gu ') ? { marca: 'Gu', sabor: n.slice(3) } : { marca: '', sabor: n };

	const cafeinaTexto = (mg: number) =>
		mg === CAFEINA_SIN_DATO ? 'con cafeína' : mg > 0 ? `${mg} mg cafeína` : '';

	// Un respaldo que dejó de correr tiene que VERSE, no descubrirse el día que
	// hace falta restaurar. El diario corre a las 03:00; la PC copia cada hora.
	const HORA = 3_600_000;
	const antiguedad = (iso: string) => (iso ? (Date.now() - Date.parse(iso)) / HORA : null);
	const haceCuanto = (h: number | null) =>
		h === null ? 'nunca' : h < 1 ? 'hace menos de 1 h' : h < 48 ? `hace ${Math.round(h)} h` : `hace ${Math.round(h / 24)} días`;
	const horasRespaldo = $derived(antiguedad(data.respaldo.ultimo));
	const horasCopiaPc = $derived(antiguedad(data.respaldo.copiaPc));

	const pesos = (n: number) =>
		n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
	const decimal = (n: number) => n.toFixed(1).replace(/\.0$/, '');
</script>

<svelte:head><title>hipolog</title></svelte:head>

<main>
	<header>
		<h1><span aria-hidden="true">🍬</span> hipolog</h1>
		<p class="sub">
			{#if r.hoyEventos}
				Hoy: {decimal(r.hoyGramos)} g de carbos
				{#if r.hoyRescates}· {r.hoyRescates} {r.hoyRescates === 1 ? 'baja' : 'bajas'}{/if}
				{#if r.hoyCombustible}· {r.hoyCombustible} de combustible{/if}
				{#if r.hoyCafeina.mg || r.hoyCafeina.sinDato}
					· cafeína {r.hoyCafeina.mg ? `${r.hoyCafeina.mg} mg` : ''}{r.hoyCafeina.sinDato
						? `${r.hoyCafeina.mg ? ' + ' : ''}${r.hoyCafeina.sinDato} sin dato`
						: ''}
				{/if}
			{:else}
				Hoy no has registrado ninguna toma.
			{/if}
		</p>
	</header>

	<div class="cols">
	<div class="col captura">
	<!-- REGISTRAR ------------------------------------------------------- -->
	<section class="tarjeta registro">
		<form method="POST" action="?/registrar" use:enhance>
			<input type="hidden" name="detallado" value={panelAbierto ? '1' : '0'} />

			<fieldset class="chips proposito">
				<legend>¿Para qué?</legend>
				<label class="chip"><input type="radio" name="proposito" value="rescate" checked /><span>Rescate · ya iba bajo</span></label>
				<label class="chip"><input type="radio" name="proposito" value="combustible" /><span>Combustible · para no bajar</span></label>
			</fieldset>

			<fieldset class="chips">
				<legend>¿Por qué?</legend>
				<label class="chip"><input type="radio" name="contexto" value="" checked /><span>—</span></label>
				{#each CONTEXTOS as c (c)}
					<label class="chip"><input type="radio" name="contexto" value={c} /><span>{c}</span></label>
				{/each}
			</fieldset>

			<fieldset class="chips">
				<legend>Flechas</legend>
				{#each TENDENCIAS as t (t)}
					<label class="chip">
						<input type="radio" name="tendencia" value={t} checked={t === ''} />
						<span>{t === '' ? '—' : t}</span>
					</label>
				{/each}
			</fieldset>

			<div class="botones">
				{#each [1, 2, 4] as n (n)}
					<button class="tableta" name="tabletas" value={n}>
						<strong>+{n}</strong>
						<small>{n * r.carbsPorTableta} g</small>
					</button>
				{/each}
			</div>

			{#if data.fuentes.length}
				<div class="presets">
					{#each data.fuentes as f (f.id)}
						{@const n = partirNombre(f.nombre)}
						<button class="preset" formaction="?/registrarFuente" name="fuenteId" value={f.id}>
							{#if n.marca}<small class="marca">{n.marca}</small>{/if}
							<strong>{n.sabor}</strong>
							<small>
								{f.gramos} g{#if f.cafeina}<span class="cafe"> · {cafeinaTexto(f.cafeina)}</span>{/if}
							</small>
						</button>
					{/each}
				</div>
			{/if}

			<details bind:open={panelAbierto}>
				<summary>Otra hora, glucosa o nota</summary>
				<p class="pista-panel">Con este panel abierto, cualquier botón usa esta fecha y hora.</p>
				<div class="rejilla">
					<label>Fecha<input type="date" name="fecha" value={r.hoy} /></label>
					<label>Hora<input type="time" name="hora" value={data.ahora} /></label>
					<label>Glucosa<input type="number" name="glucosa" min="20" max="600" placeholder="mg/dL" inputmode="numeric" /></label>
					<label>Tabletas<input type="number" name="tabletas" min="0.5" max="30" step="0.5" placeholder="p. ej. 6" inputmode="decimal" /></label>
					<label class="ancho">Nota<input type="text" name="nota" maxlength="200" placeholder="caminata larga, corrección de más…" /></label>
				</div>
				<button class="secundario">Registrar con estos datos</button>
			</details>
		</form>

		{#if form?.error}
			<p class="aviso malo">{form.error}</p>
		{:else if form?.ok}
			<p class="aviso bien">{form.ok}</p>
		{/if}
	</section>

	<!-- INVENTARIO ------------------------------------------------------ -->
	<section class="tiles">
		{#if data.sensor}
			<div class="tile sensor {data.sensor.nivel}">
				<span class="etiqueta">Ahora</span>
				<strong class="hero">
					{data.sensor.sg ?? '—'}<span
						class="flecha-sensor"
						class:calc={flechaCalculada}
						title={flechaCalculada
							? `calculada de tus lecturas (${data.sensor.calculada?.porMinuto.toFixed(1)} mg/dL por minuto)`
							: 'tendencia del sensor'}>{flechaAhora}</span>
				</strong>
				<span class="pie">
					mg/dL · {minutosDesdeLectura === null
						? data.sensor.hora
						: minutosDesdeLectura < 2
							? 'recién'
							: `hace ${minutosDesdeLectura} min`}
				</span>
			</div>
		{/if}
		<div class="tile destacado">
			<span class="etiqueta">Quedan</span>
			<strong class="hero">{decimal(r.existencias)}</strong>
			<span class="pie">tabletas en casa</span>
		</div>
		<div class="tile">
			<span class="etiqueta">Te duran</span>
			<strong>{r.diasRestantes === null ? '—' : `${r.diasRestantes} d`}</strong>
			<span class="pie">
				{#if r.seAcabaEl}se acaban ~{etiquetaLarga(r.seAcabaEl, r.hoy)}{:else}registra una compra{/if}
			</span>
		</div>
		<div class="tile">
			<span class="etiqueta">Ritmo</span>
			<strong>{decimal(r.porSemana)}</strong>
			<span class="pie">por semana · {decimal(r.porDia)}/día ({r.ventana} d)</span>
		</div>
		{#if data.subida && subidaTableta}
			<div class="tile">
				<span class="etiqueta">15 g te suben</span>
				<strong>+{Math.round(subidaTableta?.por15g ?? 0)}</strong>
				<span class="pie">
					mg/dL a los 30 min, en reposo · {subidaTableta?.eventos ?? 0}
					{subidaTableta?.eventos === 1 ? 'baja medida' : 'bajas medidas'}{#if data.subida.enEjercicio}{' '}·
						{data.subida.enEjercicio} en ejercicio aparte{/if}
				</span>
			</div>
		{/if}
		<div class="tile">
			<span class="etiqueta">Costo</span>
			<strong>{r.costoMensual === null ? '—' : pesos(r.costoMensual)}</strong>
			<span class="pie">
				{#if r.costoPorTableta !== null}al mes · {pesos(r.costoPorTableta)} c/u{:else}captura el precio{/if}
			</span>
		</div>
	</section>

	</div>
	<div class="col panel">
	<!-- CURVA DE 24 H ---------------------------------------------------- -->
	{#if data.curva && segmentos.length}
		<section class="tarjeta">
			<h2>Glucosa <small>últimas 24 h, con tus tomas encima</small></h2>
			<div
				class="curva-caja"
				onpointermove={sondear}
				onpointerdown={sondear}
				onpointerleave={() => (sonda = null)}
				role="presentation"
			>
				<svg class="curva" viewBox="0 0 100 100" preserveAspectRatio="none" role="img"
					aria-label="Curva de glucosa de las últimas 24 horas con marcas donde tomaste tabletas">
					<rect x="0" y={py(LIMITE_BAJO)} width="100" height={100 - py(LIMITE_BAJO)} class="zona-baja" />
					<line x1="0" x2="100" y1={py(LIMITE_BAJO)} y2={py(LIMITE_BAJO)}
						class="limite bajo" vector-effect="non-scaling-stroke" />
					<line x1="0" x2="100" y1={py(LIMITE_ALTO)} y2={py(LIMITE_ALTO)}
						class="limite" vector-effect="non-scaling-stroke" />
					{#each data.curva.marcas as m (m.id)}
						<line x1={px(m.x)} x2={px(m.x)} y1="0" y2="100"
							class="marca-toma" vector-effect="non-scaling-stroke" />
					{/each}
					{#each segmentos as d, i (i)}
						<polyline points={d} class="linea" vector-effect="non-scaling-stroke" />
					{/each}
				</svg>

				<span class="guia" style="top: {py(LIMITE_ALTO)}%">{LIMITE_ALTO}</span>
				<span class="guia" style="top: {py(LIMITE_BAJO)}%">{LIMITE_BAJO}</span>
				{#each marcasApiladas as m (m.id)}
					<span
						class="pastilla"
						class:comb={m.proposito === 'combustible'}
						class:otra={m.fuente !== TABLETA}
						style="left: {dentro(m.pos)}%; top: {m.nivel * 19}px"
						title="{m.hora}: {m.fuente === TABLETA ? `${decimal(m.tabletas)} tabletas` : m.fuente} · {decimal(m.gramos)} g{m.proposito === 'combustible' ? ' · combustible' : ''}"
					>{m.etiqueta}</span>
				{/each}

				{#if sonda}
					<span class="cruz" style="left: {px(sonda.x)}%"></span>
				{/if}
				{#if mostrado}
					<span class="punto" class:sondeando={!!sonda}
						style="left: {px(mostrado.x)}%; top: {py(mostrado.sg)}%"></span>
					<!-- El valor actual va a la IZQUIERDA del punto: arriba chocaría con
					     las pastillas de las tomas recientes, que viven en la misma orilla. -->
					<span
						class="globo"
						class:actual={!sonda}
						style="left: {sonda ? dentroGlobo(px(mostrado.x)) : px(mostrado.x)}%; top: {py(mostrado.sg)}%"
					>
						<b>{mostrado.sg}</b>
						{#if sonda}
							<span class="globo-sub">{mostrado.hora}</span>
						{:else if flechaAhora}
							<span class="globo-sub" class:calc={flechaCalculada}
								title={flechaCalculada ? 'calculada de tus últimas lecturas' : 'del sensor'}
							>{flechaAhora}</span>
						{/if}
					</span>
				{/if}
			</div>
			<div class="eje-x">
				{#each marcasHora as t (t.x)}
					<span style="left: {dentro(t.x)}%">{t.etiqueta}</span>
				{/each}
			</div>
			<p class="pie">
				Cada marca es una toma. Lo que pasa después de la marca es la respuesta a
				si alcanzaron.
			</p>
		</section>
	{/if}

	<!-- ÚLTIMOS 14 DÍAS -------------------------------------------------- -->
	<section class="tarjeta">
		<h2>Carbos de rescate por día <small>gramos · últimos 14</small></h2>
		<div class="barras">
			{#each r.serie as d (d.fecha)}
				<div
					class="col"
					title="{etiquetaLarga(d.fecha, r.hoy)}: {decimal(d.gramos)} g{d.gramos > d.gramosRescate
						? ` (${decimal(d.gramos - d.gramosRescate)} g de combustible)`
						: ''}"
				>
					<div class="pista">
						{#if d.gramos > 0}
							<div class="barra" style="height: {(d.gramos / maxBarra) * 100}%">
								{#if d.gramos > d.gramosRescate}
									<!-- el combustible va arriba y más tenue: no fue una baja -->
									<div class="barra-comb" style="height: {((d.gramos - d.gramosRescate) / d.gramos) * 100}%"></div>
								{/if}
								{#if d.gramos === maxBarra}<span class="valor">{decimal(d.gramos)}</span>{/if}
							</div>
						{/if}
					</div>
					<span class="dia" class:hoy={d.fecha === r.hoy}>{d.etiqueta.split(' ')[1]}</span>
				</div>
			{/each}
		</div>
		{#if r.porContexto.length}
			<ul class="desglose">
				{#each r.porContexto as c (c.llave)}
					<li><span>{c.llave}</span> <b>{c.eventos}</b></li>
				{/each}
			</ul>
		{/if}
	</section>

	<!-- HISTORIAL -------------------------------------------------------- -->
	<section class="tarjeta">
		<h2>Historial</h2>
		{#if !porDia.length}
			<p class="vacio">Nada registrado todavía. El primer botón de arriba lo arregla.</p>
		{/if}
		{#each porDia as grupo (grupo.fecha)}
			<h3 class="dia-titulo">
				{etiquetaLarga(grupo.fecha, r.hoy)}
				<small>{decimal(grupo.tomas.reduce((s, t) => s + t.gramos, 0))} g</small>
			</h3>
			<ul class="tomas">
				{#each grupo.tomas as t (t.id)}
					<li>
						<span class="hora">{t.hora}</span>
						<span class="cantidad">
							{#if t.fuente === TABLETA}
								{decimal(t.tabletas)} × {r.carbsPorTableta} g
							{:else}
								{partirNombre(t.fuente).sabor} · {decimal(t.gramos)} g
							{/if}
						</span>
						<span class="meta">
							{#if t.proposito === 'combustible'}<b class="tag-comb">combustible</b>{/if}
							{#if t.cafeina}<b class="cafe">{cafeinaTexto(t.cafeina)}</b>{/if}
							{#if t.tendencia}<b class="flecha">{t.tendencia}</b>{/if}
							{#if t.glucosa}<b>{t.glucosa}{#if t.glucosa30}→{t.glucosa30}{/if} mg/dL</b>{/if}
							{t.contexto || franja(t.hora)}{t.nota ? ` · ${t.nota}` : ''}
						</span>
						<form method="POST" action="?/borrar" use:enhance>
							<input type="hidden" name="id" value={t.id} />
							<button class="borrar" aria-label="Borrar registro de las {t.hora}">×</button>
						</form>
					</li>
				{/each}
			</ul>
		{/each}
	</section>

	<!-- COMPRAS ---------------------------------------------------------- -->
	<section class="tarjeta">
		<details>
			<summary><h2>Compras e inventario</h2></summary>

			<h3 class="subtitulo">Lo que tienes</h3>
			<ul class="inventario">
				<li>
					<span>Tabletas de glucosa</span>
					<b>{decimal(r.existencias)}</b>
					<span class="meta">{r.costoPorTableta !== null ? `${pesos(r.costoPorTableta)} c/u` : ''}</span>
				</li>
				{#each r.inventario as i (i.fuente)}
					<li class:agotado={i.quedan <= 0}>
						<span>{i.fuente}</span>
						<b>{i.quedan}</b>
						<span class="meta">
							de {i.comprado}{i.costoUnidad !== null ? ` · ${pesos(i.costoUnidad)} c/u` : ''}
						</span>
					</li>
				{/each}
			</ul>

			<h3 class="subtitulo">Registrar una compra</h3>
			<form method="POST" action="?/comprar" use:enhance class="rejilla">
				<label class="ancho">
					Qué compraste
					<select id="compra-fuente" name="fuente" bind:value={fuenteCompra}>
						<option value={TABLETA}>Tabletas de glucosa</option>
						{#each data.fuentes as f (f.id)}
							<option value={f.nombre}>{f.nombre}</option>
						{/each}
					</select>
				</label>
				<label>Fecha<input id="compra-fecha" type="date" name="fecha" value={r.hoy} /></label>
				{#if fuenteCompra === TABLETA}
					<label>Frascos<input id="compra-frascos" type="number" name="frascos" min="1" value="1" inputmode="numeric" /></label>
					<label>Tabletas c/u<input id="compra-porfrasco" type="number" name="porFrasco" min="1" value={data.tabletasPorFrasco} inputmode="numeric" required /></label>
				{:else}
					<label>Unidades<input id="compra-unidades" type="number" name="unidades" min="1" value="1" inputmode="numeric" required /></label>
				{/if}
				<label>Costo total<input id="compra-costo" type="number" name="costo" min="0" step="0.01" placeholder="MXN" inputmode="decimal" /></label>
				<label class="ancho">Nota<input id="compra-marca" type="text" name="marca" maxlength="60" placeholder="Dex4, paquete surtido…" /></label>
				<button class="secundario ancho">Agregar al inventario</button>
			</form>

			<ul class="compras">
				{#each data.compras as c (c.id)}
					<li>
						<span>{etiquetaLarga(c.fecha, r.hoy)}</span>
						<b>+{c.tabletas}</b>
						<span class="meta">
							{c.fuente === TABLETA ? 'tabletas' : c.fuente}{c.marca ? ` · ${c.marca}` : ''}{c.costo
								? ` · ${pesos(c.costo)}`
								: ''}
						</span>
						<form method="POST" action="?/borrarCompra" use:enhance>
							<input type="hidden" name="id" value={c.id} />
							<button class="borrar" aria-label="Borrar compra">×</button>
						</form>
					</li>
				{/each}
			</ul>
			<p class="pie">Tabletas compradas: {r.compradas} · consumidas: {decimal(r.consumidas)}</p>

			<form method="POST" action="?/ajustes" use:enhance class="rejilla">
				<label>Carbos por tableta<input type="number" name="carbs" min="1" max="50" step="0.5" value={r.carbsPorTableta} inputmode="decimal" /></label>
				<button class="secundario">Guardar</button>
			</form>
		</details>
	</section>

	<!-- PREAJUSTES ------------------------------------------------------- -->
	<section class="tarjeta">
		<details>
			<summary><h2>Tus preajustes</h2></summary>
			<p class="pie">
				Los botones que aparecen junto a las tabletas. Corrige gramos y cafeína con la
				etiqueta en mano: «cafeína» marcada sin miligramos se registra como
				<em>con cafeína, sin dato</em>, nunca con un número inventado.
			</p>
			{#each data.fuentes as f (f.id)}
				<form method="POST" action="?/actualizarFuente" use:enhance class="preset-fila">
					<input type="hidden" name="id" value={f.id} />
					<span class="preset-nombre">{f.nombre}</span>
					<label>g<input id="pf-g-{f.id}" type="number" name="gramos" value={f.gramos} min="1" max="200" step="0.5" inputmode="decimal" /></label>
					<label class="check"><input id="pf-c-{f.id}" type="checkbox" name="traeCafeina" value="1" checked={f.cafeina !== 0} /> cafeína</label>
					<label>mg<input id="pf-mg-{f.id}" type="number" name="cafeina" value={f.cafeina > 0 ? f.cafeina : ''} placeholder="?" min="0" inputmode="numeric" /></label>
					<button class="secundario chico">Guardar</button>
					<button class="borrar" formaction="?/borrarFuente" aria-label="Borrar {f.nombre}">×</button>
				</form>
			{/each}

			<h3 class="subtitulo">Agregar uno</h3>
			<form method="POST" action="?/agregarFuente" use:enhance class="rejilla">
				<label class="ancho">Nombre<input id="pn-nombre" type="text" name="nombre" maxlength="40" placeholder="Gu Salted Caramel, jugo de manzana…" required /></label>
				<label>Gramos de carbos<input id="pn-gramos" type="number" name="gramos" min="1" max="200" step="0.5" inputmode="decimal" required /></label>
				<label class="check"><input id="pn-cafe" type="checkbox" name="traeCafeina" value="1" /> trae cafeína</label>
				<label>mg, si lo sabes<input id="pn-mg" type="number" name="cafeina" min="0" inputmode="numeric" /></label>
				<button class="secundario ancho">Agregar preajuste</button>
			</form>
		</details>
	</section>

	</div>
	</div>

	<footer>
		<p class="respaldos">
			<span class:atrasado={horasRespaldo === null || horasRespaldo > 36}>
				Último respaldo: {haceCuanto(horasRespaldo)}
			</span>
			·
			<span class:atrasado={horasCopiaPc === null || horasCopiaPc > 72}>
				copia en tu PC: {haceCuanto(horasCopiaPc)}
			</span>
		</p>
		Registro personal, no es un dispositivo médico.
	</footer>
</main>

<style>
	:root {
		color-scheme: light;
		--bg: #f7f7f6;
		--surface: #ffffff;
		--surface-2: #f0f0ee;
		--line: #e3e3de;
		--ink: #16161a;
		--ink-2: #52514e;
		--ink-3: #85847c;
		--acento: #2a78d6;
		--acento-ink: #ffffff;
		--malo: #e34948;
		--bien: #008300;
		--ambar: #9a6400;
		--radio: 14px;
	}
	@media (prefers-color-scheme: dark) {
		:root:not([data-theme='light']) {
			color-scheme: dark;
			--bg: #121312;
			--surface: #1a1a19;
			--surface-2: #242423;
			--line: #2f2f2c;
			--ink: #ffffff;
			--ink-2: #c3c2b7;
			--ink-3: #8d8c83;
			--acento: #3987e5;
			--malo: #e66767;
			--bien: #4caf50;
			--ambar: #d8a029;
		}
	}
	:root[data-theme='dark'] {
		color-scheme: dark;
		--bg: #121312;
		--surface: #1a1a19;
		--surface-2: #242423;
		--line: #2f2f2c;
		--ink: #ffffff;
		--ink-2: #c3c2b7;
		--ink-3: #8d8c83;
		--acento: #3987e5;
		--malo: #e66767;
		--bien: #4caf50;
		--ambar: #d8a029;
	}

	/* Sin esto cada tarjeta mide 30 px más que su columna (padding + borde
	   por fuera) y la página se desborda de lado en el celular. */
	:global(*),
	:global(*::before),
	:global(*::after) {
		box-sizing: border-box;
	}

	:global(body) {
		margin: 0;
		background: var(--bg);
		color: var(--ink);
		font: 16px/1.45 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
		-webkit-text-size-adjust: 100%;
	}

	main {
		max-width: 1180px;
		margin: 0 auto;
		padding: 20px 16px 48px;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	/* Móvil: una sola columna, y los botones hasta arriba — la app se usa
	   a media corrida, el registro va primero y punto. */
	.cols {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.col {
		display: flex;
		flex-direction: column;
		gap: 14px;
		min-width: 0; /* sin esto, la curva estira la columna del grid */
	}
	/* Una fila larga del historial no tiene por qué ensanchar la tarjeta:
	   que se recorte con puntos suspensivos, no que empuje la página. */
	.col > * {
		max-width: 100%;
	}

	/* Escritorio: captura y cifras a la izquierda, gráficas e historial a la
	   derecha. La columna de captura se queda fija al hacer scroll. */
	@media (min-width: 900px) {
		main {
			padding: 28px 24px 56px;
		}
		.cols {
			display: grid;
			grid-template-columns: minmax(320px, 380px) minmax(0, 1fr);
			align-items: start;
			gap: 18px;
		}
		.col.captura {
			position: sticky;
			top: 20px;
		}
	}

	h1 {
		font-size: 1.35rem;
		margin: 0;
		letter-spacing: -0.02em;
	}
	h2 {
		font-size: 0.95rem;
		margin: 0 0 10px;
		display: inline;
	}
	h2 small,
	h1 + .sub {
		font-weight: 400;
		color: var(--ink-3);
	}
	.sub {
		margin: 4px 0 0;
		font-size: 0.9rem;
	}

	.tarjeta {
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radio);
		padding: 14px;
	}

	/* --- registro --- */
	fieldset.chips {
		border: 0;
		padding: 0;
		margin: 0 0 10px;
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	fieldset.chips legend {
		font-size: 0.75rem;
		color: var(--ink-3);
		padding: 0 0 6px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.chip input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
	.chip span {
		display: inline-block;
		padding: 7px 12px;
		border: 1px solid var(--line);
		border-radius: 999px;
		background: var(--surface-2);
		color: var(--ink-2);
		font-size: 0.85rem;
		cursor: pointer;
		user-select: none;
	}
	.chip input:checked + span {
		background: var(--acento);
		border-color: var(--acento);
		color: var(--acento-ink);
	}
	.chip input:focus-visible + span {
		outline: 2px solid var(--acento);
		outline-offset: 2px;
	}

	.botones {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 8px;
		margin: 12px 0 4px;
	}
	.tableta {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		padding: 14px 0;
		border: 0;
		border-radius: 12px;
		background: var(--acento);
		color: var(--acento-ink);
		cursor: pointer;
		font: inherit;
	}
	.tableta strong {
		font-size: 1.5rem;
		line-height: 1;
	}
	.tableta small {
		font-size: 0.7rem;
		opacity: 0.85;
	}
	.tableta:active {
		transform: scale(0.97);
	}

	details {
		margin-top: 10px;
	}
	summary {
		cursor: pointer;
		color: var(--ink-3);
		font-size: 0.85rem;
	}
	summary h2 {
		color: var(--ink);
		font-size: 0.95rem;
	}

	.rejilla {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
		gap: 8px;
		margin: 10px 0;
	}
	.rejilla label {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 0.75rem;
		color: var(--ink-3);
	}
	.ancho {
		grid-column: 1 / -1;
	}
	input[type='date'],
	input[type='time'],
	input[type='number'],
	input[type='text'] {
		font: inherit;
		padding: 9px 10px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--surface-2);
		color: var(--ink);
		min-width: 0;
	}
	.secundario {
		font: inherit;
		padding: 9px 14px;
		border: 1px solid var(--acento);
		border-radius: 10px;
		background: transparent;
		color: var(--acento);
		cursor: pointer;
		align-self: end;
	}

	.aviso {
		margin: 10px 0 0;
		font-size: 0.85rem;
	}
	.aviso.bien {
		color: var(--bien);
	}
	.aviso.malo {
		color: var(--malo);
	}

	/* --- tiles --- */
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
		gap: 10px;
	}
	.tile {
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radio);
		padding: 12px 14px;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.tile .etiqueta {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--ink-3);
	}
	.tile strong {
		font-size: 1.5rem;
		letter-spacing: -0.02em;
	}
	.tile.destacado .hero {
		font-size: 2.4rem;
		line-height: 1.05;
		color: var(--acento);
	}
	.pie {
		font-size: 0.75rem;
		color: var(--ink-3);
	}

	/* --- curva de 24 h --- */
	.curva-caja {
		position: relative;
		height: 150px;
		margin-top: 8px;
		/* pan-y deja que la página siga haciendo scroll vertical mientras el
		   dedo se arrastra de lado sobre la gráfica. */
		touch-action: pan-y;
	}
	@media (min-width: 900px) {
		.curva-caja {
			height: 230px;
		}
	}
	.curva {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		display: block;
	}
	.linea {
		fill: none;
		stroke: var(--acento);
		stroke-width: 2;
		stroke-linejoin: round;
		stroke-linecap: round;
	}
	.zona-baja {
		fill: var(--malo);
		opacity: 0.09;
	}
	.limite {
		stroke: var(--line);
		stroke-width: 1;
		stroke-dasharray: 3 4;
	}
	.limite.bajo {
		stroke: var(--malo);
		opacity: 0.55;
	}
	.marca-toma {
		stroke: var(--ink-3);
		stroke-width: 1;
		stroke-dasharray: 2 3;
		opacity: 0.7;
	}
	/* El texto es HTML encima del SVG: nítido y del mismo tamaño en
	   cualquier ancho, porque no lo escala el viewBox. */
	.guia,
	.eje-x span {
		position: absolute;
		font-size: 0.7rem;
		color: var(--ink-3);
		pointer-events: none;
	}
	.guia {
		left: 2px;
		transform: translateY(-115%);
		background: var(--surface);
		padding: 0 3px;
	}
	.pastilla {
		position: absolute;
		top: 0;
		transform: translate(-50%, -4px);
		background: var(--acento);
		color: var(--acento-ink);
		font-size: 0.7rem;
		font-weight: 700;
		border-radius: 999px;
		padding: 2px 7px;
		white-space: nowrap;
	}
	/* Punto actual, sonda y globo de valor */
	.punto {
		position: absolute;
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--acento);
		transform: translate(-50%, -50%);
		box-shadow: 0 0 0 3px var(--surface), 0 0 0 5px color-mix(in srgb, var(--acento) 35%, transparent);
		pointer-events: none;
	}
	.punto.sondeando {
		background: var(--ink);
		box-shadow: 0 0 0 3px var(--surface);
	}
	.cruz {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 1px;
		background: var(--ink-3);
		opacity: 0.5;
		pointer-events: none;
	}
	.globo {
		position: absolute;
		transform: translate(-50%, -190%);
		background: var(--ink);
		color: var(--bg);
		border-radius: 8px;
		padding: 3px 8px;
		font-size: 0.78rem;
		white-space: nowrap;
		pointer-events: none;
		display: flex;
		align-items: baseline;
		gap: 5px;
	}
	.globo.actual {
		transform: translate(calc(-100% - 12px), -50%);
	}
	.globo b {
		font-size: 0.95rem;
	}
	.globo-sub {
		opacity: 0.75;
	}
	/* Una flecha calculada no se dibuja igual que una del sensor. */
	.globo-sub.calc,
	.flecha-sensor.calc {
		opacity: 0.6;
		font-style: italic;
	}

	/* Un Gu o un jugo se distingue de las tabletas; el combustible va tenue. */
	.pastilla.otra {
		background: var(--surface);
		color: var(--acento);
		border: 1.5px solid var(--acento);
	}
	.pastilla.comb {
		opacity: 0.55;
	}

	.eje-x {
		position: relative;
		height: 16px;
		margin-top: 2px;
	}
	.eje-x span {
		transform: translateX(-50%);
	}

	/* --- tile del sensor --- */
	.tile.sensor .hero {
		font-size: 2.4rem;
		line-height: 1.05;
	}
	.tile.sensor.rango .hero {
		color: var(--bien);
	}
	.tile.sensor.bajo .hero {
		color: var(--malo);
	}
	.tile.sensor.alto .hero {
		color: #c98500;
	}
	.flecha-sensor {
		font-size: 1.4rem;
		margin-left: 4px;
		color: var(--ink-2);
	}

	/* --- preajustes en la captura --- */
	.presets {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
		gap: 6px;
		margin: 8px 0 4px;
	}
	.preset {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 1px;
		padding: 8px 10px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--surface-2);
		color: var(--ink);
		font: inherit;
		text-align: left;
		cursor: pointer;
		min-width: 0;
	}
	.preset:hover {
		border-color: var(--acento);
	}
	.preset:active {
		transform: scale(0.98);
	}
	.preset strong {
		font-size: 0.85rem;
		line-height: 1.2;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 100%;
	}
	.preset small {
		font-size: 0.7rem;
		color: var(--ink-3);
	}
	.preset .marca {
		font-size: 0.62rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--acento);
	}
	.cafe {
		color: var(--ambar);
	}
	.tag-comb {
		font-weight: 600;
		color: var(--ink-3);
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.pista-panel {
		font-size: 0.75rem;
		color: var(--ink-3);
		margin: 6px 0 0;
	}

	/* --- inventario y preajustes --- */
	.subtitulo {
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--ink-3);
		margin: 16px 0 6px;
	}
	.inventario {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.inventario li {
		display: flex;
		align-items: baseline;
		gap: 10px;
		padding: 7px 0;
		border-top: 1px solid var(--line);
		min-width: 0;
	}
	.inventario li > span:first-child {
		flex: 1 1 0;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.inventario b {
		font-variant-numeric: tabular-nums;
		font-size: 1.05rem;
	}
	.inventario .meta {
		flex: 0 0 auto;
	}
	.inventario .agotado b {
		color: var(--malo);
	}
	select {
		font: inherit;
		padding: 9px 10px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--surface-2);
		color: var(--ink);
		min-width: 0;
	}
	.preset-fila {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 10px;
		padding: 9px 0;
		border-top: 1px solid var(--line);
	}
	.preset-fila .preset-nombre {
		flex: 1 1 100%;
		font-weight: 600;
		font-size: 0.88rem;
	}
	.preset-fila label {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 0.75rem;
		color: var(--ink-3);
	}
	.preset-fila input[type='number'] {
		width: 62px;
		padding: 6px 7px;
	}
	.check {
		display: flex;
		flex-direction: row !important;
		align-items: center;
		gap: 6px;
		font-size: 0.8rem;
		color: var(--ink-2);
	}
	.secundario.chico {
		padding: 5px 10px;
		font-size: 0.8rem;
	}

	/* --- barras --- */
	.barras {
		display: flex;
		align-items: flex-end;
		gap: 2px;
		height: 96px;
		margin-top: 6px;
	}
	.col {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		height: 100%;
	}
	.pista {
		flex: 1;
		width: 100%;
		display: flex;
		align-items: flex-end;
		border-bottom: 1px solid var(--line);
	}
	.barra {
		width: 100%;
		background: var(--acento);
		border-radius: 4px 4px 0 0;
		min-height: 3px;
		position: relative;
	}
	/* El combustible de una corrida va arriba y tenue: no fue una baja. */
	.barra-comb {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		background: var(--surface);
		opacity: 0.55;
		border-radius: 4px 4px 0 0;
	}
	.barra .valor {
		position: absolute;
		top: -15px;
		left: 50%;
		transform: translateX(-50%);
		font-size: 0.65rem;
		color: var(--ink-2);
	}
	.dia {
		font-size: 0.65rem;
		color: var(--ink-3);
	}
	.dia.hoy {
		color: var(--ink);
		font-weight: 700;
	}

	.desglose {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin: 14px 0 0;
		padding: 0;
	}
	.desglose li {
		font-size: 0.75rem;
		color: var(--ink-2);
		background: var(--surface-2);
		border-radius: 999px;
		padding: 4px 10px;
	}

	/* --- historial --- */
	.dia-titulo {
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--ink-3);
		margin: 14px 0 4px;
		display: flex;
		justify-content: space-between;
	}
	.dia-titulo small {
		text-transform: none;
		letter-spacing: 0;
	}
	.tomas,
	.compras {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.tomas li,
	.compras li {
		display: flex;
		align-items: baseline;
		gap: 8px;
		padding: 8px 0;
		border-top: 1px solid var(--line);
		min-width: 0;
	}
	.hora {
		font-variant-numeric: tabular-nums;
		color: var(--ink);
		font-weight: 600;
	}
	.cantidad {
		white-space: nowrap;
	}
	.meta {
		color: var(--ink-3);
		font-size: 0.8rem;
		flex: 1 1 0;
		min-width: 0; /* sin esto la fila no se encoge y estira la tarjeta */
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.meta b {
		color: var(--ink-2);
	}
	.flecha {
		color: var(--acento);
	}
	.borrar {
		border: 0;
		background: transparent;
		color: var(--ink-3);
		font-size: 1.1rem;
		line-height: 1;
		padding: 4px 6px;
		cursor: pointer;
	}
	.borrar:hover {
		color: var(--malo);
	}
	.vacio {
		color: var(--ink-3);
		font-size: 0.9rem;
		margin: 6px 0 0;
	}

	.respaldos {
		margin: 0 0 4px;
	}
	.respaldos .atrasado {
		color: var(--malo);
		font-weight: 600;
	}
	footer {
		text-align: center;
		font-size: 0.72rem;
		color: var(--ink-3);
		margin-top: 8px;
	}
</style>
