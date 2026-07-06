require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

// Allow Shopify to embed the app in an iframe
app.use((req, res, next) => {
  const shop = process.env.SHOPIFY_STORE;
  res.setHeader(
    'Content-Security-Policy',
    `frame-ancestors https://${shop} https://admin.shopify.com;`
  );
  res.removeHeader('X-Frame-Options');
  next();
});

// Serve Vite production build
app.use(express.static(path.join(__dirname, 'dist')));

// SPA fallback — inject Shopify API key then serve index.html
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const indexPath = path.join(__dirname, 'dist', 'index.html');
  const fs = require('fs');
  if (!fs.existsSync(indexPath)) {
    return res.status(503).send('شغّل npm run build أولاً');
  }
  const html = fs.readFileSync(indexPath, 'utf8');
  const injected = html.replace(
    '</head>',
    `<script>
      window.__SHOPIFY_API_KEY__ = "${process.env.SHOPIFY_API_KEY || ''}";
      window.__STORE_NAME__ = "${process.env.STORE_NAME || 'My Store'}";
      // Initialize App Bridge immediately (before React) so Shopify mobile gets the ready signal ASAP
      (function() {
        try {
          var p = new URLSearchParams(location.search);
          var host = p.get('host');
          var key = window.__SHOPIFY_API_KEY__;
          if (host && key && window['app-bridge'] && !window.__shopifyApp) {
            window.__shopifyApp = window['app-bridge'].createApp({ apiKey: key, host: host, forceRedirect: false });
          }
        } catch(e) {}
      })();
    </script>\n</head>`
  );
  res.send(injected);
});

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const QPX_BASE = 'https://api.qpxpress.com';

// Runtime settings — start from env vars, can be updated via /api/settings
let runtimeSettings = {
  qpxUsername: process.env.QPX_USERNAME || '',
  qpxPassword: process.env.QPX_PASSWORD || '',
  qpxCustomerId: parseInt(process.env.QPX_CUSTOMER_ID || '1021'),
  // Per-store toggles. Andmore: street-only address + zero fees.
  // It's Sunglasses: match the Shopify shipping charge as the QPX fee.
  qpxStreetAddress: process.env.QPX_STREET_ADDRESS === 'true',
  qpxZeroFees: process.env.QPX_ZERO_FEES === 'true',
  qpxMatchShipping: process.env.QPX_MATCH_SHIPPING === 'true',
};

let qpxToken = null;
let qpxTokenExpiry = 0;
let qpxRefreshToken = process.env.QPX_REFRESH_TOKEN || null;

// ─── Settings API ─────────────────────────────────────────────────────────────

app.get('/api/settings', (req, res) => {
  res.json({
    qpxUsername: runtimeSettings.qpxUsername,
    qpxCustomerId: runtimeSettings.qpxCustomerId,
    hasPassword: !!runtimeSettings.qpxPassword,
    storeName: process.env.STORE_NAME || '',
    shopifyStore: SHOPIFY_STORE || '',
  });
});

app.post('/api/settings', (req, res) => {
  const { qpxUsername, qpxPassword, qpxCustomerId } = req.body;
  if (qpxUsername !== undefined) runtimeSettings.qpxUsername = qpxUsername.trim();
  if (qpxPassword && qpxPassword.trim()) runtimeSettings.qpxPassword = qpxPassword.trim();
  if (qpxCustomerId !== undefined) runtimeSettings.qpxCustomerId = parseInt(qpxCustomerId) || runtimeSettings.qpxCustomerId;
  // Reset cached token so next request uses new credentials
  qpxToken = null;
  qpxTokenExpiry = 0;
  qpxRefreshToken = null;
  console.log('Settings updated — QPX token cache cleared');
  res.json({ success: true });
});

// ─── QPX Auth ─────────────────────────────────────────────────────────────────

