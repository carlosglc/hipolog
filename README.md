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

## El sensor (opcional, apagada por default)

Con `CARELINK_URL` apuntando al proxy REST de
`carelink-python-client` (`carelink_client2_proxy.py`, puerto 8081), hipolog
agrega tres cosas:

1. **Tile "Ahora"**: glucosa y flecha del momento, en verde/rojo/ámbar según
   el rango, con hace cuánto llegó la lectura.
2. **Curva de 24 h con tus tomas encima**: un solo eje, la glucosa; las tomas
   son marcas verticales. Lo que pasa *después* de cada marca es la respuesta
   a si las tabletas alcanzaron.
3. **"Cada tableta sube X mg/dL"**: promedio real medido a los 30 minutos.

### Por qué importa persistirlo aquí

CareLink solo expone ~24 h y `glucose-pipeline` todavía no persiste nada
(`[ ] Schema and persistence`). Si nadie copia la curva alrededor de una
hipoglucemia, ese dato **se pierde**. hipolog guarda por evento la glucosa del
momento y la de 30 minutos después (`glucosa`, `glucosa30`), así que el
historial se conserva aunque el sensor ya no lo tenga.

El relleno se hace **al cargar la página**, no con un temporizador: si el
contenedor se reinicia, en la siguiente visita se recupera solo, porque la
ventana de 24 h del proxy alcanza cualquier toma del día.

### De dónde salió el shape (no lo adiviné)

- `glucose-pipeline` **no tiene REST API**: `api/`, `core/`, `ingest/` y `cli/`
  solo tienen `.gitkeep`, y su README marca `[ ] REST API`. Lo único que corre
  ahí es `mcp/server.py`, un servidor MCP **por stdio** — nada que llamar por
  HTTP.
- El REST que sí existe es el de upstream, `carelink_client2_proxy.py`:
  `GET /carelink/` (payload completo, con `sgs`) y `GET /carelink/nohistory`.
  Baja de CareLink cada 300 s y sirve de memoria, así que consultarlo es
  barato.
- Los campos salieron de los volcados reales en
  `~/Projects/carelink-python-client/data-2026*.json`:
  `lastSG = {kind, version, sg, sensorState, timestamp}`, `sgs[]` con 288
  lecturas de 24 h, `lastSGTrend`, y `markers` con
  `INSULIN / MEAL / LOW_GLUCOSE_SUSPENDED / AUTO_BASAL_DELIVERY`.
- `sg: 0` **no es cero**, es "todavía no hay lectura": se normaliza a `null` en
  un solo lugar (`src/lib/glucosa.ts`), igual que hace el MCP.
- Los `timestamp` son ISO **naive y ya locales** (`2026-09-10T22:47:31`): se
  parten con una expresión regular, nunca con `new Date(iso)`.
- De `lastSGTrend` solo observé `'UP'` y `'DOWN'` en los volcados. Las flechas
  se deducen del patrón del nombre (`…_DOUBLE`, `…_TRIPLE`) y **lo que no se
  reconoce se muestra crudo**: mejor una cadena rara visible que una flecha
  equivocada.

### Si el sensor no está

Sin `CARELINK_URL`, o si el proxy no responde, o tarda, o contesta raro: la
lectura devuelve `null`, no se dibuja la curva, no aparece el tile, y **el
registro de tabletas funciona exactamente igual**. Ningún tap espera a la red:
la glucosa se copia después, en el siguiente load.

### Para que funcione en el homelab

El proxy necesita correr en algún lado con el `logindata.json` de CareLink:

```bash
# en el homelab, junto a carelink-python-client
python3 carelink_client2_proxy.py   # escucha en 0.0.0.0:8081
```

Ojo: ese proxy **no tiene autenticación** (su propio código dice
`# Security checks (if any) / TODO`) y manda `Access-Control-Allow-Origin: *`.
Déjalo solo en la LAN.

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
