// ── CUSTOMER REGISTRY MODULE ──
// Fetches from Google Sheets via Apps Script Web App
// and merges customer info with meter data

const APPS_SCRIPT_URL = '__APPS_SCRIPT_URL__'; // replaced when user provides URL

let customerRegistry = {}; // { meterTagNumber: { fullName, address, contactNumber, emailAddress, timestamp } }

async function loadCustomers() {
  if(APPS_SCRIPT_URL === '__APPS_SCRIPT_URL__') return;
  try {
    const res = await fetch(APPS_SCRIPT_URL);
    const data = await res.json();
    customerRegistry = {};
    data.forEach(row => {
      const tag = String(row.meterTagNumber||'').trim();
      if(tag) customerRegistry[tag] = row;
    });
    console.log('[Customers] Loaded', Object.keys(customerRegistry).length, 'customers');
  } catch(e) {
    console.error('[Customers] Failed to load:', e.message);
  }
}

function getCustomer(meterKey) {
  // Try exact match first, then partial
  if(customerRegistry[meterKey]) return customerRegistry[meterKey];
  // Try matching last digits
  const keys = Object.keys(customerRegistry);
  const match = keys.find(k => meterKey.includes(k) || k.includes(meterKey));
  return match ? customerRegistry[match] : null;
}
