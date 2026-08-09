#!/usr/bin/env bash
# ============================================================
# Feuerwehr-Kataster – Speicherplatz-Prüfung
#
# Prüft den belegten Speicherplatz des Containers und schreibt das
# Ergebnis in status/disk.json. Die Web-Oberflächen lesen diese Datei
# über das Backend aus und zeigen bei Bedarf eine Warnung an.
#
# Wird von install.sh automatisch täglich per Cron eingerichtet.
# Manuell ausführen: bash check-disk.sh
# ============================================================
set -e
cd "$(dirname "$0")"
mkdir -p status

WARN_THRESHOLD=85

USED_PERCENT=$(df --output=pcent / | tail -1 | tr -dc '0-9')
if [ "$USED_PERCENT" -ge "$WARN_THRESHOLD" ]; then
  WARNING=true
else
  WARNING=false
fi

cat > status/disk.json <<EOF
{"disk_percent": ${USED_PERCENT}, "warning": ${WARNING}, "checked_at": "$(date -Iseconds)"}
EOF
