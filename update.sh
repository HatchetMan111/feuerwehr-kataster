#!/usr/bin/env bash
# ============================================================
# Feuerwehr-Kataster – Update
# Wird IM CONTAINER ausgeführt (z.B. via "pct exec <CTID> -- bash update.sh"
# oder direkt per SSH/Konsole im Container aus /opt/feuerwehr-kataster):
#
#   cd /opt/feuerwehr-kataster && bash update.sh
#
# ============================================================
set -e
cd "$(dirname "$0")"

echo "Hole neueste Version aus dem Repository..."
git pull

echo "Baue Container neu und starte die Anwendung..."
docker compose --env-file .env up -d --force-recreate --build

echo "Update abgeschlossen. Die Anwendung läuft mit der neuesten Version."