async function getQpxToken() {
  if (qpxToken && Date.now() < qpxTokenExpiry) return qpxToken;

  if (qpxRefreshToken) {
    try {
      const res = await axios.post(`${QPX_BASE}/api/token/refresh/`, {
        refresh: qpxRefreshToken,
      }, { timeout: 15000 });
      qpxToken = res.data.access;
      qpxTokenExpiry = Date.now() + 25 * 60 * 1000;
      console.log('QPX token refreshed successfully');
      return qpxToken;
    } catch (err) {
      console.warn('QPX refresh token expired or invalid, logging in with credentials...');
    }
  }

  const loginRes = await axios.post(`${QPX_BASE}/api/token/`, {
    username: runtimeSettings.qpxUsername,
    password: runtimeSettings.qpxPassword,
  }, { timeout: 15000 });

  qpxToken = loginRes.data.access;
  qpxRefreshToken = loginRes.data.refresh;
  qpxTokenExpiry = Date.now() + 25 * 60 * 1000;
  console.log('QPX login successful, new tokens obtained');
  return qpxToken;
}

function qpxHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

// ─── QPX: Test Auth ───────────────────────────────────────────────────────────

app.get('/api/qpx/test-auth', async (req, res) => {
  try {
    const token = await getQpxToken();
    res.json({ success: true, message: 'تم الاتصال بـ QPX بنجاح ✅' });
  } catch (err) {
    const detail = err.response?.data?.detail || err.response?.data || err.message;
    res.status(502).json({ success: false, error: String(detail).substring(0, 200) });
  }
});

// ─── Webhook PII Cache ────────────────────────────────────────────────────────
// Shopify webhook payloads include full customer data even when the REST API
// strips PII (Basic-plan custom apps created after mid-2026). We capture
// orders/create + orders/updated payloads and merge the PII into API results.

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PII_CACHE_FILE = path.join(DATA_DIR, 'orders-pii-cache.json');
const PII_CACHE_MAX = 20000;
let piiCache = {};

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(PII_CACHE_FILE)) {
    piiCache = JSON.parse(fs.readFileSync(PII_CACHE_FILE, 'utf8'));
    console.log(`PII cache loaded: ${Object.keys(piiCache).length} orders from ${PII_CACHE_FILE}`);
  }
} catch (err) {
  console.error('PII cache load failed:', err.message);
  piiCache = {};
}

let piiSaveTimer = null;
function schedulePiiSave() {
  if (piiSaveTimer) return;
  piiSaveTimer = setTimeout(() => {
    piiSaveTimer = null;
    try {
      const keys = Object.keys(piiCache);
      if (keys.length > PII_CACHE_MAX) {
        keys
          .sort((a, b) => (piiCache[a].received_at || 0) - (piiCache[b].received_at || 0))
          .slice(0, keys.length - PII_CACHE_MAX)
          .forEach((k) => delete piiCache[k]);
      }
      fs.writeFileSync(PII_CACHE_FILE, JSON.stringify(piiCache));
    } catch (err) {
      console.error('PII cache save failed:', err.message);
    }
  }, 2000);
}

function verifyShopifyWebhook(req) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) return true; // verification optional — enable by setting the secret
  try {
    const hmac = req.get('X-Shopify-Hmac-Sha256') || '';
    const digest = crypto.createHmac('sha256', secret).update(req.rawBody).digest('base64');
    return hmac.length === digest.length && crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
  } catch {
    return false;
  }
}

// Shopify Flow writes "QPX-DATA|name=...|phone=...|addr1=..." into the order
// note (Flow has full PII access even on Basic plan). Parse it back out.
function parseNotePii(note) {
  if (!note || !String(note).startsWith('QPX-DATA')) return null;
  const out = {};
  String(note).split('|').slice(1).forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.substring(0, idx).trim()] = part.substring(idx + 1).trim();
  });
  return out;
}

function cacheOrderPii(o) {
  if (!o || !o.id) return;
  const addr = o.shipping_address || o.billing_address || {};
  const customer = o.customer || {};
  const defAddr = customer.default_address || {};

  const notePii = parseNotePii(o.note) || {};
  // Sticky merge: Flow writes PII into the note but Shopify's checkout
  // post-processing can clear it moments later; a later webhook must never
  // erase PII we already captured.
  const prev = piiCache[String(o.id)] || {};

  const name =
    `${addr.first_name || ''} ${addr.last_name || ''}`.trim() ||
    `${customer.first_name || ''} ${customer.last_name || ''}`.trim() ||
    `${defAddr.first_name || ''} ${defAddr.last_name || ''}`.trim() ||
    notePii.name || '';
  const phone = addr.phone || o.phone || customer.phone || defAddr.phone || notePii.phone || '';

  piiCache[String(o.id)] = {
    name: name || prev.name || '',
    phone: phone || prev.phone || '',
    email: o.contact_email || o.email || customer.email || notePii.email || prev.email || '',
    address1: addr.address1 || defAddr.address1 || notePii.addr1 || prev.address1 || '',
    address2: addr.address2 || defAddr.address2 || notePii.addr2 || prev.address2 || '',
    city: addr.city || defAddr.city || notePii.city || prev.city || '',
    province: addr.province || defAddr.province || notePii.prov || prev.province || '',
    zip: addr.zip || defAddr.zip || notePii.zip || prev.zip || '',
    received_at: Date.now(),
  };
  schedulePiiSave();
}

