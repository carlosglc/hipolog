// Respaldo de la base de hipolog. Corre DENTRO del contenedor; lo invoca
// ops/respaldar-hipolog.sh desde el homelab. Dos modos:
//
//   node scripts/respaldar.mjs <archivo.db>            → copia verificada en /datos
//   node scripts/respaldar.mjs --registrar [<iso-pc>]  → anota el éxito en la app
//
// Son dos pasos porque el respaldo solo cuenta como hecho cuando la copia ya
// salió del volumen. Si esto anotara el éxito en el primer paso y luego fallara
// el `docker compose cp`, la app diría «respaldado» sin que existiera la copia.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

const RUTA = process.env.HIPOLOG_DB ?? '/datos/hipolog.db';
const [modo, extra] = process.argv.slice(2);

const anotar = (db, clave, valor) =>
	db
		.prepare(
			'INSERT INTO ajustes (clave, valor) VALUES (?, ?) ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor'
		)
		.run(clave, valor);

if (modo === '--registrar') {
	// Queda en la propia app para que un respaldo que dejó de correr se VEA en
	// la pantalla, en vez de descubrirse el día que hace falta restaurar.
	const db = new DatabaseSync(RUTA);
	anotar(db, 'ultimo_respaldo', new Date().toISOString());
	if (extra) anotar(db, 'ultima_copia_pc', extra);
	console.log('registrado');
	process.exit(0);
}

if (!/^hipolog-\d{4}-\d{2}-\d{2}\.db$/.test(modo ?? '')) {
	console.error('uso: respaldar.mjs hipolog-AAAA-MM-DD.db | --registrar [iso]');
	process.exit(2);
}

// Junto a la base: en el contenedor eso es /datos, el volumen.
const destino = join(dirname(RUTA), modo);
if (existsSync(destino)) rmSync(destino); // VACUUM INTO se niega a sobrescribir

// VACUUM INTO saca una copia consistente aunque la app esté escribiendo en ese
// momento, e incluye lo que todavía está en el WAL. Copiar el .db a mano no:
// perdería las escrituras recientes que aún no pasan del WAL al archivo.
new DatabaseSync(RUTA).exec(`VACUUM INTO '${destino}'`);

// Un respaldo que nunca se abrió es una esperanza, no un respaldo.
const copia = new DatabaseSync(destino, { readOnly: true });
const integridad = copia.prepare('PRAGMA integrity_check').get().integrity_check;
const cuenta = (t) => copia.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
const resumen = ['tomas', 'compras', 'fuentes'].map((t) => `${t}=${cuenta(t)}`).join(' ');
copia.close();

if (integridad !== 'ok') {
	rmSync(destino);
	console.error(`copia inválida: integrity_check=${integridad}`);
	process.exit(1);
}
console.log(`ok ${modo} ${resumen}`);
