const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Nodemailer (install with: npm install nodemailer) ──
let nodemailer;
try { nodemailer = require('nodemailer'); } catch(e) {
  console.warn('[Email] nodemailer not installed. Run: npm install nodemailer');
}

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
  customersFile: path.join(__dirname, 'customers.json'),
  maxSnapshotsPerMeter: 2000,
  googleSheetURL: 'https://docs.google.com/spreadsheets/d/1JGwdwxvQoF9P8DdC0SZ3D9IH8npnd60ExbTXIpqQeIw/export?format=csv&gid=1333564699',

  // ── GMAIL SETTINGS ──────────────────────────────────────────────────────────
  // Step 1: Replace with your Gmail address
  gmail: {
    from:         'Redlink Water Utility <redlinkresearchdevelopment@gmail.com>',
    user:         'redlinkresearchdevelopment@gmail.com',
    appPassword:  'rpdd hpta qgxr ncko',
  },

  // ── AUTO-BILLING SCHEDULER ─────────────────────────────────────────────────
  autoBilling: {
    enabled:       true,       // set false to disable
    // Day of month the bill is DUE (e.g. 25 = 25th of every month)
    dueDayOfMonth: 25,
    // How many days BEFORE the due date to send the email reminder (default 20)
    daysBefore:    20,
    // What time each day to run the check — 24-hr PHT (e.g. 8 = 8:00 AM)
    runHour:       8,
    runMinute:     0,
    // Log file to track which meters were already emailed this month
    logFile:       path.join(__dirname, 'autobilling-log.json'),

    // Water rate defaults used for auto-generated bills
    rates: {
      minCharge:   120,
      minCubic:    10,
      perCubic:    15,
      envFee:      5,
      sysCharge:   10,
      vatPct:      12,
      utilityName: 'Redlink Water Utility',
      address:     'Ormoc City, Leyte',
    },
  },
  // ───────────────────────────────────────────────────────────────────────────
};

let cachedToken = null;
let cachedData = {};
let lastUpdated = null;
let tokenExpiry = 0;
let history = {};
let customers = {}; // { meterTagNumber: customerData }

// ── LOAD/SAVE CUSTOMERS ──
function loadCustomers() {
  try {
    if (fs.existsSync(CONFIG.customersFile)) {
      customers = JSON.parse(fs.readFileSync(CONFIG.customersFile, 'utf8'));
      console.log(`[Customers] Loaded ${Object.keys(customers).length} customers from cache`);
    }
  } catch(e) { console.error('[Customers] Load error:', e.message); customers = {}; }
}

function saveCustomers() {
  try { fs.writeFileSync(CONFIG.customersFile, JSON.stringify(customers, null, 2)); }
  catch(e) { console.error('[Customers] Save error:', e.message); }
}

// ── CSV PARSER ──
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim());
  return lines.slice(1).map(line => {
    const vals = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { vals.push(cur); cur = ''; continue; }
      cur += ch;
    }
    vals.push(cur);
    const obj = {};
    headers.forEach((h, i) => obj[h] = (vals[i] || '').trim());
    return obj;
  });
}

function httpsGet(urlStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': 'Node.js' }
    }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        return resolve(httpsGet(res.headers.location));
      }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, text: d }));
    });
    req.on('error', reject);
    req.end();
  });
}

// fetchCustomersFromSheet is now triggered by the browser sending CSV text
// via POST /api/customers/sync  (avoids Google's server-side IP block)
async function fetchCustomersFromSheet() {
  try {

    console.log('[Customers] Fetching Google Sheet CSV...');

    const response = await httpsGet(CONFIG.googleSheetURL);

    if (response.status !== 200) {
      console.error('[Customers] Failed to fetch CSV:', response.status);
      return;
    }

    const count = importCustomersFromCSV(response.text);

    console.log(`[Customers] ✅ Synced ${count} customers from Google Sheets!`);

  } catch (e) {
    console.error('[Customers] Sync error:', e.message);
  }
}
function importCustomersFromCSV(csvText, merge) {
  const rows = parseCSV(csvText);

  if (!rows.length) {
    console.log('[Customers] CSV empty');
    return 0;
  }

  console.log('[Customers] Columns:', Object.keys(rows[0]).join(' | '));

  // If merge=true, keep existing customers and only add/update new ones
  if (!merge) customers = {};

  rows.forEach(row => {

    // FORCE AS STRING
    let rawTag = row['Meter Tag Number'] || row['meterTagNumber'] || '';

    // Convert safely to string
    let tag = String(rawTag).trim();

    // Preserve leading zeros
    // If Google removed first zero and length is 15
    if (tag.length === 15) {
      tag = '0' + tag;
    }

    // Remove scientific notation issue
    if (tag.includes('E+') || tag.includes('e+')) {
      tag = Number(tag).toLocaleString('fullwide', {
        useGrouping: false
      });
    }

    if (!tag) return;

    customers[tag] = {
      fullName: row['Full Name'] || row['fullName'] || '',
      address: row['Address'] || row['address'] || '',
      contactNumber: row['Contact Number'] || row['contactNumber'] || '',
      emailAddress: row['Email Address'] || row['emailAddress'] || '',
      timestamp: row['Timestamp'] || row['timestamp'] || '',
      meterTagNumber: tag
    };
  });

  saveCustomers();

  console.log(`[Customers] ✅ Imported ${Object.keys(customers).length} customers`);

  return Object.keys(customers).length;
}


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
  // Check no-consumption alarms after every data refresh
  checkNoConsumptionAlarms(allNodes).catch(e => console.error('[NoConsAlarm] Error:', e.message));
}

