#!/usr/bin/env bash
# ============================================================
# Feuerwehr-Kataster – Zertifikat erzeugen
#
# Erstellt ein selbstsigniertes TLS-Zertifikat mit der aktuellen
# IP-Adresse als "Subject Alternative Name". Das umgeht Caddys
# automatische Zertifikatsverwaltung komplett, die bei reinen
# IP-Adressen (ohne SNI) zu Problemen führen kann.
#
# Aufruf (im Container, im Projektordner):
#   bash generate-cert.sh [IP-Adresse]
#
# Ohne Angabe wird die aktuelle IP des Containers automatisch ermittelt.
# Erneut ausführen und Caddy neu starten, falls sich die IP-Adresse
# ändert (z.B. nach einem Neustart ohne feste IP-Reservierung).
# ============================================================
set -e
cd "$(dirname "$0")"

IP="${1:-$(hostname -I | awk '{print $1}')}"
[ -z "$IP" ] && { echo "Konnte keine IP-Adresse ermitteln. Bitte manuell angeben: bash generate-cert.sh <IP>"; exit 1; }

mkdir -p caddy/certs

echo "Erzeuge selbstsigniertes Zertifikat für: $IP (gültig 10 Jahre)"
openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout caddy/certs/selfsigned.key \
  -out caddy/certs/selfsigned.crt \
  -days 3650 \
  -subj "/CN=Feuerwehr-Kataster" \
  -addext "subjectAltName=IP:${IP},IP:127.0.0.1,DNS:localhost"

chmod 644 caddy/certs/selfsigned.crt
chmod 600 caddy/certs/selfsigned.key

echo "Fertig. Zertifikat liegt unter caddy/certs/. Caddy neu starten mit:"
echo "  docker compose --env-file .env up -d --force-recreate caddy"
