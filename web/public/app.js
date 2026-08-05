// Minecraft Server Control Panel - Frontend
// ============================================================================

const App = {
  csrfToken: null,
  ws: null,
  user: null,
  currentPage: 'dashboard',
  permissions: [],
  serverStatus: null,
  systemStats: null,
  wizardData: {},
  consoleBuffer: [],
  maxConsoleLines: 2000,
  autoScroll: true,
  consoleSearch: '',
  consoleFilter: '',
};

function $(sel, parent = document) { return parent.querySelector(sel); }
function $$(sel, parent = document) { return Array.from(parent.querySelectorAll(sel)); }

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatUptime(seconds) {
  if (!seconds) return '0s';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d) parts.push(d + 'T');
  if (h) parts.push(h + 'h');
  if (m) parts.push(m + 'm');
  parts.push(s + 's');
  return parts.join(' ');
}

function formatDate(timestamp) {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleString('de-DE');
}

function formatRelative(timestamp) {
  if (!timestamp) return '-';
  const diff = Date.now() - timestamp;
  if (diff < 60000) return 'gerade eben';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' Min';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' Std';
  return Math.floor(diff / 86400000) + ' Tage';
}

function hasPermission(perm) {
  if (App.user && App.user.role === 'owner') return true;
  return App.permissions.includes(perm);
}