// ── SERVER ──
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/api/alarms/no-consumption') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getNoConsumptionAlarmList()));
    return;
  }

  // POST /api/alarms/send-problem-alert — send email for a problem meter
  if (req.url === '/api/alarms/send-problem-alert' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { sn, devEUI, appName, email, customerName } = JSON.parse(body);
        if (!email) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'No email address provided' }));
          return;
        }
        if (!nodemailer) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'nodemailer not installed. Run: npm install nodemailer' }));
          return;
        }
        const transporter = createTransporter();
        if (!transporter) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Email transporter failed to initialize' }));
          return;
        }
        const now = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' });
        // Find node details from cache
        let meterReading = '—', lastSeen = '—', status = '—';
        for (const app of Object.values(cachedData)) {
          const node = (app.nodes || []).find(n => (n.sn || n.name) === sn || n.devEUI === devEUI);
          if (node) {
            meterReading = node.meterReading != null ? parseFloat(node.meterReading).toFixed(3) + ' m³' : '—';
            const t = node.lastActive || node.lastUpdate;
            lastSeen = t ? new Date(t).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : '—';
            const diff = t ? Date.now() - new Date(t).getTime() : Infinity;
            status = diff < 4*3600000 ? 'Online' : diff < 48*3600000 ? 'Stale' : 'Offline';
            break;
          }
        }
        const subject = `⚠️ Water Meter Problem Alert — Meter ${sn}`;
        const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f7f8fa;padding:24px;border-radius:12px">
  <div style="background:#0d0f14;padding:20px 24px;border-radius:8px;margin-bottom:20px;text-align:center">
    <h1 style="color:#00d4ff;font-size:22px;margin:0">⚠️ Meter Problem Alert</h1>
    <p style="color:#6b7399;margin:6px 0 0;font-size:13px">Redlink LoRaWAN Water Monitoring</p>
  </div>
  <p style="font-size:14px;color:#333">Dear <strong>${customerName || 'Customer'}</strong>,</p>
  <p style="font-size:14px;color:#333">This is an automated alert from <strong>Redlink Water Monitoring</strong>. Your water meter has been flagged as having a problem and requires attention.</p>
  <table style="width:100%;border-collapse:collapse;margin:18px 0;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e0e4f0">
    <tr style="background:#f0f4ff"><td style="padding:10px 16px;font-weight:700;font-size:13px;color:#333;border-bottom:1px solid #e0e4f0;width:40%">Serial Number</td><td style="padding:10px 16px;font-size:13px;font-family:monospace;color:#1a237e;border-bottom:1px solid #e0e4f0">${sn}</td></tr>
    <tr><td style="padding:10px 16px;font-weight:700;font-size:13px;color:#333;border-bottom:1px solid #e0e4f0">Device EUI</td><td style="padding:10px 16px;font-size:12px;font-family:monospace;color:#448aff;border-bottom:1px solid #e0e4f0">${devEUI || '—'}</td></tr>
    <tr style="background:#f0f4ff"><td style="padding:10px 16px;font-weight:700;font-size:13px;color:#333;border-bottom:1px solid #e0e4f0">Application</td><td style="padding:10px 16px;font-size:13px;border-bottom:1px solid #e0e4f0">${appName || '—'}</td></tr>
    <tr><td style="padding:10px 16px;font-weight:700;font-size:13px;color:#333;border-bottom:1px solid #e0e4f0">Current Reading</td><td style="padding:10px 16px;font-size:13px;font-weight:700;color:${meterReading.startsWith('0.000')?'#ff8f00':'#333'};border-bottom:1px solid #e0e4f0">${meterReading}</td></tr>
    <tr style="background:#f0f4ff"><td style="padding:10px 16px;font-weight:700;font-size:13px;color:#333;border-bottom:1px solid #e0e4f0">Status</td><td style="padding:10px 16px;font-size:13px;font-weight:700;color:${status==='Online'?'#00b359':status==='Stale'?'#e65100':'#c62828'};border-bottom:1px solid #e0e4f0">${status}</td></tr>
    <tr><td style="padding:10px 16px;font-weight:700;font-size:13px;color:#333">Last Data Received</td><td style="padding:10px 16px;font-size:13px;color:#555">${lastSeen}</td></tr>
  </table>
  <div style="background:#fff3e0;border:1px solid #ffcc80;border-radius:8px;padding:14px 18px;margin:18px 0">
    <p style="margin:0;font-size:13px;color:#e65100"><strong>⚠️ Possible issues:</strong></p>
    <ul style="margin:8px 0 0 18px;font-size:13px;color:#555">
      <li>Zero or no water consumption detected — possible closed valve, meter fault, or installation issue</li>
      <li>Meter has been offline or not transmitting for an extended period</li>
      <li>Unusually high water consumption rate detected — possible leak or tampering</li>
    </ul>
  </div>
  <p style="font-size:13px;color:#555">Please check your water meter or contact Redlink support if you believe there is an issue.</p>
  <p style="font-size:12px;color:#aaa;margin-top:24px;border-top:1px solid #e0e4f0;padding-top:12px">This alert was generated on <strong>${now}</strong> PHT by Redlink LoRaWAN Monitoring System.</p>
