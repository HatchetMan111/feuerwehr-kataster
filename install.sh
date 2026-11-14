#!/usr/bin/env bash
# ============================================================
# Feuerwehr-Kataster – Installer für Proxmox VE
# Wird DIREKT AUF DEM PROXMOX-HOST ausgeführt (nicht im Container):
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/HatchetMan111/feuerwehr-kataster/main/install.sh)"
#
# ============================================================
set -e

APP="Feuerwehr-Kataster"
GH_REPO="https://github.com/HatchetMan111/feuerwehr-kataster"

msg()  { echo -e "\n\033[1;32m[$APP]\033[0m $1"; }
fail() { echo -e "\n\033[1;31m[$APP] Fehler:\033[0m $1"; exit 1; }

if ! command -v pveversion >/dev/null 2>&1; then
  fail "Dieses Skript muss auf einem Proxmox-VE-Host ausgeführt werden."
fi

if ! command -v whiptail >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y whiptail >/dev/null
fi

# Nächste freie Container-ID automatisch ermitteln (cluster-weit über pvesh;
# Fallback: lokal ab 201 hochzählen, bis eine ID frei ist)
NEXT_ID=$(pvesh get /cluster/nextid 2>/dev/null | head -1 | tr -dc '0-9')
if ! [[ "$NEXT_ID" =~ ^[0-9]+$ ]]; then
  NEXT_ID=201
  while pct status "$NEXT_ID" >/dev/null 2>&1; do
    NEXT_ID=$((NEXT_ID + 1))
  done
fi

# Eingabe prüfen: numerisch und tatsächlich frei - sonst mit neuem
# Vorschlag erneut fragen, statt die Installation hart abzubrechen
while true; do
  CTID=$(whiptail --inputbox "Container-ID (frei wählbar)\nVorschlag: nächste freie ID" 10 60 "$NEXT_ID" --title "$APP installieren" 3>&1 1>&2 2>&3) || exit 1
  if ! [[ "$CTID" =~ ^[0-9]+$ ]]; then
    whiptail --msgbox "Die Container-ID muss eine ganze Zahl sein." 8 55 --title "$APP installieren"
    continue
  fi
  if pct status "$CTID" >/dev/null 2>&1; then
    NEXT_ID=$(pvesh get /cluster/nextid 2>/dev/null | head -1 | tr -dc '0-9')
    if ! [[ "$NEXT_ID" =~ ^[0-9]+$ ]]; then
      NEXT_ID=$CTID
      while pct status "$NEXT_ID" >/dev/null 2>&1; do
        NEXT_ID=$((NEXT_ID + 1))
      done
    fi
    whiptail --msgbox "Container-ID $CTID ist bereits vergeben.\nNächste freie ID: $NEXT_ID" 9 55 --title "$APP installieren"
    continue
  fi
  break
done

HOSTNAME=$(whiptail --inputbox "Hostname des Containers" 9 60 feuerwehr-kataster --title "$APP installieren" 3>&1 1>&2 2>&3) || exit 1
WEHRNAME=$(whiptail --inputbox "Name eurer Feuerwehr (erscheint in der App)" 9 60 "Musterwehr" --title "$APP installieren" 3>&1 1>&2 2>&3) || exit 1
STORAGE=$(whiptail --inputbox "Proxmox-Storage für den Container" 9 60 local-lvm --title "$APP installieren" 3>&1 1>&2 2>&3) || exit 1
BRIDGE=$(whiptail --inputbox "Netzwerk-Bridge" 9 60 vmbr0 --title "$APP installieren" 3>&1 1>&2 2>&3) || exit 1

BUNDESLAND=$(whiptail --menu "In welchem Bundesland liegt eure Feuerwehr?\n(für den automatischen Kartendownload)" 22 60 16 \
  "baden-wuerttemberg" "Baden-Württemberg" \
  "bayern" "Bayern" \
  "berlin" "Berlin" \
  "brandenburg" "Brandenburg" \
  "bremen" "Bremen" \
  "hamburg" "Hamburg" \
  "hessen" "Hessen" \
  "mecklenburg-vorpommern" "Mecklenburg-Vorpommern" \
  "niedersachsen" "Niedersachsen" \
  "nordrhein-westfalen" "Nordrhein-Westfalen" \
  "rheinland-pfalz" "Rheinland-Pfalz" \
  "saarland" "Saarland" \
  "sachsen" "Sachsen" \
  "sachsen-anhalt" "Sachsen-Anhalt" \
  "schleswig-holstein" "Schleswig-Holstein" \
  "thueringen" "Thüringen" \
  --title "$APP installieren" 3>&1 1>&2 2>&3) || exit 1

STANDORT=$(whiptail --inputbox "Adresse oder Ort eures Gerätehauses\n(Mittelpunkt des Kartenausschnitts)" 10 60 "Musterstraße 1, 74821 Musterstadt" --title "$APP installieren" 3>&1 1>&2 2>&3) || exit 1
RADIUS=$(whiptail --inputbox "Umkreis um diesen Standort in km\n(wie groß soll der Kartenausschnitt sein?)" 10 60 20 --title "$APP installieren" 3>&1 1>&2 2>&3) || exit 1

