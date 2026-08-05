# Minecraft Server Control Panel

Vollständiges Minecraft Java + Bedrock Server Control Panel mit moderner Web-Oberfläche.

**Stack:** Paper 1.21.4 · Geyser · Floodgate · LuckPerms · EssentialsX · Vault · CoreProtect · WorldEdit · WorldGuard · ViaVersion · Node.js · Express · WebSocket

---

## Features

### Server-Verwaltung
- **Paper 1.21.4** Java Edition Server
- **Geyser + Floodgate** für Bedrock-Spieler (UDP 19132)
- **LuckPerms** mit GUI für Ränge/Permissions
- **EssentialsX, Vault, CoreProtect, WorldEdit, WorldGuard, ViaVersion**
- Auto-Plugin-Download & Installation
- Vollständige `server.properties` Konfiguration

### Web-Panel
- 🌑 Modernes Dark-Mode Design
- 📊 Live-Dashboard mit WebSocket-Updates
- 🎮 Server Control: Start, Stop, Restart, Reload, Kill
- 💻 Live-Konsole mit Befehlseingabe
- 🛡️ 4-stufiges Rollensystem (Owner, Admin, Moderator, Viewer)
- 🔍 Volltextsuche, Filter, Activity-Feed
- 🌍 Responsive Desktop + Mobile

### Player-Info (NEU)
- 👤 **Player-Skin/Head/Body** via Mojang API & Crafatar
- ❤️ **Health, Hunger, XP-Level** via RCON
- 🎒 **Live-Inventar** (Hotbar)
- 💊 **Effekte** mit Übersetzung
- 🗺️ **Position & Welt** (Overworld/Nether/End)
- ⚔️ **Kills, Deaths, Mob-Deaths** aus Server-Logs
- 📜 **Name-Historie** via Mojang API
- 🎯 **Schnellaktionen**: Heal, Feed, Godmode, Speed, Kill, etc.
- 📊 **Scoreboard-basierte Stats**

### Sicherheit
- bcrypt-Passwort-Hashing
- CSRF-Token-Schutz
- Rate-Limiting (Auth & API)
- Audit-Log für alle Aktionen
- Server-seitige Permission-Prüfung
- Helmet-Security-Headers
- Keine ungeschützte Remote-Shell

---

## 🚀 Schnellstart (Lokal)

```bash
# Voraussetzungen: Java 21, Node.js 20+
git clone <repo>
cd minecraft-panel
npm install
node server.js
# → http://localhost:3000
```

Beim ersten Start öffnet sich der Setup-Wizard. Nach dem Login:

- **Benutzer:** `admin`
- **Passwort:** das im Setup gewählte

---

## ☁️ Railway Deployment

### 1-Klick-Deploy

1. Erstelle ein neues Railway-Projekt: https://railway.app/new
2. Wähle "Deploy from GitHub repo"
3. Wähle dieses Repository
4. Railway erkennt `railway.json` automatisch
5. Setze Environment-Variablen (optional):
   - `PANEL_PORT=3000`
   - `NODE_ENV=production`
6. Warte auf Build & Deploy
7. Railway generiert eine öffentliche URL

### Volumes für persistente Daten

In Railway:
1. Klicke auf den Service
2. "Variables" → "Add Volume"
3. Mount-Pfade:
   - `/app/server` — Minecraft-Server-Dateien
   - `/app/backups` — Backups
   - `/app/config` — Panel-Konfiguration
   - `/app/logs` — Logs

**Hinweis:** Railway Free Plan speichert Daten ohne Volume nicht persistent!

---

## 🐳 Docker

### Mit Docker Compose

```bash
docker compose up -d
```

### Standalone

```bash
docker build -t minecraft-panel .
docker run -d \
  --name minecraft-panel \
  -p 3000:3000 \
  -p 25565:25565 \
  -p 19132:19132/udp \
  -p 25575:25575 \
  -v $(pwd)/server:/app/server \
  -v $(pwd)/backups:/app/backups \
  -v $(pwd)/config:/app/config \
  -v $(pwd)/logs:/app/logs \
  minecraft-panel
```

### GitHub Container Registry

```bash
docker pull ghcr.io/<owner>/minecraft-panel:latest
```

---

## 📦 GitHub Actions CI/CD

Das Repo enthält:
- `.github/workflows/ci.yml` — Lint, Test, Docker-Build bei jedem Push
- `.github/workflows/release.yml` — Docker-Image-Release bei Tags
- `.github/dependabot.yml` — Automatische Dependency-Updates

### Neuen Release erstellen

```bash
git tag v1.0.0
git push origin v1.0.0
```

→ GitHub Actions baut und pusht das Docker-Image automatisch nach `ghcr.io`.

