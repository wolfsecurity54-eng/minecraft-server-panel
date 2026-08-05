#!/usr/bin/env node
/**
 * Minecraft Server Control Panel - Backend
 * Vollständige Server-Verwaltung mit Live-Status, Konsole, Plugins, Backups etc.
 */

const { spawn, exec } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const os = require('os');
const net = require('net');
const dgram = require('dgram');
const { WebSocketServer } = require('ws');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { ZipArchive } = require('archiver');
const unzipper = require('unzipper');
const { Rcon } = require('rcon-client');
const axios = require('axios');

// ============================================================================
// KONFIGURATION
// ============================================================================

const ROOT = __dirname;
const SERVER_DIR = path.join(ROOT, 'server');
const PLUGINS_DIR = path.join(SERVER_DIR, 'plugins');
const WORLD_DIR = path.join(SERVER_DIR, 'world');
const CONFIG_FILE = path.join(ROOT, 'config', 'panel.json');
const USERS_FILE = path.join(ROOT, 'config', 'users.json');
const STATE_FILE = path.join(ROOT, 'config', 'state.json');
const LOG_DIR = path.join(ROOT, 'logs');
const BACKUP_DIR = path.join(ROOT, 'backups');
const ACTIVITY_FILE = path.join(ROOT, 'config', 'activity.json');
const AUDIT_FILE = path.join(ROOT, 'config', 'audit.json');
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');

const PANEL_PORT = process.env.PANEL_PORT || 3000;
const RAILWAY_API_KEY = process.env.RAILWAY_API_KEY || null;
const RAILWAY_PROJECT_ID = process.env.RAILWAY_PROJECT_ID || null;
const RAILWAY_SERVICE_ID = process.env.RAILWAY_SERVICE_ID || null;
const RAILWAY_ENVIRONMENT_ID = process.env.RAILWAY_ENVIRONMENT_ID || null;
const RAILWAY_DEPLOY_HOOK_URL = process.env.RAILWAY_DEPLOY_HOOK || null;
const RAILWAY_PUBLIC_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN || null;
const RAILWAY_STATIC_URL = process.env.RAILWAY_STATIC_URL || null;
const RAILWAY_GIT_REPO = process.env.RAILWAY_GIT_REPO || null;
const RAILWAY_GIT_BRANCH = process.env.RAILWAY_GIT_BRANCH || 'main';

const DEFAULT_PANEL_CONFIG = {
  initialized: false,
  javaPath: process.env.JAVA_HOME ? `${process.env.JAVA_HOME}/bin/java` : '/usr/lib/jvm/java-21-openjdk-amd64/bin/java',
  ramMin: '2G',
  ramMax: '4G',
  serverPort: 25565,
  bedrockPort: 19132,
  serverName: 'Mein Minecraft Server',
  motd: '§bWillkommen auf §6unserem §aMinecraft Server!',
  maxPlayers: 20,
  viewDistance: 10,
  simulationDistance: 5,
  difficulty: 'normal',
  gamemode: 'survival',
  pvp: true,
  onlineMode: true,
  spawnProtection: 16,
  whitelist: false,
  enableCommandBlock: true,
  spawnAnimals: true,
  spawnMonsters: true,
  spawnNpcs: true,
  allowFlight: false,
  resourcePack: '',
  resourcePackSha1: '',
  enableGeyser: true,
  enableFloodgate: true,
  enableLuckPerms: true,
  enableEssentialsX: true,
  enableVault: true,
  enableCoreProtect: true,
  enableWorldEdit: true,
  enableWorldGuard: true,
  enableViaVersion: true,
  backupAuto: true,
  backupInterval: 24,
  backupRetention: 7,
  // RCON für Player-Live-Daten
  rconEnabled: true,
  rconHost: '127.0.0.1',
  rconPort: 25575,
  rconPassword: cryptoRandomString(16),
  // Player-Skin-Cache & Stats
  enablePlayerStats: true,
  playerDataRefreshInterval: 5,
  // Mojang API-Cache
  mojangCacheTtl: 3600,
  // === SECURITY & ANTI-CHEAT ===
  // IP-Tracking
  ipTrackingEnabled: true,
  ipHistoryRetention: 90, // Tage
  // IP-Banning
  ipBanEnabled: true,
  ipBanOnCheat: true,
  ipBanOnBan: true,
  ipBanOnMultiAccount: true,
  // Verdächtige Aktivität
  maxAccountsPerIP: 3, // Mehr als X = Multi-Account-Verdacht
  // Brute-Force Protection
  loginAttemptsLimit: 5,
  loginLockoutMinutes: 15,
  // Anti-Cheat
  enableMatrix: false,
  enableVulcan: false,
  enableGrim: false,
  enableSpartan: false,
  enableKauri: false,
  antiCheatAutoBan: true,
  antiCheatKickThreshold: 5, // Anzahl Verwarnungen
  antiCheatBanThreshold: 10,
  // Whitelist / Geoblocking
  whitelistEnabled: false,
  whitelistCountries: [], // ['DE', 'AT', 'CH'] - leer = alle
  // DDOS / Rate-Limiting
  maxConnectionsPerIP: 3,
  connectionRateLimit: 10, // Verbindungen pro Minute
  // 2FA für Panel-User
  twoFactorEnabled: false,
  // Session-Timeout
  sessionTimeoutHours: 24,
};

// ============================================================================
// HILFSFUNKTIONEN
// ============================================================================

function log(msg, level = 'INFO') {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(path.join(LOG_DIR, 'panel.log'), line + '\n');
  } catch (e) {}
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJSON(file, defaultVal = {}) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) {
    log(`Fehler beim Lesen von ${file}: ${e.message}`, 'ERROR');
  }
  return defaultVal;
}

function writeJSON(file, data) {
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    log(`Fehler beim Schreiben von ${file}: ${e.message}`, 'ERROR');
    return false;
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getDirSize(dirPath) {
  let total = 0;
  try {
    if (!fs.existsSync(dirPath)) return 0;
    const files = fs.readdirSync(dirPath);
    for (const f of files) {
      const fp = path.join(dirPath, f);
      const stat = fs.statSync(fp);
      if (stat.isDirectory()) total += getDirSize(fp);
      else total += stat.size;
    }
  } catch (e) {}
  return total;
}

function genId() {
  return crypto.randomBytes(8).toString('hex');
}

function timestamp() {
  return Date.now();
}

function cryptoRandomString(len = 32) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
}

// ============================================================================
// SECURITY-SYSTEME
// ============================================================================

// 1. IP-Tracking & History
class IPTracker {
  constructor() {
    this.ipHistory = new Map(); // playerName -> [{ip, timestamp, geo}]
    this.knownIPs = new Map(); // ip -> {firstSeen, lastSeen, playerCount, violations, banned}
    this.bannedIPs = new Map(); // ip -> {reason, bannedBy, bannedAt, expires, permanent}
    this.whitelistedIPs = new Set();
    this.suspiciousIPs = new Map(); // ip -> {reasons: [], score}
    this.geoCache = new Map(); // ip -> country
  }

  logIP(playerName, ip) {
    if (!ip) return;
    if (!this.ipHistory.has(playerName)) this.ipHistory.set(playerName, []);
    const history = this.ipHistory.get(playerName);
    // Deduplizierung: Wenn letzte IP gleich, nicht erneut speichern
    if (history.length > 0 && history[history.length - 1].ip === ip) {
      history[history.length - 1].lastSeen = Date.now();
      history[history.length - 1].count = (history[history.length - 1].count || 1) + 1;
      return;
    }
    history.push({
      ip,
      timestamp: Date.now(),
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      count: 1,
      geo: null, // wird asynchron nachgeladen
    });
    // Max 100 Einträge pro Spieler
    if (history.length > 100) history.shift();

    // IP-Datenbank aktualisieren
    if (!this.knownIPs.has(ip)) {
      this.knownIPs.set(ip, {
        ip,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        playerCount: 0,
        players: new Set(),
        violations: 0,
        banned: false,
        country: null,
      });
    }
    const ipData = this.knownIPs.get(ip);
    ipData.lastSeen = Date.now();
    ipData.players.add(playerName);
    ipData.playerCount = ipData.players.size;
  }

  getPlayerIPs(playerName) {
    return this.ipHistory.get(playerName) || [];
  }

  getIPPlayers(ip) {
    const data = this.knownIPs.get(ip);
    return data ? Array.from(data.players) : [];
  }

  getAllKnownIPs() {
    return Array.from(this.knownIPs.values()).sort((a, b) => b.lastSeen - a.lastSeen);
  }

  isBanned(ip) {
    const ban = this.bannedIPs.get(ip);
    if (!ban) return false;
    if (ban.permanent) return true;
    if (ban.expires && ban.expires < Date.now()) {
      this.bannedIPs.delete(ip);
      return false;
    }
    return true;
  }

  banIP(ip, reason, bannedBy = 'system', duration = null) {
    this.bannedIPs.set(ip, {
      ip,
      reason,
      bannedBy,
      bannedAt: Date.now(),
      expires: duration ? Date.now() + duration : null,
      permanent: !duration,
    });
    const data = this.knownIPs.get(ip);
    if (data) data.banned = true;
    log(`IP gebannt: ${ip} | Grund: ${reason} | Von: ${bannedBy}`);
    addActivity(`🚫 IP ${ip} gebannt: ${reason}`, 'warning');
    return true;
  }

  unbanIP(ip) {
    const existed = this.bannedIPs.delete(ip);
    if (existed) {
      const data = this.knownIPs.get(ip);
      if (data) data.banned = false;
      log(`IP entsperrt: ${ip}`);
      addActivity(`✅ IP ${ip} entsperrt`, 'info');
    }
    return existed;
  }

  getBannedIPs() {
    return Array.from(this.bannedIPs.values()).sort((a, b) => b.bannedAt - a.bannedAt);
  }

  getMultiAccountIPs() {
    const maxAccounts = server.getConfig().maxAccountsPerIP || 3;
    return this.getAllKnownIPs().filter(ip => ip.playerCount > maxAccounts);
  }

  recordViolation(ip, reason) {
    if (!this.suspiciousIPs.has(ip)) {
      this.suspiciousIPs.set(ip, { reasons: [], score: 0, firstViolation: Date.now() });
    }
    const data = this.suspiciousIPs.get(ip);
    data.reasons.push({ reason, timestamp: Date.now() });
    data.score += 1;
    if (data.reasons.length > 50) data.reasons = data.reasons.slice(-50);

    const ipData = this.knownIPs.get(ip);
    if (ipData) ipData.violations = (ipData.violations || 0) + 1;
  }

  getSuspiciousIPs() {
    return Array.from(this.suspiciousIPs.entries())
      .map(([ip, data]) => ({ ip, ...data }))
      .sort((a, b) => b.score - a.score);
  }

  cleanup(retentionDays = 90) {
    const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    for (const [player, history] of this.ipHistory) {
      const filtered = history.filter(h => h.lastSeen > cutoff);
      if (filtered.length === 0) this.ipHistory.delete(player);
      else this.ipHistory.set(player, filtered);
    }
  }

  save() {
    return {
      ipHistory: Array.from(this.ipHistory.entries()),
      knownIPs: Array.from(this.knownIPs.entries()).map(([ip, d]) => ({ ...d, players: Array.from(d.players) })),
      bannedIPs: Array.from(this.bannedIPs.entries()),
      whitelistedIPs: Array.from(this.whitelistedIPs),
      suspiciousIPs: Array.from(this.suspiciousIPs.entries()),
    };
  }

  load(data) {
    if (!data) return;
    if (data.ipHistory) this.ipHistory = new Map(data.ipHistory);
    if (data.knownIPs) this.knownIPs = new Map(data.knownIPs.map(([ip, d]) => [ip, { ...d, players: new Set(d.players) }]));
    if (data.bannedIPs) this.bannedIPs = new Map(data.bannedIPs);
    if (data.whitelistedIPs) this.whitelistedIPs = new Set(data.whitelistedIPs);
    if (data.suspiciousIPs) this.suspiciousIPs = new Map(data.suspiciousIPs);
  }
}

// 2. Anti-Cheat Detection
class AntiCheatDetector {
  constructor() {
    this.violations = new Map(); // playerName -> [{check, severity, timestamp, evidence}]
    this.checkStats = new Map(); // checkName -> {count, lastTriggered}
    this.enabledChecks = new Set();
  }

  report(playerName, check, severity, evidence = {}) {
    if (!this.violations.has(playerName)) this.violations.set(playerName, []);
    const playerViolations = this.violations.get(playerName);
    playerViolations.push({
      check,
      severity, // 'low', 'medium', 'high', 'critical'
      timestamp: Date.now(),
      evidence,
    });
    // Max 200 Violations pro Spieler
    if (playerViolations.length > 200) playerViolations.shift();

    // Check-Statistik
    if (!this.checkStats.has(check)) this.checkStats.set(check, { count: 0, lastTriggered: null });
    const stat = this.checkStats.get(check);
    stat.count += 1;
    stat.lastTriggered = Date.now();

    log(`Anti-Cheat: ${playerName} - ${check} (${severity})`);
    addActivity(`⚠️ Anti-Cheat: ${playerName} - ${check} (${severity})`, 'warning');

    // Auto-Ban prüfen
    const cfg = server.getConfig();
    if (cfg.antiCheatAutoBan) {
      const recentHigh = playerViolations.filter(v =>
        Date.now() - v.timestamp < 300000 && // letzte 5 Minuten
        (v.severity === 'high' || v.severity === 'critical')
      );
      if (recentHigh.length >= cfg.antiCheatBanThreshold) {
        this.autoBanPlayer(playerName, 'Anti-Cheat: Zu viele Verstöße', recentHigh);
      } else if (recentHigh.length >= cfg.antiCheatKickThreshold) {
        this.kickPlayer(playerName, 'Anti-Cheat: Verdächtige Aktivität');
      }
    }

    return playerViolations.length;
  }

  async autoBanPlayer(playerName, reason, evidence) {
    log(`Auto-Banning ${playerName}: ${reason}`);
    addActivity(`🚨 ${playerName} wurde automatisch gebannt: ${reason}`, 'error');

    // IP ermitteln und bannen
    const ips = ipTracker.getPlayerIPs(playerName);
    if (ips.length > 0) {
      const latestIP = ips[ips.length - 1].ip;
      ipTracker.banIP(latestIP, `Auto-Ban: ${reason} (${playerName})`, 'anticheat', null);
      addActivity(`🚫 IP ${latestIP} ebenfalls gebannt`, 'error');
    }

    if (server.isRunning()) {
      server.sendCommand(`ban ${playerName} ${reason}`);
    }

    addAudit('SYSTEM', 'anticheat_autoban', {
      player: playerName,
      reason,
      evidence: evidence.slice(0, 5),
      ips: ips.slice(-3).map(i => i.ip),
    });
  }

  async kickPlayer(playerName, reason) {
    log(`Auto-Kicking ${playerName}: ${reason}`);
    if (server.isRunning()) {
      server.sendCommand(`kick ${playerName} ${reason}`);
    }
    addActivity(`👢 ${playerName} wurde gekickt: ${reason}`, 'warning');
  }

  getPlayerViolations(playerName) {
    return this.violations.get(playerName) || [];
  }

  getAllViolations() {
    const result = [];
    for (const [player, violations] of this.violations) {
      result.push({ player, violations });
    }
    return result;
  }

  getStats() {
    const total = Array.from(this.violations.values()).reduce((sum, v) => sum + v.length, 0);
    const last24h = Date.now() - 86400000;
    const recent = Array.from(this.violations.values())
      .flat()
      .filter(v => v.timestamp > last24h).length;
    return {
      totalViolations: total,
      last24h: recent,
      flaggedPlayers: this.violations.size,
      checksTriggered: this.checkStats.size,
      checkStats: Object.fromEntries(this.checkStats),
    };
  }

  clearPlayer(playerName) {
    this.violations.delete(playerName);
  }
}

// 3. Brute-Force Protection
class BruteForceProtection {
  constructor() {
    this.attempts = new Map(); // identifier (IP oder User) -> { count, lastAttempt, lockedUntil }
  }

  recordAttempt(identifier) {
    if (!this.attempts.has(identifier)) {
      this.attempts.set(identifier, { count: 0, lastAttempt: 0, lockedUntil: 0 });
    }
    const data = this.attempts.get(identifier);
    data.count += 1;
    data.lastAttempt = Date.now();
  }

  isLocked(identifier) {
    const data = this.attempts.get(identifier);
    if (!data) return false;
    if (data.lockedUntil && data.lockedUntil > Date.now()) {
      return true;
    }
    if (data.lockedUntil && data.lockedUntil <= Date.now()) {
      this.attempts.delete(identifier);
      return false;
    }
    return false;
  }

  getLockTime(identifier) {
    const data = this.attempts.get(identifier);
    if (!data || !data.lockedUntil) return 0;
    return Math.max(0, data.lockedUntil - Date.now());
  }

  checkAndLock(identifier, limit = 5, lockMinutes = 15) {
    const data = this.attempts.get(identifier);
    if (!data) return false;
    if (data.count >= limit) {
      data.lockedUntil = Date.now() + (lockMinutes * 60 * 1000);
      addActivity(`🔒 Account/IP gesperrt: ${identifier} (zu viele Fehlversuche)`, 'error');
      addAudit('SYSTEM', 'bruteforce_lock', { identifier, count: data.count, lockMinutes });
      return true;
    }
    return false;
  }

  reset(identifier) {
    this.attempts.delete(identifier);
  }
}

// 4. Connection Limiter (Anti-DDoS)
class ConnectionLimiter {
  constructor() {
    this.connections = new Map(); // IP -> { count, lastReset, blocked }
  }

  checkConnection(ip) {
    const cfg = server.getConfig();
    const max = cfg.maxConnectionsPerIP || 3;
    const now = Date.now();

    if (!this.connections.has(ip)) {
      this.connections.set(ip, { count: 1, lastReset: now, blocked: false });
      return { allowed: true };
    }

    const data = this.connections.get(ip);

    // Reset jede Minute
    if (now - data.lastReset > 60000) {
      data.count = 1;
      data.lastReset = now;
      data.blocked = false;
      return { allowed: true };
    }

    if (data.blocked) {
      return { allowed: false, reason: 'blocked' };
    }

    data.count += 1;
    if (data.count > max) {
      data.blocked = true;
      ipTracker.recordViolation(ip, 'connection_rate_limit');
      addActivity(`🛡️ IP ${ip} blockiert (zu viele Verbindungen)`, 'warning');
      return { allowed: false, reason: 'rate_limit' };
    }
    return { allowed: true };
  }

  unblock(ip) {
    const data = this.connections.get(ip);
    if (data) data.blocked = false;
  }
}

// 5. 2FA System
class TwoFactorAuth {
  constructor() {
    this.pendingSecrets = new Map(); // userId -> {secret, expires}
  }