async function api(endpoint, options = {}) {
  const opts = {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  };
  if (App.csrfToken && opts.method !== 'GET') {
    opts.headers['X-CSRF-Token'] = App.csrfToken;
  }
  if (options.body) opts.body = JSON.stringify(options.body);
  const res = await fetch('/api' + endpoint, opts);
  if (res.status === 401) {
    if (App.user) {
      showLogin();
      showToast('Sitzung abgelaufen', 'warning');
    }
    throw new Error('Nicht authentifiziert');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function showToast(message, type = 'info', duration = 5000) {
  const container = $('#toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
  toast.innerHTML = `<span style="font-weight:600;font-size:14px">${icons[type] || 'ℹ'}</span><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

function showModal(title, body, footer) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  $('#modal-footer').innerHTML = '';
  if (footer) {
    if (typeof footer === 'string') $('#modal-footer').innerHTML = footer;
    else footer.forEach(b => $('#modal-footer').appendChild(b));
  }
  $('#modal-overlay').style.display = 'flex';
  bindRconActions();
}

function closeModal() {
  $('#modal-overlay').style.display = 'none';
}

async function checkAuth() {
  try {
    const me = await api('/auth/me');
    if (me.authenticated) {
      App.user = me.user;
      App.csrfToken = me.csrfToken;
      App.permissions = me.permissions || [];
      return true;
    }
  } catch (e) {}
  return false;
}

function showLogin() {
  $('#main-app').style.display = 'none';
  $('#login-screen').style.display = 'flex';
  $('#login-username').focus();
}

function showMain() {
  $('#login-screen').style.display = 'none';
  $('#main-app').style.display = 'flex';
  buildSidebar();
  $('#user-name').textContent = App.user.username;
  $('#user-role').textContent = ({ owner: 'Owner', admin: 'Admin', moderator: 'Moderator', viewer: 'Viewer' })[App.user.role] || App.user.role;
  $('#user-avatar').textContent = App.user.username[0].toUpperCase();
  navigateTo('dashboard');
}

async function login(username, password) {
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      credentials: 'same-origin',
    });
    const data = await r.json();
    if (!r.ok) {
      $('#login-error').textContent = data.error || 'Anmeldung fehlgeschlagen';
      $('#login-error').classList.add('show');
      return;
    }
    App.user = data.user;
    App.csrfToken = data.csrfToken;
    showMain();
    showToast(`Willkommen, ${data.user.username}!`, 'success');
  } catch (e) {
    $('#login-error').textContent = 'Verbindungsfehler';
    $('#login-error').classList.add('show');
  }
}

async function logout() {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  if (App.ws) App.ws.close();
  App.user = null;
  App.csrfToken = null;
  showLogin();
}

// SETUP WIZARD

const WIZARD_STEPS = [
  { id: 'minecraft_version', title: 'Minecraft-Version' },
  { id: 'java', title: 'Java-Version' },
  { id: 'ram', title: 'RAM-Speicher' },
  { id: 'server_port', title: 'Server-Port' },
  { id: 'bedrock_port', title: 'Bedrock UDP-Port' },
  { id: 'server_name', title: 'Server-Name' },
  { id: 'plugins', title: 'Plugins' },
  { id: 'geyser', title: 'Geyser' },
  { id: 'floodgate', title: 'Floodgate' },
  { id: 'luckperms', title: 'LuckPerms' },
  { id: 'backup', title: 'Backup-Einstellungen' },
  { id: 'admin_account', title: 'Administrator-Account' },
];

let wizardStep = 0;

function showWizard() {
  $('#main-app').style.display = 'none';
  $('#login-screen').style.display = 'none';
  $('#setup-wizard').style.display = 'flex';
  renderWizard();
}

function renderWizard() {
  const step = WIZARD_STEPS[wizardStep];
  const percent = ((wizardStep + 1) / WIZARD_STEPS.length) * 100;
  $('#wizard-progress-bar').style.setProperty('--progress', percent + '%');
  $('#wizard-step-info').textContent = `Schritt ${wizardStep + 1} von ${WIZARD_STEPS.length}: ${step.title}`;
  $('#wizard-prev').disabled = wizardStep === 0;
  $('#wizard-next').textContent = wizardStep === WIZARD_STEPS.length - 1 ? '🚀 Server installieren' : 'Weiter →';

  const body = $('#wizard-body');
  switch (step.id) {
    case 'minecraft_version':
      body.innerHTML = `<div class="wizard-section">
        <h3>${step.title}</h3>
        <p>Wähle die Minecraft-Version für deinen Server</p>
        <div class="wizard-field">
          <label>Version</label>
          <select id="w-mc-version"><option value="1.21.4" selected>1.21.4 (Paper, aktuell)</option></select>
        </div></div>`;
      break;
    case 'java':
      body.innerHTML = `<div class="wizard-section">
        <h3>${step.title}</h3>
        <p>Paper 1.21.4 benötigt Java 21 oder höher</p>
        <div class="wizard-field">
          <label>Java-Pfad</label>
          <input type="text" id="w-java-path" value="java">
          <p class="hint">Standard: <span class="code">java</span></p>
        </div></div>`;
      break;
    case 'ram':
      body.innerHTML = `<div class="wizard-section">
        <h3>${step.title}</h3>
        <p>Wieviel Arbeitsspeicher soll der Server nutzen?</p>
        <div class="wizard-field">
          <label>Minimaler RAM: <span id="w-ram-min-val">2G</span></label>
          <input type="range" id="w-ram-min" min="1" max="16" value="2" step="1">
        </div>
        <div class="wizard-field">
          <label>Maximaler RAM: <span id="w-ram-max-val">4G</span></label>
          <input type="range" id="w-ram-max" min="2" max="32" value="4" step="1">
        </div>
        <p class="hint">Mind. 1G, empfohlen 2-4G</p></div>`;
      $('#w-ram-min').oninput = (e) => $('#w-ram-min-val').textContent = e.target.value + 'G';
      $('#w-ram-max').oninput = (e) => $('#w-ram-max-val').textContent = e.target.value + 'G';
      break;
    case 'server_port':
      body.innerHTML = `<div class="wizard-section">
        <h3>${step.title}</h3>
        <div class="wizard-field">
          <label>Port (TCP)</label>
          <input type="number" id="w-server-port" value="25565" min="1024" max="65535">
        </div></div>`;
      break;
    case 'bedrock_port':
      body.innerHTML = `<div class="wizard-section">
        <h3>${step.title}</h3>
        <div class="wizard-field">
          <label>Port (UDP)</label>
          <input type="number" id="w-bedrock-port" value="19132" min="1024" max="65535">
          <p class="hint">Geyser benötigt UDP</p>
        </div></div>`;
      break;
    case 'server_name':
      body.innerHTML = `<div class="wizard-section">
        <h3>${step.title}</h3>
        <div class="wizard-field">
          <label>Server-Name</label>
          <input type="text" id="w-server-name" value="Mein Minecraft Server">
        </div>
        <div class="wizard-field">
          <label>MOTD</label>
          <input type="text" id="w-motd" value="§bWillkommen auf §6unserem §aMinecraft Server!">
          <p class="hint">Farbcodes: §a (grün), §b (aqua), §c (rot), §6 (gold)</p>
        </div></div>`;
      break;
    case 'plugins':
      const pluginList = [
        { id: 'enableEssentialsX', name: 'EssentialsX', desc: 'Grundlegende Befehle', recommended: true },
        { id: 'enableVault', name: 'Vault', desc: 'Permissions-API', recommended: true },
        { id: 'enableLuckPerms', name: 'LuckPerms', desc: 'Rangsystem', recommended: true },
        { id: 'enableGeyser', name: 'Geyser-Spigot', desc: 'Bedrock-Support', recommended: true },
        { id: 'enableFloodgate', name: 'Floodgate', desc: 'Bedrock ohne Java-Account', recommended: true },
        { id: 'enableCoreProtect', name: 'CoreProtect', desc: 'Block-Logging', recommended: true },
        { id: 'enableWorldEdit', name: 'WorldEdit', desc: 'Welt-Editor', recommended: false },
        { id: 'enableWorldGuard', name: 'WorldGuard', desc: 'Gebietsschutz', recommended: false },
        { id: 'enableViaVersion', name: 'ViaVersion', desc: 'Multi-Version', recommended: false },
      ];
      body.innerHTML = `<div class="wizard-section">
        <h3>${step.title}</h3>
        <div class="wizard-checkbox-grid">
          ${pluginList.map(p => `<label class="wizard-checkbox-item">
            <input type="checkbox" id="w-${p.id}" ${p.recommended ? 'checked' : ''}>
            <div><div>${p.name}</div><div style="font-size:11px;color:var(--text-muted)">${p.desc}</div></div>
          </label>`).join('')}
        </div></div>`;
      break;
    case 'geyser':
    case 'floodgate':
    case 'luckperms':
      body.innerHTML = `<div class="wizard-section">
        <h3>${step.title}</h3>
        <p>Diese Komponente wird automatisch konfiguriert.</p></div>`;
      break;
    case 'backup':
      body.innerHTML = `<div class="wizard-section">
        <h3>${step.title}</h3>
        <div class="wizard-field">
          <label class="wizard-checkbox-item">
            <input type="checkbox" id="w-backup-auto" checked>
            <div><div>Auto-Backups aktivieren</div></div>
          </label>
        </div>
        <div class="wizard-field">
          <label>Intervall (Stunden)</label>
          <input type="number" id="w-backup-interval" value="24" min="1">
        </div></div>`;
      break;
    case 'admin_account':
      body.innerHTML = `<div class="wizard-section">
        <h3>${step.title}</h3>
        <div class="wizard-field"><label>Benutzername</label>
          <input type="text" id="w-admin-user" value="admin"></div>
        <div class="wizard-field"><label>Passwort (mind. 8 Zeichen)</label>
          <input type="password" id="w-admin-pw"></div>
        <div class="wizard-field"><label>Passwort bestätigen</label>
          <input type="password" id="w-admin-pw2"></div>
      </div>`;
      break;
  }
}

function wizardNext() {
  if (wizardStep === WIZARD_STEPS.length - 1) return wizardInstall();
  wizardStep++;
  renderWizard();
}

function wizardPrev() {
  if (wizardStep > 0) { wizardStep--; renderWizard(); }
}

async function wizardInstall() {
  const pw1 = $('#w-admin-pw').value;
  const pw2 = $('#w-admin-pw2').value;
  if (pw1.length < 8) return showToast('Passwort muss mind. 8 Zeichen haben', 'error');
  if (pw1 !== pw2) return showToast('Passwörter stimmen nicht überein', 'error');

  const config = {
    paper: '1.21.4', javaPath: $('#w-java-path').value,
    ramMin: $('#w-ram-min').value + 'G', ramMax: $('#w-ram-max').value + 'G',
    serverPort: parseInt($('#w-server-port').value),
    bedrockPort: parseInt($('#w-bedrock-port').value),
    serverName: $('#w-server-name').value, motd: $('#w-motd').value,
    maxPlayers: 20, viewDistance: 10, simulationDistance: 5,
    difficulty: 'normal', gamemode: 'survival',
    pvp: true, onlineMode: true, spawnProtection: 16, whitelist: false,
    enableCommandBlock: true, spawnAnimals: true, spawnMonsters: true, spawnNpcs: true, allowFlight: false,
    enableGeyser: $('#w-enableGeyser')?.checked ?? true,
    enableFloodgate: $('#w-enableFloodgate')?.checked ?? true,
    enableLuckPerms: $('#w-enableLuckPerms')?.checked ?? true,
    enableEssentialsX: $('#w-enableEssentialsX')?.checked ?? true,
    enableVault: $('#w-enableVault')?.checked ?? true,
    enableCoreProtect: $('#w-enableCoreProtect')?.checked ?? true,
    enableWorldEdit: $('#w-enableWorldEdit')?.checked ?? false,
    enableWorldGuard: $('#w-enableWorldGuard')?.checked ?? false,
    enableViaVersion: $('#w-enableViaVersion')?.checked ?? false,
    backupAuto: $('#w-backup-auto')?.checked ?? true,
    backupInterval: parseInt($('#w-backup-interval')?.value || 24),
    backupRetention: 7,
    adminUser: $('#w-admin-user').value, adminPassword: pw1,
  };

  $('#wizard-body').innerHTML = `<div class="wizard-section" style="text-align:center">
    <div class="spinner" style="margin: 0 auto 16px;"></div>
    <h3>Server wird installiert...</h3>
    <div id="wizard-install-log" style="text-align:left;margin-top:20px;background:var(--bg-primary);padding:16px;border-radius:8px;max-height:300px;overflow-y:auto;font-family:monospace;font-size:12px"></div>
  </div>`;
  $('#wizard-next').style.display = 'none';
  $('#wizard-prev').style.display = 'none';

  const log = (msg, type = 'info') => {
    const el = $('#wizard-install-log');
    const line = document.createElement('div');
    line.style.color = type === 'error' ? 'var(--red)' : type === 'success' ? 'var(--green)' : 'var(--text-secondary)';
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  };

  try {
    log('Setup wird abgeschlossen...');
    await api('/setup/install', { method: 'POST', body: config });
    log('Installation gestartet', 'success');
    let attempts = 0;
    const checkInterval = setInterval(async () => {
      attempts++;
      try {
        const cfg = await api('/settings');
        const plugins = await api('/plugins');
        const installed = plugins.filter(p => p.installed).length;
        log(`${installed} Plugins installiert...`);
        if (installed >= 7 || attempts > 60) {
          clearInterval(checkInterval);
          log('Installation abgeschlossen!', 'success');
          setTimeout(() => location.reload(), 2000);
        }
      } catch (e) {}
    }, 3000);
  } catch (e) {
    log('Fehler: ' + e.message, 'error');
  }
}

// SIDEBAR & NAV

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>', section: 'Übersicht' },
  { id: 'console', label: 'Konsole', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M20 19.59V8l-6-6H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c.45 0 .85-.15 1.19-.4l-4.43-4.43c-.8.52-1.74.83-2.76.83-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5c0 1.02-.31 1.96-.83 2.75L20 19.59z"/></svg>', section: 'Übersicht' },
  { id: 'control', label: 'Server Control', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>', section: 'Übersicht' },
  { id: 'settings', label: 'Einstellungen', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>', section: 'Server', perm: 'settings.view' },
  { id: 'players', label: 'Spieler', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>', section: 'Server', perm: 'players.view' },
  { id: 'worlds', label: 'Welten', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>', section: 'Server', perm: 'worlds.view' },
  { id: 'plugins', label: 'Plugins', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z"/></svg>', section: 'Server', perm: 'plugins.view' },
  { id: 'permissions', label: 'LuckPerms', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/></svg>', section: 'Server', perm: 'permissions.manage' },
  { id: 'files', label: 'Dateien', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>', section: 'Verwaltung', perm: 'settings.view' },
  { id: 'geyser', label: 'Geyser / Floodgate', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14zM5 15h14v3H5z"/></svg>', section: 'Server', perm: 'geyser.view' },
  { id: 'backups', label: 'Backups', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/></svg>', section: 'Verwaltung', perm: 'backups.view' },
  { id: 'performance', label: 'Performance', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M13 2v8h8c0-4.42-3.58-8-8-8zm0 14h-2v6h2v-6zm4 0h-2v6h2v-6zm-8 0H7v6h2v-6zM9 2H7v8h2V2z"/></svg>', section: 'Verwaltung', perm: 'system.info' },
  { id: 'logs', label: 'Logs', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>', section: 'Verwaltung', perm: 'logs.view' },
  { id: 'activity', label: 'Activity', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>', section: 'Verwaltung', perm: 'activity.view' },
  { id: 'audit', label: 'Audit Log', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg>', section: 'Verwaltung', perm: 'audit.view' },
  { id: 'security', label: 'Security Center', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>', section: 'Sicherheit', perm: 'security.view' },
  { id: 'railway', label: 'Railway Deploy', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2L2 22h20L12 2zm0 4l7.5 14H4.5L12 6z"/></svg>', section: 'System', perm: 'system.info' },
  { id: 'users', label: 'Benutzer', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>', section: 'System', perm: 'users.manage' },
];

const PAGE_TITLES = {
  dashboard: 'Dashboard', console: 'Konsole', control: 'Server Control',
  settings: 'Einstellungen', players: 'Spieler', worlds: 'Welten',
  plugins: 'Plugins', permissions: 'LuckPerms', geyser: 'Geyser / Floodgate',
  backups: 'Backups', performance: 'Performance', logs: 'Logs',
  activity: 'Activity', audit: 'Audit Log', security: 'Security Center',
  railway: 'Railway Deploy', users: 'Benutzer', files: 'Dateien',
};

function buildSidebar() {
  const nav = $('#sidebar-nav');
  nav.innerHTML = '';
  let currentSection = '';
  NAV_ITEMS.forEach(item => {
    if (item.perm && !hasPermission(item.perm)) return;
    if (item.section !== currentSection) {
      currentSection = item.section;
      const sec = document.createElement('div');
      sec.className = 'nav-section';
      sec.textContent = item.section;
      nav.appendChild(sec);
    }
    const btn = document.createElement('button');
    btn.className = 'nav-item' + (App.currentPage === item.id ? ' active' : '');
    btn.innerHTML = `${item.icon}<span>${item.label}</span>`;
    btn.onclick = () => navigateTo(item.id);
    btn.dataset.pageId = item.id;
    nav.appendChild(btn);
  });
}

function navigateTo(page) {
  App.currentPage = page;
  $$('.nav-item').forEach(el => el.classList.remove('active'));
  $$('.nav-item').forEach(el => {
    if (el.dataset.pageId === page) el.classList.add('active');
  });
  $('#page-title').textContent = PAGE_TITLES[page] || page;
  renderPage();
  if (window.innerWidth <= 768) {
    $('#sidebar').classList.remove('open');
  }
}

function renderPage() {
  const content = $('#page-content');
  content.innerHTML = '<div style="text-align:center;padding:40px"><div class="spinner" style="margin:0 auto"></div></div>';
  const r = {
    dashboard: renderDashboard, console: renderConsole, control: renderControl,
    settings: renderSettings, players: renderPlayers, worlds: renderWorlds,
    plugins: renderPlugins, permissions: renderPermissions, geyser: renderGeyser,
    backups: renderBackups, performance: renderPerformance, logs: renderLogs,
    activity: renderActivity, audit: renderAudit, security: renderSecurity,
    railway: renderRailway, users: renderUsers, files: renderFiles,
  };
  if (r[App.currentPage]) r[App.currentPage]();
}

// PAGES

async function renderDashboard() {
  const content = $('#page-content');
  const [status, sys, info] = await Promise.all([
    fetch('/api/server/status').then(r => r.json()),
    api('/system/stats').catch(() => ({})),
    api('/server/info').catch(() => ({})),
  ]);
  const statusClass = status.status || 'offline';
  const statusText = ({ online: '🟢 Online', offline: '🔴 Offline', starting: '🟠 Starting', stopping: '🟠 Stopping', error: '⚠️ Error' })[statusClass] || '🔴 Offline';

  content.innerHTML = `
    <div class="grid grid-4">
      <div class="stat-card">
        <div class="stat-card-header"><span class="stat-card-label">Server</span><div class="stat-card-icon">🎮</div></div>
        <div class="stat-card-value">${statusText}</div>
        <div class="stat-card-detail">${status.uptime ? `Uptime: ${formatUptime(status.uptime)}` : 'Gestoppt'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-header"><span class="stat-card-label">Spieler</span><div class="stat-card-icon">👥</div></div>
        <div class="stat-card-value">${status.playerCount || 0} / ${info.config?.maxPlayers || 20}</div>
        <div class="stat-card-detail">${status.bedrockPlayerCount || 0} Bedrock-Spieler</div>
      </div>
      <div class="stat-card ${(status.tps || 20) < 18 ? 'alert-warning' : ''}">
        <div class="stat-card-header"><span class="stat-card-label">TPS</span><div class="stat-card-icon">⚡</div></div>
        <div class="stat-card-value">${(status.tps || 20).toFixed(1)}</div>
        <div class="stat-card-detail">MSPT: ${(status.mspt || 0).toFixed(1)}</div>
      </div>
      <div class="stat-card ${(sys.memory?.percent || 0) > 75 ? 'alert-warning' : ''}">
        <div class="stat-card-header"><span class="stat-card-label">RAM</span><div class="stat-card-icon">🧠</div></div>
        <div class="stat-card-value">${sys.memory?.usedFormatted || '0 B'}</div>
        <div class="stat-card-detail">${(sys.memory?.percent || 0).toFixed(0)}% von ${sys.memory?.totalFormatted || '0 B'}</div>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">📋 Server-Info</div></div>
      <div class="grid grid-2" style="margin:0">
        <div><div class="stat-card-label">Minecraft</div><div style="font-weight:600;margin-top:4px">${escapeHtml(info.minecraftVersion || '1.21.4')}</div></div>
        <div><div class="stat-card-label">Paper</div><div style="font-weight:600;margin-top:4px">${escapeHtml(info.paperVersion || '1.21.4')}</div></div>
        <div><div class="stat-card-label">Java-Port</div><div style="font-weight:600;margin-top:4px"><span class="code">${info.config?.serverPort || 25565}</span> TCP</div></div>
        <div><div class="stat-card-label">Bedrock-Port</div><div style="font-weight:600;margin-top:4px"><span class="code">${info.config?.bedrockPort || 19132}</span> UDP</div></div>
        <div><div class="stat-card-label">CPU</div><div style="font-weight:600;margin-top:4px">${(sys.cpu || 0).toFixed(1)}%</div></div>
        <div><div class="stat-card-label">Uptime</div><div style="font-weight:600;margin-top:4px">${formatUptime(sys.uptime || 0)}</div></div>
      </div>
    </div>`;
}

function renderConsole() {
  const content = $('#page-content');
  content.innerHTML = `
    <div class="console-container">
      <div class="console-toolbar">
        <input type="text" class="console-search" id="console-search" placeholder="🔍 Suchen...">
        <select class="console-search" id="console-filter" style="flex:0 0 140px">
          <option value="">Alle Level</option><option value="INFO">INFO</option><option value="WARN">WARN</option><option value="ERROR">ERROR</option>
        </select>
        <button class="btn btn-sm" id="console-auto-scroll">📌 Auto-Scroll: AN</button>
        <button class="btn btn-sm" id="console-clear">🗑️ Clear</button>
        <button class="btn btn-sm" id="console-refresh">🔄 Aktualisieren</button>
      </div>
      <div class="console-output" id="console-output"></div>
      <div class="console-input-row">
        <div class="console-prompt">$&nbsp;</div>
        <input type="text" class="console-input" id="console-input" placeholder="Minecraft-Befehl eingeben (z.B. list, say Hallo)">
      </div>
    </div>`;
  refreshConsole();
  $('#console-search').oninput = (e) => { App.consoleSearch = e.target.value; renderConsoleLines(); };
  $('#console-filter').onchange = (e) => { App.consoleFilter = e.target.value; renderConsoleLines(); };
  $('#console-auto-scroll').onclick = (e) => {
    App.autoScroll = !App.autoScroll;
    e.target.textContent = `📌 Auto-Scroll: ${App.autoScroll ? 'AN' : 'AUS'}`;
  };
  $('#console-clear').onclick = () => { App.consoleBuffer = []; renderConsoleLines(); };
  $('#console-refresh').onclick = refreshConsole;
  $('#console-input').onkeydown = (e) => {
    if (e.key === 'Enter' && e.target.value.trim()) {
      sendConsoleCommand(e.target.value.trim());
      e.target.value = '';
    }
  };
}

async function refreshConsole() {
  try {
    const r = await api('/console/lines?limit=500');
    App.consoleBuffer = r.lines;
    renderConsoleLines();
  } catch (e) {}
}

function renderConsoleLines() {
  const out = $('#console-output');
  if (!out) return;
  let lines = App.consoleBuffer;
  if (App.consoleSearch) {
    const s = App.consoleSearch.toLowerCase();
    lines = lines.filter(l => l.toLowerCase().includes(s));
  }
  if (App.consoleFilter) lines = lines.filter(l => l.includes(App.consoleFilter));
  out.innerHTML = lines.map(line => {
    let cls = '';
    if (line.includes('[ERROR]') || line.toLowerCase().includes('error')) cls = 'error';
    else if (line.includes('[WARN]') || line.toLowerCase().includes('warn')) cls = 'warn';
    else if (line.startsWith('> ')) cls = 'command';
    return `<div class="console-line ${cls}">${escapeHtml(line)}</div>`;
  }).join('');
  if (App.autoScroll) out.scrollTop = out.scrollHeight;
}

async function sendConsoleCommand(cmd) {
  if (!hasPermission('console.write')) return showToast('Keine Berechtigung', 'error');
  if (cmd.includes('\n') || cmd.length > 256) return showToast('Ungültiger Befehl', 'error');
  try {
    await api('/console/command', { method: 'POST', body: { command: cmd } });
  } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
}

function renderControl() {
  const content = $('#page-content');
  const status = App.serverStatus || {};
  const running = status.status === 'online';
  const starting = status.status === 'starting';

  content.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div class="card-title">🎛️ Server Control</div>
        <div class="status-pill ${status.status || 'offline'}">
          <span class="status-dot"></span>
          <span>${({online:'Online',offline:'Offline',starting:'Starting',stopping:'Stopping',error:'Error'})[status.status] || 'Offline'}</span>
        </div>
      </div>
      <div class="server-controls">
        <button class="server-control-btn start" id="ctrl-start" ${running || starting ? 'disabled' : ''}><div class="icon">▶</div><div>Start</div></button>
        <button class="server-control-btn stop" id="ctrl-stop" ${!running ? 'disabled' : ''}><div class="icon">⏹</div><div>Stop</div></button>
        <button class="server-control-btn restart" id="ctrl-restart" ${!running && !starting ? 'disabled' : ''}><div class="icon">🔄</div><div>Restart</div></button>
        <button class="server-control-btn reload" id="ctrl-reload" ${!running ? 'disabled' : ''}><div class="icon">🔃</div><div>Reload</div></button>
        <button class="server-control-btn kill" id="ctrl-kill" ${!running && !starting ? 'disabled' : ''}><div class="icon">🛑</div><div>Kill</div></button>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">📊 Live Status</div></div>
      <div class="grid grid-3">
        <div><div class="stat-card-label">PID</div><div style="font-family:monospace;font-size:18px;margin-top:4px">${status.pid || '-'}</div></div>
        <div><div class="stat-card-label">Uptime</div><div style="font-size:18px;margin-top:4px">${status.uptime ? formatUptime(status.uptime) : '-'}</div></div>
        <div><div class="stat-card-label">Spieler</div><div style="font-size:18px;margin-top:4px">${status.playerCount || 0}</div></div>
        <div><div class="stat-card-label">TPS</div><div style="font-size:18px;margin-top:4px">${(status.tps || 20).toFixed(2)}</div></div>
        <div><div class="stat-card-label">MSPT</div><div style="font-size:18px;margin-top:4px">${(status.mspt || 0).toFixed(2)}</div></div>
        <div><div class="stat-card-label">Bedrock</div><div style="font-size:18px;margin-top:4px">${status.bedrockPlayerCount || 0}</div></div>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">⚡ Schnellbefehle</div></div>
      <div class="btn-group">
        <button class="btn" data-cmd="list">📋 list</button>
        <button class="btn" data-cmd="time set day">☀️ Day</button>
        <button class="btn" data-cmd="time set night">🌙 Night</button>
        <button class="btn" data-cmd="weather clear">☀️ Clear</button>
        <button class="btn" data-cmd="weather rain">🌧️ Rain</button>
        <button class="btn" data-cmd="save-all">💾 save-all</button>
        <button class="btn" data-cmd="say Hallo Server!">📢 say Hallo</button>
      </div>
    </div>`;

  $('#ctrl-start').onclick = () => confirmAction('Server starten?', 'Wird gestartet.', async () => {
    try { await api('/server/start', { method: 'POST' }); showToast('Server wird gestartet', 'success'); }
    catch (e) { showToast('Fehler: ' + e.message, 'error'); }
  });
  $('#ctrl-stop').onclick = () => confirmAction('Server wirklich stoppen?', 'Spieler werden getrennt.', async () => {
    try { await api('/server/stop', { method: 'POST' }); showToast('Server wird gestoppt', 'warning'); }
    catch (e) { showToast('Fehler: ' + e.message, 'error'); }
  });
  $('#ctrl-restart').onclick = () => confirmAction('Server neu starten?', 'Wird gestoppt und neu gestartet.', async () => {
    try { await api('/server/restart', { method: 'POST' }); showToast('Server wird neu gestartet', 'info'); }
    catch (e) { showToast('Fehler: ' + e.message, 'error'); }
  });
  $('#ctrl-reload').onclick = () => api('/server/reload', { method: 'POST' })
    .then(() => showToast('Reload', 'success')).catch(e => showToast(e.message, 'error'));
  $('#ctrl-kill').onclick = () => confirmAction('Prozess beenden?', 'ACHTUNG: SIGKILL! Datenverlust möglich!', async () => {
    try { await api('/server/kill', { method: 'POST' }); showToast('Prozess beendet', 'error'); }
    catch (e) { showToast('Fehler: ' + e.message, 'error'); }
  });
  $$('[data-cmd]').forEach(btn => btn.onclick = () => sendConsoleCommand(btn.dataset.cmd));
}

function confirmAction(title, message, onConfirm) {
  showModal(title, `<p>${escapeHtml(message)}</p>
    <div style="margin-top:16px;background:rgba(255,154,60,0.1);border:1px solid rgba(255,154,60,0.3);padding:12px;border-radius:6px;color:var(--orange)">
      ⚠️ Bitte bestätige diese Aktion.
    </div>`,
    [
      (() => { const b = document.createElement('button'); b.className='btn btn-secondary'; b.textContent='Abbrechen'; b.onclick=closeModal; return b; })(),
      (() => { const b = document.createElement('button'); b.className='btn btn-danger'; b.textContent='Bestätigen'; b.onclick=()=>{closeModal();onConfirm();}; return b; })(),
    ]
  );
}

async function renderSettings() {
  const content = $('#page-content');
  const cfg = await api('/settings');
  const canEdit = hasPermission('settings.edit');

  content.innerHTML = `
    <div class="card">
      <div class="card-header"><div class="card-title">⚙️ Server-Einstellungen</div></div>
      <form id="settings-form">
        <div class="form-row">
          <div class="form-group"><label>Server-Name</label>
            <input type="text" name="serverName" value="${escapeHtml(cfg.serverName || '')}" ${!canEdit ? 'disabled' : ''}></div>
          <div class="form-group"><label>Max Spieler</label>
            <input type="number" name="maxPlayers" value="${cfg.maxPlayers || 20}" ${!canEdit ? 'disabled' : ''}></div>
        </div>
        <div class="form-group"><label>MOTD</label>
          <input type="text" name="motd" value="${escapeHtml(cfg.motd || '')}" ${!canEdit ? 'disabled' : ''}>
          <p class="hint">Farbcodes: §a, §b, §c, §6, §l</p></div>
        <div class="form-row">
          <div class="form-group"><label>Java Port (TCP)</label>
            <input type="number" name="serverPort" value="${cfg.serverPort || 25565}" ${!canEdit ? 'disabled' : ''}></div>
          <div class="form-group"><label>Bedrock Port (UDP)</label>
            <input type="number" name="bedrockPort" value="${cfg.bedrockPort || 19132}" ${!canEdit ? 'disabled' : ''}></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>View Distance</label>
            <input type="number" name="viewDistance" value="${cfg.viewDistance || 10}" min="3" max="32" ${!canEdit ? 'disabled' : ''}></div>
          <div class="form-group"><label>Simulation Distance</label>
            <input type="number" name="simulationDistance" value="${cfg.simulationDistance || 5}" ${!canEdit ? 'disabled' : ''}></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Schwierigkeit</label>
            <select name="difficulty" ${!canEdit ? 'disabled' : ''}>
              <option value="peaceful" ${cfg.difficulty === 'peaceful' ? 'selected' : ''}>Peaceful</option>
              <option value="easy" ${cfg.difficulty === 'easy' ? 'selected' : ''}>Easy</option>
              <option value="normal" ${cfg.difficulty === 'normal' ? 'selected' : ''}>Normal</option>
              <option value="hard" ${cfg.difficulty === 'hard' ? 'selected' : ''}>Hard</option>
            </select></div>
          <div class="form-group"><label>Gamemode</label>
            <select name="gamemode" ${!canEdit ? 'disabled' : ''}>
              <option value="survival" ${cfg.gamemode === 'survival' ? 'selected' : ''}>Survival</option>
              <option value="creative" ${cfg.gamemode === 'creative' ? 'selected' : ''}>Creative</option>
              <option value="adventure" ${cfg.gamemode === 'adventure' ? 'selected' : ''}>Adventure</option>
              <option value="spectator" ${cfg.gamemode === 'spectator' ? 'selected' : ''}>Spectator</option>
            </select></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>RAM Min</label>
            <input type="text" name="ramMin" value="${escapeHtml(cfg.ramMin || '2G')}" ${!canEdit ? 'disabled' : ''}></div>
          <div class="form-group"><label>RAM Max</label>
            <input type="text" name="ramMax" value="${escapeHtml(cfg.ramMax || '4G')}" ${!canEdit ? 'disabled' : ''}></div>
        </div>
        <div class="toggle-row">
          <div class="label-block"><div class="label">PVP</div><div class="label-desc">Spieler-Schaden untereinander</div></div>
          <label class="toggle-switch"><input type="checkbox" name="pvp" ${cfg.pvp ? 'checked' : ''} ${!canEdit ? 'disabled' : ''}><span class="toggle-slider"></span></label>
        </div>
        <div class="toggle-row">
          <div class="label-block"><div class="label">Online Mode</div><div class="label-desc">Verifiziert Mojang-Accounts</div></div>
          <label class="toggle-switch"><input type="checkbox" name="onlineMode" ${cfg.onlineMode ? 'checked' : ''} ${!canEdit ? 'disabled' : ''}><span class="toggle-slider"></span></label>
        </div>
        <div class="toggle-row">
          <div class="label-block"><div class="label">Whitelist</div><div class="label-desc">Nur Whitelist-Spieler</div></div>
          <label class="toggle-switch"><input type="checkbox" name="whitelist" ${cfg.whitelist ? 'checked' : ''} ${!canEdit ? 'disabled' : ''}><span class="toggle-slider"></span></label>
        </div>
        ${canEdit ? `<div class="btn-group mt-2">
          <button type="submit" class="btn btn-primary">💾 Speichern</button>
        </div>` : ''}
      </form>
    </div>`;

  if (canEdit) {
    $('#settings-form').onsubmit = async (e) => {
      e.preventDefault();
      const body = {};
      const fd = new FormData(e.target);
      for (const [k, v] of fd.entries()) {
        if (k === 'pvp' || k === 'onlineMode' || k === 'whitelist') continue;
        body[k] = v;
      }
      ['pvp', 'onlineMode', 'whitelist'].forEach(k => {
        const cb = $(`[name="${k}"]`);
        if (cb) body[k] = cb.checked;
      });
      try {
        await api('/settings', { method: 'PUT', body });
        showToast('Einstellungen gespeichert', 'success');
        if (confirm('Server neu starten, damit die Änderungen wirksam werden?')) {
          await api('/server/restart', { method: 'POST' });
        }
        renderSettings();
      } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
    };
  }
}

async function renderPlayers() {
  const content = $('#page-content');
  let data, rconData;
  try {
    [data, rconData] = await Promise.all([api('/players'), api('/rcon/status')]);
  } catch (e) {
    return showToast('Fehler: ' + e.message, 'error');
  }
  const players = data.players || [];
  const isPerm = (p) => hasPermission(p);

  content.innerHTML = `
    <div class="grid grid-3 mb-3">
      <div class="stat-card"><div class="stat-card-label">Java Spieler</div><div class="stat-card-value">${data.online - (data.bedrock || 0)}</div></div>
      <div class="stat-card"><div class="stat-card-label">Bedrock Spieler</div><div class="stat-card-value">${data.bedrock}</div></div>
      <div class="stat-card ${rconData.connected ? '' : 'alert-warning'}">
        <div class="stat-card-label">RCON</div>
        <div class="stat-card-value" style="font-size:18px">${rconData.connected ? '🟢 Verbunden' : '🟠 Offline'}</div>
        <div class="stat-card-detail">${rconData.connected ? 'Live-Data aktiv' : 'Kein Live-Tracking'}</div>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">👥 Spieler</div></div>
      ${players.length === 0 ? `<div class="empty-state"><div class="icon">👤</div><h3>Keine Spieler online</h3></div>` : `
        <div class="player-grid">${players.map(p => renderPlayerCard(p, isPerm)).join('')}</div>
      `}
    </div>`;

  $$('[data-action]').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const player = btn.dataset.player;
      if (action === 'player-details') showPlayerDetails(player);
      else handlePlayerAction(action, player);
    };
  });
}

function renderPlayerCard(p, isPerm) {
  const head = p.uuid ? `https://minotar.net/helm/${p.uuid}/128` : null;
  const platformName = p.isBedrock ? 'Bedrock' : (p.platform || 'Java');
  const platformClass = p.isBedrock ? 'badge-success' : 'badge-info';
  const health = p.health || 20;
  const maxHealth = p.maxHealth || 20;
  const healthPct = Math.min(100, (health / maxHealth) * 100);
  const healthColor = healthPct > 60 ? 'var(--green)' : healthPct > 30 ? 'var(--yellow)' : 'var(--red)';
  const food = p.food || 20;
  const foodPct = Math.min(100, (food / 20) * 100);
  const foodColor = foodPct > 60 ? 'var(--orange)' : foodPct > 30 ? 'var(--yellow)' : 'var(--red)';

  return `
    <div class="player-card">
      <div class="player-card-header">
        <div class="player-avatar">
          ${head ? `<img src="${head}" alt="${escapeHtml(p.name)}" onerror="this.parentNode.innerHTML='<div class=\\'player-avatar-fallback\\'>${escapeHtml(p.name[0]?.toUpperCase() || '?')}</div>'">` : `<div class="player-avatar-fallback">${escapeHtml(p.name[0]?.toUpperCase() || '?')}</div>`}
          <div class="player-platform ${platformClass}">${platformName}</div>
        </div>
        <div class="player-info">
          <div class="player-name">${escapeHtml(p.name)}</div>
          <div class="player-uuid">${p.uuid ? escapeHtml(p.uuid.substring(0,8) + '...') : 'UUID lädt...'}</div>
          <div class="player-gamemode">${p.gamemode || 'survival'} ${p.level ? '· Lvl ' + p.level : ''}</div>
        </div>
      </div>
      <div class="player-stats">
        <div class="stat-bar" title="Health">
          <span class="stat-icon">❤️</span>
          <div class="stat-bar-bg"><div class="stat-bar-fill" style="width:${healthPct}%;background:${healthColor}"></div></div>
          <span class="stat-value">${health.toFixed(0)}/${maxHealth}</span>
        </div>
        <div class="stat-bar" title="Hunger">
          <span class="stat-icon">🍖</span>
          <div class="stat-bar-bg"><div class="stat-bar-fill" style="width:${foodPct}%;background:${foodColor}"></div></div>
          <span class="stat-value">${food.toFixed(0)}/20</span>
        </div>
        ${p.location ? `<div class="stat-bar" title="Position">
          <span class="stat-icon">📍</span>
          <div class="stat-bar-bg" style="display:flex;align-items:center;padding:0 8px">
            <span style="font-size:10px;color:var(--text-secondary);font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.location.world || 'world'} · ${Math.round(p.location.x)}, ${Math.round(p.location.y)}, ${Math.round(p.location.z)}</span>
          </div>
        </div>` : ''}
      </div>
      <div class="player-actions">
        <button class="btn btn-sm" data-action="player-details" data-player="${escapeHtml(p.name)}">📊 Details</button>
        ${isPerm('players.kick') ? `<button class="btn btn-sm" data-action="kick" data-player="${escapeHtml(p.name)}">Kick</button>` : ''}
        ${isPerm('players.ban') ? `<button class="btn btn-sm btn-danger" data-action="ban" data-player="${escapeHtml(p.name)}">Ban</button>` : ''}
        ${isPerm('players.mute') ? `<button class="btn btn-sm" data-action="mute" data-player="${escapeHtml(p.name)}">Mute</button>` : ''}
      </div>
    </div>`;
}

async function showPlayerDetails(name) {
  showModal(`👤 ${name}`, '<div style="text-align:center;padding:20px"><div class="spinner" style="margin:0 auto"></div></div>');
  try {
    const d = await api(`/players/${encodeURIComponent(name)}/details`);
    showModal(`👤 ${d.name}`, renderPlayerDetails(d), '');
  } catch (e) {
    showModal(`👤 ${name}`, `<p class="text-danger">Fehler: ${escapeHtml(e.message)}</p>`);
  }
}

function renderPlayerDetails(d) {
  const skin = d.skin || {};
  const live = d.live || {};
  const stats = d.stats || {};
  const health = live.health !== undefined ? live.health : 20;
  const maxHealth = 20;
  const food = live.food !== undefined ? live.food : 20;
  const xpLevel = live.level !== undefined ? live.level : 0;
  const effects = live.effects || [];
  const inventory = live.inventory || [];
  const loc = live.location;

  return `
    <div class="player-details">
      <div class="player-details-header">
        ${skin.bodyUrl ? `<div class="player-details-skin"><img src="${skin.bodyUrl}" alt="${escapeHtml(d.name)}" onerror="this.style.display='none'"></div>` : ''}
        <div class="player-details-info">
          <h3>${escapeHtml(d.name)}</h3>
          <p>UUID: <span class="code">${escapeHtml(d.uuid || 'N/A')}</span></p>
          <p>Plattform: <span class="badge ${d.isBedrock ? 'badge-success' : 'badge-info'}">${d.isBedrock ? 'Bedrock' : 'Java'}</span></p>
          <p>Status: <span class="badge ${d.online ? 'badge-success' : 'badge-default'}">${d.online ? '🟢 Online' : '⚫ Offline'}</span></p>
          ${d.online && live.gamemode ? `<p>Gamemode: <span class="code">${escapeHtml(live.gamemode)}</span></p>` : ''}
        </div>
      </div>

      ${d.online && loc ? `
        <div class="card mb-2" style="margin-top:16px">
          <h4 style="margin-bottom:8px">🗺️ Position</h4>
          <div class="grid grid-4" style="margin:0">
            <div><div class="stat-card-label">Welt</div><div style="font-weight:600;margin-top:4px">${escapeHtml(loc.world || 'overworld')}</div></div>
            <div><div class="stat-card-label">X</div><div style="font-weight:600;margin-top:4px;font-family:monospace">${(loc.x || 0).toFixed(1)}</div></div>
            <div><div class="stat-card-label">Y</div><div style="font-weight:600;margin-top:4px;font-family:monospace">${(loc.y || 0).toFixed(1)}</div></div>
            <div><div class="stat-card-label">Z</div><div style="font-weight:600;margin-top:4px;font-family:monospace">${(loc.z || 0).toFixed(1)}</div></div>
          </div>
        </div>` : ''}

      ${d.online ? `
        <div class="card mb-2" style="margin-top:16px">
          <h4 style="margin-bottom:12px">⚡ Vitalwerte</h4>
          <div style="display:grid;gap:8px">
            <div>
              <div style="display:flex;justify-content:space-between;margin-bottom:4px">
                <span>❤️ Health</span><span><strong>${health.toFixed(1)}</strong> / ${maxHealth}</span>
              </div>
              <div class="progress-bar"><div class="progress-bar-fill" style="width:${(health/maxHealth)*100}%;background:${health > 12 ? 'var(--green)' : health > 6 ? 'var(--yellow)' : 'var(--red)'}"></div></div>
            </div>
            <div>
              <div style="display:flex;justify-content:space-between;margin-bottom:4px">
                <span>🍖 Hunger</span><span><strong>${food.toFixed(0)}</strong> / 20</span>
              </div>
              <div class="progress-bar"><div class="progress-bar-fill" style="width:${(food/20)*100}%;background:${food > 12 ? 'var(--orange)' : food > 6 ? 'var(--yellow)' : 'var(--red)'}"></div></div>
            </div>
            <div>
              <div style="display:flex;justify-content:space-between">
                <span>⭐ XP-Level</span><span><strong>${xpLevel}</strong></span>
              </div>
            </div>
          </div>
        </div>` : ''}

      ${effects.length > 0 ? `
        <div class="card mb-2" style="margin-top:16px">
          <h4 style="margin-bottom:8px">💊 Effekte (${effects.length})</h4>
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            ${effects.map(e => `<span class="badge ${e.amplifier > 0 ? 'badge-purple' : 'badge-info'}" title="Dauer: ${Math.floor(e.duration/20)}s">
              ${escapeHtml(e.displayName || e.name)} ${e.amplifier > 0 ? e.amplifier : ''}
            </span>`).join('')}
          </div>
        </div>` : ''}

      ${inventory.length > 0 ? `
        <div class="card mb-2" style="margin-top:16px">
          <h4 style="margin-bottom:8px">🎒 Hotbar</h4>
          <div class="inventory-grid">
            ${Array.from({length: 9}).map((_, i) => {
              const item = inventory.find(it => it.slot === i);
              return `<div class="inventory-slot ${item ? 'filled' : ''}">
                ${item ? `<div class="inventory-item">${escapeHtml(item.displayName || item.item)}<div class="inventory-count">${item.count}</div></div>` : ''}
              </div>`;
            }).join('')}
          </div>
        </div>` : ''}

      <div class="card mb-2" style="margin-top:16px">
        <h4 style="margin-bottom:8px">⚔️ Statistiken</h4>
        <div class="grid grid-4" style="margin:0">
          <div><div class="stat-card-label">Kills</div><div style="font-size:20px;font-weight:700;margin-top:4px">${stats.kills || 0}</div></div>
          <div><div class="stat-card-label">Deaths</div><div style="font-size:20px;font-weight:700;margin-top:4px">${stats.deaths || 0}</div></div>
          <div><div class="stat-card-label">Mob-Deaths</div><div style="font-size:20px;font-weight:700;margin-top:4px">${stats.mobDeaths || 0}</div></div>
          <div><div class="stat-card-label">K/D</div><div style="font-size:20px;font-weight:700;margin-top:4px">${stats.deaths > 0 ? (stats.kills / stats.deaths).toFixed(2) : stats.kills}</div></div>
        </div>
      </div>

      ${d.rconConnected ? `
        <div class="card" style="margin-top:16px">
          <h4 style="margin-bottom:8px">🎮 Schnellaktionen (RCON)</h4>
          <div class="btn-group">
            <button class="btn btn-sm btn-success" data-rcon-action="heal" data-rcon-player="${escapeHtml(d.name)}">💚 Heilen</button>
            <button class="btn btn-sm btn-success" data-rcon-action="feed" data-rcon-player="${escapeHtml(d.name)}">🍖 Füttern</button>
            <button class="btn btn-sm btn-warning" data-rcon-action="godmode" data-rcon-player="${escapeHtml(d.name)}">🛡️ Godmode</button>
            <button class="btn btn-sm" data-rcon-action="speed" data-rcon-player="${escapeHtml(d.name)}">⚡ Speed</button>
            <button class="btn btn-sm" data-rcon-action="clear-effects" data-rcon-player="${escapeHtml(d.name)}">✨ Clear</button>
            <button class="btn btn-sm" data-rcon-action="creative" data-rcon-player="${escapeHtml(d.name)}">✏️ Creative</button>
            <button class="btn btn-sm" data-rcon-action="survival" data-rcon-player="${escapeHtml(d.name)}">⚔️ Survival</button>
            <button class="btn btn-sm" data-rcon-action="spectator" data-rcon-player="${escapeHtml(d.name)}">👁️ Spectator</button>
            <button class="btn btn-sm btn-danger" data-rcon-action="kill" data-rcon-player="${escapeHtml(d.name)}">💀 Kill</button>
            <button class="btn btn-sm btn-warning" data-rcon-action="teleport-spawn" data-rcon-player="${escapeHtml(d.name)}">🏠 Spawn</button>
            <button class="btn btn-sm" data-rcon-action="give-diamond" data-rcon-player="${escapeHtml(d.name)}">💎 64 Diamond</button>
          </div>
        </div>
      ` : '<p class="text-muted mt-2">⚠️ RCON nicht verbunden - Live-Aktionen nicht verfügbar</p>'}
    </div>`;
}

function bindRconActions() {
  $$('[data-rcon-action]').forEach(btn => {
    btn.onclick = async () => {
      const action = btn.dataset.rconAction;
      const player = btn.dataset.rconPlayer;
      btn.disabled = true;
      const oldText = btn.textContent;
      btn.textContent = '⏳...';
      try {
        await api(`/players/${encodeURIComponent(player)}/command`, { method: 'POST', body: { action } });
        showToast(`Aktion "${action}" ausgeführt`, 'success');
        setTimeout(() => showPlayerDetails(player), 500);
      } catch (e) {
        showToast('Fehler: ' + e.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = oldText;
      }
    };
  });
}

async function handlePlayerAction(action, player) {
  if (action === 'kick') {
    const reason = prompt(`Kick Grund für ${player}?`);
    if (reason === null) return;
    performPlayerAction('kick', player, { reason });
  } else if (action === 'ban') {
    confirmAction(`${player} bannen?`, `Wird permanent gebannt.`, () => {
      const reason = prompt('Ban-Grund?', 'Verstoß gegen Regeln') || 'Kein Grund';
      performPlayerAction('ban', player, { reason });
    });
  } else if (action === 'mute') {
    const reason = prompt(`Mute-Grund für ${player}?`) || 'Stummgeschaltet';
    performPlayerAction('mute', player, { reason });
  }
}

async function performPlayerAction(action, player, extra = {}) {
  try {
    await api('/players/action', { method: 'POST', body: { action, player, ...extra } });
    showToast(`${action} für ${player} ausgeführt`, 'success');
  } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
}

async function renderWorlds() {
  const content = $('#page-content');
  const data = await api('/worlds');
  const worlds = data.worlds || [];

  content.innerHTML = `
    <div class="card">
      <div class="card-header"><div class="card-title">🌍 Welten (${worlds.length})</div></div>
      <div class="grid grid-2">
        ${worlds.map(w => `
          <div class="stat-card">
            <div class="stat-card-header">
              <span class="stat-card-label">${w.type === 'overworld' ? '🌍' : w.type === 'nether' ? '🔥' : '✨'} ${escapeHtml(w.name)}</span>
              <span class="badge ${w.status === 'aktiv' ? 'badge-success' : 'badge-default'}">${w.status}</span>
            </div>
            <div class="stat-card-value">${w.sizeFormatted}</div>
            <div class="stat-card-detail">Typ: ${w.type}</div>
            ${hasPermission('worlds.manage') ? `<div class="btn-group mt-2">
              <button class="btn btn-sm" data-backup-world="${escapeHtml(w.name)}">💾 Backup</button>
            </div>` : ''}
          </div>
        `).join('')}
      </div>
    </div>`;

  $$('[data-backup-world]').forEach(btn => btn.onclick = async () => {
    confirmAction(`Welt ${btn.dataset.backupWorld} sichern?`, 'Backup wird erstellt.', async () => {
      try {
        btn.disabled = true; btn.textContent = '⏳...';
        await api('/worlds/backup', { method: 'POST', body: { name: btn.dataset.backupWorld } });
        showToast('Backup erstellt', 'success');
        btn.textContent = '💾 Backup'; btn.disabled = false;
      } catch (e) { showToast('Fehler: ' + e.message, 'error'); btn.disabled = false; btn.textContent = '💾 Backup'; }
    });
  });
}

async function renderPlugins() {
  const content = $('#page-content');
  const plugins = await api('/plugins');

  content.innerHTML = `
    <div class="card">
      <div class="card-header"><div class="card-title">📦 Plugins (${plugins.filter(p => p.installed).length}/${plugins.length})</div></div>
      <div class="grid grid-2">
        ${plugins.map(p => `
          <div class="stat-card">
            <div class="stat-card-header">
              <span class="stat-card-label">${escapeHtml(p.name)}</span>
              <span class="badge ${p.installed ? 'badge-success' : 'badge-default'}">${p.installed ? '✓ Installiert' : 'Nicht installiert'}</span>
            </div>
            <div class="stat-card-value" style="font-size:16px">v${escapeHtml(p.version || '?')}</div>
            <div class="stat-card-detail">${escapeHtml(p.description || '')}</div>
            <div class="btn-group mt-2">
              ${!p.installed && hasPermission('plugins.install') ? `<button class="btn btn-sm btn-primary" data-install="${p.id}">📥 Installieren</button>` : ''}
              ${p.installed && !p.isServer && hasPermission('plugins.view') ? `<button class="btn btn-sm" data-config="${p.id}">⚙️ Config</button>` : ''}
            </div>
          </div>
        `).join('')}
      </div>
    </div>`;

  $$('[data-install]').forEach(btn => btn.onclick = async () => {
    btn.disabled = true; btn.innerHTML = '⏳...';
    try {
      await api('/plugins/install', { method: 'POST', body: { pluginId: btn.dataset.install } });
      showToast('Plugin installiert', 'success');
      renderPlugins();
    } catch (e) { showToast('Fehler: ' + e.message, 'error'); btn.disabled = false; btn.innerHTML = '📥 Installieren'; }
  });

  $$('[data-config]').forEach(btn => btn.onclick = async () => {
    try {
      const r = await api(`/plugins/${btn.dataset.config}/config`);
      let body = `<h4>${escapeHtml(r.plugin.name)}</h4>`;
      if (r.configs.length === 0) body += '<p class="text-muted">Keine Config-Dateien gefunden. Plugin muss erst gestartet werden.</p>';
      else body += r.configs.map(c => `<div class="mb-2"><h4>${escapeHtml(c.name)}</h4><div class="code-block">${escapeHtml(c.content.substring(0, 2000))}${c.content.length > 2000 ? '...' : ''}</div></div>`).join('');
      showModal('Plugin-Konfiguration', body);
    } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
  });
}

async function renderPermissions() {
  const content = $('#page-content');
  const data = await api('/luckperms/groups');

  content.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div class="card-title">🛡️ LuckPerms (${data.groups.length} Ränge)</div>
        ${hasPermission('permissions.manage') ? `<button class="btn btn-primary" id="lp-new-group">+ Rang</button>` : ''}
      </div>
      <div class="grid grid-2">
        ${data.groups.sort((a,b) => a.weight - b.weight).map(g => `
          <div class="stat-card">
            <div class="stat-card-header">
              <span class="stat-card-label">${escapeHtml(g.name)}</span>
              <span class="badge ${g.name === 'owner' ? 'badge-danger' : g.name === 'admin' ? 'badge-warning' : g.name === 'moderator' ? 'badge-info' : 'badge-default'}">W: ${g.weight}</span>
            </div>
            <div class="stat-card-detail" style="font-size:12px;margin-top:8px"><strong>${g.permissions.length}</strong> Permission(s) ${g.permissions.includes('*') ? '<span class="badge badge-danger" style="margin-left:4px">WILDCARD</span>' : ''}</div>
            <details style="margin-top:8px">
              <summary style="cursor:pointer;font-size:12px;color:var(--text-secondary)">Permissions anzeigen</summary>
              <div style="margin-top:8px;font-family:monospace;font-size:11px;max-height:120px;overflow-y:auto">
                ${g.permissions.map(p => `<div style="padding:2px 0">${escapeHtml(p)}</div>`).join('') || '<div class="text-muted">Keine</div>'}
              </div>
            </details>
            ${hasPermission('permissions.manage') ? `<div class="btn-group mt-2">
              <button class="btn btn-sm" data-add-perm="${escapeHtml(g.name)}">+ Perm</button>
              <button class="btn btn-sm" data-remove-perm="${escapeHtml(g.name)}">- Perm</button>
              ${g.name !== 'owner' ? `<button class="btn btn-sm btn-danger" data-delete-group="${escapeHtml(g.name)}">🗑️</button>` : ''}
            </div>` : ''}
          </div>
        `).join('')}
      </div>
    </div>`;

  $('#lp-new-group')?.addEventListener('click', () => {
    showModal('Neuer Rang', `
      <div class="form-group"><label>Name</label><input type="text" id="new-group-name" placeholder="z.B. Supporter"></div>
      <div class="form-group"><label>Gewicht</label><input type="number" id="new-group-weight" value="20"></div>
    `, [
      (() => { const b=document.createElement('button'); b.className='btn btn-secondary'; b.textContent='Abbrechen'; b.onclick=closeModal; return b; })(),
      (() => { const b=document.createElement('button'); b.className='btn btn-primary'; b.textContent='Erstellen'; b.onclick=async()=>{
        const name = $('#new-group-name').value.trim();
        const weight = parseInt($('#new-group-weight').value);
        if (!name) return showToast('Name erforderlich', 'error');
        try {
          await api('/luckperms/groups', { method: 'POST', body: { action: 'create', group: { name, weight, permissions: [] } } });
          showToast('Rang erstellt', 'success'); closeModal(); renderPermissions();
        } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
      }; return b; })(),
    ]);
  });

  $$('[data-add-perm]').forEach(btn => btn.onclick = () => {
    const group = btn.dataset.addPerm;
    const perm = prompt('Permission hinzufügen:');
    if (!perm) return;
    if (perm === '*' && App.user.role !== 'owner') return showToast('Wildcard nur für Owner', 'error');
    api('/luckperms/permissions', { method: 'POST', body: { group, permission: perm, action: 'add' } })
      .then(() => { showToast('Hinzugefügt', 'success'); renderPermissions(); })
      .catch(e => showToast('Fehler: ' + e.message, 'error'));
  });
  $$('[data-remove-perm]').forEach(btn => btn.onclick = () => {
    const group = btn.dataset.removePerm;
    const perm = prompt('Permission entfernen:');
    if (!perm) return;
    api('/luckperms/permissions', { method: 'POST', body: { group, permission: perm, action: 'remove' } })
      .then(() => { showToast('Entfernt', 'success'); renderPermissions(); })
      .catch(e => showToast('Fehler: ' + e.message, 'error'));
  });
  $$('[data-delete-group]').forEach(btn => btn.onclick = () => {
    const group = btn.dataset.deleteGroup;
    confirmAction(`Rang "${group}" löschen?`, 'Unwiderruflich.', async () => {
      try {
        await api('/luckperms/groups', { method: 'POST', body: { action: 'delete', group: { name: group } } });
        showToast('Gelöscht', 'success'); renderPermissions();
      } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
    });
  });
}

async function renderGeyser() {
  const content = $('#page-content');
  const status = await api('/geyser/status');

  content.innerHTML = `
    <div class="grid grid-3">
      <div class="stat-card ${status.geyserInstalled ? '' : 'alert-warning'}">
        <div class="stat-card-label">Geyser</div>
        <div class="stat-card-value" style="font-size:18px">${status.geyserInstalled ? '🟢 Aktiv' : '🔴 Fehlt'}</div>
      </div>
      <div class="stat-card ${status.floodgateInstalled ? '' : 'alert-warning'}">
        <div class="stat-card-label">Floodgate</div>
        <div class="stat-card-value" style="font-size:18px">${status.floodgateInstalled ? '🟢 Aktiv' : '🔴 Fehlt'}</div>
      </div>
      <div class="stat-card ${status.floodgateKeyExists ? '' : 'alert-warning'}">
        <div class="stat-card-label">Floodgate Key</div>
        <div class="stat-card-value" style="font-size:18px">${status.floodgateKeyExists ? '🔑 OK' : '🔑 Fehlt'}</div>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">🌐 Verbindung</div></div>
      <div class="grid grid-2">
        <div><div class="stat-card-label">Bedrock (UDP)</div><div style="font-size:18px;font-family:monospace;margin-top:4px">${status.bedrockPort}</div></div>
        <div><div class="stat-card-label">Java (TCP)</div><div style="font-size:18px;font-family:monospace;margin-top:4px">${status.javaServerPort}</div></div>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">🛠️ Aktionen</div></div>
      <div class="btn-group">
        <button class="btn btn-primary" id="geyser-test">🔍 Connection Test</button>
        <button class="btn" id="geyser-logs">📋 Logs</button>
      </div>
      <div id="geyser-result" class="mt-2"></div>
    </div>`;

  $('#geyser-test').onclick = async () => {
    const target = $('#geyser-result');
    target.innerHTML = '<div class="spinner"></div> Tests laufen...';
    try {
      const r = await api('/geyser/test', { method: 'POST', body: {} });
      target.innerHTML = `<div class="card">${r.tests.map(t => `
        <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)">
          <span style="font-size:18px">${t.success ? '✅' : '❌'}</span>
          <div style="flex:1"><div><strong>${escapeHtml(t.name)}</strong></div><div style="font-size:12px;color:var(--text-muted)">${escapeHtml(t.target)}</div></div>
          <span class="badge ${t.success ? 'badge-success' : 'badge-danger'}">${t.success ? 'OK' : 'FEHLER'}</span>
        </div>
      `).join('')}</div>`;
    } catch (e) { target.innerHTML = `<p class="text-danger">${escapeHtml(e.message)}</p>`; }
  };

  $('#geyser-logs').onclick = async () => {
    try {
      const r = await api('/geyser/logs');
      showModal('Geyser-Logs', `<div class="code-block">${escapeHtml(r.lines.length ? r.lines.join('\n') : 'Keine Logs')}</div>`);
    } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
  };
}

async function renderBackups() {
  const content = $('#page-content');
  const data = await api('/backups');

  content.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div class="card-title">💾 Backups (${data.backups.length})</div>
        ${hasPermission('backups.create') ? `<button class="btn btn-primary" id="backup-create">+ Backup</button>` : ''}
      </div>
      ${data.backups.length === 0 ? `<div class="empty-state"><div class="icon">💾</div><h3>Keine Backups</h3></div>` : `
        <div class="table-wrapper"><table>
          <thead><tr><th>Name</th><th>Datum</th><th>Größe</th><th>Aktionen</th></tr></thead>
          <tbody>${data.backups.map(b => `
            <tr>
              <td><strong>${escapeHtml(b.name)}</strong></td>
              <td>${formatDate(b.created)}</td>
              <td>${b.sizeFormatted}</td>
              <td><div class="btn-group">
                ${hasPermission('backups.download') ? `<a href="/api/backups/download/${encodeURIComponent(b.name)}" class="btn btn-sm">⬇️</a>` : ''}
                ${hasPermission('backups.restore') ? `<button class="btn btn-sm btn-warning" data-restore="${escapeHtml(b.name)}">♻️</button>` : ''}
                ${hasPermission('backups.delete') ? `<button class="btn btn-sm btn-danger" data-delete="${escapeHtml(b.name)}">🗑️</button>` : ''}
              </div></td>
            </tr>
          `).join('')}</tbody>
        </table></div>
      `}
    </div>`;

  $('#backup-create')?.addEventListener('click', async () => {
    const btn = $('#backup-create'); btn.disabled = true; btn.textContent = '⏳...';
    try {
      await api('/backups/create', { method: 'POST', body: { name: 'manual' } });
      showToast('Backup erstellt', 'success'); renderBackups();
    } catch (e) { showToast('Fehler: ' + e.message, 'error'); btn.disabled = false; btn.textContent = '+ Backup'; }
  });

  $$('[data-restore]').forEach(btn => btn.onclick = () => {
    const name = btn.dataset.restore;
    confirmAction('Backup wiederherstellen?', `⚠️ "${name}" überschreibt alle aktuellen Daten!`, async () => {
      try { await api('/backups/restore', { method: 'POST', body: { name } }); showToast('Wiederhergestellt', 'success'); }
      catch (e) { showToast('Fehler: ' + e.message, 'error'); }
    });
  });
  $$('[data-delete]').forEach(btn => btn.onclick = () => {
    const name = btn.dataset.delete;
    confirmAction(`"${name}" löschen?`, 'Unwiderruflich.', async () => {
      try { await api('/backups/' + encodeURIComponent(name), { method: 'DELETE' }); showToast('Gelöscht', 'success'); renderBackups(); }
      catch (e) { showToast('Fehler: ' + e.message, 'error'); }
    });
  });
}

async function renderPerformance() {
  const content = $('#page-content');
  const data = await api('/performance');

  content.innerHTML = `
    ${data.alerts && data.alerts.length ? `
      <div class="card">
        <div class="card-header"><div class="card-title">⚠️ Warnungen</div></div>
        <div class="grid grid-2">
          ${data.alerts.map(a => `<div class="stat-card ${a.level === 'critical' ? 'alert-critical' : 'alert-warning'}">
            <div class="stat-card-label">${a.icon} ${escapeHtml(a.message)}</div>
          </div>`).join('')}
        </div>
      </div>` : `<div class="card" style="background:rgba(16,185,129,0.05);border-color:rgba(16,185,129,0.3)">
        <div class="card-title text-success">✅ Alles in Ordnung</div></div>`}
    <div class="card">
      <div class="card-header"><div class="card-title">📊 Live Performance</div></div>
      <div class="grid grid-4">
        <div class="stat-card ${(data.server.tps || 20) < 18 ? 'alert-warning' : ''}">
          <div class="stat-card-label">TPS</div>
          <div class="stat-card-value">${(data.server.tps || 20).toFixed(2)}</div>
          <div class="progress-bar mt-1"><div class="progress-bar-fill" style="width:${Math.min(100, (data.server.tps/20)*100)}%;background:${(data.server.tps || 20) < 18 ? 'var(--red)' : 'var(--green)'}"></div></div>
        </div>
        <div class="stat-card ${(data.server.mspt || 0) > 50 ? 'alert-critical' : ''}">
          <div class="stat-card-label">MSPT</div>
          <div class="stat-card-value">${(data.server.mspt || 0).toFixed(2)}</div>
          <div class="progress-bar mt-1"><div class="progress-bar-fill" style="width:${Math.min(100, (data.server.mspt/50)*100)}%;background:${(data.server.mspt || 0) > 50 ? 'var(--red)' : 'var(--green)'}"></div></div>
        </div>
        <div class="stat-card ${(data.cpu || 0) > 80 ? 'alert-warning' : ''}">
          <div class="stat-card-label">CPU</div>
          <div class="stat-card-value">${(data.cpu || 0).toFixed(1)}%</div>
          <div class="progress-bar mt-1"><div class="progress-bar-fill" style="width:${data.cpu}%;background:${(data.cpu || 0) > 80 ? 'var(--orange)' : 'var(--accent)'}"></div></div>
        </div>
        <div class="stat-card ${(data.memory.percent || 0) > 80 ? 'alert-warning' : ''}">
          <div class="stat-card-label">RAM</div>
          <div class="stat-card-value">${data.memory.usedFormatted}</div>
          <div class="stat-card-detail">${(data.memory.percent || 0).toFixed(0)}% von ${data.memory.totalFormatted}</div>
          <div class="progress-bar mt-1"><div class="progress-bar-fill" style="width:${data.memory.percent}%;background:${(data.memory.percent || 0) > 80 ? 'var(--red)' : 'var(--accent)'}"></div></div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">💡 Empfehlungen</div></div>
      <div id="perf-recs"></div>
    </div>`;

  const recs = [];
  if ((data.server.tps || 20) < 18) recs.push('TPS niedrig. view-distance und simulation-distance reduzieren, oder mehr RAM zuweisen.');
  if ((data.server.mspt || 0) > 50) recs.push('MSPT über 50ms verursacht Lag. Plugins und Entity-Counts prüfen.');
  if ((data.memory.percent || 0) > 80) recs.push('RAM-Auslastung über 80%. Maximal-RAM erhöhen.');
  if ((data.cpu || 0) > 80) recs.push('CPU-Auslastung sehr hoch. Chunks reduzieren.');
  if ((data.disk.percent || 0) > 90) recs.push('Festplatte fast voll. Alte Backups löschen.');
  if (recs.length === 0) recs.push('Alle Werte im grünen Bereich.');

  $('#perf-recs').innerHTML = recs.map(r => `<div style="padding:10px 12px;background:var(--bg-tertiary);border-left:3px solid var(--accent);margin-bottom:8px;border-radius:4px">💡 ${escapeHtml(r)}</div>`).join('');
}

async function renderLogs() {
  const content = $('#page-content');
  content.innerHTML = `
    <div class="card">
      <div class="card-header"><div class="card-title">📋 Logs</div></div>
      <div class="btn-group mb-2" id="log-categories">
        <button class="btn btn-sm" data-cat="server">🖥️ Server</button>
        <button class="btn btn-sm" data-cat="geyser">🌐 Geyser</button>
        <button class="btn btn-sm" data-cat="floodgate">🔑 Floodgate</button>
        <button class="btn btn-sm" data-cat="panel">⚙️ Panel</button>
        <button class="btn btn-sm" data-cat="error">❌ Errors</button>
      </div>
      <div class="form-row">
        <div class="form-group"><input type="text" id="log-search" placeholder="🔍 Suchen..."></div>
        <div class="form-group">
          <select id="log-level"><option value="">Alle Level</option><option value="INFO">INFO</option><option value="WARN">WARN</option><option value="ERROR">ERROR</option></select>
        </div>
      </div>
      <div class="code-block" id="log-output" style="max-height:600px">Wähle eine Kategorie...</div>
    </div>`;

  let currentCat = 'server';
  const loadLogs = async () => {
    const search = $('#log-search').value;
    const level = $('#log-level').value;
    const params = new URLSearchParams({ category: currentCat });
    if (search) params.set('search', search);
    if (level) params.set('level', level);
    try {
      const r = await api('/logs?' + params);
      $('#log-output').textContent = r.lines.length ? r.lines.join('\n') : 'Keine Logs.';
    } catch (e) { $('#log-output').textContent = 'Fehler: ' + e.message; }
  };
  $$('#log-categories button').forEach(btn => btn.onclick = () => {
    $$('#log-categories button').forEach(b => b.classList.remove('btn-primary'));
    btn.classList.add('btn-primary');
    currentCat = btn.dataset.cat;
    loadLogs();
  });
  $('#log-categories button[data-cat="server"]').classList.add('btn-primary');
  $('#log-search').oninput = loadLogs;
  $('#log-level').onchange = loadLogs;
  loadLogs();
}

async function renderActivity() {
  const content = $('#page-content');
  const data = await api('/activity');
  const items = data.activities || [];
  content.innerHTML = `<div class="card"><div class="card-header"><div class="card-title">📊 Activity (${items.length})</div></div>
    ${items.length === 0 ? `<div class="empty-state"><div class="icon">📊</div><h3>Keine Aktivität</h3></div>` : `
      <div style="display:flex;flex-direction:column;gap:8px">
        ${items.map(a => `<div style="display:flex;align-items:start;gap:12px;padding:10px;background:var(--bg-tertiary);border-radius:6px;border-left:3px solid ${
          a.type === 'success' ? 'var(--green)' : a.type === 'error' ? 'var(--red)' : a.type === 'warning' ? 'var(--yellow)' : 'var(--accent)'
        }">
          <div style="flex:1"><div>${escapeHtml(a.message)}</div><div style="font-size:11px;color:var(--text-muted);margin-top:4px">${formatRelative(a.timestamp)} · ${formatDate(a.timestamp)}</div></div>
        </div>`).join('')}
      </div>`}
  </div>`;
}

async function renderAudit() {
  const content = $('#page-content');
  const data = await api('/audit');
  const items = data.audits || [];
  content.innerHTML = `<div class="card"><div class="card-header"><div class="card-title">🔒 Audit (${items.length})</div></div>
    ${items.length === 0 ? `<div class="empty-state"><h3>Keine Einträge</h3></div>` : `
      <div class="table-wrapper"><table>
        <thead><tr><th>Zeit</th><th>User</th><th>Aktion</th><th>IP</th></tr></thead>
        <tbody>${items.map(a => `<tr>
          <td>${formatDate(a.timestamp)}</td>
          <td><strong>${escapeHtml(a.user)}</strong></td>
          <td><span class="badge badge-info">${escapeHtml(a.action)}</span></td>
          <td><span class="code">${escapeHtml(a.ip || '-')}</span></td>
        </tr>`).join('')}</tbody>
      </table></div>`}
  </div>`;
}

async function renderSecurity() {
  const content = $('#page-content');
  let stats, ips, banned, suspicious, antiCheat, plugins;
  try {
    [stats, ips, banned, suspicious, antiCheat, plugins] = await Promise.all([
      api('/security/stats'),
      api('/security/ips'),
      api('/security/banned-ips'),
      api('/security/suspicious'),
      api('/security/anticheat'),
      api('/plugins'),
    ]);
  } catch (e) {
    return showToast('Fehler: ' + e.message, 'error');
  }

  const isManage = hasPermission('security.manage');
  const cfg = await api('/settings');
  const security = {
    ipTracking: cfg.ipTrackingEnabled,
    ipBan: cfg.ipBanEnabled,
    antiCheat: cfg.antiCheatAutoBan,
    twoFactor: cfg.twoFactorEnabled,
  };

  const antiCheatPlugins = plugins.filter(p => p.isAntiCheat);

  content.innerHTML = `
    <div class="grid grid-4 mb-3">
      <div class="stat-card">
        <div class="stat-card-label">Bekannte IPs</div>
        <div class="stat-card-value">${stats.ipStats.total}</div>
        <div class="stat-card-detail">${stats.ipStats.multiAccount} Multi-Account</div>
      </div>
      <div class="stat-card ${stats.ipStats.banned > 0 ? 'alert-warning' : ''}">
        <div class="stat-card-label">Gebannte IPs</div>
        <div class="stat-card-value">${stats.ipStats.banned}</div>
        <div class="stat-card-detail">Aktive Sperren</div>
      </div>
      <div class="stat-card ${stats.ipStats.suspicious > 5 ? 'alert-warning' : ''}">
        <div class="stat-card-label">Verdächtig</div>
        <div class="stat-card-value">${stats.ipStats.suspicious}</div>
        <div class="stat-card-detail">Mit Violations</div>
      </div>
      <div class="stat-card ${stats.antiCheatStats.last24h > 10 ? 'alert-warning' : ''}">
        <div class="stat-card-label">Cheat-Reports 24h</div>
        <div class="stat-card-value">${stats.antiCheatStats.last24h}</div>
        <div class="stat-card-detail">${stats.antiCheatStats.flaggedPlayers} Spieler markiert</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">🛡️ Security-Systeme</div>
        ${isManage ? '<button class="btn btn-primary" id="sec-settings">⚙️ Einstellungen</button>' : ''}
      </div>
      <div class="grid grid-3">
        <div class="stat-card ${security.ipTracking ? '' : 'alert-warning'}">
          <div class="stat-card-label">IP-Tracking</div>
          <div class="stat-card-value" style="font-size:18px">${security.ipTracking ? '🟢 Aktiv' : '🔴 Inaktiv'}</div>
          <div class="stat-card-detail">Alle Spieler-IPs werden geloggt</div>
        </div>
        <div class="stat-card ${security.ipBan ? '' : 'alert-warning'}">
          <div class="stat-card-label">IP-Ban</div>
          <div class="stat-card-value" style="font-size:18px">${security.ipBan ? '🟢 Aktiv' : '🔴 Inaktiv'}</div>
          <div class="stat-card-detail">Gebannte IPs können nicht joinen</div>
        </div>
        <div class="stat-card ${security.antiCheat ? '' : 'alert-warning'}">
          <div class="stat-card-label">Auto-Ban</div>
          <div class="stat-card-value" style="font-size:18px">${security.antiCheat ? '🟢 Aktiv' : '🔴 Inaktiv'}</div>
          <div class="stat-card-detail">Auto-Ban bei zu vielen Cheats</div>
        </div>
        <div class="stat-card ${security.twoFactor ? '' : 'alert-warning'}">
          <div class="stat-card-label">2FA</div>
          <div class="stat-card-value" style="font-size:18px">${security.twoFactor ? '🟢 Aktiv' : '🔴 Inaktiv'}</div>
          <div class="stat-card-detail">Two-Factor für Owner</div>
        </div>
        <div class="stat-card">
          <div class="stat-card-label">Brute-Force</div>
          <div class="stat-card-value" style="font-size:18px">🟢 Aktiv</div>
          <div class="stat-card-detail">5 Versuche / 15min</div>
        </div>
        <div class="stat-card">
          <div class="stat-card-label">Connection-Limit</div>
          <div class="stat-card-value" style="font-size:18px">🟢 Aktiv</div>
          <div class="stat-card-detail">Max 3 Verbindungen / IP</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">🛡️ Anti-Cheat Plugins</div>
        ${isManage ? '<button class="btn btn-primary" id="ac-install">+ Plugin installieren</button>' : ''}
      </div>
      <div class="grid grid-2">
        ${antiCheatPlugins.map(p => `
          <div class="stat-card ${p.installed ? '' : 'alert-warning'}">
            <div class="stat-card-header">
              <span class="stat-card-label">${escapeHtml(p.name)}</span>
              <span class="badge ${p.installed ? 'badge-success' : 'badge-default'}">${p.installed ? '✓ Aktiv' : 'Nicht installiert'}</span>
            </div>
            <div class="stat-card-value" style="font-size:14px">${escapeHtml(p.description)}</div>
            <div class="stat-card-detail">Severity: <span class="badge badge-${p.severity === 'high' ? 'danger' : p.severity === 'medium' ? 'warning' : 'default'}">${p.severity}</span></div>
            <div class="btn-group mt-2">
              ${!p.installed && isManage ? `<button class="btn btn-sm btn-primary" data-ac-install="${p.id}">📥 Installieren</button>` : ''}
              ${p.installed ? '<span class="badge badge-success" style="margin-top:4px">Aktiv auf Server</span>' : ''}
            </div>
          </div>
        `).join('')}
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">🚫 Gebannte IPs (${banned.banned.length})</div>
      </div>
      ${banned.banned.length === 0 ? '<div class="empty-state"><div class="icon">✅</div><h3>Keine gebannten IPs</h3></div>' : `
        <div class="table-wrapper"><table>
          <thead><tr><th>IP</th><th>Grund</th><th>Von</th><th>Typ</th><th>Gebannt am</th><th>Läuft ab</th><th></th></tr></thead>
          <tbody>${banned.banned.map(b => `
            <tr>
              <td><code>${b.ip}</code></td>
              <td>${escapeHtml(b.reason || '-')}</td>
              <td>${escapeHtml(b.bannedBy || '-')}</td>
              <td>${b.permanent ? '<span class="badge badge-danger">Permanent</span>' : '<span class="badge badge-warning">Temporär</span>'}</td>
              <td>${formatDate(b.bannedAt)}</td>
              <td>${b.expires ? formatDate(b.expires) : '∞'}</td>
              <td>${isManage ? `<button class="btn btn-sm btn-success" data-unban-ip="${b.ip}">🔓 Entsperren</button>` : '-'}</td>
            </tr>
          `).join('')}</tbody>
        </table></div>
      `}
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">⚠️ Verdächtige IPs (${suspicious.suspicious.length})</div>
      </div>
      ${suspicious.suspicious.length === 0 ? '<div class="empty-state"><div class="icon">✅</div><h3>Keine verdächtigen IPs</h3></div>' : `
        <div class="table-wrapper"><table>
          <thead><tr><th>IP</th><th>Score</th><th>Verstöße</th><th>Erste Aktivität</th><th>Aktionen</th></tr></thead>
          <tbody>${suspicious.suspicious.slice(0, 20).map(s => `
            <tr>
              <td><code>${s.ip}</code></td>
              <td><span class="badge ${s.score > 5 ? 'badge-danger' : s.score > 2 ? 'badge-warning' : 'badge-info'}">${s.score}</span></td>
              <td>${s.reasons.length}</td>
              <td>${formatRelative(s.firstViolation)}</td>
              <td>${isManage ? `<button class="btn btn-sm btn-danger" data-ban-ip="${s.ip}">🚫 Bannen</button>` : '-'}</td>
            </tr>
          `).join('')}</tbody>
        </table></div>
      `}
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">🌐 Bekannte IPs (${ips.ips.length})</div>
        ${isManage ? '<button class="btn btn-primary" id="ip-ban-manual">+ IP manuell bannen</button>' : ''}
      </div>
      <input type="text" class="console-search mb-2" id="ip-search" placeholder="🔍 IP oder Spieler suchen...">
      <div class="table-wrapper"><table id="ip-table">
        <thead><tr><th>IP</th><th>Spieler</th><th>Erstmalig</th><th>Zuletzt</th><th>Verstöße</th><th>Status</th><th></th></tr></thead>
        <tbody id="ip-tbody">${renderIpRows(ips.ips.slice(0, 50), isManage)}</tbody>
      </table></div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">⚠️ Cheat-Violations (${antiCheat.violations.length})</div>
      </div>
      ${antiCheat.violations.length === 0 ? '<div class="empty-state"><div class="icon">✅</div><h3>Keine Violations</h3></div>' : `
        <div class="table-wrapper"><table>
          <thead><tr><th>Spieler</th><th>Check</th><th>Severity</th><th>Zeit</th><th></th></tr></thead>
          <tbody>${antiCheat.violations.slice(0, 20).map(v => `
            <tr>
              <td><strong>${escapeHtml(v.player)}</strong></td>
              <td><span class="code">${escapeHtml(v.violations[0]?.check || '-')}</span></td>
              <td><span class="badge badge-${v.violations[0]?.severity === 'critical' ? 'danger' : v.violations[0]?.severity === 'high' ? 'warning' : 'info'}">${v.violations[0]?.severity || '-'}</span></td>
              <td>${v.violations[0] ? formatRelative(v.violations[0].timestamp) : '-'}</td>
              <td>${isManage ? `<button class="btn btn-sm" data-ac-clear="${escapeHtml(v.player)}">🔄 Reset</button>` : ''}</td>
            </tr>
          `).join('')}</tbody>
        </table></div>
      `}
    </div>
  `;

  $('#sec-settings')?.addEventListener('click', () => showSecuritySettings(cfg));
  $('#ac-install')?.addEventListener('click', () => {
    showModal('Anti-Cheat Plugin installieren', `<p>Wähle ein Plugin aus der Anti-Cheat-Liste aus:</p>
      <div class="btn-group" style="flex-direction:column;align-items:stretch">
        ${antiCheatPlugins.filter(p => !p.installed).map(p => `
          <button class="btn btn-secondary" data-install-ac="${p.id}">
            <strong>${escapeHtml(p.name)}</strong> · ${escapeHtml(p.severity)} · ${escapeHtml(p.description)}
          </button>
        `).join('') || '<p>Alle bereits installiert.</p>'}
      </div>`);
  });

  $('#ip-search')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    const filtered = ips.ips.filter(ip =>
      ip.ip.includes(q) ||
      (ip.players || []).some(p => p.toLowerCase().includes(q))
    );
    $('#ip-tbody').innerHTML = renderIpRows(filtered.slice(0, 50), isManage);
  });

  $('#ip-ban-manual')?.addEventListener('click', () => {
    showModal('IP manuell bannen', `
      <div class="form-group"><label>IP-Adresse</label>
        <input type="text" id="ban-ip" placeholder="192.168.1.1"></div>
      <div class="form-group"><label>Grund</label>
        <input type="text" id="ban-reason" placeholder="Verdächtige Aktivität"></div>
      <div class="form-group"><label>Dauer (Stunden, leer = permanent)</label>
        <input type="number" id="ban-duration" placeholder="24"></div>
    `, [
      (() => { const b = document.createElement('button'); b.className = 'btn btn-secondary'; b.textContent = 'Abbrechen'; b.onclick = closeModal; return b; })(),
      (() => { const b = document.createElement('button'); b.className = 'btn btn-danger'; b.textContent = '🚫 Bannen'; b.onclick = async () => {
        const ip = $('#ban-ip').value.trim();
        const reason = $('#ban-reason').value.trim() || 'Manuell gebannt';
        const duration = $('#ban-duration').value ? parseInt($('#ban-duration').value) : null;
        if (!ip) return showToast('IP erforderlich', 'error');
        try {
          await api('/security/ip/ban', { method: 'POST', body: { ip, reason, duration } });
          showToast(`IP ${ip} gebannt`, 'success');
          closeModal();
          renderSecurity();
        } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
      }; return b; })(),
    ]);
  });

  $$('[data-unban-ip]').forEach(btn => btn.onclick = async () => {
    confirmAction(`IP ${btn.dataset.unbanIp} entsperren?`, 'IP wird wieder zugelassen.', async () => {
      try {
        await api('/security/ip/unban', { method: 'POST', body: { ip: btn.dataset.unbanIp } });
        showToast('Entsperrt', 'success');
        renderSecurity();
      } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
    });
  });

  $$('[data-ban-ip]').forEach(btn => btn.onclick = async () => {
    const reason = prompt(`Grund für Bann von ${btn.dataset.banIp}?`, 'Verdächtige Aktivität');
    if (reason === null) return;
    try {
      await api('/security/ip/ban', { method: 'POST', body: { ip: btn.dataset.banIp, reason } });
      showToast('Gebannt', 'success');
      renderSecurity();
    } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
  });

  $$('[data-ac-clear]').forEach(btn => btn.onclick = async () => {
    try {
      await api('/security/anticheat/clear', { method: 'POST', body: { player: btn.dataset.acClear } });
      showToast('Reset', 'success');
      renderSecurity();
    } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
  });

  $$('[data-install-ac]').forEach(btn => btn.onclick = async () => {
    btn.disabled = true; btn.textContent = '⏳ Installiere...';
    try {
      await api('/security/anticheat/install', { method: 'POST', body: { pluginId: btn.dataset.installAc } });
      showToast('Plugin installiert', 'success');
      closeModal();
      renderSecurity();
    } catch (e) { showToast('Fehler: ' + e.message, 'error'); btn.disabled = false; btn.textContent = btn.dataset.acName || 'Installieren'; }
  });
}

