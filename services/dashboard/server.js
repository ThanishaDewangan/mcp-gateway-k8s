const express = require('express');
const path = require('path');
const crypto = require('crypto');
const {
  getUsers,
  saveUsers,
  getAuditLog,
  appendAuditLog,
  generateApiKey,
  hashApiKey
} = require('../../shared/state');

const app = express();
const port = Number(process.env.PORT || 3003);
const publicDir = path.join(__dirname, 'public');
const gatewayBaseUrl = process.env.GATEWAY_URL || 'http://localhost:3002';
const chatAgentUrl = process.env.CHAT_AGENT_URL || 'http://localhost:3004';
const adminToken = process.env.DASHBOARD_ADMIN_TOKEN || '';

app.use(express.json());
app.use(express.static(publicDir));

function requireAdmin(req, res, next) {
  if (!adminToken) return res.status(503).json({ error: 'DASHBOARD_ADMIN_TOKEN is not configured' });
  if (req.get('x-admin-token') !== adminToken) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  next();
}

app.get('/healthz', (req, res) => {
  res.json({ ok: true, service: 'dashboard', port });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, cluster: 'local-kubernetes', gatewayUrl: gatewayBaseUrl });
});

app.get('/api/users', requireAdmin, (req, res) => {
  res.json(getUsers().users.map(({ apiKeyHashes = [], inviteTokenHash, ...user }) => ({ ...user, activeKeys: apiKeyHashes.length })));
});

app.post('/api/users', requireAdmin, (req, res) => {
  if (!req.body?.name || !['member', 'admin'].includes(req.body.role || 'member')) {
    return res.status(400).json({ error: 'A name and valid role are required' });
  }
  const users = getUsers();
  const user = {
    id: `user-${Date.now()}`,
    name: req.body.name.trim(),
    role: req.body.role || 'member',
    apiKeyHashes: []
  };
  const inviteToken = generateApiKey();
  user.inviteTokenHash = hashApiKey(inviteToken);
  users.users.push(user);
  saveUsers(users);
  res.status(201).json({ id: user.id, name: user.name, role: user.role, inviteToken });
});

app.post('/api/invitations/:id/api-key', (req, res) => {
  const users = getUsers();
  const user = users.users.find((entry) => entry.id === req.params.id);
  const suppliedToken = req.body?.inviteToken;
  const suppliedHash = typeof suppliedToken === 'string' ? Buffer.from(hashApiKey(suppliedToken), 'hex') : Buffer.alloc(0);
  const expectedHash = user?.inviteTokenHash ? Buffer.from(user.inviteTokenHash, 'hex') : Buffer.alloc(0);
  if (suppliedHash.length !== expectedHash.length || suppliedHash.length === 0 ||
      !crypto.timingSafeEqual(suppliedHash, expectedHash)) {
    return res.status(401).json({ error: 'Invalid or expired invitation token' });
  }
  const key = generateApiKey();
  user.apiKeyHashes ||= [];
  user.apiKeyHashes.push(hashApiKey(key));
  delete user.inviteTokenHash;
  saveUsers(users);
  appendAuditLog({ user: user.name, server: 'dashboard', tool: 'self_issue_api_key', status: 'ok', durationMs: 0, method: 'self-service-key' });
  res.status(201).json({ key });
});

app.post('/api/users/:id/api-key', requireAdmin, (req, res) => {
  const users = getUsers();
  const user = users.users.find((entry) => entry.id === req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const key = generateApiKey();
  user.apiKeyHashes ||= [];
  user.apiKeyHashes.push(hashApiKey(key));
  saveUsers(users);
  appendAuditLog({ user: user.name, server: 'dashboard', tool: 'issue_api_key', status: 'ok', durationMs: 0, method: 'create-key' });
  res.status(201).json({ key });
});

app.delete('/api/users/:id/api-keys', requireAdmin, (req, res) => {
  const users = getUsers();
  const user = users.users.find((entry) => entry.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.apiKeyHashes = [];
  delete user.inviteTokenHash;
  saveUsers(users);
  appendAuditLog({ user: user.name, server: 'dashboard', tool: 'revoke_api_keys', status: 'ok', durationMs: 0, method: 'revoke-keys' });
  res.status(204).end();
});

app.get('/api/audit', requireAdmin, (req, res) => {
  res.json(getAuditLog());
});

app.get('/api/servers', requireAdmin, async (req, res) => {
  try {
    const response = await fetch(`${gatewayBaseUrl}/api/servers`, {
      headers: { 'x-admin-token': adminToken }
    });
    if (!response.ok) return res.status(response.status).json({ error: 'Gateway server inventory request failed' });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: `Gateway is unavailable: ${error.message}` });
  }
});

app.post('/api/servers', requireAdmin, async (req, res) => {
  try {
    const response = await fetch(`${gatewayBaseUrl}/api/servers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': adminToken },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/servers/:id', requireAdmin, async (req, res) => {
  try {
    const response = await fetch(`${gatewayBaseUrl}/api/servers/${encodeURIComponent(req.params.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-token': adminToken },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(502).json({ error: `Gateway is unavailable: ${error.message}` });
  }
});

app.delete('/api/servers/:id', requireAdmin, async (req, res) => {
  try {
    const response = await fetch(`${gatewayBaseUrl}/api/servers/${encodeURIComponent(req.params.id)}`, {
      method: 'DELETE',
      headers: { 'x-admin-token': adminToken }
    });
    res.status(response.status).end();
  } catch (error) {
    res.status(502).json({ error: `Gateway is unavailable: ${error.message}` });
  }
});

app.post('/api/chat', async (req, res) => {
  const { message, apiKey } = req.body || {};
  if (typeof message !== 'string' || !message.trim() || typeof apiKey !== 'string') {
    return res.status(400).json({ error: 'A chat message and user API key are required' });
  }
  try {
    const chatRes = await fetch(`${chatAgentUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ message: message.trim() })
    });
    const result = await chatRes.json();
    res.status(chatRes.status).json(result);
  } catch (error) {
    res.status(502).json({ error: `Chat service is unavailable: ${error.message}` });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(port, () => {
  console.log(`Dashboard server listening on http://0.0.0.0:${port}`);
});