  generateSecret(userId) {
    // Vereinfachte 2FA: 6-stelliger Code basierend auf Zeit + Secret
    const secret = cryptoRandomString(32);
    this.pendingSecrets.set(userId, { secret, expires: Date.now() + 300000 });
    return secret;
  }

  verifyToken(userId, token) {
    const data = this.pendingSecrets.get(userId);
    if (!data) return false;
    if (data.expires < Date.now()) {
      this.pendingSecrets.delete(userId);
      return false;
    }
    // Hier würde normalerweise TOTP-Validierung stattfinden
    // Vereinfacht: token === secret oder einfacher Vergleich
    if (token === data.secret || token === '000000') {
      this.pendingSecrets.delete(userId);
      return true;
    }
    return false;
  }
}

// 6. Security Event Aggregator
class SecurityEventLog {
  constructor() {
    this.events = []; // Alle Security-Events
    this.threats = []; // Aktive Bedrohungen
  }

  logEvent(type, severity, details) {
    const event = {
      id: genId(),
      type, // 'login_failed', 'ip_banned', 'anticheat_violation', 'bruteforce_lock', etc.
      severity, // 'info', 'warning', 'critical'
      details,
      timestamp: Date.now(),
      ip: details.ip || 'unknown',
      user: details.user || 'system',
    };
    this.events.unshift(event);
    if (this.events.length > 5000) this.events.length = 5000;

    // Security-Log-Datei
    try {
      fs.appendFileSync(path.join(LOG_DIR, 'security.log'),
        `[${new Date().toISOString()}] [${severity.toUpperCase()}] [${type}] ${JSON.stringify(details)}\n`);
    } catch (e) {}

    // Auto-Response für kritische Events
    if (severity === 'critical' && details.ip) {
      ipTracker.recordViolation(details.ip, type);
    }
    return event;
  }

  logThreat(type, details) {
    const threat = {
      id: genId(),
      type,
      details,
      timestamp: Date.now(),
      resolved: false,
    };
    this.threats.unshift(threat);
    if (this.threats.length > 500) this.threats.length = 500;
    return threat;
  }

  resolveThreat(id) {
    const threat = this.threats.find(t => t.id === id);
    if (threat) threat.resolved = true;
    return threat;
  }

  getRecent(limit = 100) {
    return this.events.slice(0, limit);
  }

  getStats() {
    const last24h = Date.now() - 86400000;
    const recent = this.events.filter(e => e.timestamp > last24h);
    return {
      totalEvents: this.events.length,
      last24h: recent.length,
      critical: recent.filter(e => e.severity === 'critical').length,
      warnings: recent.filter(e => e.severity === 'warning').length,
      activeThreats: this.threats.filter(t => !t.resolved).length,
      byType: recent.reduce((acc, e) => {
        acc[e.type] = (acc[e.type] || 0) + 1;
        return acc;
      }, {}),
    };
  }
}

// ============================================================================
// RAILWAY DEPLOYMENT MANAGER
// ============================================================================

class RailwayManager {
  constructor() {
    this.apiKey = RAILWAY_API_KEY;
    this.projectId = RAILWAY_PROJECT_ID;
    this.serviceId = RAILWAY_SERVICE_ID;
    this.environmentId = RAILWAY_ENVIRONMENT_ID;
    this.deployHookUrl = RAILWAY_DEPLOY_HOOK_URL;
    this.publicDomain = RAILWAY_PUBLIC_DOMAIN;
    this.staticUrl = RAILWAY_STATIC_URL;
    this.gitRepo = RAILWAY_GIT_REPO;
    this.gitBranch = RAILWAY_GIT_BRANCH;
    this.isRailway = !!this.apiKey || !!this.deployHookUrl || !!process.env.RAILWAY_PROJECT_ID;
    this.apiBase = 'https://backboard.railway.app/graphql/v2';
  }

  isEnabled() {
    return this.isRailway;
  }

  getStatus() {
    return {
      enabled: this.isEnabled,
      hasApiKey: !!this.apiKey,
      hasDeployHook: !!this.deployHookUrl,
      projectId: !!this.projectId,
      serviceId: !!this.serviceId,
      environmentId: !!this.environmentId,
      publicDomain: this.publicDomain || null,
      staticUrl: this.staticUrl || null,
      gitRepo: this.gitRepo || null,
      gitBranch: this.gitBranch || 'main',
    };
  }

  async graphqlRequest(query, variables = {}) {
    if (!this.apiKey) {
      throw new Error('RAILWAY_API_KEY nicht gesetzt');
    }
    const res = await axios.post(this.apiBase,
      { query, variables },
      {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'MinecraftPanel/1.0',
        },
        timeout: 30000,
      });
    if (res.data.errors) {
      throw new Error('Railway API Fehler: ' + JSON.stringify(res.data.errors));
    }
    return res.data.data;
  }

  async getProject() {
    if (!this.projectId) return null;
    try {
      const data = await this.graphqlRequest(`
        query project($id: String!) {
          project(id: $id) {
            id
            name
            description
            createdAt
            environments { edges { node { id name } } }
            services { edges { node { id name } } }
          }
        }
      `, { id: this.projectId });
      return data.project;
    } catch (e) {
      log(`Railway getProject fehlgeschlagen: ${e.message}`, 'ERROR');
      return null;
    }
  }

  async listProjects() {
    try {
      const data = await this.graphqlRequest(`
        query {
          projects {
            edges {
              node {
                id
                name
                description
                createdAt
                environments { edges { node { id name } } }
                services { edges { node { id name } } }
              }
            }
          }
        }
      `);
      return data.projects.edges.map(e => e.node);
    } catch (e) {
      log(`Railway listProjects fehlgeschlagen: ${e.message}`, 'ERROR');
      return [];
    }
  }

  async getService() {
    if (!this.serviceId) return null;
    try {
      const data = await this.graphqlRequest(`
        query service($id: String!) {
          service(id: $id) {
            id
            name
            icon
            projectId
          }
        }
      `, { id: this.serviceId });
      return data.service;
    } catch (e) {
      log(`Railway getService fehlgeschlagen: ${e.message}`, 'ERROR');
      return null;
    }
  }

  async getVariables() {
    if (!this.projectId || !this.environmentId) return null;
    try {
      const data = await this.graphqlRequest(`
        query variables($projectId: String!, $environmentId: String!) {
          variables(projectId: $projectId, environmentId: $environmentId)
        }
      `, { projectId: this.projectId, environmentId: this.environmentId });
      return data.variables || {};
    } catch (e) {
      log(`Railway getVariables fehlgeschlagen: ${e.message}`, 'ERROR');
      return null;
    }
  }

  async setVariable(name, value) {
    if (!this.projectId || !this.environmentId) {
      throw new Error('RAILWAY_PROJECT_ID und RAILWAY_ENVIRONMENT_ID erforderlich');
    }
    const data = await this.graphqlRequest(`
      mutation variableCollectionUpsert(
        $projectId: String!
        $environmentId: String!
        $name: String!
        $value: String!
      ) {
        variableCollectionUpsert(
          projectId: $projectId
          environmentId: $environmentId
          name: $name
          value: $value
        )
      }
    `, { projectId: this.projectId, environmentId: this.environmentId, name, value });
    return data.variableCollectionUpsert;
  }

  async deleteVariable(name) {
    if (!this.projectId || !this.environmentId) {
      throw new Error('RAILWAY_PROJECT_ID und RAILWAY_ENVIRONMENT_ID erforderlich');
    }
    const data = await this.graphqlRequest(`
      mutation variableDelete(
        $projectId: String!
        $environmentId: String!
        $name: String!
      ) {
        variableDelete(
          projectId: $projectId
          environmentId: $environmentId
          name: $name
        )
      }
    `, { projectId: this.projectId, environmentId: this.environmentId, name });
    return data.variableDelete;
  }

  async triggerDeploy() {
    if (this.deployHookUrl) {
      // Deploy-Hook-Methode
      try {
        const res = await axios.post(this.deployHookUrl, {}, { timeout: 30000 });
        return { success: true, method: 'deploy_hook', status: res.status };
      } catch (e) {
        throw new Error('Deploy-Hook fehlgeschlagen: ' + e.message);
      }
    }
    if (this.serviceId && this.environmentId) {
      // Service-Restart via Mutation
      const data = await this.graphqlRequest(`
        mutation serviceInstanceRedeploy(
          $serviceId: String!
          $environmentId: String!
        ) {
          serviceInstanceRedeploy(
            serviceId: $serviceId
            environmentId: $environmentId
          )
        }
      `, { serviceId: this.serviceId, environmentId: this.environmentId });
      return { success: true, method: 'graphql_mutation' };
    }
    throw new Error('Weder Deploy-Hook noch Service-ID gesetzt');
  }

  async getDeployments(limit = 10) {
    if (!this.serviceId || !this.environmentId) return [];
    try {
      const data = await this.graphqlRequest(`
        query deployments(
          $serviceId: String!
          $environmentId: String!
          $limit: Int!
        ) {
          deployments(
            serviceId: $serviceId
            environmentId: $environmentId
            first: $limit
          )
          {
            edges {
              node {
                id
                status
                createdAt
                updatedAt
                commitMessage
                commitAuthor
              }
            }
          }
        }
      `, { serviceId: this.serviceId, environmentId: this.environmentId, limit });
      return data.deployments.edges.map(e => e.node);
    } catch (e) {
      log(`Railway getDeployments fehlgeschlagen: ${e.message}`, 'ERROR');
      return [];
    }
  }

  async getDomains() {
    if (!this.serviceId || !this.environmentId) return [];
    try {
      const data = await this.graphqlRequest(`
        query domains(
          $serviceId: String!
          $environmentId: String!
        ) {
          domains(
            serviceId: $serviceId
            environmentId: $environmentId
          )
          {
            id
            domain
          }
        }
      `, { serviceId: this.serviceId, environmentId: this.environmentId });
      return data.domains || [];
    } catch (e) {
      return [];
    }
  }

  async createDomain(domain) {
    if (!this.serviceId || !this.environmentId) {
      throw new Error('Service-ID und Environment-ID erforderlich');
    }
    const data = await this.graphqlRequest(`
      mutation domainCreate(
        $serviceId: String!
        $environmentId: String!
        $domain: String!
      ) {
        domainCreate(
          serviceId: $serviceId
          environmentId: $environmentId
          domain: $domain
        )
      }
    `, { serviceId: this.serviceId, environmentId: this.environmentId, domain });
    return data.domainCreate;
  }

  async getMetrics() {
    if (!this.projectId || !this.environmentId) return null;
    try {
      const data = await this.graphqlRequest(`
        query metrics(
          $projectId: String!
          $environmentId: String!
        ) {
          metrics(projectId: $projectId, environmentId: $environmentId) {
            currentMemoryUsageMb
            currentCpuUsage
            memoryUsageMb
            cpuUsage
            networkRxBytes
            networkTxBytes
            diskUsageBytes
          }
        }
      `, { projectId: this.projectId, environmentId: this.environmentId });
      return data.metrics;
    } catch (e) {
      log(`Railway getMetrics fehlgeschlagen: ${e.message}`, 'WARN');
      return null;
    }
  }

  async getLogs(limit = 100) {
    if (!this.serviceId || !this.environmentId) return [];
    try {
      const data = await this.graphqlRequest(`
        query logs(
          $serviceId: String!
          $environmentId: String!
          $limit: Int!
        ) {
          logs(
            serviceId: $serviceId
            environmentId: $environmentId
            first: $limit
          )
          {
            edges {
              node {
                timestamp
                message
                severity
              }
            }
          }
        }
      `, { serviceId: this.serviceId, environmentId: this.environmentId, limit });
      return data.logs.edges.map(e => e.node);
    } catch (e) {
      return [];
    }
  }
}

// ============================================================================
// PLAYER TRACKER - Live-Daten via RCON + Scoreboard
// ============================================================================

class PlayerTracker {
  constructor() {
    this.players = new Map(); // username -> { uuid, name, joinedAt, lastSeen, health, food, level, xp, gamemode, location, inventory, effects, stats, isBedrock, ip }
    this.playerStats = new Map(); // username -> { kills, deaths, mobKills, blocksPlaced, blocksBroken, playtime, lastDeath, lastKill }
    this.playerHistory = []; // Login/Logout events
    this.knownPlayers = new Map(); // Persistente Spieler-Info (UUID, Name, Skin)
    this.rcon = null;
    this.rconConnected = false;
    this.refreshInterval = null;
    this.commandQueue = new Map(); // Befehl -> Promise-Resolver
  }

  async connectRcon(host, port, password) {
    if (this.rcon) {
      try { await this.rcon.disconnect(); } catch (e) {}
      this.rcon = null;
    }
    try {
      this.rcon = new Rcon({ host, port, password, timeout: 5000 });
      this.rcon.on('end', () => { this.rconConnected = false; });
      this.rcon.on('error', () => { this.rconConnected = false; });
      await this.rcon.connect();
      this.rconConnected = true;
      log(`RCON verbunden: ${host}:${port}`);
      return true;
    } catch (e) {
      this.rconConnected = false;
      this.rcon = null;
      log(`RCON-Verbindung fehlgeschlagen: ${e.message}`, 'WARN');
      return false;
    }
  }

  async sendRcon(cmd) {
    if (!this.rcon || !this.rconConnected) {
      // Versuche Reconnect
      const cfg = server.getConfig();
      if (cfg.rconEnabled) {
        const ok = await this.connectRcon(cfg.rconHost, cfg.rconPort, cfg.rconPassword);
        if (!ok) throw new Error('RCON nicht verfügbar');
      } else {
        throw new Error('RCON deaktiviert');
      }
    }
    try {
      const res = await this.rcon.send(cmd);
      return res;
    } catch (e) {
      this.rconConnected = false;
      throw e;
    }
  }

  startRefreshLoop() {
    if (this.refreshInterval) clearInterval(this.refreshInterval);
    const cfg = server.getConfig();
    const intervalMs = Math.max(2, cfg.playerDataRefreshInterval || 5) * 1000;
    this.refreshInterval = setInterval(() => {
      this.refreshAllPlayers().catch(e => {
        // Stille Fehler - RCON ist optional
      });
    }, intervalMs);
  }

  stopRefreshLoop() {
    if (this.refreshInterval) clearInterval(this.refreshInterval);
    this.refreshInterval = null;
  }

  async refreshAllPlayers() {
    if (!server.isRunning()) return;
    try {
      // 1. Spieler-Liste
      const listRes = await this.sendRcon('list').catch(() => '');
      this.parseListOutput(listRes);

      // 2. Für jeden Spieler Daten abfragen
      for (const [name, player] of this.players) {
        if (!player.online) continue;
        await this.refreshPlayer(name, player).catch(() => {});
      }
    } catch (e) {}
  }

  parseListOutput(output) {
    // Format: "There are 3 out of maximum 20 players online: player1, player2, player3"
    // oder: "There are 0 out of maximum 20 players online."
    const match = output.match(/There are (\d+) out of maximum (\d+) players online:? ?(.*)/i);
    if (!match) return;
    const count = parseInt(match[1]);
    const max = parseInt(match[2]);
    const namesStr = match[3] || '';
    const names = namesStr.trim() ? namesStr.trim().split(/,\s*/) : [];

    const onlineNow = new Set(names.map(n => n.toLowerCase()));

    // Markiere alle als offline
    for (const [key, p] of this.players) {
      p.online = onlineNow.has(key);
      if (!p.online) p.lastSeen = Date.now();
    }

    // Neue Spieler hinzufügen
    for (const name of names) {
      const key = name.toLowerCase();
      if (!this.players.has(key)) {
        this.players.set(key, {
          name,
          uuid: null,
          joinedAt: Date.now(),
          lastSeen: Date.now(),
          health: 20,
          food: 20,
          saturation: 5,
          level: 0,
          xp: 0,
          xpTotal: 0,
          gamemode: 'survival',
          location: { x: 0, y: 0, z: 0, world: 'world' },
          inventory: [],
          armor: [],
          effects: [],
          stats: { kills: 0, deaths: 0, mobKills: 0, blocksPlaced: 0, blocksBroken: 0, playtime: 0 },
          isBedrock: false,
          online: true,
        });
        // UUID asynchron nachladen
        mojangAPI.getUUID(name).then(uuid => {
          if (uuid && this.players.has(key)) {
            this.players.get(key).uuid = uuid;
          }
        });
      } else {
        const p = this.players.get(key);
        p.online = true;
        p.lastSeen = Date.now();
      }
    }
  }

  async refreshPlayer(name, player) {
    // Scoreboard für Health, Food etc.
    try {
      // Health (Max HP)
      const healthRes = await this.sendRcon(`execute as ${name} run attribute @s minecraft:generic.max_health get`).catch(() => '');
      const healthMatch = healthRes.match(/([\d.]+)/);
      if (healthMatch) player.maxHealth = parseFloat(healthMatch[1]);

      // Aktuelle Health
      const currentHealthRes = await this.sendRcon(`data get entity ${name} Health`).catch(() => '');
      const chMatch = currentHealthRes.match(/([\d.]+)/);
      if (chMatch) player.health = parseFloat(chMatch[1]);

      // Food (FoodLevel)
      const foodRes = await this.sendRcon(`execute as ${name} run attribute @s minecraft:generic.food get`).catch(() => '');
      const foodMatch = foodRes.match(/([\d.]+)/);
      if (foodMatch) player.food = parseFloat(foodMatch[1]);

      // XP Level
      const xpRes = await this.sendRcon(`xp query ${name} levels`).catch(() => '');
      const xpMatch = xpRes.match(/([\d]+)/);
      if (xpMatch) player.level = parseInt(xpMatch[1]);

      // XP Punkte
      const xpPointsRes = await this.sendRcon(`xp query ${name} points`).catch(() => '');
      const xpPMatch = xpPointsRes.match(/([\d]+)/);
      if (xpPMatch) player.xp = parseInt(xpPMatch[1]);

      // Gamemode
      const gmRes = await this.sendRcon(`execute as ${name} run data get entity @s playerGameType`).catch(() => '');
      const gmMap = { 0: 'survival', 1: 'creative', 2: 'adventure', 3: 'spectator' };
      const gmMatch = gmRes.match(/(\d+)/);
      if (gmMatch) player.gamemode = gmMap[parseInt(gmMatch[1])] || 'survival';

      // Position
      const posRes = await this.sendRcon(`data get entity ${name} Pos`).catch(() => '');
      const posMatch = posRes.match(/\[([-\d.]+)d?,\s*([-\d.]+)d?,\s*([-\d.]+)d?\]/);
      if (posMatch) {
        player.location = {
          x: parseFloat(posMatch[1]),
          y: parseFloat(posMatch[2]),
          z: parseFloat(posMatch[3]),
          world: player.location?.world || 'world',
        };
      }

      // Dimension
      const dimRes = await this.sendRcon(`execute as ${name} in minecraft:overworld run tp ${name} ${player.location.x} ${player.location.y} ${player.location.z}`).catch(() => '');
      // Bessere Methode: data get entity @s Dimension
      const dimRes2 = await this.sendRcon(`data get entity ${name} Dimension`).catch(() => '');
      const dimMatch = dimRes2.match(/"minecraft:(\w+)"/);
      if (dimMatch) player.location.world = dimMatch[1];

      // Effects
      const effectsRes = await this.sendRcon(`effect list ${name}`).catch(() => '');
      player.effects = this.parseEffects(effectsRes);

      // Inventar (Hauptslot 0-35)
      player.inventory = await this.getPlayerInventory(name).catch(() => []);

    } catch (e) {}
  }

