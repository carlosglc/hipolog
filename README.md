# hipolog

Registro de tabletas de glucosa: **cuándo las tomo, por qué, y cuánto me
duran**. SvelteKit + adapter-node + SQLite. Sin dependencias de runtime: la
base se maneja con `node:sqlite`, que viene en Node ≥ 22.

No es un dispositivo médico. Es una libreta que sabe sumar.

## Las dos cosas que modela

| | Qué guarda | Tabla |
|---|---|---|
| **Eventos** | fecha, hora, tabletas, contexto (ejercicio / antes de comer / nocturna / insulina de más / sin razón clara), glucosa y flechas opcionales, nota | `tomas` |
| **Inventario** | compras: frascos × tabletas, costo, marca | `compras` |

El stock es `comprado − consumido`. De ahí salen las cuatro cifras de arriba:
**quedan**, **te duran** (a tu ritmo actual), **ritmo por semana** y **costo
mensual estimado**.

El ritmo promedia una ventana de 30 días, pero si tu historial es más corto usa
los días que existan — si no, los primeros días proyectarían meses de
existencias que no tienes.

## Capturar desde el celular

La pantalla está hecha para usarse **a media corrida y bajando**: tres botones
grandes, `+1 / +2 / +4`, un tap y queda registrado con la hora actual. Los chips
de contexto y flechas son opcionales y se tocan *antes* del botón.

Para registrar algo después, `Otra hora, glucosa o nota` abre fecha, hora,
glucosa, cantidad libre (acepta medias tabletas) y nota.

## Integración con glucose-pipeline (opcional, apagada)

Revisé `~/Projects/glucose-pipeline` antes de depender de él:

- **No hay REST API todavía.** `api/`, `core/`, `adapters/`, `ingest/` y `cli/`
  contienen solo `.gitkeep`, y el README marca `[ ] REST API` sin palomear.
- Lo único que corre es `mcp/server.py`: un servidor **MCP por stdio** que
  consulta CareLink en vivo (caché de 120 s). No escucha en un puerto, así que
  no hay nada que un contenedor de Node pueda llamar por HTTP.
- La forma que sí existe es la que devuelve su herramienta
  `get_current_glucose()`: `{ glucose_mgdl, reading_time, trend, timezone,
  active_insulin_units, smartguard, pump_suspended, sensor_ok,
  sensor_age_hours, reservoir_units }`. `trend` viene de `lastSGTrend` de
  CareLink, **cadena cruda del vendor** — el enum real no está documentado en
  ese repo.

Así que `src/lib/server/glucosa.ts` no inventa un endpoint: queda inerte salvo
que definas `GLUCOSA_URL`. Si la defines, espera esas mismas llaves
(`glucose_mgdl`, `trend`), con 1.5 s de timeout, en segundo plano y dentro de un
`try/catch`: **el evento se guarda primero y la glucosa se adjunta después, si
llega**. Si el API no está, tarda o responde raro, el registro queda igual y en
la UI no pasa nada.

`trend` se guarda tal cual. Cuando conozcas los valores reales, mapéalos en la
constante `FLECHAS` de ese archivo y se verán como flechas.

## Deploy (homie-lab.local, Docker)

Puerto elegido: **8477** → 3000 del contenedor. Está libre de los tuyos (5000
Kavita, 8096 Jellyfin, 8080) y no choca con los defaults típicos de homelab
(8123 Home Assistant, 8384 Syncthing, 9000 Portainer, 3000 Grafana…).

```bash
# en el server
mkdir -p /home/jerry/docker/hipolog
rsync -a --exclude node_modules --exclude datos ./ jerry@homie-lab.local:/home/jerry/docker/hipolog/
ssh jerry@homie-lab.local 'cd /home/jerry/docker/hipolog && docker compose up -d --build'
```

Queda en `http://homie-lab.local:8477`.

- La base vive en el volumen `hipolog-datos`, montado en `/datos`
  (`HIPOLOG_DB=/datos/hipolog.db`). Sobrevive a `docker compose down` y a
  reconstruir la imagen.
- `ORIGIN` debe coincidir con la URL por la que entras; adapter-node valida el
  origen de los POST y sin eso los formularios fallan con 403.
- Respaldo: `docker run --rm -v hipolog-datos:/d -v $PWD:/b alpine tar czf /b/hipolog-$(date +%F).tgz /d`

Sin auth: es LAN. No lo publiques a internet — son datos médicos.

## Desarrollo

```bash
npm install
node scripts/seed.mjs   # carga los dos eventos del 21/09/2026 y un frasco
npm run dev             # http://127.0.0.1:3737
```

## Antes de dar algo por terminado

```bash
npm run check   # 0 errores
npm test        # 11 pruebas (resumen.ts y fechas.ts)
```

Y ábrelo en un navegador de verdad: `npm run build && node build`. El check y el
build compilan sin quejarse cosas que truenan al hidratar.

## Notas de implementación

- Las fechas se guardan como `YYYY-MM-DD` y las horas como `HH:MM`, **en hora
  local y por separado**. Nunca se construye un `Date` desde una cadena ISO: eso
  las interpreta en UTC y una toma de las 19:30 se corre de día.
- Todo el cálculo está en `src/lib/resumen.ts`, puro y sin tocar la base, para
  poder probarlo sin levantar nada.
- Los gramos por tableta son un ajuste (4 g por default, editable en *Compras e
  inventario*).
