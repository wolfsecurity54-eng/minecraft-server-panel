FROM eclipse-temurin:21-jdk-jammy

# Grundlegende Pakete
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl wget ca-certificates tmux python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node.js 20 installieren
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Package-Dateien kopieren
COPY package*.json ./

# Dependencies installieren
RUN npm install --omit=dev && npm cache clean --force

# Quellcode kopieren
COPY . .

# Verzeichnisse erstellen (Railway Volumes werden in /app/server, /app/backups, /app/config gemountet)
RUN mkdir -p server/plugins server/world backups logs config web/public

# Server-Ports
EXPOSE 3000 25565 19132/udp 25575

# Health-Check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

# Server starten
CMD ["node", "server.js"]