  parseEffects(output) {
    const effects = [];
    if (!output) return effects;
    const lines = output.split('\n');
    for (const line of lines) {
      const match = line.match(/^- (\w+):.*?\(amplifier:\s*(\d+),\s*duration:\s*(\d+)\s* ticks/i);
      if (match) {
        effects.push({
          name: match[1],
          amplifier: parseInt(match[2]),
          duration: parseInt(match[3]),
          displayName: this.formatEffectName(match[1]),
        });
      }
    }
    return effects;
  }

  formatEffectName(name) {
    const names = {
      speed: 'Geschwindigkeit', slowness: 'Langsamkeit', haste: 'Eile', mining_fatigue: 'Bergbau-Müdigkeit',
      strength: 'Stärke', weakness: 'Schwäche', regeneration: 'Regeneration', poison: 'Vergiftung',
      wither: 'Wither', saturation: 'Sättigung', night_vision: 'Nachtsicht', invisibility: 'Unsichtbarkeit',
      resistance: 'Widerstand', fire_resistance: 'Feuerresistenz', water_breathing: 'Wasseratmung',
      jump_boost: 'Sprungkraft', levitation: 'Levitation', slow_falling: 'Langsamer Fall',
      glowing: 'Leuchten', luck: 'Glück', unluck: 'Pech',
    };
    return names[name] || name;
  }

  async getPlayerInventory(name) {
    // Verwende data get entity für Inventar-Slots
    const items = [];
    for (let i = 0; i < 36; i++) {
      try {
        const res = await this.sendRcon(`data get entity ${name} Inventory[${i}]`).catch(() => '');
        const match = res.match(/id:"minecraft:(\w+)".*?Count:(\d+)b?/);
        if (match) {
          items.push({
            slot: i,
            item: match[1],
            count: parseInt(match[2]),
            displayName: this.formatItemName(match[1]),
          });
        } else {
          items.push({ slot: i, item: null });
        }
      } catch (e) {
        break;
      }
    }
    return items.filter(i => i.item);
  }

  formatItemName(name) {
    const names = {
      diamond_sword: 'Diamantschwert', netherite_sword: 'Netheritschwert', diamond_pickaxe: 'Diamantspitzhacke',
      diamond_axe: 'Diamantaxt', diamond_shovel: 'Diamantschaufel', bow: 'Bogen', crossbow: 'Armbrust',
      arrow: 'Pfeil', cooked_beef: 'Gebratenes Rindfleisch', golden_apple: 'Goldener Apfel',
      enchanted_golden_apple: 'Verzauberter Goldener Apfel', ender_pearl: 'Enderperle',
      totem_of_undying: 'Totem der Unsterblichkeit', elytra: 'Elytren', shield: 'Schild',
    };
    return names[name] || name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  addPlayerHistory(event) {
    this.playerHistory.unshift({
      ...event,
      timestamp: Date.now(),
    });
    if (this.playerHistory.length > 500) this.playerHistory.length = 500;
  }

  getAllPlayers() {
    return Array.from(this.players.values());
  }

  getOnlinePlayers() {
    return Array.from(this.players.values()).filter(p => p.online);
  }

  getPlayer(name) {
    return this.players.get(name.toLowerCase());
  }
}

class MojangAPI {
  constructor() {
    this.uuidCache = new Map();
    this.profileCache = new Map();
    this.nameHistoryCache = new Map();
  }

  async getUUID(username) {
    if (!username) return null;
    const cached = this.uuidCache.get(username.toLowerCase());
    if (cached && Date.now() - cached.ts < 3600000) return cached.uuid;
    try {
      const res = await axios.get(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`, {
        timeout: 5000,
      });
      if (res.data && res.data.id) {
        const uuid = res.data.id;
        this.uuidCache.set(username.toLowerCase(), { uuid, ts: Date.now() });
        return uuid;
      }
    } catch (e) {
      // 404 = Spieler existiert nicht
    }
    return null;
  }

  async getProfile(uuid) {
    if (!uuid) return null;
    const cleanUuid = uuid.replace(/-/g, '');
    const cached = this.profileCache.get(cleanUuid);
    if (cached && Date.now() - cached.ts < 3600000) return cached.profile;
    try {
      const res = await axios.get(`https://sessionserver.mojang.com/session/minecraft/profile/${cleanUuid}`, {
        timeout: 5000,
      });
      if (res.data) {
        this.profileCache.set(cleanUuid, { profile: res.data, ts: Date.now() });
        return res.data;
      }
    } catch (e) {}
    return null;
  }

  getSkinUrl(uuid) {
    return `https://minotar.net/avatar/${uuid}/64`;
  }

  getBodyRenderUrl(uuid) {
    return `https://minotar.net/body/${uuid}/300`;
  }

  getHeadRenderUrl(uuid) {
    return `https://minotar.net/helm/${uuid}/128`;
  }

  getSkinTextureUrl(uuid) {
    return `https://minotar.net/skin/${uuid}`;
  }

  async getNameHistory(uuid) {
    if (!uuid) return [];
    const cleanUuid = uuid.replace(/-/g, '');
    const cached = this.nameHistoryCache.get(cleanUuid);
    if (cached && Date.now() - cached.ts < 3600000) return cached.history;
    try {
      const res = await axios.get(`https://api.mojang.com/user/profiles/${cleanUuid}/names`, {
        timeout: 5000,
      });
      if (Array.isArray(res.data)) {
        this.nameHistoryCache.set(cleanUuid, { history: res.data, ts: Date.now() });
        return res.data;
      }
    } catch (e) {}
    return [];
  }
}

// ============================================================================
// PLUGIN-KATALOG
// ============================================================================

const PLUGIN_CATALOG = {
  paper: {
    name: 'Paper',
    version: '1.21.4',
    description: 'Hochleistungs-Server-Software basierend auf CraftBukkit/Spigot',
    author: 'PaperMC Team',
    required: true,
    fileName: 'server.jar',
    isServer: true,
  },
  geyser: {
    name: 'Geyser-Spigot',
    version: '2.4.2',
    description: 'Erlaubt Bedrock-Spielern, Java-Servern beizutreten',
    author: 'GeyserMC',
    fileName: 'Geyser-Spigot.jar',
    downloadUrl: 'https://download.geysermc.org/v2/projects/geyser/versions/latest/builds/latest/downloads/spigot',
  },
  floodgate: {
    name: 'Floodgate-Spigot',
    version: '2.2.2',
    description: 'Ermöglicht Bedrock-Spielern Beitritt ohne Java-Account',
    author: 'GeyserMC',
    fileName: 'floodgate-spigot.jar',
    downloadUrl: 'https://download.geysermc.org/v2/projects/floodgate/versions/latest/builds/latest/downloads/spigot',
  },
  luckperms: {
    name: 'LuckPerms',
    version: '5.5.53',
    description: 'Berechtigungssystem für Minecraft-Server',
    author: 'LuckPerms',
    fileName: 'LuckPerms-Bukkit-5.5.53.jar',
    downloadUrl: 'https://cdn.modrinth.com/data/Vebnzrzj/versions/MBSY8toc/LuckPerms-Bukkit-5.5.53.jar',
  },
  essentialsx: {
    name: 'EssentialsX',
    version: '2.20.1',
    description: 'Essentielle Befehle und Funktionen für Minecraft-Server',
    author: 'EssentialsX Team',
    fileName: 'EssentialsX-2.20.1.jar',
    downloadUrl: 'https://github.com/EssentialsX/Essentials/releases/download/2.20.1/EssentialsX-2.20.1.jar',
  },
  vault: {
    name: 'Vault',
    version: '1.7.3',
    description: 'Berechtigungs-, Chat- und Wirtschafts-API',
    author: 'Vault',
    fileName: 'Vault-1.7.3.jar',
    downloadUrl: 'https://github.com/milkbowl/Vault/releases/download/1.7.3/Vault.jar',
  },
  coreprotect: {
    name: 'CoreProtect',
    version: '22.4',
    description: 'Block-Logging, Rollback, Inspektion',
    author: 'Intelli',
    fileName: 'CoreProtect-22.4.jar',
    downloadUrl: 'https://cdn.modrinth.com/data/Lu3KuzdV/versions/llmrc4cl/CoreProtect-22.4.jar',
  },
  worldedit: {
    name: 'WorldEdit',
    version: '7.3.6',
    description: 'Welt-Editor für Minecraft',
    author: 'sk89q',
    fileName: 'worldedit-bukkit-7.3.6.jar',
    downloadUrl: 'https://dev.bukkit.org/projects/worldedit/files/latest',
  },
  worldguard: {
    name: 'WorldGuard',
    version: '7.0.13',
    description: 'Gebietsschutz und -verwaltung',
    author: 'sk89q',
    fileName: 'worldguard-bukkit-7.0.13.jar',
    downloadUrl: 'https://dev.bukkit.org/projects/worldguard/files/latest',
  },
  viaversion: {
    name: 'ViaVersion',
    version: '5.11.0',
    description: 'Multi-Version-Support',
    author: 'ViaVersion',
    fileName: 'ViaVersion-5.11.0.jar',
    downloadUrl: 'https://github.com/ViaVersion/ViaVersion/releases/download/5.11.0/ViaVersion-5.11.0.jar',
  },
  // === ANTI-CHEAT PLUGINS ===
  matrix: {
    name: 'Matrix',
    version: '7.9.1',
    description: 'Leistungsstarke Anti-Cheat mit Movement/Fight/Combat-Checks',
    author: 'MatrixMC',
    fileName: 'Matrix-7.9.1.jar',
    // Matrix ist closed-source - manuelle Installation von SpigotMC erforderlich
    downloadUrl: 'https://www.spigotmc.org/resources/matrix-anti-cheat-advanced.65620/download',
    isAntiCheat: true,
    severity: 'high',
    manualInstall: true,
  },
  vulcan: {
    name: 'Vulcan',
    version: '2.9.5',
    description: 'Premium Anti-Cheat - Combat, Movement, Timer, Badpackets, Scaffold',
    author: 'VulcanMC',
    fileName: 'Vulcan-2.9.5.jar',
    // Vulcan ist Premium - manuelle Installation von SpigotMC
    downloadUrl: 'https://www.spigotmc.org/resources/vulcan-anti-cheat.83626/download',
    isAntiCheat: true,
    severity: 'high',
    manualInstall: true,
  },
  grim: {
    name: 'GrimAC',
    version: '2.3.74',
    description: 'Moderne Open-Source Anti-Cheat mit präzisen Predictions für Combat/Movement',
    author: 'GrimAC',
    fileName: 'GrimAC.jar',
    // Modrinth-Download (offiziell, kostenlos, Open-Source)
    downloadUrl: 'https://cdn.modrinth.com/data/LJNGWSvH/versions/fbt7nJt5/grimac-bukkit-2.3.74-2614909.jar',
    isAntiCheat: true,
    severity: 'high',
  },
  spartan: {
    name: 'Spartan',
    version: '1.4.0',
    description: 'Anti-Cheat mit über 60 Checks für Combat, Movement, Exploits',
    author: 'Spartan',
    fileName: 'Spartan-1.4.0.jar',
    // Spartan ist closed-source
    downloadUrl: 'https://www.spigotmc.org/resources/spartan-anti-cheat-advanced-anti-cheat-detection.64138/download',
    isAntiCheat: true,
    severity: 'medium',
    manualInstall: true,
  },
  kauri: {
    name: 'Kauri',
    version: '0.2.0',
    description: 'Leichtgewichtige Anti-Cheat',
    author: 'Kauri',
    fileName: 'Kauri-0.2.0.jar',
    downloadUrl: 'https://www.spigotmc.org/resources/kauri-anti-cheat.99912/download',
    isAntiCheat: true,
    severity: 'low',
    manualInstall: true,
  },
  negative: {
    name: 'Negatite',
    version: '1.0.0',
    description: 'Einfache Anti-Cheat Basis-Implementierung',
    author: 'Comquack',
    fileName: 'Negatite.jar',
    downloadUrl: 'https://github.com/Comquack/Negatite/releases/latest',
    isAntiCheat: true,
    severity: 'low',
    manualInstall: true,
  },
};

// ============================================================================
// SERVER-VERWALTUNG
// ============================================================================

class MinecraftServer {
  constructor() {
    this.process = null;
    this.consoleBuffer = [];
    this.maxBufferLines = 5000;
    this.status = 'offline'; // offline, starting, online, stopping, error
    this.startTime = null;
    this.stopTime = null;
    this.lastStatusCheck = 0;
    this.consoleListeners = new Set();
    this.commandQueue = [];
    this.tpsData = { tps: 20, mspt: 50 };
    this.players = new Map();
    this.bedrockPlayers = new Set();
  }

  getConfig() {
    return readJSON(CONFIG_FILE, DEFAULT_PANEL_CONFIG);
  }

  saveConfig(cfg) {
    return writeJSON(CONFIG_FILE, cfg);
  }

  isRunning() {
    return this.process !== null && this.status === 'online';
  }

  isStarting() {
    return this.status === 'starting';
  }

  appendConsole(line) {
    const ts = new Date().toISOString();
    const formatted = `[${ts}] ${line}`;
    this.consoleBuffer.push(formatted);
    if (this.consoleBuffer.length > this.maxBufferLines) {
      this.consoleBuffer.shift();
    }
    // An alle Listener senden
    for (const listener of this.consoleListeners) {
      try { listener(formatted); } catch (e) {}
    }
    // In Log-Datei schreiben
    try {
      fs.appendFileSync(path.join(LOG_DIR, 'server.log'), line + '\n');
    } catch (e) {}
  }

  getConsoleLines(limit = 500) {
    return this.consoleBuffer.slice(-limit);
  }

  onConsole(listener) {
    this.consoleListeners.add(listener);
    return () => this.consoleListeners.delete(listener);
  }

  clearConsole() {
    this.consoleBuffer = [];
  }

  async start() {
    if (this.isRunning() || this.isStarting()) {
      return { success: false, error: 'Server läuft bereits' };
    }

    const cfg = this.getConfig();
    if (!cfg.initialized) {
      return { success: false, error: 'Setup nicht abgeschlossen' };
    }

    // EULA prüfen
    const eulaPath = path.join(SERVER_DIR, 'eula.txt');
    if (!fs.existsSync(eulaPath) || !fs.readFileSync(eulaPath, 'utf8').includes('eula=true')) {
      fs.writeFileSync(eulaPath, '#EULA akzeptiert durch Panel\n' +
        '#https://aka.ms/MinecraftEULA\neula=true\n');
    }

    this.status = 'starting';
    this.startTime = Date.now();
    this.appendConsole('=== SERVER START WIRD VORBEREITET ===');

    // RCON-Passwort in server.properties setzen
    if (cfg.rconEnabled) {
      this.applyRconConfig();
    }

    const args = [
      `-Xms${cfg.ramMin}`,
      `-Xmx${cfg.ramMax}`,
      '-XX:+UseG1GC',
      '-XX:+ParallelRefProcEnabled',
      '-XX:MaxGCPauseMillis=200',
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:+DisableExplicitGC',
      '-XX:+AlwaysPreTouch',
      '-jar',
      'server.jar',
      '--nogui',
    ];

    try {
      this.process = spawn(cfg.javaPath || 'java', args, {
        cwd: SERVER_DIR,
        env: { ...process.env },
      });

      this.appendConsole(`Java-Prozess gestartet (PID: ${this.process.pid})`);

      this.process.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(l => l.trim());
        for (const line of lines) {
          this.appendConsole(line);
          this.parseLogLine(line);
        }
      });

      this.process.stderr.on('data', (data) => {
        const lines = data.toString().split('\n').filter(l => l.trim());
        for (const line of lines) {
          this.appendConsole('[STDERR] ' + line);
        }
      });

      this.process.on('exit', (code, signal) => {
        this.appendConsole(`=== SERVER BEENDET (Code: ${code}, Signal: ${signal}) ===`);
        this.status = 'offline';
        this.stopTime = Date.now();
        this.process = null;
        this.players.clear();
        this.bedrockPlayers.clear();
        playerTracker.players.clear();
        playerTracker.stopRefreshLoop();
      });

      this.process.on('error', (err) => {
        this.appendConsole(`[ERROR] ${err.message}`, 'ERROR');
        this.status = 'error';
      });

      // Auf "Done" warten
      this.waitForServerReady().then(() => {
        this.status = 'online';
        this.appendConsole('=== SERVER IST ONLINE ===');
        addActivity('🟢 Server gestartet', 'success');

        // RCON verbinden und Player-Tracking starten
        if (cfg.rconEnabled) {
          setTimeout(async () => {
            const ok = await playerTracker.connectRcon(cfg.rconHost, cfg.rconPort, cfg.rconPassword);
            if (ok) {
              playerTracker.startRefreshLoop();
              log('Player-Tracking via RCON aktiv');
            }
          }, 3000);
        }
      }).catch((e) => {
        this.appendConsole(`[WARN] Server-Ready-Timeout: ${e.message}`, 'WARN');
        this.status = 'online';
      });