msg "Lade Debian-12-Vorlage (falls noch nicht vorhanden)..."
pveam update >/dev/null
TEMPLATE=$(pveam available --section system | grep debian-12-standard | awk '{print $2}' | tail -1)
[ -z "$TEMPLATE" ] && fail "Konnte keine Debian-12-Vorlage finden."
pveam download local "$TEMPLATE" >/dev/null 2>&1 || true

msg "Erstelle LXC-Container $CTID ($HOSTNAME)..."
pct create "$CTID" "local:vztmpl/$TEMPLATE" \
  --hostname "$HOSTNAME" \
  --cores 2 \
  --memory 6144 \
  --swap 1024 \
  --rootfs "$STORAGE:32" \
  --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp" \
  --features nesting=1,keyctl=1 \
  --unprivileged 1 \
  --onboot 1

pct start "$CTID"
msg "Warte, bis der Container bereit ist und eine IP hat..."
# Nicht einfach fest schlafen: langsamere Hosts brauchen länger, schnellere
# würden unnötig warten. Sobald hostname -I eine Adresse liefert, geht es weiter.
IP=""
for i in $(seq 1 30); do
  IP=$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')
  [ -n "$IP" ] && break
  sleep 1
done
[ -z "$IP" ] && fail "Konnte keine IP-Adresse für den Container ermitteln."
msg "Container-IP: $IP (das Zertifikat wird direkt für diese Adresse ausgestellt)"

msg "Installiere Docker (offizielles Docker-Repository – Debian selbst bietet kein docker-compose-plugin an)..."
pct exec "$CTID" -- bash -c '
set -e
apt-get update -qq
apt-get install -y ca-certificates curl gnupg git >/dev/null
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
ARCH=$(dpkg --print-architecture)
CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $CODENAME stable" > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
'

msg "Lade die Anwendung aus dem Repository..."
pct exec "$CTID" -- bash -c "git clone --depth 1 '$GH_REPO.git' /opt/feuerwehr-kataster"

DB_PASSWORD=$(openssl rand -hex 16)
JWT_SECRET=$(openssl rand -hex 32)
ADMIN_PASSWORD=$(openssl rand -hex 6)

# .env auf dem Host erzeugen und per pct push in den Container bringen -
# zuverlässiger als die Datei über eine stdin-Pipe in pct exec zu schreiben
ENV_TMP=$(mktemp)
cat > "$ENV_TMP" <<EOF
DB_NAME=kataster
DB_USER=kataster
DB_PASSWORD=$DB_PASSWORD
JWT_SECRET=$JWT_SECRET
ADMIN_PASSWORD=$ADMIN_PASSWORD
WEHRNAME=$WEHRNAME
EOF
pct push "$CTID" "$ENV_TMP" /opt/feuerwehr-kataster/.env
rm -f "$ENV_TMP"

msg "Erzeuge TLS-Zertifikat für $IP..."
pct exec "$CTID" -- bash -c "cd /opt/feuerwehr-kataster && bash generate-cert.sh '$IP'"

msg "Starte die Anwendung (Datenbank, Backend, Oberflächen)..."
pct exec "$CTID" -- bash -c "cd /opt/feuerwehr-kataster && docker compose --env-file .env up -d --build postgis backend admin-web einsatz-pwa caddy"

msg "Baue automatisch das Kartenmaterial für einen Umkreis von ${RADIUS}km um '$STANDORT'..."
msg "Das dauert je nach Ausschnittgröße 10 bis 30 Minuten. Die App ist in der Zwischenzeit bereits nutzbar,"
msg "nur die Kartenkacheln erscheinen erst danach."
pct exec "$CTID" -- bash -c "cd /opt/feuerwehr-kataster && bash setup-tiles.sh '$BUNDESLAND' '$STANDORT' '$RADIUS'" \
  || echo "Hinweis: Der automatische Kartenaufbau ist fehlgeschlagen. Siehe README.md, Abschnitt 'Kartenmaterial', zum manuellen Nachholen."

msg "Starte den Kartenserver..."
pct exec "$CTID" -- bash -c "cd /opt/feuerwehr-kataster && docker compose --env-file .env up -d tileserver" || true

msg "Richte tägliche Speicherplatz-Prüfung ein..."
pct exec "$CTID" -- bash -c "cd /opt/feuerwehr-kataster && bash check-disk.sh"
pct exec "$CTID" -- bash -c "
  (crontab -l 2>/dev/null | grep -v check-disk.sh; echo '0 6 * * * cd /opt/feuerwehr-kataster && bash check-disk.sh >/dev/null 2>&1') | crontab -
"

echo ""
echo "=================================================================="
echo " $APP wurde erfolgreich installiert."
echo ""
echo "  Adresse:            https://$IP"
echo "  Admin-Benutzername: admin"
echo "  Admin-Passwort:     $ADMIN_PASSWORD"
echo ""
echo "  WICHTIG:"
echo "  - Der Browser wird beim ersten Aufruf vor dem Zertifikat warnen"
echo "    (selbstsigniert, aber genau für $IP ausgestellt) - das ist normal,"
echo "    einmal bestätigen bzw. das Zertifikat als vertrauenswürdig hinterlegen"
echo "    (siehe README.md, Abschnitt 'TLS-Zertifikat')."
echo "  - Diese Adresse nur über euer VPN erreichbar machen,"
echo "    NICHT im öffentlichen Internet freigeben."
echo "  - Beim ersten Login das Admin-Passwort direkt ändern."
echo "=================================================================="