function renderIpRows(ips, isManage) {
  if (ips.length === 0) return '<tr><td colspan="7" class="text-muted" style="text-align:center;padding:20px">Keine IPs gefunden</td></tr>';
  return ips.map(ip => `
    <tr>
      <td><code>${ip.ip}</code></td>
      <td>${(ip.players || []).map(p => `<span class="badge badge-info" style="margin:1px">${escapeHtml(p)}</span>`).join('') || '-'}</td>
      <td>${formatDate(ip.firstSeen)}</td>
      <td>${formatRelative(ip.lastSeen)}</td>
      <td>${ip.violations > 0 ? `<span class="badge badge-warning">${ip.violations}</span>` : '0'}</td>
      <td>${ip.banned ? '<span class="badge badge-danger">Gebannt</span>' : '<span class="badge badge-success">Aktiv</span>'}</td>
      <td>${isManage && !ip.banned ? `<button class="btn btn-sm btn-danger" data-ban-ip="${ip.ip}">🚫</button>` : '-'}</td>
    </tr>
  `).join('');
}

function showSecuritySettings(currentCfg) {
  showModal('Security-Einstellungen', `
    <div class="toggle-row">
      <div class="label-block"><div class="label">IP-Tracking</div><div class="label-desc">Speichere alle Spieler-IPs mit Zeitstempel</div></div>
      <label class="toggle-switch"><input type="checkbox" id="set-ipTracking" ${currentCfg.ipTrackingEnabled ? 'checked' : ''}><span class="toggle-slider"></span></label>
    </div>
    <div class="toggle-row">
      <div class="label-block"><div class="label">IP-Ban aktiviert</div><div class="label-desc">Gebannte IPs können nicht joinen</div></div>
      <label class="toggle-switch"><input type="checkbox" id="set-ipBan" ${currentCfg.ipBanEnabled ? 'checked' : ''}><span class="toggle-slider"></span></label>
    </div>
    <div class="toggle-row">
      <div class="label-block"><div class="label">IP-Ban bei Spieler-Ban</div><div class="label-desc">Auch die IP wird gebannt wenn ein Spieler gebannt wird</div></div>
      <label class="toggle-switch"><input type="checkbox" id="set-ipBanOnBan" ${currentCfg.ipBanOnBan ? 'checked' : ''}><span class="toggle-slider"></span></label>
    </div>
    <div class="toggle-row">
      <div class="label-block"><div class="label">IP-Ban bei Multi-Account</div><div class="label-desc">Wenn mehr als maxAccounts pro IP, wird IP gebannt</div></div>
      <label class="toggle-switch"><input type="checkbox" id="set-ipBanOnMultiAccount" ${currentCfg.ipBanOnMultiAccount ? 'checked' : ''}><span class="toggle-slider"></span></label>
    </div>
    <div class="form-group"><label>Max Accounts pro IP (Multi-Account-Limit)</label>
      <input type="number" id="set-maxAccounts" value="${currentCfg.maxAccountsPerIP || 3}" min="1" max="20">
    </div>
    <div class="toggle-row">
      <div class="label-block"><div class="label">Auto-Ban bei Cheating</div><div class="label-desc">Spieler werden nach Schwellwert automatisch gebannt</div></div>
      <label class="toggle-switch"><input type="checkbox" id="set-antiCheatAutoBan" ${currentCfg.antiCheatAutoBan ? 'checked' : ''}><span class="toggle-slider"></span></label>
    </div>
    <div class="form-group"><label>Auto-Ban Schwellwert (Anzahl Violations)</label>
      <input type="number" id="set-banThreshold" value="${currentCfg.antiCheatBanThreshold || 10}" min="1">
    </div>
    <div class="form-group"><label>Login-Versuche bis Lockout</label>
      <input type="number" id="set-loginAttempts" value="${currentCfg.loginAttemptsLimit || 5}" min="1">
    </div>
    <div class="form-group"><label>Lockout-Dauer (Minuten)</label>
      <input type="number" id="set-lockoutMinutes" value="${currentCfg.loginLockoutMinutes || 15}" min="1">
    </div>
    <div class="toggle-row">
      <div class="label-block"><div class="label">2FA für Owner</div><div class="label-desc">Zwei-Faktor-Authentifizierung aktivieren</div></div>
      <label class="toggle-switch"><input type="checkbox" id="set-twoFactor" ${currentCfg.twoFactorEnabled ? 'checked' : ''}><span class="toggle-slider"></span></label>
    </div>
    <div class="form-group"><label>IP-History Aufbewahrung (Tage)</label>
      <input type="number" id="set-retention" value="${currentCfg.ipHistoryRetention || 90}" min="1">
    </div>
  `, [
    (() => { const b = document.createElement('button'); b.className = 'btn btn-secondary'; b.textContent = 'Abbrechen'; b.onclick = closeModal; return b; })(),
    (() => { const b = document.createElement('button'); b.className = 'btn btn-primary'; b.textContent = 'Speichern'; b.onclick = async () => {
      const body = {
        ipTrackingEnabled: $('#set-ipTracking').checked,
        ipBanEnabled: $('#set-ipBan').checked,
        ipBanOnBan: $('#set-ipBanOnBan').checked,
        ipBanOnMultiAccount: $('#set-ipBanOnMultiAccount').checked,
        maxAccountsPerIP: parseInt($('#set-maxAccounts').value),
        antiCheatAutoBan: $('#set-antiCheatAutoBan').checked,
        antiCheatBanThreshold: parseInt($('#set-banThreshold').value),
        loginAttemptsLimit: parseInt($('#set-loginAttempts').value),
        loginLockoutMinutes: parseInt($('#set-lockoutMinutes').value),
        twoFactorEnabled: $('#set-twoFactor').checked,
        ipHistoryRetention: parseInt($('#set-retention').value),
      };
      try {
        await api('/security/settings', { method: 'PUT', body });
        showToast('Gespeichert', 'success');
        closeModal();
        renderSecurity();
      } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
    }; return b; })(),
  ]);
}

