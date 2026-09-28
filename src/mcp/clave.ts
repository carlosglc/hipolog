import { randomInt } from 'node:crypto';
import { hashDeClave } from './auth.ts';

/**
 * Genera la contraseña del conector y su hash.
 *
 *   node src/mcp/clave.ts
 *
 * La contraseña se imprime UNA vez; en el .env va solo el hash. Son 4
 * bloques de 5 caracteres sin letras ambiguas (~98 bits): se puede teclear
 * en el teléfono sin confundir 0 con O.
 */
const ALFABETO = 'abcdefghjkmnpqrstuvwxyz23456789';
const bloque = () => Array.from({ length: 5 }, () => ALFABETO[randomInt(ALFABETO.length)]).join('');
const clave = [bloque(), bloque(), bloque(), bloque()].join('-');

console.log(`CLAVE=${clave}`);
console.log(`MCP_CLAVE_HASH=${hashDeClave(clave)}`);