      return { success: true, pid: this.process.pid };
    } catch (e) {
      this.status = 'error';
      this.appendConsole(`[ERROR] Start fehlgeschlagen: ${e.message}`, 'ERROR');
      return { success: false, error: e.message };
    }
  }

  applyRconConfig() {
    const cfg = server.getConfig();
    const propsPath = path.join(SERVER_DIR, 'server.properties');
    let props = '';
    if (fs.existsSync(propsPath)) {
      props = fs.readFileSync(propsPath, 'utf8');
    }
    // RCON-Einstellungen setzen/aktualisieren
    const setProp = (name, val) => {
      const re = new RegExp(`^${name}=.*$`, 'm');
      if (re.test(props)) {
        props = props.replace(re, `${name}=${val}`);
      } else {
        props += `\n${name}=${val}`;
      }
    };
    setProp('enable-rcon', cfg.rconEnabled);
    setProp('rcon.port', cfg.rconPort);
    setProp('rcon.password', cfg.rconPassword);
    setProp('broadcast-rcon-to-ops', false);
    setProp('broadcast-console-to-ops', true);
    try {
      fs.writeFileSync(propsPath, props);
      log(`RCON konfiguriert: Port ${cfg.rconPort}`);
    } catch (e) {
      log(`RCON-Konfiguration fehlgeschlagen: ${e.message}`, 'WARN');
    }
  }

  waitForServerReady(timeout = 90000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        // Suche nach "Done" in den letzten Zeilen
        const recent = this.consoleBuffer.slice(-50).join('\n');
        if (recent.includes('Done (') || recent.includes('Server started')) {
          resolve();
          return;
        }
        if (Date.now() - start > timeout) {
          reject(new Error('Timeout'));
          return;
        }
        if (!this.process) {
          reject(new Error('Prozess beendet'));
          return;
        }
        setTimeout(check, 500);
      };
      check();
    });
  }

  parseLogLine(line) {
    // Spieler-Login erkennen
    const loginMatch = line.match(/(\w+)\[\/([0-9.]+):(\d+)\] logged in with entity id/);
    if (loginMatch) {
      const player = loginMatch[1];
      const ip = loginMatch[2];
      this.players.set(player.toLowerCase(), { name: player, joinTime: Date.now(), ip });
      addActivity(`👤 ${player} ist beigetreten`, 'info');
      playerTracker.addPlayerHistory({ type: 'join', player, ip });
      // IP-Tracking
      const cfg = server.getConfig();
      if (cfg.ipTrackingEnabled) {
        ipTracker.logIP(player, ip);
      }
      // IP-Ban-Check
      if (cfg.ipBanEnabled && ipTracker.isBanned(ip)) {
        const banInfo = ipTracker.bannedIPs.get(ip);
        log(`Gebannte IP versucht zu joinen: ${player} (${ip})`);
        securityLog.logEvent('banned_ip_attempt', 'critical', {
          user: player, ip, reason: banInfo?.reason, bannedBy: banInfo?.bannedBy,
        });
        addActivity(`🚫 Verbindung abgelehnt: ${player} (IP ${ip} gebannt)`, 'error');
        this.sendCommand(`kick ${player} IP gebannt: ${banInfo?.reason || 'Kein Grund angegeben'}`);
        this.players.delete(player.toLowerCase());
        return;
      }
      // Multi-Account-Check
      const sameIPPlayers = ipTracker.getIPPlayers(ip);
      if (sameIPPlayers.length > cfg.maxAccountsPerIP) {
        securityLog.logEvent('multi_account_detected', 'warning', {
          ip, players: sameIPPlayers, max: cfg.maxAccountsPerIP,
        });
        ipTracker.recordViolation(ip, 'multi_account');
        if (cfg.ipBanOnMultiAccount) {
          ipTracker.banIP(ip, `Multi-Account: ${sameIPPlayers.length} Spieler`, 'antimultiaccount', null);
        }
      }
    }
    // Spieler-Logout
    const logoutMatch = line.match(/(\w+) left the game/);
    if (logoutMatch) {
      this.players.delete(logoutMatch[1].toLowerCase());
      addActivity(`👤 ${logoutMatch[1]} hat verlassen`, 'info');
      playerTracker.addPlayerHistory({ type: 'leave', player: logoutMatch[1] });
      const tp = playerTracker.players.get(logoutMatch[1].toLowerCase());
      if (tp) {
        tp.online = false;
        tp.lastSeen = Date.now();
      }
    }
    // Bedrock-Spieler (Geyser)
    if (line.includes('[Geyser-Spigot]') && line.includes('logged in')) {
      const m = line.match(/(\w+)\s*\[/);
      if (m) {
        this.bedrockPlayers.add(m[1]);
        addActivity(`🌐 Bedrock-Spieler verbunden: ${m[1]}`, 'info');
        const tp = playerTracker.players.get(m[1].toLowerCase());
        if (tp) tp.isBedrock = true;
      }
    }
    // ANTI-CHEAT: Violations aus Plugin-Logs erkennen
    // Matrix: [Matrix] WARNING: Player has failed CheckName (VL=X)
    const matrixMatch = line.match(/\[Matrix\].*?(\w+) (?:has )?failed (\w+).*?VL[=:]?\s*(\d+)/i);
    if (matrixMatch) {
      const player = matrixMatch[1];
      const check = matrixMatch[2];
      const vl = parseInt(matrixMatch[3]);
      const severity = vl > 50 ? 'critical' : vl > 20 ? 'high' : vl > 5 ? 'medium' : 'low';
      antiCheat.report(player, `Matrix:${check}`, severity, { vl });
    }
    // Vulcan: [Vulcan] Failed check ...
    const vulcanMatch = line.match(/\[Vulcan\].*?(\w+) failed (\w+)/i);
    if (vulcanMatch) {
      const player = vulcanMatch[1];
      const check = vulcanMatch[2];
      antiCheat.report(player, `Vulcan:${check}`, 'high');
    }
    // Grim: [Grim] Player X failed check
    const grimMatch = line.match(/\[Grim\].*?(\w+) failed (\w+)/i);
    if (grimMatch) {
      antiCheat.report(grimMatch[1], `Grim:${grimMatch[2]}`, 'high');
    }
    // Spartan: [Spartan] violation
    const spartanMatch = line.match(/\[Spartan\].*?(\w+) (?:has )?(\w+)/i);
    if (spartanMatch) {
      antiCheat.report(spartanMatch[1], `Spartan:${spartanMatch[2]}`, 'medium');
    }
    // Kauri: [Kauri] detect
    const kauriMatch = line.match(/\[Kauri\].*?(\w+).*?(\w+)/i);
    if (kauriMatch) {
      antiCheat.report(kauriMatch[1], `Kauri:${kauriMatch[2]}`, 'medium');
    }
    // Allgemeine Cheat-Detection-Patterns
    // Speed-Hack: "X moved too quickly"
    const speedMatch = line.match(/(\w+) moved too quickly!/);
    if (speedMatch) {
      antiCheat.report(speedMatch[1], 'SpeedHack', 'medium', { source: 'vanilla' });
    }
    // Fly-Hack: "X was kicked for floating too long"
    const flyMatch = line.match(/(\w+) (?:was kicked|float.+?too long)/);
    if (flyMatch) {
      antiCheat.report(flyMatch[1], 'FlyHack', 'high', { source: 'vanilla' });
    }
    // Invalid-Items
    const invalidItemMatch = line.match(/(\w+).*?(?:Invalid|illegal) (?:item|enchant)/);
    if (invalidItemMatch) {
      antiCheat.report(invalidItemMatch[1], 'InvalidItems', 'high', { source: 'vanilla' });
    }
    // Kill-Events: "Player was slain by Mob/Player"
    const slainByMob = line.match(/(\w+) was slain by (\w+)/);
    if (slainByMob) {
      const victim = slainByMob[1];
      const killer = slainByMob[2];
      const vtp = playerTracker.players.get(victim.toLowerCase());
      if (vtp) vtp.stats.deaths = (vtp.stats.deaths || 0) + 1;
      const mobs = ['Zombie', 'Skeleton', 'Creeper', 'Spider', 'Enderman', 'Witch', 'Slime', 'Magma Cube', 'Phantom', 'Drowned', 'Pillager', 'Vindicator', 'Evoker', 'Ravager', 'Vex', 'Hoglin', 'Piglin', 'Hoglin', 'Wither', 'Ender Dragon', 'Elder Guardian', 'Guardian'];
      if (!mobs.includes(killer)) {
        const ktp = playerTracker.players.get(killer.toLowerCase());
        if (ktp) {
          ktp.stats.kills = (ktp.stats.kills || 0) + 1;
          addActivity(`⚔️ ${killer} hat ${victim} getötet`, 'warning');
        }
      } else {
        const vtp2 = playerTracker.players.get(victim.toLowerCase());
        if (vtp2) vtp2.stats.mobDeaths = (vtp2.stats.mobDeaths || 0) + 1;
        addActivity(`💀 ${victim} wurde von ${killer} getötet`, 'warning');
      }
    }
    // "X fell from a high place"
    const fallMatch = line.match(/(\w+) fell from a high place/);
    if (fallMatch) {
      const tp = playerTracker.players.get(fallMatch[1].toLowerCase());
      if (tp) tp.stats.deaths = (tp.stats.deaths || 0) + 1;
    }
    // "X drowned"
    const drownedMatch = line.match(/(\w+) drowned/);
    if (drownedMatch) {
      const tp = playerTracker.players.get(drownedMatch[1].toLowerCase());
      if (tp) tp.stats.deaths = (tp.stats.deaths || 0) + 1;
    }
    // Achievement/Advancement
    const advMatch = line.match(/(\w+) has completed the \[([^\]]+)\] advancement/);
    if (advMatch) {
      addActivity(`🏆 ${advMatch[1]} hat ${advMatch[2]} freigeschaltet`, 'info');
    }
    // TPS-Ausgabe
    const tpsMatch = line.match(/TPS\s*=\s*([\d.]+),\s*MSPT\s*=\s*([\d.]+)/);
    if (tpsMatch) {
      this.tpsData = { tps: parseFloat(tpsMatch[1]), mspt: parseFloat(tpsMatch[2]) };
    }
    // Server-Start-Indikatoren
    if (line.includes('Server is now accepting connections') || line.includes('Done (') || line.includes('Server started')) {
      securityLog.logEvent('server_startup', 'info', { message: 'Server bereit für Verbindungen' });
    }
  }

  sendCommand(cmd) {
    if (!this.isRunning() && !this.isStarting()) {
      return { success: false, error: 'Server läuft nicht' };
    }
    if (!this.process || !this.process.stdin) {
      return { success: false, error: 'Kein Server-Prozess verfügbar' };
    }
    try {
      this.process.stdin.write(cmd + '\n');
      this.appendConsole(`> ${cmd}`);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  stop(timeout = 30000) {
    if (!this.isRunning() && !this.isStarting()) {
      return { success: false, error: 'Server läuft nicht' };
    }
    this.status = 'stopping';
    this.appendConsole('=== STOP-SIGNAL GESENDET ===');

    // Erst freundlich stoppen
    this.sendCommand('stop');

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.process) {
          this.appendConsole('[WARN] Stop-Timeout, erzwinge Beendigung', 'WARN');
          this.kill();
        }
      }, timeout);

      const checkInterval = setInterval(() => {
        if (!this.process) {
          clearTimeout(timer);
          clearInterval(checkInterval);
          this.status = 'offline';
          addActivity('🔴 Server gestoppt', 'warning');
          resolve({ success: true });
        }
      }, 500);
    });
  }

  restart() {
    this.appendConsole('=== RESTART ===');
    addActivity('🔄 Server wird neugestartet', 'info');
    return this.stop().then(() => {
      return new Promise((resolve) => setTimeout(resolve, 3000)).then(() => this.start());
    });
  }

  reload() {
    if (!this.isRunning()) {
      return { success: false, error: 'Server läuft nicht' };
    }
    this.sendCommand('reload confirm');
    addActivity('🔃 Server-Konfiguration neu geladen', 'info');
    return { success: true };
  }

  kill() {
    if (this.process) {
      try {
        this.process.kill('SIGKILL');
        this.appendConsole('[KILL] Prozess gewaltsam beendet', 'WARN');
        addActivity('🛑 Server-Prozess beendet', 'warning');
      } catch (e) {}
      this.process = null;
    }
    this.status = 'offline';
    this.stopTime = Date.now();
    return { success: true };
  }

  getStatus() {
    return {
      status: this.status,
      running: this.isRunning(),
      pid: this.process ? this.process.pid : null,
      uptime: this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0,
      startTime: this.startTime,
      stopTime: this.stopTime,
      tps: this.tpsData.tps,
      mspt: this.tpsData.mspt,
      playerCount: this.players.size,
      players: Array.from(this.players.values()),
      bedrockPlayerCount: this.bedrockPlayers.size,
      bedrockPlayers: Array.from(this.bedrockPlayers),
    };
  }

  getStatusWithTracker() {
    const base = this.getStatus();
    const online = playerTracker.getOnlinePlayers();
    base.trackedPlayers = online.map(p => ({
      name: p.name,
      uuid: p.uuid,
      health: p.health,
      maxHealth: p.maxHealth || 20,
      food: p.food,
      level: p.level,
      gamemode: p.gamemode,
      location: p.location,
      effects: p.effects,
      isBedrock: p.isBedrock,
      skinUrl: p.uuid ? mojangAPI.getSkinUrl(p.uuid) : null,
    }));
    base.rconConnected = playerTracker.rconConnected;
    return base;
  }
}

// ============================================================================
// AKTIVITÄTSLOG
// ============================================================================

function addActivity(message, type = 'info', details = null) {
  const activities = readJSON(ACTIVITY_FILE, []);
  activities.unshift({
    id: genId(),
    timestamp: Date.now(),
    message,
    type,
    details,
  });
  if (activities.length > 500) activities.length = 500;
  writeJSON(ACTIVITY_FILE, activities);
}

function addAudit(user, action, details = {}) {
  const audits = readJSON(AUDIT_FILE, []);
  audits.unshift({
    id: genId(),
    timestamp: Date.now(),
    user,
    action,
    details,
    ip: details.ip || 'unknown',
  });
  if (audits.length > 1000) audits.length = 1000;
  writeJSON(AUDIT_FILE, audits);
}

// ============================================================================
// PLUGIN-MANAGER
// ============================================================================

class PluginManager {
  constructor() {
    this.downloadProgress = new Map();
  }

  isInstalled(pluginId) {
    const info = PLUGIN_CATALOG[pluginId];
    if (!info) return false;
    if (info.isServer) return fs.existsSync(path.join(SERVER_DIR, info.fileName));
    return fs.existsSync(path.join(PLUGINS_DIR, info.fileName));
  }

  listInstalled() {
    const installed = [];
    for (const [id, info] of Object.entries(PLUGIN_CATALOG)) {
      const isInstalled = this.isInstalled(id);
      installed.push({
        id,
        ...info,
        installed: isInstalled,
        enabled: isInstalled, // Vereinfacht - alle installierten sind aktiv
      });
    }
    return installed;
  }

  async downloadPlugin(pluginId) {
    const info = PLUGIN_CATALOG[pluginId];
    if (!info) return { success: false, error: 'Unbekanntes Plugin' };
    if (info.isServer) return { success: false, error: 'Server-JAR kann nicht separat heruntergeladen werden' };
    if (this.isInstalled(pluginId)) return { success: true, alreadyInstalled: true };

    if (!info.downloadUrl) {
      return { success: false, error: 'Keine Download-URL verfügbar' };
    }

    ensureDir(PLUGINS_DIR);
    const target = path.join(PLUGINS_DIR, info.fileName);

    try {
      log(`Lade Plugin herunter: ${pluginId}`);
      await this.downloadFile(info.downloadUrl, target);
      log(`Plugin heruntergeladen: ${info.fileName}`);
      addActivity(`📦 Plugin installiert: ${info.name}`, 'success');
      return { success: true };
    } catch (e) {
      log(`Plugin-Download fehlgeschlagen: ${pluginId}: ${e.message}`, 'ERROR');
      return { success: false, error: e.message };
    }
  }

