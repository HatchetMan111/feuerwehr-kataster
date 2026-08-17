# Feuerwehr-Kataster

Eine lokal betriebene Kartenanwendung für Feuerwehren: Löschteiche, Zisternen,
Hydranten, Gülle-Gruben und weitere einsatzrelevante Punkte werden mit allen
wichtigen Informationen (Fassungsvermögen, Zugänglichkeit, Eigentümer, letzte
Prüfung) auf einer Karte erfasst – damit dieses Wissen nicht mit einzelnen
Personen verloren geht, sondern für die Wehr über Generationen erhalten bleibt.

Die Anwendung läuft komplett **lokal auf eurem eigenen Proxmox-Server**, ohne
Cloud-Anbieter. Zugriff ausschließlich über euer VPN ins Feuerwehr-Netz.

## Architektur

- **1 LXC-Container** auf Proxmox (Debian 12), darin per Docker Compose:
  - `postgis` – Datenbank (PostgreSQL + PostGIS)
  - `backend` – API (Node.js/Express), Rechte- und Änderungshistorie-Logik
  - `admin-web` – Verwaltungsoberfläche (Desktop, volle Bearbeitung)
  - `einsatz-pwa` – schlanke Karten-App, installierbar auf dem Home-Bildschirm,
    funktioniert auch offline
  - `tileserver` – lokale Kartenkacheln (keine Anfragen ins offene Internet
    im laufenden Betrieb – nur einmalig beim Einrichten)
  - `caddy` – Reverse Proxy mit automatischem TLS-Zertifikat

## Kartenmaterial

Das Kartenmaterial wird bei der Installation **automatisch** aufgebaut:
`install.sh` fragt Bundesland, Adresse eures Gerätehauses und einen Umkreis
in km ab, lädt daraufhin selbstständig die passenden OpenStreetMap-Daten
(Geofabrik), schneidet den gewünschten Umkreis zu und importiert ihn in den
Tileserver. Danach läuft alles offline weiter, ohne weitere Internetzugriffe.

Das übernimmt das Skript `setup-tiles.sh`. Wollt ihr später einen größeren
Umkreis oder einen anderen Standort, einfach im Container erneut ausführen:

```bash
cd /opt/feuerwehr-kataster
bash setup-tiles.sh baden-wuerttemberg "Musterstraße 1, 74821 Musterstadt" 30
docker compose --env-file .env up -d tileserver
```

Hinweis: Dieser Schritt braucht spürbar mehr Arbeitsspeicher und Zeit als der
Rest der Anwendung (deshalb ist der Container standardmäßig mit 6 GB RAM
angelegt). Bei sehr großen Umkreisen (>50km) kann der Import entsprechend
länger dauern.

## Installation

Auf dem Proxmox-Host ausführen (nicht in einem Container):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/HatchetMan111/feuerwehr-kataster/main/install.sh)"
```

Das Skript fragt Container-ID, Hostname, Wehr-Name, Storage und Netzwerk-Bridge
ab, erstellt den LXC-Container automatisch und startet die Anwendung. Am Ende
werden die Zugangsdaten für den ersten Admin-Login angezeigt – **bitte das
Passwort direkt nach dem ersten Login ändern.**

### TLS-Zertifikat

Für die Offline-Funktion (Service Worker) und "Zum Home-Bildschirm hinzufügen"
wird eine HTTPS-Verbindung benötigt. `install.sh` erzeugt dafür automatisch
ein **selbstsigniertes Zertifikat**, das direkt auf die IP-Adresse eures
Containers ausgestellt ist (siehe `generate-cert.sh`). Damit der Browser
keine Warnung mehr anzeigt, muss dieses Zertifikat einmalig auf den Geräten
der Gruppenführer als vertrauenswürdig hinterlegt werden:

1. Zertifikat aus dem Container holen: `pct exec <CTID> -- cat /opt/feuerwehr-kataster/caddy/certs/selfsigned.crt`
2. Auf jedem Gerät (Laptop, Tablet, Handy) importieren und als vertrauenswürdig einstufen

Ändert sich die IP-Adresse des Containers (z.B. nach einem Neustart ohne
feste IP-Reservierung im Router), muss das Zertifikat neu erzeugt werden:

```bash
cd /opt/feuerwehr-kataster
bash generate-cert.sh          # ermittelt die aktuelle IP automatisch
docker compose --env-file .env up -d --force-recreate caddy
```

Empfehlenswert ist trotzdem eine **feste IP-Reservierung** (DHCP-Reservation)
im Router für den Container, damit dieser Schritt möglichst selten nötig ist.

Alternativ: Falls ihr eine eigene Domain besitzt, könnt ihr in der `.env` eine
echte Domain eintragen und Caddy per DNS-Challenge ein "echtes" Let's-Encrypt-
Zertifikat ausstellen lassen (siehe Kommentare in `caddy/Caddyfile`).

### Manuelle Installation (ohne Skript)

Falls ihr den Container lieber selbst anlegt:

```bash
pct create 201 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname feuerwehr-kataster --cores 2 --memory 6144 --swap 1024 \
  --rootfs local-lvm:32 --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --features nesting=1,keyctl=1 --unprivileged 1 --onboot 1

