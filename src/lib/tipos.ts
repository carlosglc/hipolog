export type Toma = {
	id: number;
	fecha: string; // 'YYYY-MM-DD' local
	hora: string; // 'HH:MM' local
	tabletas: number; // 0 cuando el rescate no fue con tabletas
	gramos: number; // carbohidratos: la unidad común entre todas las fuentes
	fuente: string; // 'tableta' o el nombre de un preajuste
	proposito: string; // 'rescate' (ibas bajo) o 'combustible' (para no bajar)
	cafeina: number; // mg, porque el sabor del gel importa
	contexto: string;
	glucosa: number | null; // mg/dL al momento de la toma, opcional
	glucosa30: number | null; // mg/dL 30 min después: si las tabletas alcanzaron
	tendencia: string; // flechas del sensor: '↓', '↓↓', '↓↓↓', '→'
	nota: string;
};

export type Compra = {
	id: number;
	fecha: string;
	tabletas: number; // UNIDADES de la fuente: tabletas, o geles para un Gu
	fuente: string; // 'tableta' o el nombre de un preajuste
	costo: number; // pesos, 0 si no se capturó
	marca: string;
};

export type Fuente = {
	id: number;
	nombre: string;
	gramos: number;
	cafeina: number;
	/** Propósito sugerido al capturar con el formulario largo. En el tap
	 *  rápido manda el selector de la pantalla, porque el mismo Gu puede ser
	 *  combustible en una corrida y rescate cuando algo se salió de control. */
	proposito: string;
	orden: number;
};

/**
 * Comerse carbohidratos tiene dos intenciones distintas y no se pueden
 * mezclar: un rescate corrige una baja que YA está pasando; el combustible
 * la previene. Solo los rescates cuentan como hipoglucemias y solo ellos
 * entran en "cuánto me sube".
 */
export const RESCATE = 'rescate';
export const COMBUSTIBLE = 'combustible';

/** La fuente de siempre. Su inventario es el que proyecta «te duran N días». */
export const TABLETA = 'tableta';

/**
 * «Trae cafeína, pero no sé cuánta». El empaque dice +Caffeine sin el
 * número, y en un registro médico no se inventa un número. La UI lo muestra
 * como «con cafeína» y los totales lo reportan aparte en vez de sumarlo.
 */
export const CAFEINA_SIN_DATO = -1;

export const CONTEXTOS = [
	'ejercicio',
	'antes de comer',
	'nocturna',
	'insulina de más',
	'sin razón clara'
] as const;

export const TENDENCIAS = ['', '→', '↓', '↓↓', '↓↓↓'] as const;
