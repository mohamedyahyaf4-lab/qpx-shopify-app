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

// SPA fallback — all non-API routes → index.html
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const indexPath = path.join(__dirname, 'dist', 'index.html');
  if (require('fs').existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(503).send('جاري التحميل... شغّل npm run build أولاً');
  }
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
  if (qpxToken && Date.now() < qpxTokenExpiry) return qpxToken;
  const res = await axios.post(`${QPX_BASE}/api/token/refresh/`, {
    refresh: qpxRefreshToken,
  });
  qpxToken = res.data.access;
  // Access tokens expire in ~30min, refresh after 25min
  qpxTokenExpiry = Date.now() + 25 * 60 * 1000;
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
        address: [addr.address1, addr.address2].filter(Boolean).join(', '),
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
    });
    res.json(response.data);
  } catch (err) {
    console.error('QPX cities error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─── QPX: Send Orders ────────────────────────────────────────────────────────

app.post('/api/qpx/send-orders', async (req, res) => {
  const { orders } = req.body; // array of order objects
  if (!orders || !orders.length) return res.status(400).json({ error: 'No orders provided' });

  const token = await getQpxToken();
  const results = [];

  for (const order of orders) {
    try {
      const payload = {
        shipment_contents: order.items,
        full_name: order.customer_name,
        phone: order.phone,
        address: order.address,
        city: order.qpx_city_id,
        customer: QPX_CUSTOMER_ID,
        total_amount: parseFloat(order.total_price) || 0,
        notes: `Shopify Order #${order.shopify_order_number}`,
        order_date: new Date().toISOString(),
      };

      const qpxRes = await axios.post(`${QPX_BASE}/addorders/order/`, payload, {
        headers: qpxHeaders(token),
      });

      const serial = qpxRes.data?.serial || qpxRes.data?.id;

      // Save QPX serial as note_attribute on Shopify order
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