app.post('/webhooks/orders', (req, res) => {
  if (!verifyShopifyWebhook(req)) {
    console.warn('Webhook HMAC verification failed');
    return res.status(401).send('invalid hmac');
  }
  try {
    cacheOrderPii(req.body);
    const o = req.body || {};
    console.log(`Webhook received: order #${o.order_number || o.id} — name=${!!(piiCache[String(o.id)] || {}).name} phone=${!!(piiCache[String(o.id)] || {}).phone}`);
    try { fs.writeFileSync(path.join(DATA_DIR, 'last-webhook.json'), JSON.stringify(req.body)); } catch {}
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }
  res.status(200).send('ok');
});

// Debug: structure of the last webhook payload (which PII fields Shopify sent)
app.get('/api/webhook-cache/last', (req, res) => {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'last-webhook.json'), 'utf8'));
    res.json({
      order_number: o.order_number,
      top_keys: Object.keys(o),
      shipping_address: o.shipping_address ? Object.fromEntries(Object.entries(o.shipping_address).map(([k, v]) => [k, v === null ? null : typeof v === 'string' ? (v ? 'SET' : 'EMPTY') : v])) : null,
      billing_address_keys: o.billing_address ? Object.keys(o.billing_address) : null,
      customer: o.customer ? Object.fromEntries(Object.entries(o.customer).filter(([k]) => ['first_name', 'last_name', 'phone', 'email', 'default_address'].includes(k)).map(([k, v]) => [k, v === null ? null : typeof v === 'object' ? 'OBJECT' : 'SET'])) : null,
      phone: o.phone === null ? null : o.phone ? 'SET' : o.phone,
      email: o.email === null ? null : o.email ? 'SET' : o.email,
    });
  } catch (err) {
    res.status(404).json({ error: 'no webhook captured yet' });
  }
});

// Health/debug: how many orders captured, without exposing the PII itself
app.get('/api/webhook-cache/status', (req, res) => {
  const entries = Object.values(piiCache);
  res.json({
    count: entries.length,
    with_name: entries.filter((e) => e.name).length,
    with_phone: entries.filter((e) => e.phone).length,
    last_received_at: entries.length ? new Date(Math.max(...entries.map((e) => e.received_at || 0))).toISOString() : null,
    data_dir: DATA_DIR,
  });
});

// ─── Shopify: Get Orders ──────────────────────────────────────────────────────

function mapShopifyOrder(o) {
  const addr = o.shipping_address || o.billing_address || {};
  const customer = o.customer || {};
  const items = o.line_items.map((i) => `${i.name} x${i.quantity}`).join(' | ');

  const cached = piiCache[String(o.id)] || {};
  const notePii = parseNotePii(o.note) || {};

  const addrName = `${addr.first_name || ''} ${addr.last_name || ''}`.trim();
  const customerName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim();
  const name = addrName || customerName || notePii.name || cached.name || o.contact_email || o.email || cached.email || '';

  const phone = addr.phone || o.phone || customer.phone || notePii.phone || cached.phone || '';

  const a1 = addr.address1 || notePii.addr1 || cached.address1;
  const a2 = addr.address2 || notePii.addr2 || cached.address2;
  const city = addr.city || notePii.city || cached.city;
  const province = addr.province || notePii.prov || cached.province;
  const zip = addr.zip || notePii.zip || cached.zip;

  // Shipping the customer was charged in Shopify (used as QPX fee for non-Andmore stores)
  let shipping_price = '0';
  if (o.total_shipping_price_set?.shop_money?.amount != null) {
    shipping_price = o.total_shipping_price_set.shop_money.amount;
  } else if (Array.isArray(o.shipping_lines) && o.shipping_lines.length) {
    shipping_price = String(o.shipping_lines.reduce((s, l) => s + (parseFloat(l.price) || 0), 0));
  }

  return {
    id: o.id,
    shopify_order_number: o.order_number,
    created_at: o.created_at,
    customer_name: name,
    phone,
    city: province || city || '',
    address: [a1, a2].filter(Boolean).join('، '),
    address_full: [a1, a2, city, province, zip].filter(Boolean).join('، '),
    items,
    total_price: o.total_price,
    currency: o.currency,
    financial_status: o.financial_status,
    fulfillment_status: o.fulfillment_status || 'unfulfilled',
    shipping_price,
    qpx_serial: o.note_attributes?.find((n) => n.name === 'qpx_serial')?.value || null,
  };
}

