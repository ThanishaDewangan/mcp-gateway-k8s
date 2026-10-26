const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const storeToken = 'store-mcp-integration-token';
const consumerKey = 'ck_integration';
const consumerSecret = 'cs_integration';
const processes = [];
let storePort;
let wooPort;
let storeProcess;
let mockWoo;
const calls = [];

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function startStore() {
  storeProcess = spawn(process.execPath, ['services/store-mcp/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(storePort),
      STORE_BACKEND: 'woocommerce',
      WOOCOMMERCE_URL: `http://127.0.0.1:${wooPort}`,
      WOOCOMMERCE_HOST: 'store.test',
      WOOCOMMERCE_SCHEME: 'http',
      WOOCOMMERCE_KEY: consumerKey,
      WOOCOMMERCE_SECRET: consumerSecret,
      STORE_MCP_AUTH_TOKEN: storeToken
    },
    stdio: 'ignore'
  });
  processes.push(storeProcess);
  return storeProcess;
}

async function waitFor(url, process) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`Store MCP process exited with ${process.exitCode}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch (error) {
      if (attempt === 99) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function invoke(tool, args = {}) {
  const response = await fetch(`http://127.0.0.1:${storePort}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${storeToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `test-${tool}`,
      method: 'tools/call',
      params: { name: tool, arguments: args }
    })
  });
  return { response, body: await response.json() };
}

before(async () => {
  storePort = await findFreePort();
  wooPort = await findFreePort();
  mockWoo = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const auth = req.headers.authorization;
    calls.push({ method: req.method, url: req.url, auth, forwardedHost: req.headers['x-forwarded-host'] });
    const parsedUrl = new URL(req.url, 'http://mock');
    const resource = parsedUrl.pathname.replace('/wp-json/wc/v3/', '');
    let payload;

    if (resource === 'products' && req.method === 'GET') payload = [{ id: 1, name: 'Woo product', price: '12.50' }];
    else if (resource === 'products' && req.method === 'POST') payload = { id: 3, ...JSON.parse(body) };
    else if (resource === 'orders' && req.method === 'GET') payload = [{ id: 42, status: 'processing', date_created: new Date().toISOString() }];
    else if (resource === 'orders/42' && req.method === 'GET') payload = { id: 42, status: 'processing' };
    else if (resource === 'orders/42' && req.method === 'PUT') payload = { id: 42, ...JSON.parse(body) };
    else payload = { message: `Unexpected mock endpoint ${req.method} ${req.url}` };

    const status = payload.message ? 404 : 200;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => mockWoo.listen(wooPort, '127.0.0.1', resolve));
  const process = startStore();
  await waitFor(`http://127.0.0.1:${storePort}/healthz`, process);
});

after(async () => {
  for (const process of processes) {
    if (process.exitCode === null) process.kill();
  }
  if (mockWoo) await new Promise((resolve) => mockWoo.close(resolve));
});

test('WooCommerce MCP tools call REST v3 with secret credentials and validated data', async () => {
  let result = await invoke('list_products');
  assert.equal(result.response.status, 200);
  assert.match(result.body.result.content[0].text, /Woo product/);

  result = await invoke('create_product', { name: 'New Item', price: 17.5, stock: 4 });
  assert.equal(result.body.result.isError, undefined);
  assert.equal(JSON.parse(result.body.result.content[0].text).regular_price, '17.50');

  result = await invoke('list_orders', { today: true });
  assert.match(result.body.result.content[0].text, /42/);
  const ordersRequest = calls.find((call) => call.url.startsWith('/wp-json/wc/v3/orders?'));
  assert.ok(ordersRequest.url.includes('after='));
  assert.ok(ordersRequest.url.includes('before='));

  result = await invoke('get_order', { id: 42 });
  assert.match(result.body.result.content[0].text, /processing/);
  result = await invoke('update_order_status', { id: 42, status: 'completed' });
  assert.match(result.body.result.content[0].text, /completed/);

  const expectedAuth = `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')}`;
  assert.ok(calls.every((call) => call.auth === expectedAuth));
  assert.ok(calls.every((call) => call.forwardedHost === 'store.test'));

  result = await invoke('update_order_status', { id: 42, status: 'not-a-status' });
  assert.equal(result.body.result.isError, true);
  assert.match(result.body.result.content[0].text, /valid order id/);

  const unauthorized = await fetch(`http://127.0.0.1:${storePort}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  });
  assert.equal(unauthorized.status, 401);
});
