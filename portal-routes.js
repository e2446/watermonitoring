// ══════════════════════════════════════════════════════════════════════════════
// ── CUSTOMER PORTAL API ROUTES
// ── Add these routes inside your existing request handler in server.js
// ── (paste inside the section where you handle other routes like /api/data)
// ══════════════════════════════════════════════════════════════════════════════
//
// REQUIRES: npm install bcryptjs  (or use plain comparison if you skip hashing)
// REQUIRES: crypto (built-in Node.js)
//
// In your server.js, add at the top with other requires:
//   const crypto = require('crypto');
//   let bcrypt; try { bcrypt = require('bcryptjs'); } catch(e) {}
//
// Also add this near the top (with your other state vars):
//   let portalPasswords = {};  // { meterKey: { hash, otpExpiry, otp } }
//   const portalPwFile = path.join(__dirname, 'portal_passwords.json');
//
// ── LOAD/SAVE portal passwords ──────────────────────────────────────────────

function loadPortalPasswords() {
  try {
    if (fs.existsSync(portalPwFile))
      portalPasswords = JSON.parse(fs.readFileSync(portalPwFile, 'utf8'));
  } catch(e) { portalPasswords = {}; }
}

function savePortalPasswords() {
  try { fs.writeFileSync(portalPwFile, JSON.stringify(portalPasswords, null, 2)); }
  catch(e) { console.error('[Portal] Save passwords error:', e.message); }
}

// ── ROUTE: POST /api/portal/request-password ────────────────────────────────
// Body: { email: "user@email.com" }
// Finds customer by email, generates OTP, sends email, stores hashed OTP

