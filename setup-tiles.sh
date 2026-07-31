#!/usr/bin/env bash
# ============================================================
# Feuerwehr-Kataster – automatischer Kartenaufbau
#
# Wird von install.sh automatisch aufgerufen, kann aber auch später
# manuell erneut ausgeführt werden, um den Kartenausschnitt zu ändern:
#
#   bash setup-tiles.sh <bundesland-slug> "<Adresse oder Ort>" <radius_km>
#
# Beispiel:
#   bash setup-tiles.sh baden-wuerttemberg "Musterstraße 1, 74821 Musterstadt" 20
#
# ============================================================
set -e

BUNDESLAND="$1"
ADRESSE="$2"
RADIUS_KM="${3:-20}"

if [ -z "$BUNDESLAND" ] || [ -z "$ADRESSE" ]; then
  echo "Aufruf: bash setup-tiles.sh <bundesland-slug> \"<Adresse>\" [radius_km]"
  exit 1
fi

cd "$(dirname "$0")"
mkdir -p tiles
cd tiles

echo "[Kartenaufbau] Prüfe benötigte Werkzeuge..."
command -v osmium >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y osmium-tool >/dev/null)
command -v python3 >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y python3 >/dev/null)

echo "[Kartenaufbau] Ermittle Koordinaten für: $ADRESSE"
ENCODED=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$ADRESSE")
GEO=$(curl -fsSL -H "User-Agent: feuerwehr-kataster-setup (Kontakt: siehe Wehr)" \
  "https://nominatim.openstreetmap.org/search?q=${ENCODED}&format=json&limit=1")

LAT=$(echo "$GEO" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['lat'] if d else '')")
LON=$(echo "$GEO" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['lon'] if d else '')")

if [ -z "$LAT" ] || [ -z "$LON" ]; then
  echo "[Kartenaufbau] Adresse konnte nicht gefunden werden. Bitte Schreibweise prüfen oder"
  echo "               stattdessen Koordinaten direkt in dieses Skript eintragen."
  exit 1
fi
echo "[Kartenaufbau] Gefunden: Breite $LAT, Länge $LON"

BBOX=$(python3 - "$LAT" "$LON" "$RADIUS_KM" <<'PYEOF'
import sys, math
lat, lon, radius = float(sys.argv[1]), float(sys.argv[2]), float(sys.argv[3])
dlat = radius / 111.0
dlon = radius / (111.0 * math.cos(math.radians(lat)))
print(f"{lon-dlon},{lat-dlat},{lon+dlon},{lat+dlat}")
PYEOF
)
echo "[Kartenaufbau] Kartenausschnitt (Bounding Box): $BBOX"

if [ ! -f "region.osm.pbf" ]; then
  echo "[Kartenaufbau] Lade Kartendaten für '$BUNDESLAND' von Geofabrik (das kann einige Minuten dauern)..."
  curl -fL --progress-bar -o region.osm.pbf \
    "https://download.geofabrik.de/europe/germany/${BUNDESLAND}-latest.osm.pbf"
else
  echo "[Kartenaufbau] Bundesland-Datei bereits vorhanden, überspringe Download."
fi

echo "[Kartenaufbau] Schneide Umkreis von ${RADIUS_KM} km zu..."
rm -f local.osm.pbf
osmium extract -b "$BBOX" region.osm.pbf -o local.osm.pbf

echo "[Kartenaufbau] Importiere Kartenausschnitt in den Tileserver (kann 10-30 Minuten dauern)..."
cd ..
docker compose --env-file .env run --rm tileserver import

echo "[Kartenaufbau] Fertig. Der Kartenserver kann jetzt gestartet werden:"
echo "               docker compose --env-file .env up -d tileserver"
