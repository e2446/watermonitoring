const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  username: 'redlink',
  password: 'redlink123456',
  applications: [
    { id: 1298, name: 'PrepaidWaterMeter-042026' },
    { id: 1285, name: 'Cyble-032026' }
  ],
  host: 'sindconiot.com',
  refreshInterval: 60000,
  port: 3000,
  historyFile: path.join(__dirname, 'history.json'),
  maxSnapshotsPerMeter: 2000  // keep up to ~2000 readings per meter
};

let cachedToken = null;
let cachedData = {};
let lastUpdated = null;
let tokenExpiry = 0;
let history = {};  // { "sn_or_devEUI": [ { ts, meterReading, battery, rssi, valve }, ... ] }

// ── PHILIPPINE TIME (UTC+8) ──
function getPHTTime() {
  const now = new Date();
  // Offset to UTC+8
  const phtOffset = 8 * 60; // minutes
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const pht = new Date(utc + phtOffset * 60000);
  // Format: 2026-05-23 14:32:00 PHT
  const pad = n => String(n).padStart(2,'0');
  return `${pht.getFullYear()}-${pad(pht.getMonth()+1)}-${pad(pht.getDate())} ${pad(pht.getHours())}:${pad(pht.getMinutes())}:${pad(pht.getSeconds())} PHT`;
}

function getPHTISO() {
  const now = new Date();
  const phtOffset = 8 * 60;
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const pht = new Date(utc + phtOffset * 60000);
  const pad = n => String(n).padStart(2,'0');
  return `${pht.getFullYear()}-${pad(pht.getMonth()+1)}-${pad(pht.getDate())}T${pad(pht.getHours())}:${pad(pht.getMinutes())}:${pad(pht.getSeconds())}+08:00`;
}

// ── LOAD HISTORY ──
function loadHistory() {
  try {
    if (fs.existsSync(CONFIG.historyFile)) {
      history = JSON.parse(fs.readFileSync(CONFIG.historyFile, 'utf8'));
      const total = Object.values(history).reduce((s,a)=>s+a.length,0);
      console.log(`[History] Loaded ${Object.keys(history).length} meters, ${total} snapshots`);
    }
  } catch(e) { console.error('[History] Load error:', e.message); history = {}; }
}

function saveHistory() {
  try {
    fs.writeFileSync(CONFIG.historyFile, JSON.stringify(history), 'utf8');
  } catch(e) { console.error('[History] Save error:', e.message); }
}

function recordSnapshot(nodes) {
  const ts = getPHTISO();
  let changed = false;
  nodes.forEach(n => {
    const key = n.sn || n.name || n.devEUI;
    if (!key) return;
    if (!history[key]) history[key] = [];
    const snap = {
      ts,
      devEUI: n.devEUI,
      appName: n._appName,
      meterReading: n.meterReading !== undefined ? parseFloat(n.meterReading) : null,
      battery: n.batteryLevel || n.battery || null,
      rssi: n.rssi || null,
      snr: n.snr || null,
      valve: n.valve || null,
      temperature: n.mCUTemp || null,
      rebootCount: n.rebootCount || null,
    };
    // avoid duplicate consecutive identical readings
    const last = history[key][history[key].length - 1];
    if (!last || last.meterReading !== snap.meterReading || last.battery !== snap.battery) {
      history[key].push(snap);
      if (history[key].length > CONFIG.maxSnapshotsPerMeter)
        history[key] = history[key].slice(-CONFIG.maxSnapshotsPerMeter);
      changed = true;
    }
  });
  if (changed) saveHistory();
}

// ── HTTP ──
function httpsRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function login() {
  console.log('[Auth] Logging in...');
  const body = JSON.stringify({ username: CONFIG.username, password: CONFIG.password });
  const res = await httpsRequest({
    hostname: CONFIG.host, path: '/api/internal/login', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Accept': 'application/json' }
  }, body);
  if (res.status === 200 && res.data?.jwt) {
    cachedToken = res.data.jwt;
    try {
      const payload = JSON.parse(Buffer.from(cachedToken.split('.')[1], 'base64').toString());
      tokenExpiry = payload.exp * 1000;
    } catch(e) {}
    console.log('[Auth] ✅ Login OK, token until', new Date(tokenExpiry).toLocaleString());
    return true;
  }
  console.error('[Auth] ❌ Failed:', res.status);
  return false;
}

async function ensureToken() {
  if (!cachedToken || Date.now() > tokenExpiry - 60000) return await login();
  return true;
}

async function fetchAppNodes(app) {
  const res = await httpsRequest({
    hostname: CONFIG.host,
    path: `/api/applications/${app.id}/nodes?limit=100&offset=0&sortField=deveui&order=0&match=`,
    method: 'GET',
    headers: { 'Grpc-Metadata-Authorization': cachedToken, 'Accept': 'application/json' }
  });
  if (res.status === 401) return null;
  if (res.status === 200 && res.data) {
    const nodes = res.data.result || res.data.nodes || (Array.isArray(res.data) ? res.data : []);
    return nodes.map(n => ({ ...n, _appName: app.name, _appId: app.id }));
  }
  return [];
}

async function fetchAll() {
  const ok = await ensureToken();
  if (!ok) return;
  const allNodes = [];
  for (const app of CONFIG.applications) {
    let nodes = await fetchAppNodes(app);
    if (nodes === null) {
      cachedToken = null;
      if (await login()) nodes = await fetchAppNodes(app) || [];
      else nodes = [];
    }
    cachedData[app.id] = { name: app.name, nodes };
    allNodes.push(...nodes);
    console.log(`[Data] ✅ "${app.name}" — ${nodes.length} nodes`);
  }
  lastUpdated = getPHTISO();
  recordSnapshot(allNodes);
  console.log(`[Data] Total: ${allNodes.length} nodes | History: ${Object.keys(history).length} meters tracked`);
}

// ── SERVER ──
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/api/nodes') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ applications: cachedData, lastUpdated }));
    return;
  }

  if (req.url === '/api/refresh') {
    fetchAll().then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, lastUpdated }));
    });
    return;
  }

  if (req.url === '/api/history') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(history));
    return;
  }

  // History for a specific meter: /api/history/SN
  if (req.url.startsWith('/api/history/')) {
    const key = decodeURIComponent(req.url.replace('/api/history/', ''));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(history[key] || []));
    return;
  }

  // Serve static files
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url.slice(1));
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(fs.readFileSync(filePath));
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

loadHistory();
server.listen(CONFIG.port, '0.0.0.0', async () => {
  console.log(`\n🚀 Dashboard → http://localhost:${CONFIG.port}`);
  await fetchAll();
  setInterval(fetchAll, CONFIG.refreshInterval);
  console.log(`⏱  Auto-refresh every ${CONFIG.refreshInterval/1000}s\n`);
});
