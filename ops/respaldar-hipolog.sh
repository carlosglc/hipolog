#!/bin/sh
# Respaldo de hipolog.
#
#   respaldar-hipolog.sh              el diario, hipolog-AAAA-MM-DD.db
#                                     (lo corre cron; se guarda 30 días)
#   respaldar-hipolog.sh <etiqueta>   una copia a mano, <etiqueta>-AAAAMMDD-HHMM.db
#                                     (nunca pisa al diario, nunca se borra sola)
#
# La etiqueta existe por la restauración: antes de restaurar se guarda el estado
# actual, por si se eligió mal la fecha. Con el nombre diario, ese paso
# sobrescribiría justo el respaldo de hoy que quizá se quería restaurar.
#
#   copia consistente y verificada → fuera del volumen → 30 días aquí
#
# La copia FUERA de esta máquina la jala la PC cada hora
# (ops/copiar-respaldos.sh): un respaldo en el mismo disco no te salva si se
# muere el disco. La PC guarda todo el historial; aquí solo 30 días.
set -eu

DIR="$HOME/respaldos"
LOG="$DIR/respaldos.log"
APP="$HOME/docker/hipolog"
if [ $# -gt 0 ]; then
	F="$1-$(date -u +%Y%m%d-%H%M).db"
else
	# 09:00 UTC en cron = 03:00 en México, así que la fecha UTC es la del día.
	F="hipolog-$(date -u +%F).db"
fi

mkdir -p "$DIR"
log() { echo "[$(date -u '+%F %T')] $*" >> "$LOG"; }

cd "$APP"

# 1 · Copia consistente y verificada, dentro del volumen.
if ! salida=$(docker compose exec -T hipolog node scripts/respaldar.mjs "$F" 2>&1); then
	log "FALLÓ la copia: $salida"
	exit 1
fi

# 2 · Sacarla del volumen. Hasta aquí el respaldo NO cuenta como hecho.
docker compose cp "hipolog:/datos/$F" "$DIR/$F" >/dev/null 2>&1 || true
docker compose exec -T hipolog rm -f "/datos/$F"
if [ ! -s "$DIR/$F" ]; then
	log "FALLÓ: $F no salió del volumen"
	exit 1
fi

# 3 · Ahora sí, anotarlo en la app. De paso, cuándo copió la PC por última vez
#     (ops/copiar-respaldos.sh toca este archivo cada vez que termina bien).
PC=""
[ -f "$DIR/.ultima-copia-pc" ] && PC=$(date -u -r "$DIR/.ultima-copia-pc" +%FT%TZ)
docker compose exec -T hipolog node scripts/respaldar.mjs --registrar "$PC" >/dev/null

log "$salida"

# 4 · Treinta días aquí. Solo toca los automáticos: los manuales de antes de un
#     despliegue (respaldo-antes-*.db) se quedan.
find "$DIR" -name 'hipolog-????-??-??.db' -mtime +30 -delete