---

## 🛠️ Manuelle Installation (VPS / Root-Server)

### Voraussetzungen

```bash
# Debian/Ubuntu
sudo apt update
sudo apt install -y openjdk-21-jdk-headless nodejs-20 curl

# Java prüfen
java -version
```

### Setup mit systemd

```bash
# Repo klonen
git clone <repo> /opt/minecraft-panel
cd /opt/minecraft-panel
npm install --omit=dev

# Service-Datei erstellen
sudo tee /etc/systemd/system/minecraft-panel.service > /dev/null <<EOF
[Unit]
Description=Minecraft Server Control Panel
After=network.target

[Service]
Type=simple
User=minecraft
WorkingDirectory=/opt/minecraft-panel
Environment=JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# Service starten
sudo systemctl daemon-reload
sudo systemctl enable --now minecraft-panel
sudo systemctl status minecraft-panel
```

### Firewall

```bash
# Web-Panel
sudo ufw allow 3000/tcp

# Minecraft Java
sudo ufw allow 25565/tcp

# Minecraft Bedrock (Geyser)
sudo ufw allow 19132/udp

# RCON (nur lokal oder vertrauenswürdige Netze!)
sudo ufw allow from 127.0.0.1 to any port 25575
```

---

## 🔧 Konfiguration

### Panel-Config (`config/panel.json`)

Wird automatisch erstellt. Wichtige Felder:

```json
{
  "serverName": "Mein Server",
  "motd": "§bWillkommen!",
  "serverPort": 25565,
  "bedrockPort": 19132,
  "maxPlayers": 20,
  "ramMin": "2G",
  "ramMax": "4G",
  "rconEnabled": true,
  "rconPort": 25575,
  "rconPassword": "<auto-generiert>",
  "playerDataRefreshInterval": 5
}
```

### Environment-Variablen

| Variable       | Default | Beschreibung                  |
|----------------|---------|-------------------------------|
| `PANEL_PORT`   | 3000    | Web-Panel Port                |
| `NODE_ENV`     | —       | `production` für Production   |
| `JAVA_HOME`    | —       | Java-Installationspfad        |

---

## 🔐 Sicherheit

### Standard-Login ändern

Nach dem ersten Setup unbedingt das Standard-Passwort ändern!

### RCON absichern

RCON hat volle Server-Kontrolle. Empfehlungen:
- RCON nur auf `127.0.0.1` binden
- Starkes Passwort verwenden
- RCON-Port nicht öffentlich exposen

### TLS/SSL

Für öffentliches Deployment empfohlen. Optionen:
- Railway: Automatisches HTTPS
- Docker: Traefik / nginx reverse proxy mit Let's Encrypt
- Manual: nginx + certbot

---

## 📊 API-Endpunkte (Auswahl)

### Öffentlich
- `GET /api/health` — Health-Check
- `GET /api/setup/status` — Setup-Status
- `POST /api/auth/login` — Login
- `GET /api/auth/me` — Aktueller Benutzer

### Authentifiziert
- `GET /api/server/status` — Live-Server-Status
- `GET /api/players` — Online-Spieler
- `GET /api/players/:name/details` — **Spieler-Details** (Skin, Inventar, Health, etc.)
- `GET /api/players/:name/location` — **Position/Welt**
- `GET /api/players/:name/names` — **Name-Historie**
- `POST /api/players/:name/command` — **RCON-Aktion** (heal, feed, godmode, etc.)
- `POST /api/console/command` — Befehl senden
- `GET /api/rcon/status` — RCON-Status

---

## 🐛 Troubleshooting

### Server startet nicht (Out of Memory)

RAM zu niedrig konfiguriert. Im Panel: **Einstellungen → RAM** auf z.B. `512M / 1G` setzen.

### Plugins laden nicht

- Logs prüfen: `logs/server.log`
- Java-Version prüfen: `java -version` (Java 21 erforderlich für 1.21.4)
- Plugin-Kompatibilität prüfen (Paper 1.21.4 unterstützt nicht alle alten Plugins)

### RCON funktioniert nicht

- `enable-rcon=true` in `server/server.properties`?
- Firewall offen?
- RCON-Passwort korrekt?
- Panel: **Geyser → Connection Test → RCON Reconnect**

### Bedrock-Spieler können nicht joinen

- Geyser-Plugin geladen? (`[Geyser-Spigot]` in Logs)
- Floodgate-Key vorhanden? (`server/plugins/floodgate/key.pem`)
- UDP 19132 in Firewall offen?
- Online-Mode: Bei `true` benötigen Java-Spieler gültigen Account, Bedrock-Spieler können via Floodgate joinen

---

## 📄 Lizenz

MIT License
