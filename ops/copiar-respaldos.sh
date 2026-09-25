#!/bin/sh
# Trae a esta PC los respaldos de hipolog que genera el homelab.
# Lo corre cron cada hora y al encender (ver `crontab -l` en la PC).
#
# Sin --delete a propósito: el homelab guarda 30 días y borra lo viejo; esta
# PC guarda TODO el historial. Es la copia que sobrevive si el disco del
# homelab se muere.
set -eu

DEST="$HOME/respaldos-hipolog"
LOG="$DEST/copia.log"
SSH="ssh -o BatchMode=yes -o ConnectTimeout=15"
mkdir -p "$DEST"

if rsync -a -e "$SSH" --include='hipolog-*.db' --include='respaldo-*.db' --exclude='*' \
	jerry@homie-lab.local:respaldos/ "$DEST/" 2>>"$LOG"; then
	# Le avisa al homelab que la copia llegó. El respaldo diario lo anota en la
	# app, así que si esta PC deja de copiar, se ve en la pantalla.
	$SSH jerry@homie-lab.local 'touch ~/respaldos/.ultima-copia-pc'
	echo "[$(date '+%F %T')] ok · $(ls "$DEST"/*.db | wc -l) respaldos en esta PC" >> "$LOG"
else
	echo "[$(date '+%F %T')] no se pudo copiar (¿homelab apagado o fuera de la red?)" >> "$LOG"
fi
