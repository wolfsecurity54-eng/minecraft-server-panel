FROM eclipse-temurin:21-jdk-jammy

# Grundlegende Pakete
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl wget ca-certificates \
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

# Verzeichnisse erstellen
RUN mkdir -p server/plugins server/world backups logs config web/public

# Server-Ports (ALLE verfügbar machen)
EXPOSE 3000 25565 19132/udp 25575

# Server starten (kein HEALTHCHECK im Dockerfile, Railway macht das selbst)
CMD ["node", "server.js"]