async function renderFiles() { if (window.FileManager) await FileManager.mount(); else $('#page-content').innerHTML = '<div class="empty-state">File-Manager wird geladen...</div>'; }

async function renderRailway() {
  const content = $('#page-content');
  let status, projects, project, variables, deployments, metrics;
  try {
    [status, projects, project, variables, deployments, metrics] = await Promise.all([
      api('/railway/status'),
      api('/railway/projects').catch(() => ({ projects: [] })),
      api('/railway/project').catch(() => ({ project: null })),
      api('/railway/variables').catch(() => ({ variables: {} })),
      api('/railway/deployments').catch(() => ({ deployments: [] })),
      api('/railway/metrics').catch(() => ({ metrics: null })),
    ]);
  } catch (e) {
    return showToast('Fehler: ' + e.message, 'error');
  }

  const isManage = hasPermission('users.manage');
  const isConfigured = status.hasApiKey || status.hasDeployHook;

  content.innerHTML = `
    <div class="grid grid-3 mb-3">
      <div class="stat-card ${isConfigured ? '' : 'alert-warning'}">
        <div class="stat-card-label">Railway-Verbindung</div>
        <div class="stat-card-value" style="font-size:18px">${isConfigured ? '🟢 Konfiguriert' : '🟠 Nicht konfiguriert'}</div>
        <div class="stat-card-detail">${status.hasApiKey ? 'API-Key gesetzt' : status.hasDeployHook ? 'Deploy-Hook gesetzt' : 'Keine Credentials'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-label">Projekt</div>
        <div class="stat-card-value" style="font-size:16px">${project?.project?.name || '-'}</div>
        <div class="stat-card-detail">${project?.project?.id ? 'ID: ' + project.project.id.substring(0, 8) + '...' : 'Kein Projekt geladen'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-label">Public Domain</div>
        <div class="stat-card-value" style="font-size:14px;font-family:monospace">${status.publicDomain || '-'}</div>
        <div class="stat-card-detail">${status.publicDomain ? 'Online erreichbar' : 'Noch nicht öffentlich'}</div>
      </div>
    </div>

    ${metrics.metrics ? `
      <div class="card">
        <div class="card-header"><div class="card-title">📊 Railway-Metriken</div></div>
        <div class="grid grid-4">
          <div class="stat-card">
            <div class="stat-card-label">Memory</div>
            <div class="stat-card-value">${(metrics.metrics.currentMemoryUsageMb || 0).toFixed(0)} MB</div>
            <div class="progress-bar mt-1"><div class="progress-bar-fill" style="width:${Math.min(100, ((metrics.metrics.currentMemoryUsageMb || 0) / 512) * 100)}%"></div></div>
          </div>
          <div class="stat-card">
            <div class="stat-card-label">CPU</div>
            <div class="stat-card-value">${(metrics.metrics.currentCpuUsage || 0).toFixed(1)}%</div>
            <div class="progress-bar mt-1"><div class="progress-bar-fill" style="width:${metrics.metrics.currentCpuUsage || 0}%"></div></div>
          </div>
          <div class="stat-card">
            <div class="stat-card-label">Netzwerk RX</div>
            <div class="stat-card-value" style="font-size:16px">${(metrics.metrics.networkRxBytes || 0).toLocaleString()} B</div>
          </div>
          <div class="stat-card">
            <div class="stat-card-label">Netzwerk TX</div>
            <div class="stat-card-value" style="font-size:16px">${(metrics.metrics.networkTxBytes || 0).toLocaleString()} B</div>
          </div>
        </div>
      </div>
    ` : ''}

    ${!isConfigured ? `
      <div class="card" style="background:rgba(255,154,60,0.05);border-color:rgba(255,154,60,0.3)">
        <div class="card-header"><div class="card-title">⚙️ Railway-Konfiguration</div></div>
        <p style="margin-bottom:16px;color:var(--text-secondary)">Verbinde dein Railway-Konto, um Deployment, Variablen und Metriken direkt aus dem Panel zu verwalten.</p>
        <form id="railway-config-form">
          <div class="form-group">
            <label>API-Key (von <a href="https://railway.app/account/tokens" target="_blank" style="color:var(--accent)">railway.app/account/tokens</a>)</label>
            <input type="password" id="rw-api-key" placeholder="railway_xxxxxxxxxxxxxxxxxx">
            <p class="hint">Format: <code>railway_</code> + 40 Zeichen. Wird sicher in der Panel-Config gespeichert.</p>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Project ID (optional)</label>
              <input type="text" id="rw-project-id" placeholder="auto-erkannt via API">
              <p class="hint">Leer lassen für Auto-Erkennung</p>
            </div>
            <div class="form-group">
              <label>Service ID (optional)</label>
              <input type="text" id="rw-service-id" placeholder="auto-erkannt via API">
            </div>
          </div>
          <div class="form-group">
            <label>Git Repository (für Auto-Deploy)</label>
            <input type="text" id="rw-git-repo" placeholder="https://github.com/user/minecraft-panel.git">
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Git Branch</label>
              <input type="text" id="rw-git-branch" value="main">
            </div>
            <div class="form-group">
              <label>Deploy-Hook URL (Alternative zu API-Key)</label>
              <input type="text" id="rw-deploy-hook" placeholder="https://api.railway.app/hooks/...">
            </div>
          </div>
          <button type="submit" class="btn btn-primary">💾 Speichern & Verbinden</button>
        </form>
      </div>
    ` : `
      <div class="card">
        <div class="card-header">
          <div class="card-title">🚂 Railway-Konfiguration</div>
          ${isManage ? '<button class="btn" id="rw-reconfig">⚙️ Neu konfigurieren</button>' : ''}
        </div>
        <div class="grid grid-2" style="margin:0">
          <div><div class="stat-card-label">API-Key</div><div style="margin-top:4px">${status.hasApiKey ? '✅ Gesetzt' : '❌ Nicht gesetzt'}</div></div>
          <div><div class="stat-card-label">Project ID</div><div style="margin-top:4px;font-family:monospace">${status.projectId ? '✅ ' + status.projectId.substring(0, 12) + '...' : '❌ Nicht gesetzt'}</div></div>
          <div><div class="stat-card-label">Service ID</div><div style="margin-top:4px;font-family:monospace">${status.serviceId ? '✅ ' + status.serviceId.substring(0, 12) + '...' : '❌ Nicht gesetzt'}</div></div>
          <div><div class="stat-card-label">Git Repository</div><div style="margin-top:4px;font-family:monospace;font-size:12px">${status.gitRepo || '-'}</div></div>
        </div>
        <div class="btn-group mt-2">
          ${status.hasApiKey || status.hasDeployHook ? `<button class="btn btn-primary" id="rw-deploy">🚀 Redeploy triggern</button>` : ''}
          ${isManage ? `<button class="btn" id="rw-setup-env">🔧 Auto-Setup (Env-Vars)</button>` : ''}
        </div>
      </div>
    `}

    <div class="card">
      <div class="card-header">
        <div class="card-title">📦 Deployments (${deployments.deployments.length})</div>
      </div>
      ${deployments.deployments.length === 0 ? '<div class="empty-state"><div class="icon">📦</div><h3>Keine Deployments</h3></div>' : `
        <div class="table-wrapper"><table>
          <thead><tr><th>Status</th><th>Commit</th><th>Autor</th><th>Erstellt</th></tr></thead>
          <tbody>${deployments.deployments.map(d => `
            <tr>
              <td><span class="badge ${d.status === 'SUCCESS' ? 'badge-success' : d.status === 'BUILDING' ? 'badge-warning' : d.status === 'FAILED' ? 'badge-danger' : 'badge-info'}">${d.status}</span></td>
              <td>${escapeHtml(d.commitMessage?.substring(0, 50) || '-')}</td>
              <td>${escapeHtml(d.commitAuthor || '-')}</td>
              <td>${formatRelative(d.createdAt)}</td>
            </tr>
          `).join('')}</tbody>
        </table></div>
      `}
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">🔧 Environment-Variablen (${Object.keys(variables.variables || {}).length})</div>
        ${isManage ? '<button class="btn btn-primary" id="rw-add-var">+ Variable</button>' : ''}
      </div>
      ${Object.keys(variables.variables || {}).length === 0 ? '<div class="empty-state">Keine Variablen sichtbar</div>' : `
        <div class="table-wrapper"><table>
          <thead><tr><th>Name</th><th>Wert</th><th></th></tr></thead>
          <tbody>${Object.entries(variables.variables).map(([k, v]) => `
            <tr>
              <td><code>${escapeHtml(k)}</code></td>
              <td><code style="font-size:11px">${escapeHtml(String(v).substring(0, 60))}${String(v).length > 60 ? '...' : ''}</code></td>
              <td>${isManage ? `<button class="btn btn-sm btn-danger" data-rw-del-var="${escapeHtml(k)}">🗑️</button>` : ''}</td>
            </tr>
          `).join('')}</tbody>
        </table></div>
      `}
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">📂 Projekte (${projects.projects.length})</div></div>
      ${projects.projects.length === 0 ? '<div class="empty-state">Keine Projekte sichtbar. API-Key prüfen.</div>' : `
        <div class="grid grid-2">
          ${projects.projects.map(p => `
            <div class="stat-card">
              <div class="stat-card-header">
                <span class="stat-card-label">${escapeHtml(p.name)}</span>
                <span class="badge badge-info">${p.services.edges.length} Services</span>
              </div>
              <div class="stat-card-value" style="font-size:14px">ID: ${p.id.substring(0, 12)}...</div>
              <div class="stat-card-detail">${p.environments.edges.length} Environments</div>
            </div>
          `).join('')}
        </div>
      `}
    </div>
  `;

  $('#railway-config-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      apiKey: $('#rw-api-key').value.trim(),
      projectId: $('#rw-project-id').value.trim(),
      serviceId: $('#rw-service-id').value.trim(),
      environmentId: '',
      deployHookUrl: $('#rw-deploy-hook').value.trim(),
      gitRepo: $('#rw-git-repo').value.trim(),
      gitBranch: $('#rw-git-branch').value.trim() || 'main',
    };
    try {
      await api('/railway/configure', { method: 'POST', body });
      showToast('Railway konfiguriert', 'success');
      renderRailway();
    } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
  });

  $('#rw-reconfig')?.addEventListener('click', () => {
    // Force re-render with config form by clearing config
    showModal('Railway rekonfigurieren', `
      <p>Gib einen neuen API-Key ein oder ändere die Konfiguration:</p>
      <div class="form-group"><label>API-Key</label>
        <input type="password" id="rw-reconfig-key" value="${status.hasApiKey ? '********' : ''}"></div>
      <div class="form-group"><label>Git Repository</label>
        <input type="text" id="rw-reconfig-repo" value="${status.gitRepo || ''}"></div>
    `, [
      (() => { const b = document.createElement('button'); b.className = 'btn btn-secondary'; b.textContent = 'Abbrechen'; b.onclick = closeModal; return b; })(),
      (() => { const b = document.createElement('button'); b.className = 'btn btn-primary'; b.textContent = 'Speichern'; b.onclick = async () => {
        const apiKey = $('#rw-reconfig-key').value;
        const body = {
          apiKey: apiKey === '********' ? '' : apiKey,
          projectId: '', serviceId: '', environmentId: '',
          gitRepo: $('#rw-reconfig-repo').value,
          gitBranch: status.gitBranch || 'main',
        };
        try {
          await api('/railway/configure', { method: 'POST', body });
          showToast('Aktualisiert', 'success');
          closeModal();
          renderRailway();
        } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
      }; return b; })(),
    ]);
  });

  $('#rw-deploy')?.addEventListener('click', async () => {
    if (!confirm('Deployment jetzt triggern?')) return;
    const btn = $('#rw-deploy');
    btn.disabled = true;
    btn.textContent = '⏳ Wird ausgelöst...';
    try {
      await api('/railway/deploy', { method: 'POST', body: {} });
      showToast('Deployment gestartet!', 'success');
      setTimeout(renderRailway, 2000);
    } catch (e) { showToast('Fehler: ' + e.message, 'error'); btn.disabled = false; btn.textContent = '🚀 Redeploy triggern'; }
  });

  $('#rw-setup-env')?.addEventListener('click', async () => {
    try {
      await api('/railway/setup-env', { method: 'POST', body: {} });
      showToast('Env-Variablen eingerichtet', 'success');
    } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
  });

  $('#rw-add-var')?.addEventListener('click', () => {
    showModal('Variable hinzufügen', `
      <div class="form-group"><label>Name</label>
        <input type="text" id="rw-var-name" placeholder="JAVA_HOME"></div>
      <div class="form-group"><label>Wert</label>
        <input type="text" id="rw-var-value" placeholder="/usr/lib/jvm/java-21-openjdk-amd64"></div>
    `, [
      (() => { const b = document.createElement('button'); b.className = 'btn btn-secondary'; b.textContent = 'Abbrechen'; b.onclick = closeModal; return b; })(),
      (() => { const b = document.createElement('button'); b.className = 'btn btn-primary'; b.textContent = 'Hinzufügen'; b.onclick = async () => {
        const name = $('#rw-var-name').value.trim();
        const value = $('#rw-var-value').value;
        if (!name) return showToast('Name erforderlich', 'error');
        try {
          await api('/railway/variables', { method: 'POST', body: { name, value } });
          showToast('Variable gesetzt', 'success');
          closeModal();
          renderRailway();
        } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
      }; return b; })(),
    ]);
  });

  $$('[data-rw-del-var]').forEach(btn => btn.onclick = async () => {
    if (!confirm(`Variable "${btn.dataset.rwDelVar}" löschen?`)) return;
    try {
      await api('/railway/variables/' + encodeURIComponent(btn.dataset.rwDelVar), { method: 'DELETE' });
      showToast('Gelöscht', 'success');
      renderRailway();
    } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
  });
}