</div>`;
        await transporter.sendMail({ from: CONFIG.gmail.from, to: email, subject, html });
        console.log(`[Problem Alert] Sent to ${email} for meter ${sn}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sentTo: email }));
      } catch(e) {
        console.error('[Problem Alert] Error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

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

  if (req.url === '/api/customers') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(customers));
    return;
  }

  // POST /api/customers/sync  — browser fetches CSV and sends it here
  if (req.url === '/api/customers/sync' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { csv, merge } = payload;
        const count = importCustomersFromCSV(csv, merge);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // GET /api/customers/sync kept for backward compat (no-op now)
  if (req.url === '/api/customers/sync') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, count: Object.keys(customers).length }));
    return;
  }

  // ── GET /api/autobilling/status ──
  if (req.url === '/api/autobilling/status') {
    const cfg = CONFIG.autoBilling;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      enabled:       cfg.enabled,
      dueDayOfMonth: cfg.dueDayOfMonth,
      daysBefore:    cfg.daysBefore,
      sendDay:       cfg.dueDayOfMonth - cfg.daysBefore,
      runHour:       cfg.runHour,
      runMinute:     cfg.runMinute,
      log:           autoBillingLog,
    }));
    return;
  }

  // ── POST /api/autobilling/run — manually trigger now (for testing) ──
  if (req.url === '/api/autobilling/run' && req.method === 'POST') {
    runAutoBilling().then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Auto-billing run complete. Check server console.' }));
    }).catch(e => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    });
    return;
  }

  // ── DELETE /api/autobilling/log — clear sent log ──
  if (req.url === '/api/autobilling/log' && req.method === 'DELETE') {
    autoBillingLog = {};
    saveAutoBillingLog();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Auto-billing log cleared.' }));
    return;
  }

  // ── GET /api/history — all meters ──
  if (req.url === '/api/history') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(history));
    return;
  }

  // ── GET /api/history/SN — specific meter ──
  if (req.url.startsWith('/api/history/')) {
    const key = decodeURIComponent(req.url.replace('/api/history/', ''));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(history[key] || []));
    return;
  }

  // ── POST /api/send-bill  — renders bill HTML and emails it ──
  if (req.url === '/api/send-bill' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const { customer, bill, meter, rates, period, billNo, dueDate } = payload;

        if (!customer || !customer.emailAddress) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'No email address for this customer.' }));
          return;
        }
        if (!nodemailer) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'nodemailer not installed. Run: npm install nodemailer' }));
          return;
        }
        const cfg = CONFIG.gmail;
        if (!cfg.appPassword || cfg.appPassword.startsWith('xxxx')) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Gmail App Password not configured in server.js CONFIG.gmail.' }));
          return;
        }

        const transporter = createTransporter();

        const html = buildEmailHTML({ customer, bill, meter, rates, period, billNo, dueDate });

        await transporter.sendMail({
          from:    cfg.from,
          to:      `${customer.fullName} <${customer.emailAddress}>`,
          subject: `💧 Water Bill — ${period} | ${billNo}`,
          html,
        });

        console.log(`[Email] ✅ Bill sent to ${customer.emailAddress} (${billNo})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, to: customer.emailAddress }));
      } catch(e) {
        console.error('[Email] ❌', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
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

// ── BUILD EMAIL HTML ──────────────────────────────────────────────────────────
function buildEmailHTML({ customer, bill, meter, rates, period, billNo, dueDate }) {
  const fmt  = v => '₱' + parseFloat(v).toFixed(2);
  const fmtM = v => parseFloat(v).toFixed(3) + ' m³';
  const due  = dueDate ? new Date(dueDate).toLocaleDateString('en-PH',{year:'numeric',month:'long',day:'numeric'}) : '—';
  const excess = Math.max(0, meter.consumed - rates.minCubic);

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Water Bill — ${billNo}</title></head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f8;padding:30px 0">
<tr><td align="center">
<table width="620" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10)">

  <!-- HEADER -->
  <tr><td style="background:linear-gradient(135deg,#0d7abf 0%,#0a5a8f 100%);padding:32px 36px">
    <table width="100%"><tr>
      <td><span style="font-size:28px;font-weight:900;color:#fff;letter-spacing:1px">💧 ${rates.utilityName}</span><br>
          <span style="font-size:13px;color:rgba(255,255,255,0.75)">${rates.address}</span></td>
      <td align="right"><span style="font-size:22px;font-weight:700;color:#fff">WATER BILL</span><br>
          <span style="font-size:12px;color:rgba(255,255,255,0.75);font-family:monospace">${billNo}</span><br>
          <span style="font-size:12px;color:rgba(255,255,255,0.75)">${period}</span></td>
    </tr></table>
  </td></tr>

  <!-- DUE DATE BANNER -->
  <tr><td style="background:#fff3cd;padding:12px 36px;border-bottom:3px solid #ffb300">
    <span style="font-size:14px;color:#7a5c00">⏰ <strong>Payment Due:</strong> ${due} &nbsp;·&nbsp; Please pay on or before this date to avoid disconnection.</span>
  </td></tr>

  <!-- CUSTOMER & METER INFO -->
  <tr><td style="padding:28px 36px 0">
    <table width="100%" cellpadding="0" cellspacing="0">
    <tr valign="top">
      <td width="48%" style="background:#f8fafc;border-radius:8px;padding:18px 20px;border:1px solid #e2e8f0">
        <p style="margin:0 0 12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#64748b">Account Information</p>
        <p style="margin:0 0 6px;font-size:16px;font-weight:700;color:#1e293b">${customer.fullName}</p>
        <p style="margin:0 0 4px;font-size:13px;color:#64748b">${customer.address}</p>
        <p style="margin:0 0 4px;font-size:13px;color:#64748b">📞 ${customer.contactNumber}</p>
        <p style="margin:0;font-size:13px;color:#64748b">✉️ ${customer.emailAddress}</p>
      </td>
      <td width="4%"></td>
      <td width="48%" style="background:#f8fafc;border-radius:8px;padding:18px 20px;border:1px solid #e2e8f0">
        <p style="margin:0 0 12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#64748b">Meter Information</p>
        <p style="margin:0 0 5px;font-size:12px;color:#64748b">Serial: <strong style="color:#1e293b;font-family:monospace">${meter.key}</strong></p>
        <p style="margin:0 0 5px;font-size:12px;color:#64748b">Device EUI: <strong style="color:#1e293b;font-family:monospace;font-size:11px">${meter.devEUI || '—'}</strong></p>
        <p style="margin:0 0 5px;font-size:12px;color:#64748b">Billing Period: <strong style="color:#1e293b">${period}</strong></p>
        <p style="margin:0;font-size:12px;color:#64748b">Type: <strong style="color:#1e293b">LoRaWAN Smart Meter</strong></p>
      </td>
    </tr>
    </table>
  </td></tr>

  <!-- CONSUMPTION TABLE -->
  <tr><td style="padding:24px 36px 0">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:8px;overflow:hidden;border:1px solid #e2e8f0">
      <tr style="background:#0d7abf">
        <th style="padding:12px 16px;text-align:left;font-size:12px;color:#fff;font-weight:700;text-transform:uppercase;letter-spacing:.06em">Description</th>
        <th style="padding:12px 16px;text-align:left;font-size:12px;color:#fff;font-weight:700;text-transform:uppercase;letter-spacing:.06em">Details</th>
        <th style="padding:12px 16px;text-align:right;font-size:12px;color:#fff;font-weight:700;text-transform:uppercase;letter-spacing:.06em">Amount</th>
      </tr>
      <tr style="background:#f0f9ff"><td style="padding:11px 16px;font-size:13px;color:#1e293b"><strong>Previous Reading</strong></td><td style="padding:11px 16px;font-size:13px;color:#64748b">${fmtM(meter.startReading)}</td><td style="padding:11px 16px;text-align:right;font-size:13px;font-family:monospace"></td></tr>
      <tr style="background:#f0f9ff"><td style="padding:11px 16px;font-size:13px;color:#1e293b;border-bottom:2px solid #bae6fd"><strong>Current Reading</strong></td><td style="padding:11px 16px;font-size:13px;color:#64748b;border-bottom:2px solid #bae6fd">${fmtM(meter.endReading)}</td><td style="padding:11px 16px;text-align:right;font-size:13px;font-family:monospace;border-bottom:2px solid #bae6fd"></td></tr>
      <tr style="background:#e0f2fe"><td style="padding:11px 16px;font-size:13px;color:#0369a1"><strong>Total Consumption</strong></td><td style="padding:11px 16px;font-size:13px;color:#0369a1;font-weight:700">${fmtM(meter.consumed)}</td><td style="padding:11px 16px;text-align:right;font-size:13px;font-family:monospace;font-weight:700;color:#0369a1">${fmtM(meter.consumed)}</td></tr>
      <tr><td colspan="3" style="padding:4px"></td></tr>
      <tr><td style="padding:10px 16px;font-size:13px;color:#374151">Minimum Charge (first ${rates.minCubic} m³)</td><td style="padding:10px 16px;font-size:12px;color:#6b7280">minimum block rate</td><td style="padding:10px 16px;text-align:right;font-size:13px;font-family:monospace">${fmt(rates.minCharge)}</td></tr>
      ${excess > 0 ? `<tr><td style="padding:10px 16px;font-size:13px;color:#374151">Excess Consumption</td><td style="padding:10px 16px;font-size:12px;color:#6b7280">${fmtM(excess)} × ${fmt(rates.perCubic)}/m³</td><td style="padding:10px 16px;text-align:right;font-size:13px;font-family:monospace">${fmt(excess * rates.perCubic)}</td></tr>` : ''}
      <tr><td style="padding:10px 16px;font-size:13px;color:#374151">Environmental Fee</td><td style="padding:10px 16px;font-size:12px;color:#6b7280">fixed</td><td style="padding:10px 16px;text-align:right;font-size:13px;font-family:monospace">${fmt(rates.envFee)}</td></tr>
      <tr><td style="padding:10px 16px;font-size:13px;color:#374151">System/Service Charge</td><td style="padding:10px 16px;font-size:12px;color:#6b7280">fixed</td><td style="padding:10px 16px;text-align:right;font-size:13px;font-family:monospace">${fmt(rates.sysCharge)}</td></tr>
      <tr style="background:#f8fafc"><td style="padding:11px 16px;font-size:13px;font-weight:700;color:#1e293b;border-top:1px solid #e2e8f0">Subtotal</td><td style="border-top:1px solid #e2e8f0"></td><td style="padding:11px 16px;text-align:right;font-size:13px;font-family:monospace;font-weight:700;border-top:1px solid #e2e8f0">${fmt(bill.subtotal)}</td></tr>
      <tr><td style="padding:10px 16px;font-size:13px;color:#374151">VAT (${rates.vatPct}%)</td><td style="padding:10px 16px;font-size:12px;color:#6b7280">${rates.vatPct}% of subtotal</td><td style="padding:10px 16px;text-align:right;font-size:13px;font-family:monospace">${fmt(bill.vat)}</td></tr>
      <tr style="background:#0d7abf"><td style="padding:14px 16px;font-size:15px;font-weight:700;color:#fff">TOTAL AMOUNT DUE</td><td></td><td style="padding:14px 16px;text-align:right;font-size:17px;font-family:monospace;font-weight:900;color:#fff">${fmt(bill.total)}</td></tr>
    </table>
  </td></tr>

  <!-- FOOTER -->
  <tr><td style="padding:24px 36px 32px">
    <p style="margin:0 0 6px;font-size:12px;color:#94a3b8;text-align:center">This is a system-generated bill from your LoRaWAN smart water meter.</p>
    <p style="margin:0;font-size:12px;color:#94a3b8;text-align:center">For inquiries, please contact <strong>${rates.utilityName}</strong> · ${rates.address}</p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}
// ─────────────────────────────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════════════════
// AUTO-BILLING SCHEDULER
// Runs daily at CONFIG.autoBilling.runHour PHT.
// On the trigger date (dueDayOfMonth - daysBefore), sends the monthly bill
// to every registered customer that has an email address.
// A log file prevents double-sending within the same billing month.
// ══════════════════════════════════════════════════════════════════════════════

let autoBillingLog = {}; // { 'YYYY-MM': { meterKey: true } }

function loadAutoBillingLog() {
  const cfg = CONFIG.autoBilling;
  try {
    if (fs.existsSync(cfg.logFile)) {
      autoBillingLog = JSON.parse(fs.readFileSync(cfg.logFile, 'utf8'));
      console.log('[AutoBill] Log loaded —', Object.keys(autoBillingLog).length, 'month(s) on record');
    }
  } catch(e) { autoBillingLog = {}; }
}

function saveAutoBillingLog() {
  try { fs.writeFileSync(CONFIG.autoBilling.logFile, JSON.stringify(autoBillingLog, null, 2)); }
  catch(e) { console.error('[AutoBill] Could not save log:', e.message); }
}

// ── Billing math (mirrors billing.html logic) ──────────────────────────────
function calcBillServer(consumed, rates) {
  const c = Math.max(0, consumed);
  if (c === 0) return { waterCharge:0, envFee:0, sysCharge:0, subtotal:0, vat:0, total:0, isZero:true };
  let waterCharge = rates.minCharge;
  if (c > rates.minCubic) waterCharge += (c - rates.minCubic) * rates.perCubic;
  const subtotal = waterCharge + rates.envFee + rates.sysCharge;
  const vat      = subtotal * (rates.vatPct / 100);
  const total    = subtotal + vat;
  return { waterCharge, envFee: rates.envFee, sysCharge: rates.sysCharge, subtotal, vat, total, isZero: false };
}

function getMonthConsumptionServer(meterKey, year, month) {
  const hist = history[meterKey] || [];
  if (!hist.length) return null;
  const start = new Date(year, month - 1, 1, 0, 0, 0);
  const end   = new Date(year, month, 0, 23, 59, 59);
  const inMonth = hist.filter(h => {
    const t = new Date(h.ts); return t >= start && t <= end && h.meterReading !== null;
  });
  if (!inMonth.length) return null;
  const before   = hist.filter(h => new Date(h.ts) < start && h.meterReading !== null);
  const baseline = before.length ? before[before.length - 1] : inMonth[0];
  const latest   = inMonth[inMonth.length - 1];
  const consumed = Math.max(0, parseFloat(latest.meterReading) - parseFloat(baseline.meterReading));
  return { consumed, startReading: parseFloat(baseline.meterReading), endReading: parseFloat(latest.meterReading),
           startDate: baseline.ts, endDate: latest.ts, records: inMonth.length };
}

// ── Customer lookup (mirrors billing.html lookupCustomer) ──────────────────
function lookupCustomerServer(meterKey, devEUI) {
  const candidates = [meterKey, devEUI].filter(Boolean).map(k => String(k).trim());
  for (const key of candidates) {
    if (!key) continue;
    if (customers[key]) return customers[key];
    const withZero    = '0' + key;
    const withoutZero = key.startsWith('0') ? key.slice(1) : null;
    if (customers[withZero]) return customers[withZero];
    if (withoutZero && customers[withoutZero]) return customers[withoutZero];
    const byTag = Object.values(customers).find(c => {
      const tag = String(c.meterTagNumber || '').trim();
      return tag === key || tag === withZero || (withoutZero && tag === withoutZero);
    });
    if (byTag) return byTag;
    const sfx = key.slice(-8);
    const bySuffix = Object.values(customers).find(c => {
      const tag = String(c.meterTagNumber || '').trim();
      return tag.endsWith(sfx) || key.endsWith(tag.slice(-8));
    });
    if (bySuffix) return bySuffix;
    const bySub = Object.values(customers).find(c => {
      const tag = String(c.meterTagNumber || '').trim();
      return tag.includes(key) || key.includes(tag);
    });
    if (bySub) return bySub;
  }
  return null;
}

// ── Core auto-send function ────────────────────────────────────────────────
async function runAutoBilling() {
  const cfg = CONFIG.autoBilling;
  if (!cfg.enabled) return;

  const now = new Date();
  // Work in PHT (UTC+8)
  const phtOffset = 8 * 60 * 60000;
  const pht = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + phtOffset);

  const todayDay  = pht.getDate();
  const thisMonth = pht.getMonth() + 1; // 1-based
  const thisYear  = pht.getFullYear();

  // Calculate which day of this month is the trigger day
  // due date = dueDayOfMonth; send day = dueDayOfMonth - daysBefore
  const sendDay = cfg.dueDayOfMonth - cfg.daysBefore;

  console.log(`[AutoBill] Daily check — PHT date: ${thisYear}-${String(thisMonth).padStart(2,'0')}-${String(todayDay).padStart(2,'0')} | Send day this month: ${sendDay}`);

  if (todayDay !== sendDay) {
    console.log(`[AutoBill] Not send day (${sendDay}). Skipping.`);
    return;
  }

  const monthKey = `${thisYear}-${String(thisMonth).padStart(2,'0')}`;
  if (!autoBillingLog[monthKey]) autoBillingLog[monthKey] = {};

  // Due date for this month's bill
  const dueDate = new Date(thisYear, thisMonth - 1, cfg.dueDayOfMonth);
  const dueDateStr = dueDate.toISOString().split('T')[0];

  const monthNames = ['','January','February','March','April','May','June','July','August','September','October','November','December'];
  const period = `${monthNames[thisMonth]} ${thisYear}`;
  const rates  = cfg.rates;

  // Gather all meters from all applications
  let allNodes = [];
  Object.values(cachedData).forEach(app => {
    (app.nodes || []).forEach(n => allNodes.push({ ...n, _appName: app.name }));
  });

  if (!allNodes.length) {
    console.log('[AutoBill] No meter data available yet. Will retry tomorrow.');
    return;
  }

  let sent = 0, skipped = 0, noEmail = 0, noData = 0, errors = 0;

  for (const n of allNodes) {
    const meterKey = n.sn || n.name || n.devEUI;
    if (!meterKey) continue;

    // Skip if already emailed this meter this month
    if (autoBillingLog[monthKey][meterKey]) {
      skipped++;
      continue;
    }

    const customer = lookupCustomerServer(meterKey, n.devEUI);
    if (!customer || !customer.emailAddress) { noEmail++; continue; }

    const cons = getMonthConsumptionServer(meterKey, thisYear, thisMonth);
    if (!cons) { noData++; continue; }

    const bill = calcBillServer(cons.consumed, rates);
    if (bill.isZero) { skipped++; continue; } // no charge = no bill to send

    const billNo = `RWU-${thisYear}${String(thisMonth).padStart(2,'0')}-${meterKey.slice(-6)}`;

    try {
      const transporter = createTransporter();
      if (!transporter) { errors++; continue; }

      const html = buildEmailHTML({
        customer,
        bill,
        meter: { key: meterKey, devEUI: n.devEUI || '—', consumed: cons.consumed,
                 startReading: cons.startReading, endReading: cons.endReading },
        rates,
        period,
        billNo,
        dueDate: dueDateStr,
      });

      await transporter.sendMail({
        from:    CONFIG.gmail.from,
        to:      `${customer.fullName} <${customer.emailAddress}>`,
        subject: `💧 Water Bill — ${period} | Due ${dueDate.toLocaleDateString('en-PH',{month:'long',day:'numeric',year:'numeric'})} | ${billNo}`,
        html,
      });

      autoBillingLog[monthKey][meterKey] = {
        sentAt: getPHTISO(), email: customer.emailAddress, billNo, total: bill.total
      };
      sent++;
      console.log(`[AutoBill] ✅ Sent → ${customer.fullName} <${customer.emailAddress}> | ${billNo} | ₱${bill.total.toFixed(2)}`);

      // Small delay between emails to avoid Gmail rate limits
      await new Promise(r => setTimeout(r, 1500));

    } catch(e) {
      errors++;
      console.error(`[AutoBill] ❌ Failed for ${meterKey}:`, e.message);
    }
  }

  saveAutoBillingLog();
  console.log(`[AutoBill] 📊 Done — Sent: ${sent} | Skipped: ${skipped} | No email: ${noEmail} | No data: ${noData} | Errors: ${errors}`);
}

// ── Shared transporter factory ────────────────────────────────────────────
function createTransporter() {
  if (!nodemailer) { console.error('[Email] nodemailer not installed'); return null; }
  const cfg = CONFIG.gmail;
  if (!cfg.appPassword || cfg.appPassword.startsWith('xxxx')) {
    console.error('[Email] Gmail App Password not set in CONFIG.gmail'); return null;
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: cfg.user, pass: cfg.appPassword.replace(/\s/g, '') }
  });
}

// ── Schedule daily check at runHour:runMinute PHT ─────────────────────────
function scheduleDailyAutoBilling() {
  const cfg = CONFIG.autoBilling;
  if (!cfg.enabled) { console.log('[AutoBill] Disabled in config.'); return; }

  function msUntilNextRun() {
    const now = new Date();
    const phtOffset = 8 * 60 * 60000;
    const pht = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + phtOffset);
    let next = new Date(pht);
    next.setHours(cfg.runHour, cfg.runMinute, 0, 0);
    if (next <= pht) next.setDate(next.getDate() + 1); // already passed today → tomorrow
    const ms = next - pht;
    return ms;
  }

  function scheduleNext() {
    const ms = msUntilNextRun();
    const hh = Math.floor(ms / 3600000);
    const mm = Math.floor((ms % 3600000) / 60000);
    console.log(`[AutoBill] Next check in ${hh}h ${mm}m (daily at ${String(cfg.runHour).padStart(2,'0')}:${String(cfg.runMinute).padStart(2,'0')} PHT, send day: ${cfg.dueDayOfMonth - cfg.daysBefore} of each month)`);
    setTimeout(async () => {
      await runAutoBilling();
      scheduleNext(); // reschedule for tomorrow
    }, ms);
  }

  scheduleNext();
}

// ══════════════════════════════════════════════════════════════════════════════
// ── NO-CONSUMPTION ALARM SYSTEM ──
// Checks every refresh: if a meter has had 0 consumption for 24h+ AND
// has a registered customer, sends one email alert (no repeat spam)
// ══════════════════════════════════════════════════════════════════════════════

const noConsAlertFile = path.join(__dirname, 'no_consumption_alerts.json');
let noConsAlerts = {}; // { meterKey: { lastAlertSent, lastReading } }

function loadNoConsAlerts() {
  try {
    if (fs.existsSync(noConsAlertFile))
      noConsAlerts = JSON.parse(fs.readFileSync(noConsAlertFile, 'utf8'));
  } catch(e) { noConsAlerts = {}; }
}

function saveNoConsAlerts() {
  try { fs.writeFileSync(noConsAlertFile, JSON.stringify(noConsAlerts, null, 2)); }
  catch(e) { console.error('[NoConsAlarm] Save error:', e.message); }
}

async function checkNoConsumptionAlarms(allNodes) {
  const now = Date.now();
  const transporter = getTransporter();
  if (!transporter) return;

  for (const n of allNodes) {
    const key = n.sn || n.name || n.devEUI;
    if (!key) continue;

    const hist = history[key] || [];
    if (hist.length < 2) continue;

    // Get readings from last 24 hours
    const cutoff = now - 24 * 3600000;
    const recent = hist.filter(h => new Date(h.ts).getTime() > cutoff);
    if (!recent.length) continue;

    // Check if consumption in last 24h is 0
    const first = recent[0];
    const last  = recent[recent.length - 1];
    const consumed = parseFloat(last.meterReading) - parseFloat(first.meterReading);

    if (consumed > 0) {
      // Consumption detected — clear alert flag
      if (noConsAlerts[key]) {
        delete noConsAlerts[key];
        saveNoConsAlerts();
      }
      continue;
    }

    // Zero consumption for 24h — check if we already sent alert today
    const today = getPHTISO().substring(0, 10); // YYYY-MM-DD
    if (noConsAlerts[key] && noConsAlerts[key].lastAlertDate === today) continue;

    // Find customer
    const customer = customers[key] || customers[n.devEUI] || null;
    const toEmail  = customer?.emailAddress;
    const toName   = customer?.fullName || key;

    console.log(`[NoConsAlarm] ⚠️  ${key} — 0 consumption for 24h. Customer: ${toName}`);

    // Send email if customer has email
    if (toEmail) {
      try {
        await transporter.sendMail({
          from:    CONFIG.gmail.from,
          to:      `${toName} <${toEmail}>`,
          subject: `⚠️ Water Meter Alert — No Consumption Detected (${key})`,
          html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
            <div style="background:#1976d2;padding:20px;border-radius:8px 8px 0 0">
              <h2 style="color:white;margin:0">💧 Redlink Water Utility</h2>
              <p style="color:#90caf9;margin:4px 0 0">No Consumption Alert</p>
            </div>
            <div style="background:#fff8e1;border:1px solid #ffb300;padding:20px;margin:0">
              <p style="color:#e65100;font-size:16px;font-weight:bold">⚠️ No water consumption detected for over 24 hours</p>
              <p style="color:#555">This may indicate a closed valve, meter issue, or no water usage at your location.</p>
            </div>
            <div style="background:#f5f5f5;padding:20px">
              <table style="width:100%;border-collapse:collapse;font-size:14px">
                <tr><td style="padding:8px;color:#666;width:40%">Customer Name</td><td style="padding:8px;font-weight:bold">${toName}</td></tr>
                <tr style="background:white"><td style="padding:8px;color:#666">Meter Serial</td><td style="padding:8px;font-weight:bold">${key}</td></tr>
                <tr><td style="padding:8px;color:#666">Device EUI</td><td style="padding:8px;font-family:monospace">${n.devEUI||'—'}</td></tr>
                <tr style="background:white"><td style="padding:8px;color:#666">Current Reading</td><td style="padding:8px;font-weight:bold">${parseFloat(last.meterReading).toFixed(3)} m³</td></tr>
                <tr><td style="padding:8px;color:#666">Last 24h Consumption</td><td style="padding:8px;font-weight:bold;color:#e65100">0.000 m³</td></tr>
                <tr style="background:white"><td style="padding:8px;color:#666">Alert Time</td><td style="padding:8px">${getPHTISO().replace('T',' ').replace('+08:00','')} PHT</td></tr>
              </table>
            </div>
            <div style="background:#1976d2;padding:16px;border-radius:0 0 8px 8px;text-align:center">
              <p style="color:white;margin:0;font-size:13px">Please check your water meter or contact us if you need assistance.</p>
              <p style="color:#90caf9;margin:4px 0 0;font-size:12px">Redlink Water Utility · LoRaWAN Smart Metering System</p>
            </div>
          </div>`
        });
        console.log(`[NoConsAlarm] ✅ Email sent to ${toEmail}`);
      } catch(e) {
        console.error(`[NoConsAlarm] ❌ Email failed for ${key}:`, e.message);
      }
    } else {
      console.log(`[NoConsAlarm] ⚠️  No email on file for ${key}`);
    }

    // Mark as alerted today
    noConsAlerts[key] = { lastAlertDate: today, lastReading: parseFloat(last.meterReading), sentTo: toEmail || 'no email' };
    saveNoConsAlerts();
  }
}