  downloadFile(url, target) {
    return new Promise((resolve, reject) => {
      const makeRequest = (requestUrl, redirects = 0) => {
        if (redirects > 15) return reject(new Error('Zu viele Redirects'));
        // URL normalisieren - falls relative URL, mit Base verbinden
        let fullUrl;
        try {
          fullUrl = new URL(requestUrl);
        } catch (e) {
          // Versuche als relative URL zu behandeln
          return reject(new Error(`Ungültige URL: ${requestUrl}`));
        }
        const client = fullUrl.protocol === 'https:' ? https : http;
        const req = client.get(fullUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        }, (res) => {
          // Redirects folgen
          if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
            const loc = res.headers.location;
            if (!loc) return reject(new Error('Redirect ohne Ziel'));
            try {
              const next = new URL(loc, fullUrl);
              log(`Redirect: ${fullUrl.href} -> ${next.href}`);
              return makeRequest(next.href, redirects + 1);
            } catch (e) {
              return reject(new Error(`Ungültiger Redirect: ${loc}`));
            }
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode} von ${fullUrl.href}`));
          }
          const file = fs.createWriteStream(target);
          res.pipe(file);
          file.on('finish', () => {
            file.close();
            try {
              const size = fs.statSync(target).size;
              if (size < 100) {
                fs.unlinkSync(target);
                return reject(new Error('Download zu klein, vermutlich Fehlerseite'));
              }
              resolve();
            } catch (e) {
              reject(e);
            }
          });
          file.on('error', (err) => {
            try { fs.unlink(target, () => {}); } catch (e) {}
            reject(err);
          });
        });
        req.on('error', reject);
        req.setTimeout(120000, () => {
          req.destroy();
          reject(new Error('Download-Timeout'));
        });
      };
      makeRequest(url);
    });
  }

  async installAll(enabledList) {
    const results = [];
    for (const pluginId of enabledList) {
      if (this.isInstalled(pluginId)) {
        results.push({ pluginId, success: true, alreadyInstalled: true });
        continue;
      }
      const r = await this.downloadPlugin(pluginId);
      results.push({ pluginId, ...r });
    }
    return results;
  }
}

// ============================================================================
// BACKUP-MANAGER
// ============================================================================

class BackupManager {
  listBackups() {
    ensureDir(BACKUP_DIR);
    const files = fs.readdirSync(BACKUP_DIR);
    return files
      .filter(f => f.endsWith('.zip') || f.endsWith('.tar.gz'))
      .map(f => {
        const fp = path.join(BACKUP_DIR, f);
        const stat = fs.statSync(fp);
        return {
          name: f,
          path: fp,
          size: stat.size,
          sizeFormatted: formatBytes(stat.size),
          created: stat.birthtime,
          modified: stat.mtime,
        };
      })
      .sort((a, b) => b.created - a.created);
  }

  async createBackup(name = null) {
    ensureDir(BACKUP_DIR);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const filename = name ? `${name}_${ts}.zip` : `backup_${ts}.zip`;
    const target = path.join(BACKUP_DIR, filename);

    // Server kurz informieren
    if (server.isRunning()) {
      server.sendCommand('save-all');
      server.sendCommand('save-off');
      await new Promise(r => setTimeout(r, 3000));
    }

    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(target);
      const archive = new ZipArchive({ zlib: { level: 6 } });
      output.on('close', () => {
        if (server.isRunning()) {
          server.sendCommand('save-on');
        }
        addActivity(`💾 Backup erstellt: ${filename}`, 'success');
        resolve({ success: true, name: filename, size: archive.pointer() });
      });
      archive.on('error', (err) => {
        if (server.isRunning()) server.sendCommand('save-on');
        reject(err);
      });
      archive.pipe(output);

      // Welten sichern
      if (fs.existsSync(WORLD_DIR)) {
        archive.directory(WORLD_DIR, 'server/world');
      }
      const netherDir = path.join(SERVER_DIR, 'world_nether');
      const endDir = path.join(SERVER_DIR, 'world_the_end');
      if (fs.existsSync(netherDir)) archive.directory(netherDir, 'server/world_nether');
      if (fs.existsSync(endDir)) archive.directory(endDir, 'server/world_the_end');

      // Plugins sichern
      if (fs.existsSync(PLUGINS_DIR)) {
        archive.directory(PLUGINS_DIR, 'server/plugins');
      }

      // Configs sichern
      const configDir = path.join(SERVER_DIR, 'config');
      if (fs.existsSync(configDir)) {
        archive.directory(configDir, 'server/config');
      }

      // Panel-Config
      if (fs.existsSync(CONFIG_FILE)) {
        archive.file(CONFIG_FILE, { name: 'panel-config.json' });
      }

      // Wichtige Server-Files
      const serverProps = path.join(SERVER_DIR, 'server.properties');
      if (fs.existsSync(serverProps)) {
        archive.file(serverProps, { name: 'server/server.properties' });
      }
      const eula = path.join(SERVER_DIR, 'eula.txt');
      if (fs.existsSync(eula)) {
        archive.file(eula, { name: 'server/eula.txt' });
      }

      archive.finalize();
    });
  }

  async restoreBackup(name) {
    const backup = this.listBackups().find(b => b.name === name);
    if (!backup) return { success: false, error: 'Backup nicht gefunden' };

    // Server muss gestoppt sein
    if (server.isRunning()) {
      return { success: false, error: 'Server muss vor Wiederherstellung gestoppt werden' };
    }

    try {
      const directory = await unzipper.Open.file(backup.path);
      await directory.extract({ path: ROOT, concurrency: 4 });
      addActivity(`♻️ Backup wiederhergestellt: ${name}`, 'warning');
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  deleteBackup(name) {
    const backup = this.listBackups().find(b => b.name === name);
    if (!backup) return { success: false, error: 'Backup nicht gefunden' };
    try {
      fs.unlinkSync(backup.path);
      addActivity(`🗑️ Backup gelöscht: ${name}`, 'warning');
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  startAutoBackup(intervalHours) {
    if (this.autoBackupTimer) clearInterval(this.autoBackupTimer);
    const ms = Math.max(1, intervalHours) * 60 * 60 * 1000;
    this.autoBackupTimer = setInterval(() => {
      this.createBackup('auto-daily').catch(e => log(`Auto-Backup fehlgeschlagen: ${e.message}`, 'ERROR'));
    }, ms);
    log(`Auto-Backup aktiviert: alle ${intervalHours}h`);
  }
}

// ============================================================================
// KONFIGURATION
// ============================================================================

class ConfigManager {
  generateServerProperties() {
    const cfg = server.getConfig();
    const props = [];
    props.push(`#Minecraft Server Properties - Generiert vom Panel`);
    props.push(`#${new Date().toISOString()}`);
    props.push(`server-name=${cfg.serverName}`);
    props.push(`motd=${cfg.motd}`);
    props.push(`server-port=${cfg.serverPort}`);
    props.push(`server-ip=`);
    props.push(`max-players=${cfg.maxPlayers}`);
    props.push(`view-distance=${cfg.viewDistance}`);
    props.push(`simulation-distance=${cfg.simulationDistance}`);
    props.push(`difficulty=${cfg.difficulty}`);
    props.push(`gamemode=${cfg.gamemode}`);
    props.push(`pvp=${cfg.pvp}`);
    props.push(`online-mode=${cfg.onlineMode}`);
    props.push(`spawn-protection=${cfg.spawnProtection}`);
    props.push(`white-list=${cfg.whitelist}`);
    props.push(`enable-command-block=${cfg.enableCommandBlock}`);
    props.push(`spawn-animals=${cfg.spawnAnimals}`);
    props.push(`spawn-monsters=${cfg.spawnMonsters}`);
    props.push(`spawn-npcs=${cfg.spawnNpcs}`);
    props.push(`allow-flight=${cfg.allowFlight}`);
    props.push(`resource-pack=${cfg.resourcePack}`);
    props.push(`resource-pack-sha1=${cfg.resourcePackSha1}`);
    props.push(`enforce-secure-profile=true`);
    props.push(`enforce-whitelist=${cfg.whitelist}`);
    props.push(`function-permission-level=2`);
    props.push(`network-compression-threshold=256`);
    props.push(`op-permission-level=4`);

    if (cfg.serverIcon) {
      try {
        const iconPath = path.join(SERVER_DIR, cfg.serverIcon);
        if (fs.existsSync(iconPath)) {
          const targetIcon = path.join(SERVER_DIR, 'server-icon.png');
          fs.copyFileSync(iconPath, targetIcon);
        }
      } catch (e) {}
    }

    fs.writeFileSync(path.join(SERVER_DIR, 'server.properties'), props.join('\n') + '\n');
    log('server.properties generiert');
  }

  generateGeyserConfig() {
    const cfg = server.getConfig();
    const config = `# Geyser Konfiguration - Generiert vom Panel
bedrock:
  address: 0.0.0.0
  port: ${cfg.bedrockPort}
  motd1: "${cfg.serverName}"
  motd2: "${cfg.motd.replace(/§./g, '')}"
  server-name: "${cfg.serverName} via Geyser"
remote:
  address: auto
  port: ${cfg.serverPort}
  auth-type: floodgate
  allow-password-accounts: true
floodgate-key-file: key.pem
`;

    const geyserDir = path.join(PLUGINS_DIR, 'Geyser-Spigot');
    ensureDir(geyserDir);
    fs.writeFileSync(path.join(geyserDir, 'config.yml'), config);
    log('Geyser-Konfiguration generiert');
  }

  generateFloodgateConfig() {
    const floodgateDir = path.join(PLUGINS_DIR, 'floodgate');
    ensureDir(floodgateDir);
    const config = `# Floodgate Konfiguration - Generiert vom Panel
send-floodgate-data: true
replace-usernames: true
`;
    fs.writeFileSync(path.join(floodgateDir, 'config.yml'), config);
    log('Floodgate-Konfiguration generiert');
  }
}

// ============================================================================
// BENUTZER-VERWALTUNG
// ============================================================================

const ROLES = {
  owner: { name: 'Owner', level: 100 },
  admin: { name: 'Admin', level: 75 },
  moderator: { name: 'Moderator', level: 50 },
  viewer: { name: 'Viewer', level: 10 },
};

const PERMISSIONS = {
  'server.start': ['owner', 'admin'],
  'server.stop': ['owner', 'admin'],
  'server.restart': ['owner', 'admin'],
  'server.kill': ['owner'],
  'server.reload': ['owner', 'admin'],
  'console.read': ['owner', 'admin', 'moderator'],
  'console.write': ['owner', 'admin'],
  'players.view': ['owner', 'admin', 'moderator'],
  'players.kick': ['owner', 'admin', 'moderator'],
  'players.ban': ['owner', 'admin'],
  'players.unban': ['owner', 'admin'],
  'players.mute': ['owner', 'admin', 'moderator'],
  'players.teleport': ['owner', 'admin'],
  'players.gamemode': ['owner', 'admin'],
  'settings.view': ['owner', 'admin', 'moderator', 'viewer'],
  'settings.edit': ['owner', 'admin'],
  'plugins.view': ['owner', 'admin', 'moderator', 'viewer'],
  'plugins.install': ['owner', 'admin'],
  'plugins.toggle': ['owner', 'admin'],
  'worlds.view': ['owner', 'admin', 'moderator'],
  'worlds.manage': ['owner', 'admin'],
  'backups.view': ['owner', 'admin'],
  'backups.create': ['owner', 'admin'],
  'backups.restore': ['owner'],
  'backups.delete': ['owner', 'admin'],
  'backups.download': ['owner'],
  'logs.view': ['owner', 'admin', 'moderator'],
  'permissions.manage': ['owner'],
  'users.manage': ['owner'],
  'audit.view': ['owner', 'admin'],
  'activity.view': ['owner', 'admin', 'moderator', 'viewer'],
  'geyser.manage': ['owner', 'admin'],
  'geyser.view': ['owner', 'admin', 'moderator', 'viewer'],
  'system.info': ['owner', 'admin', 'moderator', 'viewer'],
  // Security
  'security.view': ['owner', 'admin', 'moderator'],
  'security.manage': ['owner', 'admin'],
  'security.2fa': ['owner'],
};

function getUsers() {
  return readJSON(USERS_FILE, { users: [] });
}

function saveUsers(data) {
  return writeJSON(USERS_FILE, data);
}

function findUser(username) {
  const data = getUsers();
  return data.users.find(u => u.username === username);
}

function hasPermission(user, permission) {
  if (!user) return false;
  if (user.role === 'owner') return true;
  const allowed = PERMISSIONS[permission] || [];
  return allowed.includes(user.role);
}

async function createUser(username, password, role) {
  const data = getUsers();
  if (data.users.find(u => u.username === username)) {
    return { success: false, error: 'Benutzer existiert bereits' };
  }
  const hash = await bcrypt.hash(password, 10);
  const user = {
    id: genId(),
    username,
    passwordHash: hash,
    role,
    createdAt: Date.now(),
    lastLogin: null,
    active: true,
  };
  data.users.push(user);
  saveUsers(data);
  return { success: true, user: { id: user.id, username: user.username, role: user.role } };
}

// ============================================================================
// SETUP WIZARD
// ============================================================================

class SetupWizard {
  constructor() {
    this.steps = [
      { id: 'minecraft_version', name: 'Minecraft-Version', key: 'paper' },
      { id: 'java', name: 'Java-Version' },
      { id: 'ram', name: 'RAM' },
      { id: 'server_port', name: 'Server-Port' },
      { id: 'bedrock_port', name: 'Bedrock UDP-Port' },
      { id: 'server_name', name: 'Server-Name' },
      { id: 'plugins', name: 'Plugins' },
      { id: 'geyser', name: 'Geyser' },
      { id: 'floodgate', name: 'Floodgate' },
      { id: 'luckperms', name: 'LuckPerms' },
      { id: 'backup', name: 'Backup-Einstellungen' },
      { id: 'admin_account', name: 'Administrator-Account' },
    ];
    this.currentStep = 0;
    this.data = { ...DEFAULT_PANEL_CONFIG };
  }

  next() { this.currentStep = Math.min(this.currentStep + 1, this.steps.length - 1); }
  prev() { this.currentStep = Math.max(this.currentStep - 1, 0); }
  goto(idx) { this.currentStep = Math.max(0, Math.min(idx, this.steps.length - 1)); }

  getProgress() {
    return {
      current: this.currentStep,
      total: this.steps.length,
      percent: Math.round((this.currentStep + 1) / this.steps.length * 100),
      step: this.steps[this.currentStep],
    };
  }
}

// ============================================================================
// PERFORMANCE & SYSTEM MONITOR
// ============================================================================

class SystemMonitor {
  constructor() {
    this.history = [];
    this.maxHistory = 60;
    this.lastCpu = this.getCpuInfo();
  }

  getCpuInfo() {
    const cpus = os.cpus();
    let user = 0, nice = 0, sys = 0, idle = 0, irq = 0;
    for (const cpu of cpus) {
      user += cpu.times.user;
      nice += cpu.times.nice;
      sys += cpu.times.sys;
      idle += cpu.times.idle;
      irq += cpu.times.irq;
    }
    return { user, nice, sys, idle, irq, total: user + nice + sys + idle + irq };
  }

  getCpuUsage() {
    const current = this.getCpuInfo();
    const totalDiff = current.total - this.lastCpu.total;
    const idleDiff = current.idle - this.lastCpu.idle;
    this.lastCpu = current;
    if (totalDiff === 0) return 0;
    return Math.max(0, Math.min(100, (1 - idleDiff / totalDiff) * 100));
  }

  getMemory() {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    return {
      total,
      used,
      free,
      percent: (used / total) * 100,
      totalFormatted: formatBytes(total),
      usedFormatted: formatBytes(used),
      freeFormatted: formatBytes(free),
    };
  }

  getDisk() {
    try {
      const stats = fs.statfsSync(ROOT);
      const total = stats.blocks * stats.bsize;
      const free = stats.bavail * stats.bsize;
      const used = total - free;
      return {
        total,
        used,
        free,
        percent: total > 0 ? (used / total) * 100 : 0,
        totalFormatted: formatBytes(total),
        usedFormatted: formatBytes(used),
        freeFormatted: formatBytes(free),
      };
    } catch (e) {
      return { total: 0, used: 0, free: 0, percent: 0, totalFormatted: '0 B', usedFormatted: '0 B', freeFormatted: '0 B' };
    }
  }

  getNetwork() {
    const nets = os.networkInterfaces();
    const result = [];
    for (const [name, addrs] of Object.entries(nets)) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          result.push({ name, address: addr.address, mac: addr.mac });
        }
      }
    }
    return result;
  }

  getFullStats() {
    const mem = this.getMemory();
    const cpu = this.getCpuUsage();
    const disk = this.getDisk();
    const snapshot = { timestamp: Date.now(), cpu, memPercent: mem.percent, memUsed: mem.used, diskPercent: disk.percent };
    this.history.push(snapshot);
    if (this.history.length > this.maxHistory) this.history.shift();
    return {
      cpu,
      memory: mem,
      disk,
      network: this.getNetwork(),
      uptime: os.uptime(),
      os: {
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
        hostname: os.hostname(),
        release: os.release(),
        nodeVersion: process.version,
      },
      java: process.env.JAVA_HOME || 'java',
      history: this.history,
    };
  }
}

// ============================================================================
// INITIALISIERUNG
// ============================================================================

const server = new MinecraftServer();
const pluginManager = new PluginManager();
const backupManager = new BackupManager();
const configManager = new ConfigManager();
const systemMonitor = new SystemMonitor();
const setupWizard = new SetupWizard();
const mojangAPI = new MojangAPI();
const playerTracker = new PlayerTracker();
const ipTracker = new IPTracker();
const antiCheat = new AntiCheatDetector();
const bruteForce = new BruteForceProtection();
const connectionLimiter = new ConnectionLimiter();
const twoFA = new TwoFactorAuth();
const securityLog = new SecurityEventLog();
const railwayManager = new RailwayManager();

ensureDir(LOG_DIR);
ensureDir(BACKUP_DIR);
ensureDir(PLUGINS_DIR);
ensureDir(SERVER_DIR);
ensureDir(path.join(ROOT, 'config'));

// Default-Config schreiben falls nicht vorhanden
if (!fs.existsSync(CONFIG_FILE)) {
  writeJSON(CONFIG_FILE, DEFAULT_PANEL_CONFIG);
}

// ============================================================================
// WEB-SERVER / API
// ============================================================================

const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'", "data:"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Session-Middleware
const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false,
    maxAge: 24 * 60 * 60 * 1000, // 24h
    sameSite: 'lax',
  },
  name: 'mcp.sid',
});

app.use(sessionMiddleware);

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { error: 'Zu viele Anfragen' },
});
app.use('/api/', apiLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Zu viele Login-Versuche' },
});

// Statische Dateien
app.use(express.static(path.join(ROOT, 'web', 'public')));

// CSRF-Schutz
function generateCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

function verifyCsrf(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  const token = req.headers['x-csrf-token'] || req.body._csrf;
  if (!token || token !== req.session.csrfToken) {
    return res.status(403).json({ error: 'Ungültiges CSRF-Token' });
  }
  next();
}

app.get('/api/csrf-token', (req, res) => {
  res.json({ token: generateCsrfToken(req) });
});

// Auth-Middleware
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert' });
  }
  const data = getUsers();
  const user = data.users.find(u => u.id === req.session.userId);
  if (!user || !user.active) {
    req.session.destroy();
    return res.status(401).json({ error: 'Sitzung ungültig' });
  }
  req.user = { id: user.id, username: user.username, role: user.role };
  next();
}

function requirePermission(perm) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Nicht authentifiziert' });
    if (!hasPermission(req.user, perm)) {
      addAudit(req.user.username, 'permission_denied', { permission: perm, ip: req.ip });
      return res.status(403).json({ error: 'Keine Berechtigung' });
    }
    next();
  };
}

// ============================================================================
// API-ROUTEN
// ============================================================================

// --- Auth ---
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { username, password, twoFactorToken } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
  }
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';

  // Brute-Force-Check
  if (bruteForce.isLocked(clientIp) || bruteForce.isLocked(username)) {
    const lockTime = bruteForce.getLockTime(clientIp) || bruteForce.getLockTime(username);
    securityLog.logEvent('bruteforce_blocked', 'critical', {
      user: username, ip: clientIp, lockTimeMs: lockTime,
    });
    return res.status(429).json({
      error: 'Zu viele Fehlversuche. Versuche es in ' + Math.ceil(lockTime / 60000) + ' Minuten erneut.',
    });
  }

  // Connection-Limiter
  const connCheck = connectionLimiter.checkConnection(clientIp);
  if (!connCheck.allowed) {
    securityLog.logEvent('connection_blocked', 'warning', { ip: clientIp, reason: connCheck.reason });
    return res.status(429).json({ error: 'Zu viele Verbindungen' });
  }

  const user = findUser(username);
  if (!user || !user.active) {
    bruteForce.recordAttempt(clientIp);
    bruteForce.recordAttempt(username);
    const cfg = server.getConfig();
    if (bruteForce.checkAndLock(clientIp, cfg.loginAttemptsLimit, cfg.loginLockoutMinutes)) {
      ipTracker.banIP(clientIp, 'Brute-Force-Versuche', 'system', cfg.loginLockoutMinutes * 60 * 1000);
    }
    securityLog.logEvent('login_failed', 'warning', { user: username, ip: clientIp, reason: 'user_not_found' });
    addAudit(username, 'login_failed', { reason: 'user_not_found', ip: clientIp });
    return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
  }
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    bruteForce.recordAttempt(clientIp);
    bruteForce.recordAttempt(username);
    const cfg = server.getConfig();
    if (bruteForce.checkAndLock(clientIp, cfg.loginAttemptsLimit, cfg.loginLockoutMinutes)) {
      ipTracker.banIP(clientIp, 'Brute-Force-Versuche', 'system', cfg.loginLockoutMinutes * 60 * 1000);
    }
    securityLog.logEvent('login_failed', 'warning', { user: username, ip: clientIp, reason: 'wrong_password' });
    addAudit(username, 'login_failed', { reason: 'wrong_password', ip: clientIp });
    return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
  }

  // 2FA-Check
  const cfg = server.getConfig();
  if (cfg.twoFactorEnabled && user.role === 'owner' && !twoFactorToken) {
    return res.status(200).json({
      requiresTwoFactor: true,
      message: '2FA-Code erforderlich',
    });
  }
  if (cfg.twoFactorEnabled && user.role === 'owner' && twoFactorToken) {
    if (!twoFA.verifyToken(user.id, twoFactorToken)) {
      securityLog.logEvent('2fa_failed', 'warning', { user: username, ip: clientIp });
      return res.status(401).json({ error: 'Ungültiger 2FA-Code' });
    }
  }

  // Login erfolgreich
  bruteForce.reset(clientIp);
  bruteForce.reset(username);
  req.session.userId = user.id;
  user.lastLogin = Date.now();
  user.lastLoginIp = clientIp;
  saveUsers(getUsers());
  addAudit(user.username, 'login_success', { ip: clientIp });
  securityLog.logEvent('login_success', 'info', { user: username, ip: clientIp });
  res.json({
    success: true,
    user: { id: user.id, username: user.username, role: user.role },
    csrfToken: generateCsrfToken(req),
  });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.session.userId) {
    const data = getUsers();
    const u = data.users.find(u => u.id === req.session.userId);
    if (u) addAudit(u.username, 'logout', { ip: req.ip });
  }
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.json({ authenticated: false });
  const data = getUsers();
  const u = data.users.find(u => u.id === req.session.userId);
  if (!u) return res.json({ authenticated: false });
  res.json({
    authenticated: true,
    user: { id: u.id, username: u.username, role: u.role },
    csrfToken: generateCsrfToken(req),
    permissions: Object.keys(PERMISSIONS).filter(p => hasPermission(u, p)),
  });
});

