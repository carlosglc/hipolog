export type Toma = {
	id: number;
	fecha: string; // 'YYYY-MM-DD' local
	hora: string; // 'HH:MM' local
	tabletas: number;
	contexto: string;
	glucosa: number | null; // mg/dL al momento de la toma, opcional
	tendencia: string; // flechas del sensor: '↓', '↓↓', '↓↓↓', '→'
	nota: string;
};

export type Compra = {
	id: number;
	fecha: string;
	tabletas: number;
	costo: number; // pesos, 0 si no se capturó
	marca: string;
};

export const CONTEXTOS = [
	'ejercicio',
	'antes de comer',
	'nocturna',
	'insulina de más',
	'sin razón clara'
] as const;

export const TENDENCIAS = ['', '→', '↓', '↓↓', '↓↓↓'] as const;