async function handlePortalRequestPassword(body, res) {
  const { email } = body;
  if (!email) return sendJSON(res, 400, { success: false, message: 'Email required' });

  // Find customer with this email
  const matchKey = Object.keys(customers).find(k =>
    (customers[k].emailAddress || '').toLowerCase().trim() === email.toLowerCase().trim()
  );

  if (!matchKey) {
    return sendJSON(res, 404, { success: false, message: 'No account found with that email address.' });
  }

  const customer = customers[matchKey];

  // Generate 8-char OTP password
  const otp = crypto.randomBytes(4).toString('hex').toUpperCase(); // e.g. A3F2C8D1
  const otpExpiry = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

  // Store (hashed if bcrypt available)
  if (bcrypt) {
    portalPasswords[matchKey] = { hash: bcrypt.hashSync(otp, 10), otpExpiry };
  } else {
    portalPasswords[matchKey] = { plainOtp: otp, otpExpiry };
  }
  savePortalPasswords();

  // Send email
  const transporter = createTransporter();
  if (!transporter) {
    return sendJSON(res, 500, { success: false, message: 'Email service unavailable. Please contact support.' });
  }

  const meterKey = customer.meterTagNumber || matchKey;
  const appNode = Object.values(cachedData)
    .flatMap(a => a.nodes || [])
    .find(n => (n.sn||n.name||n.devEUI) === matchKey);
  const devEUI = appNode?.devEUI || '—';

  try {
    await transporter.sendMail({
      from: CONFIG.gmail.from,
      to: `${customer.fullName} <${email}>`,
      subject: '🔑 Your Redlink Water Portal Password',
      html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#06080f;color:#dde2f0;border-radius:16px;overflow:hidden">
        <div style="background:linear-gradient(135deg,#0099cc,#00b8d4);padding:28px;text-align:center">
          <h1 style="color:white;margin:0;font-size:24px">💧 Redlink Water</h1>
          <p style="color:rgba(255,255,255,.85);margin:6px 0 0;font-size:14px">Customer Self-Service Portal</p>
        </div>
        <div style="padding:28px">
          <p style="font-size:15px;margin:0 0 16px">Hello, <strong>${customer.fullName}</strong>!</p>
          <p style="color:#9ba8cc;font-size:14px;margin:0 0 20px">Here is your one-time portal password. Use it to log in and view your meter details, consumption history, and bills.</p>

          <div style="background:#0c0f1a;border:1px solid #1e2438;border-radius:12px;padding:20px;text-align:center;margin-bottom:20px">
            <div style="font-size:11px;color:#5c6585;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">Your Password</div>
            <div style="font-family:monospace;font-size:32px;font-weight:700;color:#00c8ff;letter-spacing:.15em">${otp}</div>
            <div style="font-size:11px;color:#5c6585;margin-top:8px">Valid for 24 hours</div>
          </div>

          <div style="background:#111420;border:1px solid #1e2438;border-radius:10px;padding:16px;margin-bottom:20px">
            <div style="font-size:12px;color:#9ba8cc;margin-bottom:10px;font-weight:600">YOUR METER DETAILS</div>
            <table style="width:100%;font-size:13px;border-collapse:collapse">
              <tr><td style="padding:5px 0;color:#5c6585;width:45%">Customer Name</td><td style="font-weight:600">${customer.fullName}</td></tr>
              <tr><td style="padding:5px 0;color:#5c6585">Meter Tag Number</td><td style="font-family:monospace">${meterKey}</td></tr>
              <tr><td style="padding:5px 0;color:#5c6585">Device EUI</td><td style="font-family:monospace">${devEUI}</td></tr>
              <tr><td style="padding:5px 0;color:#5c6585">Address</td><td>${customer.address||'—'}</td></tr>
            </table>
          </div>

          <div style="background:#1a0c0c;border:1px solid #3d1515;border-radius:8px;padding:12px;font-size:12px;color:#ff8a93;margin-bottom:20px">
            🔒 <strong>Security Note:</strong> Never share this password with anyone. Redlink staff will never ask for your password. Change it after your first login.
          </div>

          <p style="text-align:center">
            <a href="http://localhost:3000/customer-portal.html" style="display:inline-block;background:linear-gradient(135deg,#00c8ff,#00b8d4);color:black;font-weight:700;padding:12px 28px;border-radius:9px;text-decoration:none;font-size:14px">
              → Open Customer Portal
            </a>
          </p>
        </div>
        <div style="background:#0c0f1a;padding:16px;text-align:center;border-top:1px solid #1e2438">
          <p style="color:#5c6585;font-size:12px;margin:0">Redlink Water Utility · LoRaWAN Smart Metering · Ormoc City, Leyte</p>
        </div>
      </div>`
    });

    console.log(`[Portal] ✅ Password sent to ${email} for meter ${matchKey}`);
    return sendJSON(res, 200, { success: true, message: 'Password sent!' });

  } catch(e) {
    console.error('[Portal] Email error:', e.message);
    return sendJSON(res, 500, { success: false, message: 'Failed to send email: ' + e.message });
  }
}

// ── ROUTE: POST /api/portal/login ────────────────────────────────────────────
// Body: { identifier: "meter/EUI/name", password: "OTP" }
// Returns: { success, customer, node, history }

async function handlePortalLogin(body, res) {
  const { identifier, password } = body;
  if (!identifier || !password)
    return sendJSON(res, 400, { success: false, message: 'Identifier and password required' });

  const idLow = identifier.toLowerCase().trim();

  // Find matching meter key (by SN, EUI, or customer name)
  let matchKey = null;
  let matchNode = null;
  let matchCustomer = null;

  const allNodes = Object.values(cachedData).flatMap(a => a.nodes || []);

  for (const n of allNodes) {
    const sn  = (n.sn || n.name || '').toLowerCase();
    const eui = (n.devEUI || '').toLowerCase();
    const k   = n.sn || n.name || n.devEUI;
    const cust = customers[k] || customers[n.devEUI] || null;
    const name = (cust?.fullName || '').toLowerCase();

    if (sn === idLow || eui === idLow || (name && (name.includes(idLow) || idLow.includes(name)))) {
      matchKey = k;
      matchNode = n;
      matchCustomer = cust;
      break;
    }
  }

  if (!matchKey) {
    return sendJSON(res, 404, { success: false, message: 'No meter found matching that identifier.' });
  }

  // Verify password
  const stored = portalPasswords[matchKey];
  if (!stored) {
    return sendJSON(res, 401, { success: false, message: 'No password set for this account. Please request a password first.' });
  }

  if (stored.otpExpiry && Date.now() > stored.otpExpiry) {
    return sendJSON(res, 401, { success: false, message: 'Your password has expired. Please request a new one.' });
  }

  let valid = false;
  if (bcrypt && stored.hash) {
    valid = bcrypt.compareSync(password, stored.hash);
  } else if (stored.plainOtp) {
    valid = stored.plainOtp === password.trim().toUpperCase();
  }

  if (!valid) {
    return sendJSON(res, 401, { success: false, message: 'Incorrect password. Please check the email we sent you.' });
  }

  // Return customer data + history
  const hist = history[matchKey] || [];

  console.log(`[Portal] ✅ Login success: ${matchKey} (${matchCustomer?.fullName || 'unknown'})`);

  return sendJSON(res, 200, {
    success: true,
    customer: matchCustomer,
    node: matchNode,
    history: hist,
  });
}

// ── Helper: send JSON response ───────────────────────────────────────────────
function sendJSON(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

// ══════════════════════════════════════════════════════════════════════════════
// HOW TO WIRE THESE ROUTES INTO server.js
// ══════════════════════════════════════════════════════════════════════════════
//
// In your existing request handler, add these cases:
//
//   if (req.method === 'POST' && req.url === '/api/portal/request-password') {
//     let body = '';
//     req.on('data', d => body += d);
//     req.on('end', () => {
//       try { handlePortalRequestPassword(JSON.parse(body), res); }
//       catch(e) { sendJSON(res, 400, { success:false, message:'Bad request' }); }
//     });
//     return;
//   }
//
//   if (req.method === 'POST' && req.url === '/api/portal/login') {
//     let body = '';
//     req.on('data', d => body += d);
//     req.on('end', () => {
//       try { handlePortalLogin(JSON.parse(body), res); }
//       catch(e) { sendJSON(res, 400, { success:false, message:'Bad request' }); }
//     });
//     return;
//   }
//
//   // Also serve the portal HTML file:
//   if (req.method === 'GET' && req.url === '/customer-portal') {
//     const html = fs.readFileSync(path.join(__dirname, 'customer-portal.html'));
//     res.writeHead(200, { 'Content-Type': 'text/html' });
//     res.end(html);
//     return;
//   }
//
// And at the bottom with your other load calls:
//   loadPortalPasswords();
//
// ══════════════════════════════════════════════════════════════════════════════
