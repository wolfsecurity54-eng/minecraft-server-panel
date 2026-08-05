# 🚂 Railway Deployment Fix-Anleitung

## ❌ Problem-Diagnose

Das Deployment schlug fehl mit:
```
Builder: DOCKERFILE
Status: FAILED
Meta: { reason: "deploy", commitHash: "22c0fcf5ad8cc0d5505bc7d3180f106fb09c2b27" }
```

**Mögliche Ursachen:**
1. Token `d5d2974b-f725-40bf-9c6f-7a6930be0cf4` ist **Read-Only** (kann keine Mutationen ausführen)
2. Fehlende Volume-Mounts für Server-Persistenz
3. Java-21 Installation fehlte
4. Build-Logs nicht abrufbar mit Read-Only-Token

## ✅ Lösungs-Schritte

### Option 1: Manuelles Redeploy über Railway-Web (EMPFOHLEN)

1. Gehe zu https://railway.app/dashboard
2. Klicke auf das Projekt **"Server"**
3. Wähle den Service **"minecraft-server-panel"**
4. Klicke auf **"..."** (3 Punkte) → **"Redeploy"**

Beim erneuten Deployment wird Railway:
- ✅ Dockerfile finden (jetzt im Repo)
- ✅ Java 21 installieren (über Temurin-Image)
- ✅ Node.js 20 installieren
- ✅ Panel starten

### Option 2: Railway CLI verwenden (Personal Access Token nötig)

```bash
# 1. Token erstellen: https://railway.app/account/tokens
#    Format: railway_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 2. Railway CLI installieren
npm install -g @railway/cli

# 3. Login mit Personal Token
railway login --browserless
# Token eingeben: railway_xxxxx...

# 4. Zum Projekt navigieren
railway link

# 5. Volume hinzufügen
railway volume add --mount-path /app/server
railway volume add --mount-path /app/backups
railway volume add --mount-path /app/config

# 6. Environment-Variablen setzen
railway variables set JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
railway variables set PANEL_PORT=3000
railway variables set NODE_ENV=production

# 7. Re-Deploy triggern
railway up
```

### Option 3: Personal Access Token via API

```bash
# 1. Token aus: https://railway.app/account/tokens
# 2. API-Config:
export RAILWAY_TOKEN="railway_xxxxx..."
export PROJECT_ID="d5d2974b-f725-40bf-9c6f-7a6930be0cf4"
export SERVICE_ID="8c397aed-c660-42b7-a870-1b7243655b62"
export ENV_ID="d1753a1a-a34f-408c-b5c9-36628bec85ce"

# 3. Service-Config updaten
curl -X POST https://backboard.railway.app/graphql/v2 \
  -H "Authorization: Bearer $RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"mutation { serviceInstanceUpdate(environmentId: \\\"$ENV_ID\\\", serviceId: \\\"$SERVICE_ID\\\", input: { builder: DOCKERFILE, dockerfilePath: \\\"/Dockerfile\\\", startCommand: \\\"node server.js\\\", healthcheckPath: \\\"/api/health\\\", healthcheckTimeout: 60, restartPolicyType: ON_FAILURE, restartPolicyMaxRetries: 3 }) }\"}"

# 4. Env-Variablen setzen
for var in "JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64" "PANEL_PORT=3000" "NODE_ENV=production"; do
  NAME="${var%%=*}"
  VALUE="${var#*=}"
  curl -X POST https://backboard.railway.app/graphql/v2 \
    -H "Authorization: Bearer $RAILWAY_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"query\":\"mutation(\$input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: \$input) }\",\"variables\":{\"input\":{\"projectId\":\"$PROJECT_ID\",\"environmentId\":\"$ENV_ID\",\"variables\":{\"$NAME\":\"$VALUE\"}}}}"
done

# 5. Redeploy
curl -X POST https://backboard.railway.app/graphql/v2 \
  -H "Authorization: Bearer $RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"mutation { serviceInstanceRedeploy(serviceId: \\\"$SERVICE_ID\\\", environmentId: \\\"$ENV_ID\\\") }\"}"
```

## 🐳 Dockerfile-Konfiguration

Das Repo enthält bereits `Dockerfile` mit Java 21. Lassen Sie uns verifizieren:

```bash
# Inhalts-Verifikation
curl -s https://raw.githubusercontent.com/wolfsecurity54-eng/minecraft-server-panel/main/Dockerfile
```

## 🔧 Volume-Setup (KRITISCH für Minecraft-Server)

Ohne Volumes gehen beim **jedem Re-Deploy** alle Daten verloren!

**Im Railway-Dashboard:**
1. Klicke auf den Service
2. **"Variables"** Tab → **"+ New Volume"**
3. Füge 3 Volumes hinzu:

| Mount Path | Größe (min) |
|------------|-------------|
| `/app/server` | 2 GB |
| `/app/backups` | 1 GB |
| `/app/config` | 100 MB |

**Oder via CLI:**
```bash
railway volume add --mount-path /app/server --size 2GB
railway volume add --mount-path /app/backups --size 1GB
railway volume add --mount-path /app/config
```

## 🌐 Port-Konfiguration

Railway erkennt die Ports automatisch aus dem `railway.json`:
- `3000/TCP` - Web-Panel
- `25565/TCP` - Minecraft Java
- `19132/UDP` - Minecraft Bedrock (Geyser)

**Falls nicht automatisch erkannt:**
1. Service → **"Settings"** → **"Networking"** → **"Generate Domain"**
2. Custom Domain für Port 3000

## 🔑 Environment-Variablen (manuell setzen)

| Variable | Wert | Notwendig |
|----------|------|-----------|
| `JAVA_HOME` | `/usr/lib/jvm/java-21-openjdk-amd64` | ✅ Ja |
| `PANEL_PORT` | `3000` | Nein (default) |
| `NODE_ENV` | `production` | Nein (default) |
| `SESSION_SECRET` | `<random 32+ chars>` | Empfohlen |
| `RAILWAY_API_KEY` | `railway_xxxxx...` | Nur für Panel-Railway-Management |

## 🧪 Verifikation nach Deployment

Nach erfolgreichem Deployment:

1. **Health-Check:** https://<your-app>.up.railway.app/api/health
2. **Web-Panel:** https://<your-app>.up.railway.app
3. **Login:** admin / admin1234 (im Setup ändern!)
4. **Logs prüfen:** Service → Deployments → neueste → View Logs

## 🆘 Bei weiteren Problemen

### Logs einsehen
Railway-Dashboard → Service → **Deployments** → neueste → **View Logs**

### Support
- Discord: https://discord.gg/railway
- Docs: https://docs.railway.app
- Status: https://status.railway.app

### Komplett zurücksetzen
Falls alles fehlschlägt:
1. Service löschen
2. Neu erstellen
3. **GitHub-Repo auswählen**: `wolfsecurity54-eng/minecraft-server-panel`
4. Volumes hinzufügen
5. Deploy