async function renderUsers() {
  const content = $('#page-content');
  const data = await api('/users');
  content.innerHTML = `<div class="card">
    <div class="card-header">
      <div class="card-title">👤 Benutzer (${data.users.length})</div>
      <button class="btn btn-primary" id="user-new">+ Benutzer</button>
    </div>
    <div class="table-wrapper"><table>
      <thead><tr><th>Benutzer</th><th>Rolle</th><th>Status</th><th>Letzter Login</th><th></th></tr></thead>
      <tbody>${data.users.map(u => `<tr>
        <td><strong>${escapeHtml(u.username)}</strong></td>
        <td><span class="badge ${u.role === 'owner' ? 'badge-danger' : u.role === 'admin' ? 'badge-warning' : u.role === 'moderator' ? 'badge-info' : 'badge-default'}">${escapeHtml(data.roles[u.role]?.name || u.role)}</span></td>
        <td>${u.active ? '<span class="badge badge-success">Aktiv</span>' : '<span class="badge badge-default">Inaktiv</span>'}</td>
        <td>${u.lastLogin ? formatRelative(u.lastLogin) : 'Nie'}</td>
        <td>${u.active && u.username !== App.user.username ? `<button class="btn btn-sm btn-danger" data-delete-user="${u.id}">🗑️</button>` : '<span class="text-muted">-</span>'}</td>
      </tr>`).join('')}</tbody>
    </table></div>
  </div>`;

  $('#user-new').onclick = () => {
    showModal('Neuer Benutzer', `
      <div class="form-group"><label>Benutzername</label><input type="text" id="new-user-name"></div>
      <div class="form-group"><label>Passwort (≥8 Zeichen)</label><input type="password" id="new-user-pw"></div>
      <div class="form-group"><label>Rolle</label>
        <select id="new-user-role">
          <option value="viewer">Viewer</option><option value="moderator">Moderator</option>
          <option value="admin">Admin</option><option value="owner">Owner</option>
        </select></div>
    `, [
      (() => { const b=document.createElement('button'); b.className='btn btn-secondary'; b.textContent='Abbrechen'; b.onclick=closeModal; return b; })(),
      (() => { const b=document.createElement('button'); b.className='btn btn-primary'; b.textContent='Erstellen'; b.onclick=async()=>{
        const username = $('#new-user-name').value.trim();
        const password = $('#new-user-pw').value;
        const role = $('#new-user-role').value;
        if (!username || !password) return showToast('Felder erforderlich', 'error');
        try { await api('/users', { method: 'POST', body: { username, password, role } });
          showToast('Erstellt', 'success'); closeModal(); renderUsers();
        } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
      }; return b; })(),
    ]);
  };
  $$('[data-delete-user]').forEach(btn => btn.onclick = () => {
    confirmAction('Benutzer deaktivieren?', 'Kann sich nicht mehr anmelden.', async () => {
      try { await api('/users/' + btn.dataset.deleteUser, { method: 'DELETE' });
        showToast('Deaktiviert', 'success'); renderUsers();
      } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
    });
  });
}

