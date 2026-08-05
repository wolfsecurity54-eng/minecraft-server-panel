# Railway Deployment Anleitung

## 📋 Voraussetzungen

1. Railway-Account: https://railway.app
2. GitHub-Account (für Deployment aus Repository)
3. Railway API-Token (https://railway.app/account/tokens)

## 🚀 Deployment-Schritte

### 1. GitHub-Repository vorbereiten

```bash
# Repo erstellen
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/DEIN-USER/minecraft-panel.git
git push -u origin main
```

### 2. Railway-Projekt erstellen

1. Gehe zu https://railway.app/new
2. Wähle **"Deploy from GitHub repo"**
3. Wähle dein Repository
4. Railway erkennt `railway.json` und `nixpacks.toml` automatisch

### 3. Environment-Variablen setzen

Im Railway-Dashboard unter **Variables**:

| Variable | Wert | Beschreibung |
|----------|------|--------------|
| `RAILWAY_API_KEY` | `railway_xxxxx...` | Dein persönlicher API-Token |
| `RAILWAY_PROJECT_ID` | (automatisch) | Wird vom System gesetzt |
| `RAILWAY_SERVICE_ID` | (automatisch) | Wird vom System gesetzt |
| `PANEL_PORT` | `3000` | Web-Panel Port |

**Railway-interne Variablen** (automatisch von Railway gesetzt):
- `RAILWAY_PROJECT_ID` 
- `RAILWAY_SERVICE_ID`
- `RAILWAY_ENVIRONMENT_ID`
- `RAILWAY_PUBLIC_DOMAIN`
- `RAILWAY_STATIC_URL`

### 4. Volume hinzufügen (für Persistenz)

Unter **Settings → Volumes**:
- `/app/server` - Minecraft-Server-Files
- `/app/backups` - Backups
- `/app/config` - Panel-Config
- `/app/logs` - Logs

### 5. Ports freigeben

Unter **Settings → Networking → Public Networking**:
- Port 3000 (Web-Panel)
- Port 25565 (Minecraft Java)
- Port 19132 (Minecraft Bedrock/Geyser UDP)

## 🔑 Railway API-Key Setup

### API-Token erstellen

1. Gehe zu https://railway.app/account/tokens
2. Klicke **"Create Token"**
3. Kopiere den Token (Format: `railway_xxxxx...`)

### Token im Panel eintragen

**Methode 1: Über das Web-Panel**
1. Login als Owner
2. Gehe zu **System → Railway**
3. Trage den Token ein und klicke "Verbinden"

**Methode 2: Über Environment-Variable**
```
RAILWAY_API_KEY=railway_xxxxxxxxxxxxxxxxxx
```

### Projekt/Services finden

Nach erfolgreichem Deployment:
1. Gehe zum Railway-Dashboard
2. Wähle dein Projekt
3. URL-Struktur: `https://railway.app/project/{PROJECT_ID}/service/{SERVICE_ID}`

## 🛠️ Railway-Management via Panel

Nach Setup kannst du im Panel folgende Aktionen ausführen:

### Deployment triggern
- **System → Railway → Redeploy** Button

### Environment-Variablen verwalten
- **System → Railway → Variables** - Alle Variablen anzeigen
- Hinzufügen/Ändern/Löschen direkt im Panel

### Deployments überwachen
- **System → Railway → Deployments** - Letzte Deployments
- **System → Railway → Logs** - Build-Logs

### Metriken anzeigen
- **System → Railway → Metrics** - CPU, RAM, Disk, Network

### Domains verwalten
- **System → Railway → Domains** - Custom Domains hinzufügen

## 📊 API-Endpoints (Railway-Management)

```
GET  /api/railway/status           - Status & Konfiguration
GET  /api/railway/projects         - Alle Projekte auflisten
GET  /api/railway/project          - Aktuelles Projekt
GET  /api/railway/service          - Aktueller Service
GET  /api/railway/variables        - Environment-Variablen
POST /api/railway/variables        - Variable setzen
DEL  /api/railway/variables/:name  - Variable löschen
POST /api/railway/deploy           - Deployment triggern
GET  /api/railway/deployments      - Deployment-Historie
GET  /api/railway/domains          - Domains
POST /api/railway/domains          - Domain hinzufügen
GET  /api/railway/metrics          - Resource-Metriken
GET  /api/railway/logs             - Build-Logs
POST /api/railway/configure        - Konfiguration speichern
```

## 🔐 Sicherheit

### API-Key schützen
- Niemals direkt ins Repo committen
- Nur über Environment-Variablen oder Panel konfigurieren
- Token regelmäßig rotieren

### Permissions
Das Panel nutzt `system.info` Permission für Railway-Endpoints:
- **Owner**: Vollzugriff auf Railway
- **Admin**: Lesezugriff
- **Moderator/Viewer**: Kein Zugriff

## 🚨 Troubleshooting

### "RAILWAY_API_KEY nicht gesetzt"
- Token in Railway-Dashboard → Variables setzen
- Oder über Panel → System → Railway konfigurieren

### "Not Authorized" Fehler
- Token abgelaufen → neuen erstellen
- Token-Format prüfen: muss `railway_` Präfix haben
- Token-Berechtigungen prüfen

### Deployment schlägt fehl
- Build-Logs prüfen: **System → Railway → Logs**
- Java-Version in `nixpacks.toml` prüfen
- Node-Version in `package.json` prüfen
- Port-Konflikte in `railway.json` prüfen

### Minecraft-Server startet nicht
- RAM-Setting zu niedrig (Minimum 512M)
- Java-HEAP-Einstellungen in `server.js` prüfen
- Volume-Mount-Pfade prüfen

## 📈 Production-Checkliste

- [ ] Railway-Projekt erstellt
- [ ] GitHub-Repo verbunden
- [ ] Environment-Variablen gesetzt
- [ ] Persistent Volumes hinzufügt
- [ ] Ports öffentlich gemacht
- [ ] Custom Domain konfiguriert (optional)
- [ ] API-Token im Panel gespeichert
- [ ] Initial-Setup im Panel durchgeführt
- [ ] Anti-Cheat-Plugin (GrimAC) installiert
- [ ] Security-Settings konfiguriert
- [ ] Backup-Strategie aktiviert
- [ ] 2FA für Owner aktiviert (empfohlen)
- [ ] Brute-Force-Schutz aktiv (default aktiv)
- [ ] IP-Ban aktiviert (default aktiv)
- [ ] Auto-Backup aktiviert (default 24h)
- [ ] Monitoring via Railway-Metriken

## 💰 Kosten

Railway Free Tier: $5 USD Guthaben/Monat
- Kleine Minecraft-Server (1-5 Spieler): ~$3-5/Monat
- Größere Server (10+ Spieler): $10-20/Monat
- Persistent Volumes: je nach Größe

**Tipp**: Für 24/7-Betrieb ist der Hobby Plan ($5/Monat) ausreichend für kleine Server.
