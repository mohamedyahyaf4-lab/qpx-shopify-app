require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

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
const QPX_CUSTOMER_ID = parseInt(process.env.QPX_CUSTOMER_ID || '1021');
let qpxToken = null;
let qpxTokenExpiry = 0;
let qpxRefreshToken = process.env.QPX_REFRESH_TOKEN;

// ─── QPX Auth ───────────────────────────────────────────────────────────────

async function getQpxToken() {
  // Return cached access token if still valid
  if (qpxToken && Date.now() < qpxTokenExpiry) return qpxToken;

  // Try refresh token first
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

  // Fallback: login with username + password to get fresh tokens
  const loginRes = await axios.post(`${QPX_BASE}/api/token/`, {
    username: process.env.QPX_USERNAME,
    password: process.env.QPX_PASSWORD,
  }, { timeout: 15000 });

  qpxToken = loginRes.data.access;
  qpxRefreshToken = loginRes.data.refresh; // update in-memory refresh token
  qpxTokenExpiry = Date.now() + 25 * 60 * 1000;
  console.log('QPX login successful, new tokens obtained');
  return qpxToken;
}

function qpxHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

// ─── Shopify: Get Orders ─────────────────────────────────────────────────────

app.get('/api/shopify/orders', async (req, res) => {
  try {
    const { limit = 50, status = 'open', page_info } = req.query;
    let url = `https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json?limit=${limit}&status=${status === 'any' ? 'any' : 'open'}`;
    if (page_info) url += `&page_info=${page_info}`;

    const response = await axios.get(url, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN },
    });

    const orders = response.data.orders.map((o) => {
      const addr = o.shipping_address || o.billing_address || {};
      const items = o.line_items.map((i) => `${i.name} x${i.quantity}`).join(' | ');
      return {
        id: o.id,
        shopify_order_number: o.order_number,
        created_at: o.created_at,
        customer_name: `${addr.first_name || ''} ${addr.last_name || ''}`.trim() || o.contact_email,
        phone: addr.phone || o.phone || '',
        city: addr.province || addr.city || '',
        address: [addr.address1, addr.address2].filter(Boolean).join('، '),
        address_full: [
          addr.address1,
          addr.address2,
          addr.city,
          addr.province,
          addr.zip,
        ].filter(Boolean).join('، '),
        items,
        total_price: o.total_price,
        currency: o.currency,
        financial_status: o.financial_status,
        fulfillment_status: o.fulfillment_status || 'unfulfilled',
        qpx_serial: o.note_attributes?.find((n) => n.name === 'qpx_serial')?.value || null,
      };
    });

    // Pagination link header
    const linkHeader = response.headers['link'] || '';
    let nextPageInfo = null;
    const nextMatch = linkHeader.match(/<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    if (nextMatch) nextPageInfo = nextMatch[1];

    res.json({ orders, next_page_info: nextPageInfo });
  } catch (err) {
    console.error('Shopify error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─── QPX: Get Cities ─────────────────────────────────────────────────────────

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

// ─── QPX: Send Orders ────────────────────────────────────────────────────────

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
    // Skip if already sent (has qpx_serial) — prevents duplicate submissions
    if (order.qpx_serial) {
      results.push({ shopify_id: order.id, order_number: order.shopify_order_number, status: 'skipped', qpx_serial: order.qpx_serial });
      continue;
    }
    try {
      const payload = {
        shipment_contents: order.items,
        full_name: `${order.customer_name} #${order.shopify_order_number}`,
        phone: order.phone,
        address: order.address_full || order.address,
        ...(order.qpx_city_id ? { city: order.qpx_city_id } : {}),
        customer: QPX_CUSTOMER_ID,
        total_amount: parseFloat(order.total_price) || 0,
        notes: `Shopify Order #${order.shopify_order_number}`,
        order_date: new Date().toISOString(),
      };

      const qpxRes = await axios.post(`${QPX_BASE}/addorders/order/`, payload, {
        headers: qpxHeaders(token),
        timeout: 20000,
      });

      console.log(`QPX response for #${order.shopify_order_number}:`, JSON.stringify(qpxRes.data));
      const serial = qpxRes.data?.serial || qpxRes.data?.id;

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

// ─── Shopify: Clear QPX Serial ───────────────────────────────────────────────

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

// ─── QPX: Get Sent Orders ────────────────────────────────────────────────────

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

// ─── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ QPX-Shopify Bridge running at http://localhost:${PORT}\n`);
});
