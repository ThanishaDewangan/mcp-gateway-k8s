const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const port = Number(process.env.PORT || 3001);
const dataDir = process.env.DATA_DIR || path.resolve(__dirname, '../../data');
const storeFile = path.join(dataDir, 'store-data.json');
const storeBackend = process.env.STORE_BACKEND || 'memory';
const wooCommerceUrl = (process.env.WOOCOMMERCE_URL || '').replace(/\/+$/, '');

async function wooCommerceRequest(resource, query = '', options = {}) {
  const key = process.env.WOOCOMMERCE_KEY;
  const secret = process.env.WOOCOMMERCE_SECRET;
  if (!wooCommerceUrl || !key || !secret) {
    throw new Error('WooCommerce URL and API credentials must be configured');
  }

  const auth = Buffer.from(`${key}:${secret}`).toString('base64');
  const response = await fetch(`${wooCommerceUrl}/wp-json/wc/v3/${resource}${query}`, {
    ...options,
    headers: {
      authorization: `Basic ${auth}`,
      'content-type': 'application/json',
      'x-forwarded-host': process.env.WOOCOMMERCE_HOST || new URL(wooCommerceUrl).host,
      'x-forwarded-proto': process.env.WOOCOMMERCE_SCHEME || 'http',
      ...options.headers
    }
  });
  const responseText = await response.text();
  let body;
  try {
    body = responseText ? JSON.parse(responseText) : null;
  } catch (error) {
    throw new Error(`WooCommerce API returned invalid JSON (HTTP ${response.status})`);
  }
  if (!response.ok) {
    throw new Error(`WooCommerce API returned ${response.status}: ${body?.message || response.statusText}`);
  }
  return body;
}

function ensureStore() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(storeFile)) {
    const initial = {
      products: [
        { id: 1, name: 'Starter Kit', price: 29.99, stock: 10 },
        { id: 2, name: 'Pro Hopper', price: 79.99, stock: 5 }
      ],
      orders: [
        { id: 1001, status: 'processing', total: 29.99, customer: 'User A', date_created: new Date().toISOString(), lineItems: [{ productId: 1, quantity: 1 }] }
      ]
    };
    fs.writeFileSync(storeFile, JSON.stringify(initial, null, 2), 'utf8');
  }
}

function readStore() {
  ensureStore();
  return JSON.parse(fs.readFileSync(storeFile, 'utf8'));
}

function writeStore(data) {
  fs.writeFileSync(storeFile, JSON.stringify(data, null, 2), 'utf8');
}

function normalizeToolResult(payload) {
  return {
    jsonrpc: '2.0',
    result: {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
    }
  };
}

async function createProductTool(args = {}) {
  if (!args.name || !Number.isFinite(Number(args.price)) || Number(args.price) < 0) {
    throw new Error('Product name and a non-negative price are required');
  }
  if (storeBackend === 'woocommerce') {
    return wooCommerceRequest('products', '', {
      method: 'POST',
      body: JSON.stringify({
        name: args.name,
        type: 'simple',
        regular_price: Number(args.price).toFixed(2),
        stock_quantity: Number(args.stock || 1),
        manage_stock: true
      })
    });
  }
  const store = readStore();
  const product = {
    id: Date.now(),
    name: args.name,
    price: Number(args.price),
    stock: Number(args.stock || 1)
  };

  store.products.push(product);
  writeStore(store);
  return { product, message: `Created product ${product.name}` };
}

async function listProductsTool() {
  if (storeBackend === 'woocommerce') {
    return wooCommerceRequest('products', '?per_page=100');
  }
  return readStore().products;
}

async function listOrdersTool(args = {}) {
  if (storeBackend === 'woocommerce') {
    const query = new URLSearchParams({ per_page: '100' });
    if (args.today) {
      const now = new Date();
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const end = new Date(start.getTime() + 86400000 - 1);
      query.set('after', start.toISOString());
      query.set('before', end.toISOString());
    } else {
      if (args.after) query.set('after', args.after);
      if (args.before) query.set('before', args.before);
    }
    return wooCommerceRequest('orders', `?${query.toString()}`);
  }
  const orders = readStore().orders;
  if (!args.today) return orders;
  const today = new Date().toISOString().slice(0, 10);
  return orders.filter((order) => (order.date_created || '').slice(0, 10) === today);
}

async function getOrderTool(args = {}) {
  const id = Number(args.id || args.orderId);
  if (!Number.isInteger(id) || id < 1) {
    throw new Error('A valid order id is required');
  }
  if (storeBackend === 'woocommerce') {
    return wooCommerceRequest(`orders/${id}`);
  }
  const found = readStore().orders.find((order) => Number(order.id) === id);
  if (!found) {
    throw new Error('Order not found');
  }
  return found;
}