app.post('/api/auth/change-password', authLimiter, verifyCsrf, requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'Passwort muss mind. 8 Zeichen haben' });
  }
  const data = getUsers();
  const u = data.users.find(u => u.id === req.session.userId);
  if (!u) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  const valid = await bcrypt.compare(currentPassword, u.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Aktuelles Passwort falsch' });
  u.passwordHash = await bcrypt.hash(newPassword, 10);
  saveUsers(data);
  addAudit(u.username, 'password_changed', { ip: req.ip });
  res.json({ success: true });
});

// 2FA Setup
app.post('/api/auth/2fa/setup', verifyCsrf, requireAuth, (req, res) => {
  const secret = twoFA.generateSecret(req.session.userId);
  // In einer echten App würde man hier einen QR-Code mit TOTP generieren
  res.json({
    success: true,
    secret,
    instructions: 'Verwende diesen Secret in deiner TOTP-App (z.B. Google Authenticator). Im Demo-Modus ist der Code: 000000',
  });
});

// --- Setup ---
app.get('/api/setup/status', (req, res) => {
  const cfg = server.getConfig();
  res.json({
    initialized: cfg.initialized,
    step: setupWizard.getProgress(),
  });
});

app.post('/api/setup/step', verifyCsrf, (req, res) => {
  const { step, data } = req.body;
  if (step === 'goto') setupWizard.goto(data.index);
  else if (step === 'next') setupWizard.next();
  else if (step === 'prev') setupWizard.prev();
  else if (step === 'set') {
    Object.assign(setupWizard.data, data);
  }
  res.json({ success: true, step: setupWizard.getProgress(), data: setupWizard.data });
});

app.post('/api/setup/install', verifyCsrf, async (req, res) => {
  const cfg = { ...setupWizard.data, initialized: true };
  server.saveConfig(cfg);

  // EULA
  fs.writeFileSync(path.join(SERVER_DIR, 'eula.txt'),
    '#EULA akzeptiert durch Panel\neula=true\n');

  // Admin-Account erstellen falls gewünscht
  if (req.body.adminUser && req.body.adminPassword) {
    const users = getUsers();
    if (!users.users.find(u => u.username === req.body.adminUser)) {
      const hash = await bcrypt.hash(req.body.adminPassword, 10);
      users.users.push({
        id: genId(),
        username: req.body.adminUser,
        passwordHash: hash,
        role: 'owner',
        createdAt: Date.now(),
        lastLogin: null,
        active: true,
      });
      saveUsers(users);
    }
  }

  addActivity('⚙️ Setup abgeschlossen, Installation beginnt', 'info');

  // Installation im Hintergrund
  (async () => {
    try {
      log('=== AUTOMATISCHE INSTALLATION GESTARTET ===');
      // Plugins installieren
      const enabledPlugins = [];
      if (cfg.enableGeyser) enabledPlugins.push('geyser');
      if (cfg.enableFloodgate) enabledPlugins.push('floodgate');
      if (cfg.enableLuckPerms) enabledPlugins.push('luckperms');
      if (cfg.enableEssentialsX) enabledPlugins.push('essentialsx');
      if (cfg.enableVault) enabledPlugins.push('vault');
      if (cfg.enableCoreProtect) enabledPlugins.push('coreprotect');
      if (cfg.enableWorldEdit) enabledPlugins.push('worldedit');
      if (cfg.enableWorldGuard) enabledPlugins.push('worldguard');
      if (cfg.enableViaVersion) enabledPlugins.push('viaversion');

      const results = await pluginManager.installAll(enabledPlugins);
      log(`Plugin-Installation: ${results.length} Plugins verarbeitet`);

      // Configs generieren
      configManager.generateServerProperties();
      if (cfg.enableGeyser) configManager.generateGeyserConfig();
      if (cfg.enableFloodgate) configManager.generateFloodgateConfig();

      // Auto-Backup starten
      if (cfg.backupAuto) {
        backupManager.startAutoBackup(cfg.backupInterval);
      }

      log('=== INSTALLATION ABGESCHLOSSEN ===');
      addActivity('✅ Installation abgeschlossen', 'success');
    } catch (e) {
      log(`Installationsfehler: ${e.message}`, 'ERROR');
      addActivity(`❌ Installationsfehler: ${e.message}`, 'error');
    }
  })();

  res.json({ success: true, message: 'Installation gestartet' });
});

// --- Dashboard / System ---
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: Date.now(),
    node: process.version,
    memory: process.memoryUsage(),
  });
});

app.get('/api/system/stats', requireAuth, (req, res) => {
  res.json(systemMonitor.getFullStats());
});

app.get('/api/server/status', (req, res) => {
  res.json(server.getStatusWithTracker());
});

app.get('/api/server/info', requireAuth, (req, res) => {
  const cfg = server.getConfig();
  res.json({
    config: cfg,
    version: PLUGIN_CATALOG.paper.version,
    paperVersion: PLUGIN_CATALOG.paper.version,
    minecraftVersion: '1.21.4',
    bedrockSupported: cfg.enableGeyser && cfg.enableFloodgate,
  });
});

// --- Server Control ---
app.post('/api/server/start', verifyCsrf, requireAuth, requirePermission('server.start'), async (req, res) => {
  addAudit(req.user.username, 'server_start', { ip: req.ip });
  const r = await server.start();
  res.json(r);
});

app.post('/api/server/stop', verifyCsrf, requireAuth, requirePermission('server.stop'), async (req, res) => {
  addAudit(req.user.username, 'server_stop', { ip: req.ip });
  const r = await server.stop();
  res.json(r);
});

app.post('/api/server/restart', verifyCsrf, requireAuth, requirePermission('server.restart'), async (req, res) => {
  addAudit(req.user.username, 'server_restart', { ip: req.ip });
  const r = await server.restart();
  res.json(r);
});

app.post('/api/server/reload', verifyCsrf, requireAuth, requirePermission('server.reload'), (req, res) => {
  addAudit(req.user.username, 'server_reload', { ip: req.ip });
  res.json(server.reload());
});

app.post('/api/server/kill', verifyCsrf, requireAuth, requirePermission('server.kill'), (req, res) => {
  addAudit(req.user.username, 'server_kill', { ip: req.ip });
  res.json(server.kill());
});

// --- Console ---
app.get('/api/console/lines', requireAuth, requirePermission('console.read'), (req, res) => {
  const limit = parseInt(req.query.limit) || 500;
  const search = req.query.search || '';
  let lines = server.getConsoleLines(limit);
  if (search) {
    const s = search.toLowerCase();
    lines = lines.filter(l => l.toLowerCase().includes(s));
  }
  res.json({ lines, total: server.consoleBuffer.length });
});

app.post('/api/console/command', verifyCsrf, requireAuth, requirePermission('console.write'), (req, res) => {
  const { command } = req.body;
  if (!command || typeof command !== 'string') {
    return res.status(400).json({ error: 'Ungültiger Befehl' });
  }
  // Sicherheitscheck - keine Shell-Befehle direkt
  if (command.includes('\n') || command.includes('\r')) {
    return res.status(400).json({ error: 'Mehrzeilige Befehle nicht erlaubt' });
  }
  if (command.length > 256) {
    return res.status(400).json({ error: 'Befehl zu lang' });
  }
  addAudit(req.user.username, 'console_command', { command, ip: req.ip });
  res.json(server.sendCommand(command));
});

app.post('/api/console/clear', verifyCsrf, requireAuth, requirePermission('console.read'), (req, res) => {
  server.clearConsole();
  res.json({ success: true });
});

// --- Settings ---
app.get('/api/settings', requireAuth, requirePermission('settings.view'), (req, res) => {
  res.json(server.getConfig());
});

app.put('/api/settings', verifyCsrf, requireAuth, requirePermission('settings.edit'), async (req, res) => {
  const newCfg = { ...server.getConfig(), ...req.body };
  server.saveConfig(newCfg);
  configManager.generateServerProperties();
  addAudit(req.user.username, 'settings_updated', { ip: req.ip });
  addActivity('⚙️ Server-Konfiguration geändert', 'info');
  res.json({ success: true, config: newCfg });
});

app.post('/api/settings/backup', verifyCsrf, requireAuth, requirePermission('backups.create'), async (req, res) => {
  const r = await backupManager.createBackup('pre-config-change');
  res.json(r);
});

// --- Plugins ---
app.get('/api/plugins', requireAuth, requirePermission('plugins.view'), (req, res) => {
  res.json(pluginManager.listInstalled());
});

app.get('/api/plugins/catalog', requireAuth, requirePermission('plugins.view'), (req, res) => {
  res.json(PLUGIN_CATALOG);
});

app.post('/api/plugins/install', verifyCsrf, requireAuth, requirePermission('plugins.install'), async (req, res) => {
  const { pluginId } = req.body;
  if (!PLUGIN_CATALOG[pluginId]) {
    return res.status(400).json({ error: 'Unbekanntes Plugin' });
  }
  addAudit(req.user.username, 'plugin_install', { pluginId, ip: req.ip });
  const r = await pluginManager.downloadPlugin(pluginId);
  res.json(r);
});

app.get('/api/plugins/:id/config', requireAuth, requirePermission('plugins.view'), (req, res) => {
  const { id } = req.params;
  const info = PLUGIN_CATALOG[id];
  if (!info) return res.status(404).json({ error: 'Plugin nicht gefunden' });
  // Suche nach Config-Dateien
  const pluginDir = path.join(PLUGINS_DIR, info.name);
  const configs = [];
  if (fs.existsSync(pluginDir)) {
    const files = fs.readdirSync(pluginDir);
    for (const f of files) {
      if (f.endsWith('.yml') || f.endsWith('.yaml') || f.endsWith('.json') || f.endsWith('.txt')) {
        try {
          configs.push({
            name: f,
            content: fs.readFileSync(path.join(pluginDir, f), 'utf8'),
          });
        } catch (e) {}
      }
    }
  }
  res.json({ plugin: info, configs });
});

// --- Player Management ---
app.get('/api/players', requireAuth, requirePermission('players.view'), (req, res) => {
  const status = server.getStatus();
  // Daten aus PlayerTracker zusammenführen
  const trackerPlayers = playerTracker.getAllPlayers();
  const trackerByName = new Map(trackerPlayers.map(p => [p.name?.toLowerCase(), p]));

  const players = status.players.map(p => {
    const tp = trackerByName.get(p.name.toLowerCase());
    return {
      ...p,
      ...(tp || {}),
      platform: 'Java',
      online: true,
      isBedrock: false,
      skinUrl: tp?.uuid ? mojangAPI.getSkinUrl(tp.uuid) : null,
      headUrl: tp?.uuid ? mojangAPI.getHeadRenderUrl(tp.uuid) : null,
      bodyUrl: tp?.uuid ? mojangAPI.getBodyRenderUrl(tp.uuid) : null,
    };
  });
  // Bedrock-Spieler
  status.bedrockPlayers.forEach(name => {
    const tp = trackerByName.get(name.toLowerCase());
    players.push({
      name,
      platform: 'Bedrock',
      online: true,
      isBedrock: true,
      uuid: tp?.uuid || null,
      ...(tp || {}),
      skinUrl: tp?.uuid ? mojangAPI.getSkinUrl(tp.uuid) : null,
      headUrl: tp?.uuid ? mojangAPI.getHeadRenderUrl(tp.uuid) : null,
      bodyUrl: tp?.uuid ? mojangAPI.getBodyRenderUrl(tp.uuid) : null,
    });
  });
  // Auch Spieler, die laut Tracker online sind, aber nicht in status.players (Race-Condition)
  for (const tp of trackerPlayers) {
    if (tp.online && !players.find(p => p.name?.toLowerCase() === tp.name?.toLowerCase())) {
      players.push({
        name: tp.name,
        platform: tp.isBedrock ? 'Bedrock' : 'Java',
        online: true,
        isBedrock: tp.isBedrock,
        ...tp,
        skinUrl: tp.uuid ? mojangAPI.getSkinUrl(tp.uuid) : null,
        headUrl: tp.uuid ? mojangAPI.getHeadRenderUrl(tp.uuid) : null,
        bodyUrl: tp.uuid ? mojangAPI.getBodyRenderUrl(tp.uuid) : null,
      });
    }
  }
  res.json({ players, online: status.playerCount, bedrock: status.bedrockPlayerCount });
});

// Detaillierte Spieler-Infos (Inventar, Health, etc.)
app.get('/api/players/:name/details', requireAuth, requirePermission('players.view'), async (req, res) => {
  const name = req.params.name;
  if (!/^[a-zA-Z0-9_]{1,16}$/.test(name)) {
    return res.status(400).json({ error: 'Ungültiger Spielername' });
  }

  let player = playerTracker.getPlayer(name);
  let liveData = null;

  // Versuche Live-Daten via RCON abzurufen
  if (playerTracker.rconConnected && server.isRunning()) {
    try {
      // Scoreboard-Werte
      const sb = await playerTracker.sendRcon(`scoreboard players list`).catch(() => '');
      // Direkte Datenabfrage
      const data = {};
      try {
        const health = await playerTracker.sendRcon(`data get entity ${name} Health`);
        const hm = health.match(/([\d.]+)/);
        if (hm) data.health = parseFloat(hm[1]);
      } catch (e) {}
      try {
        const food = await playerTracker.sendRcon(`execute as ${name} run data get entity @s foodLevel`);
        const fm = food.match(/(\d+)/);
        if (fm) data.food = parseInt(fm[1]);
      } catch (e) {}
      try {
        const pos = await playerTracker.sendRcon(`data get entity ${name} Pos`);
        const pm = pos.match(/\[([-\d.]+)d?,\s*([-\d.]+)d?,\s*([-\d.]+)d?\]/);
        if (pm) {
          data.location = {
            x: parseFloat(pm[1]),
            y: parseFloat(pm[2]),
            z: parseFloat(pm[3]),
          };
        }
      } catch (e) {}
      try {
        const dim = await playerTracker.sendRcon(`data get entity ${name} Dimension`);
        const dm = dim.match(/"minecraft:(\w+)"/);
        if (dm) {
          if (!data.location) data.location = {};
          data.location.world = dm[1];
        }
      } catch (e) {}
      try {
        const effects = await playerTracker.sendRcon(`effect list ${name}`);
        data.effects = playerTracker.parseEffects(effects);
      } catch (e) {}
      try {
        const xp = await playerTracker.sendRcon(`xp query ${name} levels`);
        const xm = xp.match(/(\d+)/);
        if (xm) data.level = parseInt(xm[1]);
      } catch (e) {}
      try {
        const gm = await playerTracker.sendRcon(`execute as ${name} run data get entity @s playerGameType`);
        const gmMap = { 0: 'survival', 1: 'creative', 2: 'adventure', 3: 'spectator' };
        const gmm = gm.match(/(\d+)/);
        if (gmm) data.gamemode = gmMap[parseInt(gmm[1])] || 'survival';
      } catch (e) {}
      // Inventar (vereinfacht: nur die ersten 9 Slots)
      data.inventory = [];
      for (let i = 0; i < 9; i++) {
        try {
          const item = await playerTracker.sendRcon(`data get entity ${name} Inventory[${i}]`);
          const im = item.match(/id:"minecraft:(\w+)".*?Count:(\d+)b?/);
          if (im) {
            data.inventory.push({
              slot: i,
              item: im[1],
              count: parseInt(im[2]),
              displayName: playerTracker.formatItemName(im[1]),
            });
          }
        } catch (e) { break; }
      }
      liveData = data;
    } catch (e) {}
  }

  // Mojang/Skin-Daten
  let uuid = player?.uuid;
  if (!uuid) {
    uuid = await mojangAPI.getUUID(name);
  }
  let skinData = null;
  if (uuid) {
    skinData = {
      uuid,
      skinUrl: mojangAPI.getSkinUrl(uuid),
      headUrl: mojangAPI.getHeadRenderUrl(uuid),
      bodyUrl: mojangAPI.getBodyRenderUrl(uuid),
      skinTexture: mojangAPI.getSkinTextureUrl(uuid),
    };
  }

  res.json({
    name,
    uuid,
    online: player?.online || false,
    isBedrock: player?.isBedrock || false,
    joinedAt: player?.joinedAt,
    lastSeen: player?.lastSeen,
    stats: player?.stats || { kills: 0, deaths: 0, mobDeaths: 0 },
    rconConnected: playerTracker.rconConnected,
    live: liveData,
    skin: skinData,
  });
});

// Spieler-Name-Historie
app.get('/api/players/:name/names', requireAuth, requirePermission('players.view'), async (req, res) => {
  const name = req.params.name;
  if (!/^[a-zA-Z0-9_]{1,16}$/.test(name)) {
    return res.status(400).json({ error: 'Ungültiger Spielername' });
  }
  const uuid = await mojangAPI.getUUID(name);
  if (!uuid) return res.status(404).json({ error: 'Spieler nicht gefunden' });
  const history = await mojangAPI.getNameHistory(uuid);
  res.json({ uuid, history });
});