app.get('/api/shopify/orders', async (req, res) => {
  try {
    const { limit = 50, status = 'open', page_info } = req.query;
    const totalLimit = Math.min(parseInt(limit) || 50, 600);
    const orderStatus = (status === 'open' || status === 'closed') ? status : 'any';
    const shopifyHeaders = { 'X-Shopify-Access-Token': SHOPIFY_TOKEN };
    const PAGE_SIZE = 250;

    if (page_info || totalLimit <= 250) {
      const url = `https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json?limit=${Math.min(totalLimit, 250)}&status=${orderStatus}${page_info ? `&page_info=${page_info}` : ''}`;
      const response = await axios.get(url, { headers: shopifyHeaders });
      const orders = response.data.orders
        .filter((o) => !o.cancelled_at)
        .map(mapShopifyOrder);
      const linkHeader = response.headers['link'] || '';
      const nextMatch = linkHeader.match(/<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="next"/);
      return res.json({ orders, next_page_info: nextMatch ? nextMatch[1] : null });
    }

    let allOrders = [];
    let nextPage = null;
    let firstPage = true;

    while (allOrders.length < totalLimit) {
      const remaining = totalLimit - allOrders.length;
      const pageSize = Math.min(remaining, PAGE_SIZE);
      let url = firstPage
        ? `https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json?limit=${pageSize}&status=${orderStatus}`
        : `https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json?limit=${pageSize}&page_info=${nextPage}`;
      firstPage = false;

      const response = await axios.get(url, { headers: shopifyHeaders });
      const batch = response.data.orders
        .filter((o) => !o.cancelled_at)
        .map(mapShopifyOrder);
      allOrders = allOrders.concat(batch);

      const linkHeader = response.headers['link'] || '';
      const nextMatch = linkHeader.match(/<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="next"/);
      nextPage = nextMatch ? nextMatch[1] : null;

      if (!nextPage || batch.length === 0) break;
    }

    res.json({ orders: allOrders.slice(0, totalLimit), next_page_info: null });
  } catch (err) {
    console.error('Shopify error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─── QPX: Get Cities ──────────────────────────────────────────────────────────

app.get('/api/qpx/cities', async (req, res) => {
  try {
    const token = await getQpxToken();
    const response = await axios.get(`${QPX_BASE}/locations/city/`, {
      headers: qpxHeaders(token),
      timeout: 15000,
    });
    res.json(response.data);
  } catch (err) {
    console.error('QPX cities error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─── QPX: Send Orders ─────────────────────────────────────────────────────────

app.post('/api/qpx/send-orders', async (req, res) => {
  const { orders } = req.body;
  if (!orders || !orders.length) return res.status(400).json({ error: 'No orders provided' });

  let token;
  try {
    token = await getQpxToken();
  } catch (err) {
    console.error('QPX token error:', err.response?.data || err.message);
    return res.status(502).json({ error: 'فشل في الاتصال بشركة الشحن: ' + (err.response?.data?.detail || err.message) });
  }

  const results = [];

  for (const order of orders) {
    if (order.qpx_serial) {
      results.push({ shopify_id: order.id, order_number: order.shopify_order_number, status: 'skipped', qpx_serial: order.qpx_serial });
      continue;
    }
    try {
      const isPaid = order.financial_status === 'paid';
      const payload = {
        shipment_contents: order.items,
        full_name: `${order.customer_name} #${order.shopify_order_number}`,
        phone: order.phone,
        // Andmore: street-only address (governorate goes in the QPX city field).
        // Other stores: full address incl. governorate.
        address: runtimeSettings.qpxStreetAddress
          ? (order.address || order.address_full)
          : (order.address_full || order.address),
        ...(order.qpx_city_id ? { city: order.qpx_city_id } : {}),
        customer: runtimeSettings.qpxCustomerId,
        total_amount: isPaid ? 0 : (parseFloat(order.total_price) || 0),
        notes: `Shopify Order #${order.shopify_order_number}${isPaid ? ' (مدفوع مسبقاً)' : ''}`,
        order_date: new Date().toISOString(),
      };

      const qpxRes = await axios.post(`${QPX_BASE}/addorders/order/`, payload, {
        headers: qpxHeaders(token),
        timeout: 20000,
      });

      console.log(`QPX response for #${order.shopify_order_number}:`, JSON.stringify(qpxRes.data));
      const serial = qpxRes.data?.serial || qpxRes.data?.id;

      // QPX ignores the customer field on creation (assigns the API user's
      // default customer) — always PATCH it so the order shows in the client
      // portal. Only zero the fees for stores with that toggle on (Andmore).
      if (serial) {
        try {
          const patchBody = { customer: runtimeSettings.qpxCustomerId };
          // Andmore: zero fees. It's Sunglasses: match Shopify shipping charge.
          // Others: leave QPX's auto-calculated fee untouched.
          if (runtimeSettings.qpxZeroFees) {
            patchBody.total_fees = 0;
          } else if (runtimeSettings.qpxMatchShipping) {
            patchBody.total_fees = parseFloat(order.shipping_price) || 0;
          }
          await axios.patch(
            `${QPX_BASE}/addorders/order/${serial}/`,
            patchBody,
            { headers: qpxHeaders(token), timeout: 15000 }
          );
          console.log(`QPX order ${serial} patched: customer=${runtimeSettings.qpxCustomerId}${'total_fees' in patchBody ? ', total_fees=' + patchBody.total_fees : ' (auto fees)'}`);
        } catch (err) {
          console.error(`QPX patch failed for ${serial}:`, err.response?.data || err.message);
        }
      }

      if (serial) {
        await saveQpxSerialToShopify(order.id, order.shopify_order_number, serial);
      }

      results.push({ shopify_id: order.id, order_number: order.shopify_order_number, status: 'success', qpx_serial: serial });
    } catch (err) {
      const errMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`QPX send error for order ${order.shopify_order_number}:`, errMsg);
      results.push({ shopify_id: order.id, order_number: order.shopify_order_number, status: 'error', error: errMsg });
    }
  }

  res.json({ results });
});

async function saveQpxSerialToShopify(orderId, orderNumber, serial) {
  try {
    await axios.put(
      `https://${SHOPIFY_STORE}/admin/api/2024-01/orders/${orderId}.json`,
      {
        order: {
          id: orderId,
          note_attributes: [{ name: 'qpx_serial', value: String(serial) }],
          tags: `qpx_sent,qpx_${serial}`,
        },
      },
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
    );
  } catch (err) {
    console.error(`Failed to update Shopify order ${orderNumber}:`, err.response?.data || err.message);
  }
}

// ─── Shopify: Clear QPX Serial ────────────────────────────────────────────────

app.delete('/api/shopify/orders/:id/qpx-serial', async (req, res) => {
  const orderId = req.params.id;
  try {
    await axios.put(
      `https://${SHOPIFY_STORE}/admin/api/2024-01/orders/${orderId}.json`,
      { order: { id: orderId, note_attributes: [], tags: '' } },
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Clear QPX serial error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─── QPX: Get Sent Orders ─────────────────────────────────────────────────────

app.get('/api/qpx/orders', async (req, res) => {
  try {
    const token = await getQpxToken();
    const { page = 1, page_size = 20, full_name = '', phone_number = '' } = req.query;
    const response = await axios.get(`${QPX_BASE}/addorders/order/`, {
      headers: qpxHeaders(token),
      params: { rejected: 0, page, page_size, full_name, phone_number },
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ QPX-Shopify Bridge running at http://localhost:${PORT}\n`);
});