async function updateOrderStatusTool(args = {}) {
  const id = Number(args.id || args.orderId);
  const allowedStatuses = ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed'];
  if (!Number.isInteger(id) || id < 1 || !allowedStatuses.includes(args.status)) {
    throw new Error('A valid order id and WooCommerce order status are required');
  }
  if (storeBackend === 'woocommerce') {
    return wooCommerceRequest(`orders/${id}`, '', {
      method: 'PUT',
      body: JSON.stringify({ status: args.status })
    });
  }
  const store = readStore();
  const order = store.orders.find((entry) => Number(entry.id) === id);
  if (!order) {
    throw new Error('Order not found');
  }
  order.status = args.status;
  writeStore(store);
  return order;
}

app.use(express.json());
app.use((req, res, next) => {
  res.set('MCP-Protocol-Version', '2025-03-26');
  next();
});
app.use((req, res, next) => {
  const expectedToken = process.env.STORE_MCP_AUTH_TOKEN;
  if (!expectedToken || req.path === '/healthz') return next();
  if (req.get('authorization') !== `Bearer ${expectedToken}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, service: 'store-mcp', backend: storeBackend, port });
});

app.post('/mcp', async (req, res) => {
  const body = req.body || {};
  const method = body.method || body.action;
  const params = body.params || {};
  const id = body.id ?? null;
  if (body.jsonrpc !== '2.0' || typeof method !== 'string') {
    return res.status(400).json({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC request' } });
  }

  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'woocommerce-mcp-server', version: '1.0.0' }
      }
    });
  }

  if (method === 'notifications/initialized' || method === 'ping') {
    return res.status(202).end();
  }

  if (method === 'tools/list') {
    if (storeBackend === 'woocommerce') {
      try {
        await wooCommerceRequest('products', '?per_page=1');
      } catch (error) {
        console.warn(`WooCommerce readiness check failed: ${error.message}`);
        return res.json({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: 'WooCommerce API is unavailable or not configured' }
        });
      }
    }
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          { name: 'list_products', description: 'List all WooCommerce products', inputSchema: { type: 'object', properties: {} } },
          { name: 'create_product', description: 'Create a WooCommerce product', inputSchema: { type: 'object', properties: { name: { type: 'string' }, price: { type: 'number' }, stock: { type: 'number' } } } },
          { name: 'list_orders', description: 'List WooCommerce orders. Set today=true to return only orders created today (UTC), or use ISO 8601 after/before timestamps.', inputSchema: { type: 'object', properties: { today: { type: 'boolean' }, after: { type: 'string' }, before: { type: 'string' } } } },
          { name: 'get_order', description: 'Get a single product order', inputSchema: { type: 'object', properties: { id: { type: 'number' } } } },
          { name: 'update_order_status', description: 'Update the status of an order', inputSchema: { type: 'object', properties: { id: { type: 'number' }, status: { type: 'string' } } } }
        ]
      }
    });
  }

  if (method === 'tools/call') {
    const toolName = params.name;
    const args = params.arguments || {};
    const tools = {
      list_products: () => listProductsTool(),
      create_product: () => createProductTool(args),
      list_orders: () => listOrdersTool(args),
      get_order: () => getOrderTool(args),
      update_order_status: () => updateOrderStatusTool(args)
    };
    if (!Object.prototype.hasOwnProperty.call(tools, toolName)) {
      return res.status(200).json({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${toolName}` } });
    }
    try {
      const payload = await tools[toolName]();
      return res.json({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
      });
    } catch (error) {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: error.message }], isError: true }
      });
    }
  }

  return res.status(200).json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported method: ${method}` } });
});

app.get('/api/products', async (req, res, next) => {
  try { res.json(await listProductsTool()); } catch (error) { next(error); }
});

app.post('/api/products', async (req, res, next) => {
  try { res.status(201).json(await createProductTool(req.body || {})); } catch (error) { next(error); }
});

app.get('/api/orders', async (req, res, next) => {
  try { res.json(await listOrdersTool(req.query)); } catch (error) { next(error); }
});

app.get('/api/orders/:id', async (req, res, next) => {
  try { res.json(await getOrderTool({ id: req.params.id })); } catch (error) { next(error); }
});

app.post('/api/orders/:id/status', async (req, res, next) => {
  try { res.json(await updateOrderStatusTool({ id: req.params.id, status: req.body.status })); } catch (error) { next(error); }
});

app.use((error, req, res, next) => {
  console.error(error.message);
  res.status(502).json({ error: error.message });
});

app.listen(port, () => {
  console.log(`Store MCP server listening on http://0.0.0.0:${port}`);
});
