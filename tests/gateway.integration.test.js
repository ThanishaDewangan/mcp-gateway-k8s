const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gateway-test-'));
const children = [];
const ports = {};
const adminToken = 'integration-admin-token';
const storeToken = 'integration-store-token';
const sampleToken = 'integration-sample-token';
let mockLlm;
let sampleProcess;
const usedPorts = new Set();

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => {
        if (error) return reject(error);
        if (usedPorts.has(port)) return freePort().then(resolve, reject);
        usedPorts.add(port);
        resolve(port);
      });
    });
  });
}

function startService(file, env) {
  const child = spawn(process.execPath, [file], { cwd: root, env: { ...process.env, ...env }, stdio: 'ignore' });
  children.push(child);
  return child;
}

async function waitFor(url, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child && child.exitCode !== null) throw new Error(`${url} process exited with ${child.exitCode}`);
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

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const body = response.status === 204 ? null : await response.json();
  return { response, body };
}

before(async () => {
  ports.store = await freePort();
  ports.sample = await freePort();
  ports.gateway = await freePort();
  ports.dashboard = await freePort();
  ports.chat = await freePort();
  ports.llm = await freePort();

  mockLlm = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw);
    const hasToolResults = payload.messages.some((message) => message.role === 'tool');
    const completion = hasToolResults
      ? { role: 'assistant', content: 'The order list and shipment UR-1001 were checked.' }
      : {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call-orders', type: 'function', function: { name: 'woocommerce__list_orders', arguments: '{"today":true}' } },
            { id: 'call-shipment', type: 'function', function: { name: 'sample-mcp__lookup_shipment', arguments: '{"tracking_number":"UR-1001"}' } }
          ]
        };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: completion }] }));
  });
  await new Promise((resolve) => mockLlm.listen(ports.llm, '127.0.0.1', resolve));

  const sharedEnv = { DATA_DIR: dataDir };
  const store = startService('services/store-mcp/server.js', {
    ...sharedEnv, PORT: String(ports.store), STORE_BACKEND: 'memory', STORE_MCP_AUTH_TOKEN: storeToken
  });
  sampleProcess = startService('services/sample-mcp/server.js', {
    ...sharedEnv, PORT: String(ports.sample), SAMPLE_MCP_AUTH_TOKEN: sampleToken
  });
  const gateway = startService('services/gateway/server.js', {
    ...sharedEnv,
    PORT: String(ports.gateway),
    UPSTREAM_MCP_URL: `http://127.0.0.1:${ports.store}/mcp`,
    STORE_MCP_AUTH_TOKEN: storeToken,
    CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    DASHBOARD_ADMIN_TOKEN: adminToken
  });
  const dashboard = startService('services/dashboard/server.js', {
    ...sharedEnv,
    PORT: String(ports.dashboard),
    GATEWAY_URL: `http://127.0.0.1:${ports.gateway}`,
    CHAT_AGENT_URL: `http://127.0.0.1:${ports.chat}`,
    DASHBOARD_ADMIN_TOKEN: adminToken
  });
  const chat = startService('services/chat/server.js', {
    ...sharedEnv,
    PORT: String(ports.chat),
    GATEWAY_URL: `http://127.0.0.1:${ports.gateway}`,
    LLM_API_KEY: 'test-llm-key',
    LLM_BASE_URL: `http://127.0.0.1:${ports.llm}/v1`,
    LLM_MODEL: 'mock-model'
  });
  await Promise.all([
    waitFor(`http://127.0.0.1:${ports.store}/healthz`, store),
    waitFor(`http://127.0.0.1:${ports.sample}/healthz`, sampleProcess),
    waitFor(`http://127.0.0.1:${ports.gateway}/healthz`, gateway),
    waitFor(`http://127.0.0.1:${ports.dashboard}/healthz`, dashboard),
    waitFor(`http://127.0.0.1:${ports.chat}/healthz`, chat)
  ]);
});