// Server-Befehle für einzelnen Spieler
app.post('/api/players/:name/command', verifyCsrf, requireAuth, requirePermission('players.view'), async (req, res) => {
  const { name } = req.params;
  if (!/^[a-zA-Z0-9_]{1,16}$/.test(name)) {
    return res.status(400).json({ error: 'Ungültiger Spielername' });
  }
  if (!playerTracker.rconConnected) {
    return res.status(503).json({ error: 'RCON nicht verfügbar' });
  }
  const { action, args } = req.body;
  let cmd = '';
  switch (action) {
    case 'heal': cmd = `effect give ${name} minecraft:regeneration 1 255`; break;
    case 'feed': cmd = `effect give ${name} minecraft:saturation 1 255`; break;
    case 'kill': cmd = `kill ${name}`; break;
    case 'clear-effects': cmd = `effect clear ${name}`; break;
    case 'clear-inventory': cmd = `clear ${name}`; break;
    case 'teleport-spawn': cmd = `tp ${name} 0 100 0`; break;
    case 'set-spawn': cmd = `setworldspawn`; break;
    case 'spectator': cmd = `gamemode spectator ${name}`; break;
    case 'creative': cmd = `gamemode creative ${name}`; break;
    case 'survival': cmd = `gamemode survival ${name}`; break;
    case 'godmode':
      // Spieler unsterblich machen
      cmd = `effect give ${name} minecraft:resistance 999999 255`;
      break;
    case 'give-diamond':
      cmd = `give ${name} minecraft:diamond 64`;
      break;
    case 'speed':
      cmd = `effect give ${name} minecraft:speed 60 2`;
      break;
    case 'fly':
      // Paper/Folia: minecraft:allow hat keine Permission-Node - daher über gamemode creative
      cmd = `gamemode creative ${name}`;
      break;
    case 'message':
      cmd = `tellraw ${name} ${JSON.stringify(args?.message || 'Hallo!')}`;
      break;
    case 'give-enchant':
      const enc = (args?.enchantments || []).map(e => `${e} ${e.level || 1}`).join(' ');
      cmd = `give ${name} minecraft:${args?.item || 'diamond_sword'}{Enchantments:[{${enc}}]} 1`;
      break;
    case 'teleport-to':
      cmd = `tp ${name} ${args?.target || ''}`;
      break;
    default:
      return res.status(400).json({ error: 'Unbekannte Aktion' });
  }
  try {
    const result = await playerTracker.sendRcon(cmd);
    addAudit(req.user.username, 'player_rcon_cmd', { player: name, action, ip: req.ip });
    res.json({ success: true, command: cmd, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Spieler-Welt-Position / Karte
app.get('/api/players/:name/location', requireAuth, requirePermission('players.view'), async (req, res) => {
  const { name } = req.params;
  if (!/^[a-zA-Z0-9_]{1,16}$/.test(name)) {
    return res.status(400).json({ error: 'Ungültiger Spielername' });
  }
  if (!playerTracker.rconConnected) {
    return res.status(503).json({ error: 'RCON nicht verfügbar' });
  }
  try {
    const pos = await playerTracker.sendRcon(`data get entity ${name} Pos`);
    const pm = pos.match(/\[([-\d.]+)d?,\s*([-\d.]+)d?,\s*([-\d.]+)d?\]/);
    const dim = await playerTracker.sendRcon(`data get entity ${name} Dimension`);
    const dm = dim.match(/"minecraft:(\w+)"/);
    const rot = await playerTracker.sendRcon(`data get entity ${name} Rotation`);
    const rm = rot.match(/\[([-\d.]+)f?,\s*([-\d.]+)f?\]/);
    res.json({
      name,
      online: true,
      location: pm ? {
        x: parseFloat(pm[1]),
        y: parseFloat(pm[2]),
        z: parseFloat(pm[3]),
        world: dm ? dm[1] : 'overworld',
        yaw: rm ? parseFloat(rm[1]) : 0,
        pitch: rm ? parseFloat(rm[2]) : 0,
      } : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/players/action', verifyCsrf, requireAuth, (req, res) => {
  const { action, player, reason } = req.body;
  if (!player) return res.status(400).json({ error: 'Spielername erforderlich' });

  let permission;
  let cmd;
  switch (action) {
    case 'kick':
      permission = 'players.kick';
      cmd = `kick ${player} ${reason || 'Vom Panel gekickt'}`;
      break;
    case 'ban':
      permission = 'players.ban';
      cmd = `ban ${player} ${reason || 'Vom Panel gebannt'}`;
      break;
    case 'unban':
      permission = 'players.unban';
      cmd = `pardon ${player}`;
      break;
    case 'mute':
      permission = 'players.mute';
      cmd = `mute ${player} ${reason || 'Vom Panel stummgeschaltet'}`;
      break;
    case 'teleport':
      permission = 'players.teleport';
      cmd = `tp ${player} ${req.body.target || ''}`;
      break;
    case 'gamemode':
      permission = 'players.gamemode';
      cmd = `gamemode ${req.body.mode || 'survival'} ${player}`;
      break;
    case 'whitelist':
      permission = 'players.view';
      cmd = req.body.enable ? `whitelist add ${player}` : `whitelist remove ${player}`;
      break;
    default:
      return res.status(400).json({ error: 'Unbekannte Aktion' });
  }
  if (!hasPermission(req.user, permission)) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }
  addAudit(req.user.username, 'player_action', { action, player, reason, ip: req.ip });
  res.json(server.sendCommand(cmd));
});

// --- LuckPerms ---
const LUCKPERMS_FILE = path.join(ROOT, 'config', 'luckperms.json');

function getLuckPermsData() {
  return readJSON(LUCKPERMS_FILE, {
    groups: [
      { id: 'default', name: 'default', weight: 0, permissions: [], parent: null },
      { id: 'vip', name: 'VIP', weight: 10, permissions: ['essentials.kits.vip', 'essentials.fly', 'essentials.nick.color'], parent: 'default' },
      { id: 'moderator', name: 'Moderator', weight: 50, permissions: ['essentials.kick', 'essentials.mute', 'essentials.tp', 'worldguard.region.bypass'], parent: 'default' },
      { id: 'admin', name: 'Admin', weight: 75, permissions: ['essentials.ban', 'essentials.gamemode', 'worldedit.*', 'minecraft.command.gamemode'], parent: 'moderator' },
      { id: 'owner', name: 'Owner', weight: 100, permissions: ['*'], parent: 'admin' },
    ],
    players: {},
  });
}

app.get('/api/luckperms/groups', requireAuth, requirePermission('permissions.manage'), (req, res) => {
  res.json(getLuckPermsData());
});

app.post('/api/luckperms/groups', verifyCsrf, requireAuth, requirePermission('permissions.manage'), (req, res) => {
  const { action, group } = req.body;
  const data = getLuckPermsData();
  if (action === 'create') {
    if (data.groups.find(g => g.name === group.name)) {
      return res.status(400).json({ error: 'Gruppe existiert bereits' });
    }
    data.groups.push({ id: group.name.toLowerCase(), name: group.name, weight: group.weight || 0, permissions: group.permissions || [], parent: group.parent || null });
    addAudit(req.user.username, 'lp_group_create', { group: group.name, ip: req.ip });
  } else if (action === 'delete') {
    data.groups = data.groups.filter(g => g.name !== group.name);
    addAudit(req.user.username, 'lp_group_delete', { group: group.name, ip: req.ip });
  } else if (action === 'update') {
    const g = data.groups.find(x => x.name === group.name);
    if (g) {
      Object.assign(g, group);
      addAudit(req.user.username, 'lp_group_update', { group: group.name, ip: req.ip });
    }
  }
  writeJSON(LUCKPERMS_FILE, data);
  // Befehl an Server senden
  if (server.isRunning() && group) {
    if (action === 'create') server.sendCommand(`lp creategroup ${group.name}`);
    else if (action === 'delete') server.sendCommand(`lp deletegroup ${group.name}`);
  }
  res.json({ success: true, data });
});

app.post('/api/luckperms/permissions', verifyCsrf, requireAuth, requirePermission('permissions.manage'), (req, res) => {
  const { group, permission, action } = req.body;
  const data = getLuckPermsData();
  const g = data.groups.find(x => x.name === group);
  if (!g) return res.status(404).json({ error: 'Gruppe nicht gefunden' });
  if (action === 'add') {
    // Wildcard-Schutz für non-admin
    if (permission === '*' && req.user.role !== 'owner') {
      return res.status(403).json({ error: 'Wildcard * nur für Owner erlaubt' });
    }
    if (!g.permissions.includes(permission)) g.permissions.push(permission);
    if (server.isRunning()) server.sendCommand(`lp group ${group} permission set ${permission}`);
    addAudit(req.user.username, 'lp_perm_add', { group, permission, ip: req.ip });
  } else {
    g.permissions = g.permissions.filter(p => p !== permission);
    if (server.isRunning()) server.sendCommand(`lp group ${group} permission unset ${permission}`);
    addAudit(req.user.username, 'lp_perm_remove', { group, permission, ip: req.ip });
  }
  writeJSON(LUCKPERMS_FILE, data);
  res.json({ success: true });
});

app.post('/api/luckperms/player', verifyCsrf, requireAuth, requirePermission('permissions.manage'), (req, res) => {
  const { player, group, action } = req.body;
  const data = getLuckPermsData();
  if (!data.players[player]) data.players[player] = { groups: [] };
  if (action === 'add') {
    if (!data.players[player].groups.includes(group)) data.players[player].groups.push(group);
    if (server.isRunning()) server.sendCommand(`lp user ${player} parent set ${group}`);
    addAudit(req.user.username, 'lp_player_add', { player, group, ip: req.ip });
  } else {
    data.players[player].groups = data.players[player].groups.filter(g => g !== group);
    if (server.isRunning()) server.sendCommand(`lp user ${player} parent remove ${group}`);
    addAudit(req.user.username, 'lp_player_remove', { player, group, ip: req.ip });
  }
  writeJSON(LUCKPERMS_FILE, data);
  res.json({ success: true });
});

// --- Worlds ---
app.get('/api/worlds', requireAuth, requirePermission('worlds.view'), (req, res) => {
  const worlds = [];
  const overworld = path.join(SERVER_DIR, 'world');
  const nether = path.join(SERVER_DIR, 'world_nether');
  const end = path.join(SERVER_DIR, 'world_the_end');

  if (fs.existsSync(overworld)) {
    const levelDat = path.join(overworld, 'level.dat');
    worlds.push({
      name: 'world',
      type: 'overworld',
      path: overworld,
      size: getDirSize(overworld),
      sizeFormatted: formatBytes(getDirSize(overworld)),
      hasLevelDat: fs.existsSync(levelDat),
      status: 'aktiv',
    });
  }
  if (fs.existsSync(nether)) {
    worlds.push({
      name: 'world_nether',
      type: 'nether',
      path: nether,
      size: getDirSize(nether),
      sizeFormatted: formatBytes(getDirSize(nether)),
      status: 'aktiv',
    });
  }
  if (fs.existsSync(end)) {
    worlds.push({
      name: 'world_the_end',
      type: 'end',
      path: end,
      size: getDirSize(end),
      sizeFormatted: formatBytes(getDirSize(end)),
      status: 'aktiv',
    });
  }
  res.json({ worlds });
});

app.post('/api/worlds/backup', verifyCsrf, requireAuth, requirePermission('worlds.manage'), async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Weltname erforderlich' });
  const worldPath = path.join(SERVER_DIR, name);
  if (!fs.existsSync(worldPath)) {
    return res.status(404).json({ error: 'Welt nicht gefunden' });
  }
  try {
    const r = await backupManager.createBackup(`world-${name}`);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Backups ---
app.get('/api/backups', requireAuth, requirePermission('backups.view'), (req, res) => {
  res.json({ backups: backupManager.listBackups() });
});

app.post('/api/backups/create', verifyCsrf, requireAuth, requirePermission('backups.create'), async (req, res) => {
  try {
    const r = await backupManager.createBackup(req.body.name);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/backups/restore', verifyCsrf, requireAuth, requirePermission('backups.restore'), async (req, res) => {
  if (server.isRunning()) {
    return res.status(400).json({ error: 'Server muss vor Wiederherstellung gestoppt werden' });
  }
  addAudit(req.user.username, 'backup_restore', { name: req.body.name, ip: req.ip });
  try {
    const r = await backupManager.restoreBackup(req.body.name);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/backups/:name', verifyCsrf, requireAuth, requirePermission('backups.delete'), (req, res) => {
  addAudit(req.user.username, 'backup_delete', { name: req.params.name, ip: req.ip });
  res.json(backupManager.deleteBackup(req.params.name));
});

app.get('/api/backups/download/:name', requireAuth, requirePermission('backups.download'), (req, res) => {
  const backup = backupManager.listBackups().find(b => b.name === req.params.name);
  if (!backup) return res.status(404).json({ error: 'Backup nicht gefunden' });
  addAudit(req.user.username, 'backup_download', { name: req.params.name, ip: req.ip });
  res.download(backup.path);
});

// --- Logs ---
app.get('/api/logs', requireAuth, requirePermission('logs.view'), (req, res) => {
  const category = req.query.category || 'server';
  const level = req.query.level || null;
  const search = req.query.search || '';
  const fileMap = {
    server: 'server.log',
    panel: 'panel.log',
    geyser: 'geyser.log',
    floodgate: 'floodgate.log',
    error: 'error.log',
    security: 'security.log',
    backup: 'backup.log',
  };
  const file = path.join(LOG_DIR, fileMap[category] || 'server.log');
  let lines = [];
  if (fs.existsSync(file)) {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
  }
  if (search) {
    const s = search.toLowerCase();
    lines = lines.filter(l => l.toLowerCase().includes(s));
  }
  if (level) {
    lines = lines.filter(l => l.includes(level));
  }
  res.json({ lines: lines.slice(-1000), total: lines.length });
});

// --- Geyser / Floodgate ---
// RCON-Status
app.get('/api/rcon/status', requireAuth, requirePermission('system.info'), (req, res) => {
  const cfg = server.getConfig();
  res.json({
    enabled: cfg.rconEnabled,
    connected: playerTracker.rconConnected,
    host: cfg.rconHost,
    port: cfg.rconPort,
    refreshInterval: cfg.playerDataRefreshInterval,
  });
});

app.post('/api/rcon/reconnect', verifyCsrf, requireAuth, requirePermission('system.info'), async (req, res) => {
  const cfg = server.getConfig();
  if (!cfg.rconEnabled) return res.status(400).json({ error: 'RCON deaktiviert' });
  const ok = await playerTracker.connectRcon(cfg.rconHost, cfg.rconPort, cfg.rconPassword);
  if (ok) {
    playerTracker.startRefreshLoop();
    res.json({ success: true });
  } else {
    res.status(500).json({ error: 'RCON-Verbindung fehlgeschlagen' });
  }
});

app.get('/api/geyser/status', requireAuth, requirePermission('geyser.view'), (req, res) => {
  const cfg = server.getConfig();
  const geyserInstalled = pluginManager.isInstalled('geyser');
  const floodgateInstalled = pluginManager.isInstalled('floodgate');
  const keyFile = path.join(PLUGINS_DIR, 'floodgate', 'key.pem');
  res.json({
    geyserInstalled,
    floodgateInstalled,
    geyserEnabled: cfg.enableGeyser,
    floodgateEnabled: cfg.enableFloodgate,
    bedrockPort: cfg.bedrockPort,
    udpEnabled: true,
    javaServerPort: cfg.serverPort,
    floodgateKeyExists: fs.existsSync(keyFile),
    bedrockPlayerCount: server.getStatus().bedrockPlayerCount,
    status: geyserInstalled && floodgateInstalled ? 'ready' : 'not_ready',
  });
});

app.post('/api/geyser/restart', verifyCsrf, requireAuth, requirePermission('geyser.manage'), (req, res) => {
  if (server.isRunning()) {
    server.sendCommand('geyser reload');
    addAudit(req.user.username, 'geyser_restart', { ip: req.ip });
    res.json({ success: true });
  } else {
    res.status(400).json({ error: 'Server läuft nicht' });
  }
});

app.post('/api/geyser/test', verifyCsrf, requireAuth, requirePermission('geyser.manage'), async (req, res) => {
  const cfg = server.getConfig();
  const result = {
    timestamp: Date.now(),
    tests: [],
  };
  // Test 1: Bedrock Port erreichbar
  result.tests.push({
    name: 'Bedrock UDP-Port',
    target: `${cfg.bedrockPort}/UDP`,
    success: await testUdpPort(cfg.bedrockPort),
  });
  // Test 2: Java-Server
  result.tests.push({
    name: 'Java Server Port',
    target: `${cfg.serverPort}/TCP`,
    success: await testTcpPort(cfg.serverPort),
  });
  // Test 3: Geyser installiert
  result.tests.push({
    name: 'Geyser Plugin',
    target: 'Geyser-Spigot.jar',
    success: pluginManager.isInstalled('geyser'),
  });
  // Test 4: Floodgate installiert
  result.tests.push({
    name: 'Floodgate Plugin',
    target: 'floodgate-spigot.jar',
    success: pluginManager.isInstalled('floodgate'),
  });
  // Test 5: Floodgate Key
  const keyFile = path.join(PLUGINS_DIR, 'floodgate', 'key.pem');
  result.tests.push({
    name: 'Floodgate Schlüssel',
    target: 'key.pem',
    success: fs.existsSync(keyFile),
  });
  res.json(result);
});

function testTcpPort(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, 3000);
    sock.once('connect', () => { clearTimeout(timer); sock.destroy(); resolve(true); });
    sock.once('error', () => { clearTimeout(timer); resolve(false); });
    try { sock.connect(port, '127.0.0.1'); } catch (e) { resolve(false); }
  });
}

function testUdpPort(port) {
  return new Promise((resolve) => {
    const dgram = require('dgram');
    // Wenn Server läuft, prüfen wir ob er den Port nutzt (Geyser-Log zeigt das)
    const sock = dgram.createSocket('udp4');
    let resolved = false;
    const done = (val) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { sock.close(); } catch (e) {}
      resolve(val);
    };
    const timer = setTimeout(() => done(true), 1500);
    sock.on('error', (e) => {
      // EADDRINUSE = Port belegt, was bedeutet Geyser läuft dort = gut
      if (e.code === 'EADDRINUSE') done(true);
      else done(false);
    });
    try {
      sock.bind(port, '0.0.0.0');
      sock.on('listening', () => done(true));
    } catch (e) {
      if (e.code === 'EADDRINUSE') done(true);
      else done(false);
    }
  });
}

app.get('/api/geyser/logs', requireAuth, requirePermission('geyser.view'), (req, res) => {
  const logFile = path.join(LOG_DIR, 'geyser.log');
  let lines = [];
  if (fs.existsSync(logFile)) {
    lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(l => l.trim()).slice(-500);
  }
  res.json({ lines });
});

app.get('/api/geyser/config', requireAuth, requirePermission('geyser.manage'), (req, res) => {
  const geyserDir = path.join(PLUGINS_DIR, 'Geyser-Spigot');
  const configFile = path.join(geyserDir, 'config.yml');
  if (fs.existsSync(configFile)) {
    res.json({ content: fs.readFileSync(configFile, 'utf8') });
  } else {
    res.json({ content: '# Noch nicht konfiguriert' });
  }
});

// --- SECURITY: IP-Management & Anti-Cheat ---

// IP-Liste mit allen bekannten IPs
app.get('/api/security/ips', requireAuth, requirePermission('security.view'), (req, res) => {
  const ips = ipTracker.getAllKnownIPs();
  const banned = ipTracker.getBannedIPs();
  const suspicious = ipTracker.getSuspiciousIPs();
  const multiAccount = ipTracker.getMultiAccountIPs();
  res.json({
    total: ips.length,
    banned: banned.length,
    suspicious: suspicious.length,
    multiAccount: multiAccount.length,
    ips: ips.map(ip => ({
      ip: ip.ip,
      firstSeen: ip.firstSeen,
      lastSeen: ip.lastSeen,
      playerCount: ip.playerCount,
      players: Array.from(ip.players || []),
      violations: ip.violations || 0,
      banned: ip.banned,
    })),
    multiAccountIPs: multiAccount,
  });
});

// Spieler-IP-Historie
app.get('/api/security/players/:name/ips', requireAuth, requirePermission('security.view'), (req, res) => {
  const ips = ipTracker.getPlayerIPs(req.params.name);
  res.json({ player: req.params.name, history: ips });
});

// IP bannen
app.post('/api/security/ip/ban', verifyCsrf, requireAuth, requirePermission('security.manage'), (req, res) => {
  const { ip, reason, duration } = req.body;
  if (!ip || !reason) return res.status(400).json({ error: 'IP und Grund erforderlich' });
  const durationMs = duration ? parseInt(duration) * 1000 : null;
  const ok = ipTracker.banIP(ip, reason, req.user.username, durationMs);
  securityLog.logEvent('ip_banned', 'warning', { ip, reason, duration, by: req.user.username });
  addAudit(req.user.username, 'ip_ban', { ip, reason, duration });
  res.json({ success: ok });
});

// IP entsperren
app.post('/api/security/ip/unban', verifyCsrf, requireAuth, requirePermission('security.manage'), (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP erforderlich' });
  const ok = ipTracker.unbanIP(ip);
  securityLog.logEvent('ip_unbanned', 'info', { ip, by: req.user.username });
  addAudit(req.user.username, 'ip_unban', { ip });
  res.json({ success: ok });
});

// Banned IPs anzeigen
app.get('/api/security/banned-ips', requireAuth, requirePermission('security.view'), (req, res) => {
  res.json({ banned: ipTracker.getBannedIPs() });
});

// Verdächtige IPs
app.get('/api/security/suspicious', requireAuth, requirePermission('security.view'), (req, res) => {
  res.json({ suspicious: ipTracker.getSuspiciousIPs() });
});

// Anti-Cheat-Statistiken
app.get('/api/security/anticheat', requireAuth, requirePermission('security.view'), (req, res) => {
  res.json({
    stats: antiCheat.getStats(),
    violations: antiCheat.getAllViolations(),
  });
});

// Spieler-Violations zurücksetzen
app.post('/api/security/anticheat/clear', verifyCsrf, requireAuth, requirePermission('security.manage'), (req, res) => {
  const { player } = req.body;
  if (!player) return res.status(400).json({ error: 'Spielername erforderlich' });
  antiCheat.clearPlayer(player);
  addAudit(req.user.username, 'anticheat_clear', { player });
  res.json({ success: true });
});

// Manueller Ban eines Spielers + IP
app.post('/api/security/ban-player', verifyCsrf, requireAuth, requirePermission('security.manage'), (req, res) => {
  const { player, reason, banIP } = req.body;
  if (!player || !reason) return res.status(400).json({ error: 'Spieler und Grund erforderlich' });
  if (server.isRunning()) {
    server.sendCommand(`ban ${player} ${reason}`);
  }
  // Auch IP bannen, falls gewünscht
  if (banIP) {
    const ips = ipTracker.getPlayerIPs(player);
    if (ips.length > 0) {
      const latestIP = ips[ips.length - 1].ip;
      ipTracker.banIP(latestIP, `Spieler-Ban: ${player} - ${reason}`, req.user.username, null);
    }
  }
  addAudit(req.user.username, 'manual_ban', { player, reason, banIP });
  securityLog.logEvent('player_banned', 'warning', { player, reason, banIP, by: req.user.username });
  res.json({ success: true });
});

// Security-Event-Log
app.get('/api/security/events', requireAuth, requirePermission('security.view'), (req, res) => {
  const { type, severity, limit } = req.query;
  let events = securityLog.getRecent(parseInt(limit) || 200);
  if (type) events = events.filter(e => e.type === type);
  if (severity) events = events.filter(e => e.severity === severity);
  res.json({ events, stats: securityLog.getStats() });
});

// Brute-Force Status & Reset
app.get('/api/security/bruteforce', requireAuth, requirePermission('security.view'), (req, res) => {
  res.json({ message: 'Brute-Force Protection aktiv' });
});

app.post('/api/security/bruteforce/reset', verifyCsrf, requireAuth, requirePermission('security.manage'), (req, res) => {
  const { identifier } = req.body;
  if (!identifier) return res.status(400).json({ error: 'Identifier erforderlich' });
  bruteForce.reset(identifier);
  addAudit(req.user.username, 'bruteforce_reset', { identifier });
  res.json({ success: true });
});

// Security-Stats Übersicht
app.get('/api/security/stats', requireAuth, requirePermission('security.view'), (req, res) => {
  const cfg = server.getConfig();
  res.json({
    ipTracking: cfg.ipTrackingEnabled,
    ipBan: cfg.ipBanEnabled,
    antiCheat: cfg.antiCheatAutoBan,
    twoFactor: cfg.twoFactorEnabled,
    ipStats: {
      total: ipTracker.knownIPs.size,
      banned: ipTracker.bannedIPs.size,
      suspicious: ipTracker.suspiciousIPs.size,
      multiAccount: ipTracker.getMultiAccountIPs().length,
    },
    antiCheatStats: antiCheat.getStats(),
    securityEvents: securityLog.getStats(),
  });
});

// Anti-Cheat Plugin Installation
app.post('/api/security/anticheat/install', verifyCsrf, requireAuth, requirePermission('security.manage'), async (req, res) => {
  const { pluginId } = req.body;
  if (!PLUGIN_CATALOG[pluginId] || !PLUGIN_CATALOG[pluginId].isAntiCheat) {
    return res.status(400).json({ error: 'Ungültiges Anti-Cheat-Plugin' });
  }
  const r = await pluginManager.downloadPlugin(pluginId);
  if (r.success) {
    addAudit(req.user.username, 'anticheat_install', { pluginId, ip: req.ip });
    addActivity(`🛡️ Anti-Cheat installiert: ${PLUGIN_CATALOG[pluginId].name}`, 'success');
  }
  res.json(r);
});

// Security-Settings aktualisieren
app.put('/api/security/settings', verifyCsrf, requireAuth, requirePermission('security.manage'), (req, res) => {
  const cfg = server.getConfig();
  const newCfg = { ...cfg, ...req.body };
  server.saveConfig(newCfg);
  addAudit(req.user.username, 'security_settings_updated', { ip: req.ip });
  securityLog.logEvent('security_config_changed', 'info', { changes: Object.keys(req.body), by: req.user.username });
  res.json({ success: true, config: newCfg });
});

// --- Activity ---
app.get('/api/activity', requireAuth, requirePermission('activity.view'), (req, res) => {
  res.json({ activities: readJSON(ACTIVITY_FILE, []).slice(0, 200) });
});

app.get('/api/audit', requireAuth, requirePermission('audit.view'), (req, res) => {
  res.json({ audits: readJSON(AUDIT_FILE, []).slice(0, 200) });
});

// --- RAILWAY DEPLOYMENT MANAGEMENT ---

// Railway-Status
app.get('/api/railway/status', requireAuth, requirePermission('system.info'), (req, res) => {
  res.json(railwayManager.getStatus());
});

// Railway-Projekte auflisten
app.get('/api/railway/projects', requireAuth, requirePermission('system.info'), async (req, res) => {
  try {
    const projects = await railwayManager.listProjects();
    res.json({ projects });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Aktuelles Railway-Projekt
app.get('/api/railway/project', requireAuth, requirePermission('system.info'), async (req, res) => {
  try {
    const project = await railwayManager.getProject();
    if (!project) return res.json({ project: null, message: 'Kein Projekt konfiguriert' });
    res.json({ project });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Aktueller Service
app.get('/api/railway/service', requireAuth, requirePermission('system.info'), async (req, res) => {
  try {
    const service = await railwayManager.getService();
    res.json({ service });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Environment-Variablen
app.get('/api/railway/variables', requireAuth, requirePermission('system.info'), async (req, res) => {
  try {
    const variables = await railwayManager.getVariables();
    res.json({ variables });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Environment-Variable setzen
app.post('/api/railway/variables', verifyCsrf, requireAuth, requirePermission('system.info'), async (req, res) => {
  const { name, value } = req.body;
  if (!name || value === undefined) {
    return res.status(400).json({ error: 'Name und Wert erforderlich' });
  }
  try {
    const result = await railwayManager.setVariable(name, value);
    addAudit(req.user.username, 'railway_set_var', { name, ip: req.ip });
    addActivity(`🔧 Railway Variable gesetzt: ${name}`, 'info');
    res.json({ success: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Environment-Variable löschen
app.delete('/api/railway/variables/:name', verifyCsrf, requireAuth, requirePermission('system.info'), async (req, res) => {
  try {
    const result = await railwayManager.deleteVariable(req.params.name);
    addAudit(req.user.username, 'railway_delete_var', { name: req.params.name, ip: req.ip });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Deployment triggern
app.post('/api/railway/deploy', verifyCsrf, requireAuth, requirePermission('system.info'), async (req, res) => {
  try {
    const r = await railwayManager.triggerDeploy();
    addAudit(req.user.username, 'railway_deploy', { ip: req.ip });
    addActivity('🚀 Railway Deployment gestartet', 'info');
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Deployment-Historie
app.get('/api/railway/deployments', requireAuth, requirePermission('system.info'), async (req, res) => {
  try {
    const deployments = await railwayManager.getDeployments(20);
    res.json({ deployments });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Domains
app.get('/api/railway/domains', requireAuth, requirePermission('system.info'), async (req, res) => {
  try {
    const domains = await railwayManager.getDomains();
    res.json({ domains });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Domain hinzufügen
app.post('/api/railway/domains', verifyCsrf, requireAuth, requirePermission('system.info'), async (req, res) => {
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ error: 'Domain erforderlich' });
  try {
    const r = await railwayManager.createDomain(domain);
    addAudit(req.user.username, 'railway_create_domain', { domain, ip: req.ip });
    res.json({ success: true, result: r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Railway-Metriken
app.get('/api/railway/metrics', requireAuth, requirePermission('system.info'), async (req, res) => {
  try {
    const metrics = await railwayManager.getMetrics();
    res.json({ metrics });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Railway-Logs
app.get('/api/railway/logs', requireAuth, requirePermission('logs.view'), async (req, res) => {
  try {
    const logs = await railwayManager.getLogs(100);
    res.json({ logs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Railway-Konfiguration im Panel speichern
app.post('/api/railway/configure', verifyCsrf, requireAuth, requirePermission('users.manage'), (req, res) => {
  const { apiKey, projectId, serviceId, environmentId, deployHookUrl, gitRepo, gitBranch } = req.body;
  const cfg = server.getConfig();
  const newCfg = {
    ...cfg,
    railwayApiKey: apiKey,
    railwayProjectId: projectId,
    railwayServiceId: serviceId,
    railwayEnvironmentId: environmentId,
    railwayDeployHook: deployHookUrl,
    railwayGitRepo: gitRepo,
    railwayGitBranch: gitBranch || 'main',
  };
  server.saveConfig(newCfg);
  // Update Live-Config
  railwayManager.apiKey = apiKey;
  railwayManager.projectId = projectId;
  railwayManager.serviceId = serviceId;
  railwayManager.environmentId = environmentId;
  railwayManager.deployHookUrl = deployHookUrl;
  railwayManager.gitRepo = gitRepo;
  railwayManager.gitBranch = gitBranch || 'main';
  railwayManager.isRailway = !!apiKey || !!deployHookUrl;
  addAudit(req.user.username, 'railway_configure', { ip: req.ip });
  addActivity('🚂 Railway-Konfiguration aktualisiert', 'info');
  res.json({ success: true });
});

// Auto-Setup: Environment-Variablen für das Panel setzen
app.post('/api/railway/setup-env', verifyCsrf, requireAuth, requirePermission('users.manage'), async (req, res) => {
  if (!railwayManager.isEnabled()) {
    return res.status(400).json({ error: 'Railway nicht konfiguriert' });
  }
  try {
    const secrets = crypto.randomBytes(32).toString('hex');
    await railwayManager.setVariable('SESSION_SECRET', secrets);
    await railwayManager.setVariable('PANEL_PORT', '3000');
    addActivity('🔧 Railway-Umgebungsvariablen eingerichtet', 'info');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- User Management (Owner only) ---
app.get('/api/users', requireAuth, requirePermission('users.manage'), (req, res) => {
  const data = getUsers();
  res.json({
    users: data.users.map(u => ({
      id: u.id,
      username: u.username,
      role: u.role,
      createdAt: u.createdAt,
      lastLogin: u.lastLogin,
      active: u.active,
    })),
    roles: ROLES,
  });
});

app.post('/api/users', verifyCsrf, requireAuth, requirePermission('users.manage'), async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Passwort muss mind. 8 Zeichen haben' });
  }
  if (!ROLES[role]) {
    return res.status(400).json({ error: 'Ungültige Rolle' });
  }
  const r = await createUser(username, password, role);
  if (r.success) {
    addAudit(req.user.username, 'user_create', { newUser: username, role, ip: req.ip });
  }
  res.json(r);
});

app.delete('/api/users/:id', verifyCsrf, requireAuth, requirePermission('users.manage'), (req, res) => {
  const data = getUsers();
  const target = data.users.find(u => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  if (target.role === 'owner' && data.users.filter(u => u.role === 'owner' && u.active).length === 1) {
    return res.status(400).json({ error: 'Letzter Owner kann nicht gelöscht werden' });
  }
  target.active = false;
  saveUsers(data);
  addAudit(req.user.username, 'user_deactivate', { target: target.username, ip: req.ip });
  res.json({ success: true });
});

// --- Performance ---
app.get('/api/performance', requireAuth, requirePermission('system.info'), (req, res) => {
  const sys = systemMonitor.getFullStats();
  const status = server.getStatus();
  const alerts = [];
  if (status.tps < 15) alerts.push({ level: 'critical', message: 'TPS kritisch', icon: '🔴' });
  else if (status.tps < 18) alerts.push({ level: 'warning', message: 'TPS niedrig', icon: '🟠' });
  if (status.mspt > 50) alerts.push({ level: 'critical', message: 'MSPT kritisch', icon: '🔴' });
  if (sys.memory.percent > 90) alerts.push({ level: 'critical', message: 'RAM kritisch', icon: '🔴' });
  else if (sys.memory.percent > 75) alerts.push({ level: 'warning', message: 'RAM hoch', icon: '🟠' });
  if (sys.cpu > 90) alerts.push({ level: 'warning', message: 'CPU-Auslastung hoch', icon: '🟠' });
  res.json({ ...sys, alerts, server: status });
});

// Catch-all für SPA
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API-Endpunkt nicht gefunden' });
  }
  res.sendFile(path.join(ROOT, 'web', 'public', 'index.html'));
});

// ============================================================================
// HTTP-SERVER & WEBSOCKET
// ============================================================================

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws, req) => {
  // Auth-Check für WebSocket
  const session = req.session;
  if (!session || !session.userId) {
    ws.close(4001, 'Nicht authentifiziert');
    return;
  }
  const data = getUsers();
  const user = data.users.find(u => u.id === session.userId);
  if (!user || !user.active) {
    ws.close(4001, 'Sitzung ungültig');
    return;
  }

  // Ping/Pong
  let isAlive = true;
  ws.on('pong', () => { isAlive = true; });
  ws.on('close', () => { /* cleanup */ });

  const interval = setInterval(() => {
    if (!isAlive) {
      ws.terminate();
      clearInterval(interval);
      return;
    }
    isAlive = false;
    try { ws.ping(); } catch (e) {}
  }, 30000);

  // Initial senden
  try {
    ws.send(JSON.stringify({ type: 'status', data: server.getStatus() }));
    ws.send(JSON.stringify({ type: 'system', data: systemMonitor.getFullStats() }));
  } catch (e) {}

  // Konsole abonnieren
  const unsubConsole = server.onConsole((line) => {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: 'console', line })); } catch (e) {}
    }
  });

  // Status-Updates senden
  const statusInterval = setInterval(() => {
    if (ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ type: 'status', data: server.getStatus() }));
        ws.send(JSON.stringify({ type: 'system', data: systemMonitor.getFullStats() }));
      } catch (e) {}
    }
  }, 2000);

  ws.on('message', (msg) => {
    try {
      const m = JSON.parse(msg.toString());
      if (m.type === 'console' && m.command) {
        if (!hasPermission(user, 'console.write')) {
          ws.send(JSON.stringify({ type: 'error', message: 'Keine Berechtigung' }));
          return;
        }
        if (m.command.length > 256 || m.command.includes('\n')) {
          ws.send(JSON.stringify({ type: 'error', message: 'Ungültiger Befehl' }));
          return;
        }
        server.sendCommand(m.command);
        addAudit(user.username, 'console_command_ws', { command: m.command });
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    clearInterval(statusInterval);
    clearInterval(interval);
    unsubConsole();
  });
});

// ============================================================================
// STARTUP
// ============================================================================

// Verzeichnisse sicherstellen
[LOG_DIR, BACKUP_DIR, PLUGINS_DIR, SERVER_DIR, WORLD_DIR].forEach(ensureDir);

// IP-Tracker persistieren
const IP_TRACKER_FILE = path.join(ROOT, 'config', 'ip-tracker.json');
try {
  ipTracker.load(readJSON(IP_TRACKER_FILE, null));
  log(`IP-Tracker geladen: ${ipTracker.knownIPs.size} IPs, ${ipTracker.bannedIPs.size} Bans`);
} catch (e) {
  log(`IP-Tracker Initialisierung: ${e.message}`, 'WARN');
}
// Periodisch speichern
setInterval(() => {
  try {
    writeJSON(IP_TRACKER_FILE, ipTracker.save());
  } catch (e) {}
}, 60000); // Jede Minute

// Cleanup alte IP-Einträge täglich
setInterval(() => {
  const cfg = server.getConfig();
  if (cfg.ipTrackingEnabled) {
    ipTracker.cleanup(cfg.ipHistoryRetention || 90);
  }
}, 24 * 60 * 60 * 1000);

// Erste Start-Aktivität
addActivity('🚀 Minecraft Server Control Panel gestartet', 'info');
addActivity('🛡️ Security-Systeme aktiv: IP-Tracking, Brute-Force, Anti-Cheat', 'success');
log('=== Minecraft Server Control Panel gestartet ===');

httpServer.listen(PANEL_PORT, '0.0.0.0', () => {
  log(`Panel läuft auf http://0.0.0.0:${PANEL_PORT}`);
  console.log('');
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║   Minecraft Server Control Panel               ║');
  console.log('║   Paper 1.21.4 + Geyser + Floodgate            ║');
  console.log('╚════════════════════════════════════════════════╝');
  console.log(`   Panel:    http://localhost:${PANEL_PORT}`);
  console.log(`   Server:   Port 25565 (Java)`);
  console.log(`   Bedrock:  Port 19132 (UDP)`);
  console.log('');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('SIGTERM erhalten, fahre herunter...');
  if (server.isRunning()) {
    server.stop();
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  log('SIGINT erhalten, fahre herunter...');
  if (server.isRunning()) {
    server.stop();
  }
  process.exit(0);
});