// ── EXPOSE NO-CONS ALARMS TO FRONTEND ──
function getNoConsumptionAlarmList() {
  const now = Date.now();
  const result = [];
  const allNodes = Object.values(cachedData).flatMap(a => a.nodes);
  allNodes.forEach(n => {
    const key = n.sn || n.name || n.devEUI;
    if (!key) return;
    const hist = history[key] || [];
    if (hist.length < 2) return;
    const cutoff = now - 24 * 3600000;
    const recent = hist.filter(h => new Date(h.ts).getTime() > cutoff);
    if (!recent.length) return;
    const first = recent[0];
    const last  = recent[recent.length - 1];
    const consumed = parseFloat(last.meterReading) - parseFloat(first.meterReading);
    if (consumed <= 0) {
      const customer = customers[key] || customers[n.devEUI] || null;
      const alert = noConsAlerts[key] || null;
      result.push({
        key, devEUI: n.devEUI, appName: n._appName,
        currentReading: parseFloat(last.meterReading),
        lastSeen: last.ts,
        customerName: customer?.fullName || null,
        customerEmail: customer?.emailAddress || null,
        emailSent: alert ? alert.lastAlertDate : null,
        sentTo: alert ? alert.sentTo : null,
      });
    }
  });
  return result;
}


loadHistory();
loadCustomers();
loadAutoBillingLog();
loadNoConsAlerts();
server.listen(CONFIG.port, async () => {
  console.log(`\n🚀 Dashboard → http://localhost:${CONFIG.port}`);
  console.log(`✅ Route loaded: POST /api/alarms/send-problem-alert`);
  await fetchAll();
  await fetchCustomersFromSheet();
  setInterval(fetchAll, CONFIG.refreshInterval);
  // Sync customers every 5 minutes
  setInterval(fetchCustomersFromSheet, 5 * 60000);
  console.log(`⏱  Auto-refresh every ${CONFIG.refreshInterval/1000}s\n`);
  // Start auto-billing scheduler
  scheduleDailyAutoBilling();
});