// WEBSOCKET

function connectWebSocket() {
  if (App.ws) { try { App.ws.close(); } catch (e) {} }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  App.ws = new WebSocket(`${proto}//${location.host}/ws`);

  App.ws.onopen = () => console.log('WS connected');
  App.ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'status') {
        App.serverStatus = msg.data;
        updateStatusDisplay();
      } else if (msg.type === 'system') {
        App.systemStats = msg.data;
      } else if (msg.type === 'console' && App.currentPage === 'console') {
        App.consoleBuffer.push(msg.line);
        if (App.consoleBuffer.length > App.maxConsoleLines) App.consoleBuffer.shift();
        renderConsoleLines();
      }
    } catch (e) {}
  };
  App.ws.onclose = () => setTimeout(connectWebSocket, 3000);
  App.ws.onerror = () => {};
}

function updateStatusDisplay() {
  const status = App.serverStatus;
  if (!status) return;
  const pill = $('#status-pill');
  pill.className = 'status-pill ' + (status.status || 'offline');
  const labels = { online: '🟢 Online', offline: '🔴 Offline', starting: '🟠 Starting', stopping: '🟠 Stopping', error: '⚠️ Error' };
  $('#status-text').textContent = labels[status.status] || 'Offline';
  $('#uptime-display').textContent = status.uptime ? `Uptime: ${formatUptime(status.uptime)}` : '';
}

async function init() {
  $('#login-form').onsubmit = (e) => {
    e.preventDefault();
    login($('#login-username').value, $('#login-password').value);
  };
  $('#logout-btn').onclick = logout;
  $('#modal-close').onclick = closeModal;
  $('#modal-overlay').onclick = (e) => { if (e.target.id === 'modal-overlay') closeModal(); };
  $('#sidebar-toggle').onclick = () => $('#sidebar').classList.toggle('open');
  $('#sidebar-toggle-mobile').onclick = () => $('#sidebar').classList.toggle('open');
  $('#wizard-prev').onclick = wizardPrev;
  $('#wizard-next').onclick = wizardNext;

  try {
    const setup = await api('/setup/status');
    if (!setup.initialized) { showWizard(); return; }
  } catch (e) {}

  if (await checkAuth()) {
    showMain();
    connectWebSocket();
    setInterval(async () => {
      try {
        const status = await fetch('/api/server/status').then(r => r.json());
        App.serverStatus = status;
        updateStatusDisplay();
      } catch (e) {}
      try {
        const sys = await api('/system/stats');
        App.systemStats = sys;
      } catch (e) {}
    }, 5000);
  } else {
    showLogin();
  }
}

document.addEventListener('DOMContentLoaded', init);