after(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  if (mockLlm) await new Promise((resolve) => mockLlm.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('gateway authenticates, aggregates and routes tools, runs chat calls, audits users and isolates failures', async () => {
  const dashboardUrl = `http://127.0.0.1:${ports.dashboard}`;
  const gatewayUrl = `http://127.0.0.1:${ports.gateway}`;
  const adminHeaders = { 'x-admin-token': adminToken, 'content-type': 'application/json' };

  let result = await request(`${dashboardUrl}/api/users`, { headers: adminHeaders });
  assert.equal(result.response.status, 200);
  const user = result.body.find((entry) => entry.id === 'user-a');
  assert.ok(user);

  result = await request(`${dashboardUrl}/api/users/${user.id}/api-key`, { method: 'POST', headers: adminHeaders });
  assert.equal(result.response.status, 201);
  const apiKey = result.body.key;

  result = await request(`${dashboardUrl}/api/users`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ name: 'User B', role: 'member' })
  });
  assert.equal(result.response.status, 201);
  const userB = result.body;
  result = await request(`${dashboardUrl}/api/invitations/${userB.id}/api-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inviteToken: userB.inviteToken })
  });
  assert.equal(result.response.status, 201);
  const userBKey = result.body.key;
  assert.equal(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8').includes(userB.inviteToken), false);
  result = await request(`${dashboardUrl}/api/invitations/${userB.id}/api-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inviteToken: userB.inviteToken })
  });
  assert.equal(result.response.status, 401);

  result = await request(`${dashboardUrl}/api/servers`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      id: 'sample-mcp',
      name: 'Sample Shipping',
      url: `http://127.0.0.1:${ports.sample}/mcp`,
      credential: sampleToken
    })
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  assert.equal('credential' in result.body, false);

  const mcpHeaders = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  result = await request(`${gatewayUrl}/mcp`, {
    method: 'POST',
    headers: mcpHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 'list-tools', method: 'tools/list', params: {} })
  });
  assert.equal(result.response.status, 200);
  const names = result.body.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('woocommerce__list_products'));
  assert.ok(names.includes('sample-mcp__lookup_shipment'));
  result = await request(`${gatewayUrl}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${userBKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'user-b-list', method: 'tools/list', params: {} })
  });
  assert.equal(result.response.status, 200);
  result = await request(`${gatewayUrl}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${userBKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'user-b-orders',
      method: 'tools/call',
      params: { name: 'woocommerce__list_orders', arguments: { today: true } }
    })
  });
  assert.equal(result.response.status, 200);

  result = await request(`${gatewayUrl}/mcp`, {
    method: 'POST',
    headers: mcpHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'lookup-shipment',
      method: 'tools/call',
      params: { name: 'sample-mcp__lookup_shipment', arguments: { tracking_number: 'UR-1001' } }
    })
  });
  assert.equal(result.body.id, 'lookup-shipment');
  assert.match(result.body.result.content[0].text, /in_transit/);

  result = await request(`${dashboardUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey, message: 'What orders came in today and where is UR-1001?' })
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.match(result.body.response, /shipment UR-1001/);
  assert.deepEqual(result.body.toolsCalled.map((tool) => tool.name), [
    'woocommerce__list_orders',
    'sample-mcp__lookup_shipment'
  ]);

  result = await request(`${dashboardUrl}/api/audit`, { headers: adminHeaders });
  assert.ok(result.body.some((entry) => entry.user === 'User A' && entry.server === 'Sample Shipping' && entry.tool === 'lookup_shipment' && entry.status === 'ok'));
  assert.ok(result.body.some((entry) => entry.user === 'User A' && entry.server === 'WooCommerce Store' && entry.tool === 'list_orders' && entry.status === 'ok'));
  assert.ok(result.body.some((entry) => entry.user === 'User B' && entry.server === 'WooCommerce Store' && entry.tool === 'list_orders'));

  result = await request(`${dashboardUrl}/api/servers/sample-mcp`, {
    method: 'PUT',
    headers: adminHeaders,
    body: JSON.stringify({ enabled: false })
  });
  assert.equal(result.response.status, 200);
  result = await request(`${gatewayUrl}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${userBKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'disabled-tool',
      method: 'tools/call',
      params: { name: 'sample-mcp__lookup_shipment', arguments: { tracking_number: 'UR-1001' } }
    })
  });
  assert.equal(result.response.status, 404);
  result = await request(`${dashboardUrl}/api/audit`, { headers: adminHeaders });
  assert.ok(result.body.some((entry) => entry.user === 'User B' && entry.server === 'sample-mcp' && entry.status === 'failed'));

  result = await request(`${dashboardUrl}/api/servers/sample-mcp`, {
    method: 'PUT',
    headers: adminHeaders,
    body: JSON.stringify({ enabled: true })
  });
  assert.equal(result.response.status, 200);
  sampleProcess.kill();
  await new Promise((resolve) => setTimeout(resolve, 100));
  result = await request(`${dashboardUrl}/api/servers`, { headers: adminHeaders });
  assert.equal(result.body.find((server) => server.id === 'sample-mcp').status, 'Unreachable');
  result = await request(`${gatewayUrl}/mcp`, {
    method: 'POST',
    headers: mcpHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 'after-failure', method: 'tools/list', params: {} })
  });
  assert.ok(result.body.result.tools.some((tool) => tool.name === 'woocommerce__list_products'));
  assert.ok(!result.body.result.tools.some((tool) => tool.name.startsWith('sample-mcp__')));

  result = await request(`${dashboardUrl}/api/users/${userB.id}/api-keys`, { method: 'DELETE', headers: adminHeaders });
  assert.equal(result.response.status, 204);
  result = await request(`${gatewayUrl}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${userBKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'revoked', method: 'tools/list', params: {} })
  });
  assert.equal(result.response.status, 401);

  result = await request(`${dashboardUrl}/api/users/${user.id}/api-keys`, { method: 'DELETE', headers: adminHeaders });
  assert.equal(result.response.status, 204);
});