pct start 201
pct exec 201 -- bash -c '
set -e
apt-get update -qq
apt-get install -y ca-certificates curl gnupg git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
ARCH=$(dpkg --print-architecture)
CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $CODENAME stable" > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
'
pct exec 201 -- git clone https://github.com/HatchetMan111/feuerwehr-kataster.git /opt/feuerwehr-kataster
```

Dann `.env.example` nach `.env` kopieren, Werte eintragen, und im Container:

```bash
cd /opt/feuerwehr-kataster
docker compose --env-file .env up -d --build
```

## Update

Im Container, im Projektordner:

```bash
bash update.sh
```

Das Skript holt die neueste Version und baut **alle** Container neu (auch
Caddy). Bewusst so, nicht nur einzelne Dienste: Caddy hält Verbindungen zu
den anderen Containern offen und hat früher teils noch mit einer bereits
ersetzten, alten Container-Instanz weitergeredet, wenn nur einzelne Dienste
neu gebaut wurden – Updates kamen dann nicht an, obwohl der neue Code längst
da war. Das ist inzwischen durch `keepalive off` im Caddyfile strukturell
behoben, `bash update.sh` bleibt trotzdem der empfohlene, unkomplizierteste Weg.

## Nutzerverwaltung

- Rolle **Admin**: kann Punkte endgültig löschen und neue Nutzer anlegen
- Rolle **Gruppenführer**: kann Punkte anlegen und bearbeiten, aber nicht
  löschen (schützt vor versehentlichem Datenverlust)

Neue Nutzer legt ein Admin direkt in der Verwaltungsoberfläche an (Sidebar
unten, "Neuen Nutzer anlegen").

## Kategorien

Vorbelegt sind: Löschteich, Zisterne, Hydrant, Offenes Gewässer, Güllegrube,
Gefahrenpunkt, Sammelplatz, Sonstiges. Weitere Kategorien können direkt per
SQL ergänzt werden, z.B.:

```sql
INSERT INTO categories (key, label, color, icon)
VALUES ('schwimmbad', 'Privates Schwimmbad', 'teal', 'droplet');
```

Erlaubte Farben für neue Kategorien: `teal` (Wasserquellen), `coral`
(Gefahren), `gray` (Sonstiges) – das steuert die Icon-Farbe auf der Karte.

## Offline-Funktion der Einsatz-PWA

- Die Karte, zuletzt geladene Punkte und die App selbst werden im Browser
  zwischengespeichert
- Ein neuer Punkt, der ohne Verbindung erfasst wird, landet in einer lokalen
  Warteschlange (IndexedDB) auf dem Gerät und wird automatisch übertragen,
  sobald wieder eine Verbindung ins Feuerwehr-Netz besteht
- "Zum Home-Bildschirm hinzufügen": bei Android/Chrome erscheint ein
  automatischer Hinweis; bei iPhone/Safari über "Teilen → Zum
  Home-Bildschirm"

## Datenschutz

Auch beim rein lokalen Betrieb bleibt eure Feuerwehr datenschutzrechtlich für
die gespeicherten personenbezogenen Daten (z.B. Ansprechpartner, Telefon-
nummern) verantwortlich. Da kein externer Anbieter beteiligt ist, entfällt
allerdings ein Auftragsverarbeitungsvertrag. Empfehlenswert: eine kurze
interne Notiz, wer für die Daten verantwortlich ist und wie lange sie
aufbewahrt werden.

## Speicherplatz-Überwachung

`check-disk.sh` prüft täglich um 6 Uhr automatisch (per Cron, von `install.sh`
eingerichtet) den belegten Speicherplatz des Containers. Ab 85 % Belegung
erscheint beim nächsten Login ein Warnbanner in beiden Oberflächen. Manuell
prüfen:

```bash
cd /opt/feuerwehr-kataster
bash check-disk.sh
cat status/disk.json
```

## Backup

Empfohlen: regelmäßige Proxmox-Backups des gesamten LXC-Containers über den
Proxmox Backup Server, plus einen zusätzlichen Datenbank-Dump an einen
zweiten Ort:

```bash
docker exec <postgis-container> pg_dump -U kataster kataster > backup-$(date +%F).sql
```

## Lizenz

MIT – siehe `LICENSE`. Jede Feuerwehr darf das Projekt frei nutzen, anpassen
und weitergeben.
