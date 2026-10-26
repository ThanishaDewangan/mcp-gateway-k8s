const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  getGatewayState,
  saveGatewayState,
  appendAuditLog,
  userFromApiKey,
  isValidApiKey
} = require('../../shared/state');

const app = express();
const port = Number(process.env.PORT || 3002);
const dataDir = process.env.DATA_DIR || path.resolve(__dirname, '../../data');
const upstreamFile = path.join(dataDir, 'upstream-servers.json');

function encryptionKey() {
  const value = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!value) throw new Error('CREDENTIALS_ENCRYPTION_KEY must be configured');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('CREDENTIALS_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  return key;
}

function encryptCredential(credential) {
  if (!credential) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(credential, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
}

function decryptCredential(encrypted) {
  if (!encrypted) return '';
  const [iv, tag, ciphertext] = encrypted.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

function publicServer(server) {
  const { credential, credentialCiphertext, ...safeServer } = server;
  return safeServer;
}

function ensureState() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(upstreamFile)) {
    const servers = getGatewayState().servers.map(({ credential, ...server }) => ({
      ...server,
      credentialCiphertext: encryptCredential(credential)
    }));
    fs.writeFileSync(upstreamFile, JSON.stringify({ servers }, null, 2), 'utf8');
  }
}

function readServers() {
  ensureState();
  return JSON.parse(fs.readFileSync(upstreamFile, 'utf8')).servers || [];
}

function writeServers(servers) {
  fs.writeFileSync(upstreamFile, JSON.stringify({ servers }, null, 2), 'utf8');
}

async function callUpstream(server, method, params) {
  const body = { jsonrpc: '2.0', id: crypto.randomUUID(), method, params };
  const credential = server.credentialCiphertext ? decryptCredential(server.credentialCiphertext) : '';
  const response = await fetch(server.url, {
    signal: AbortSignal.timeout(10000),
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'MCP-Protocol-Version': '2025-03-26',
      ...(credential ? { authorization: `Bearer ${credential}` } : {})
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Upstream ${server.name} unreachable: ${response.status}`);
  }

  const result = await response.json();
  if (result.error) {
    throw new Error(`Upstream ${server.name} returned an MCP error: ${result.error.message || 'unknown error'}`);
  }
  return result;
}

function getEnabledServers() {
  return readServers().filter((server) => server.enabled && server.status !== 'Disabled');
}

function parseAuth(req) {
  const header = req.headers.authorization || '';
  const key = header.startsWith('Bearer ') ? header.slice(7) : header;
  return key;
}

function requireUser(req, res, next) {
  const token = parseAuth(req);
  if (!token || !isValidApiKey(token)) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  req.user = userFromApiKey(token);
  next();
}

function requireAdmin(req, res, next) {
  const expected = process.env.DASHBOARD_ADMIN_TOKEN;
  if (!expected) return res.status(503).json({ error: 'DASHBOARD_ADMIN_TOKEN is not configured' });
  if (req.get('x-admin-token') !== expected) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  next();
}

app.use(express.json());
app.use((req, res, next) => {
  res.set('MCP-Protocol-Version', '2025-03-26');
  next();
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, service: 'gateway', port });
});

app.get('/api/servers', requireAdmin, async (req, res) => {
  const servers = readServers();
  const results = await Promise.all(servers.map(async (server) => {
    if (!server.enabled) {
      server.status = 'Disabled';
      return server;
    }
    try {
      await callUpstream(server, 'tools/list', {});
      server.status = 'Connected';
    } catch (error) {
      server.status = 'Unreachable';
    }
    return server;
  }));
  writeServers(results);
  res.json(results.map(publicServer));
});

app.post('/api/servers', requireAdmin, async (req, res) => {
  const servers = readServers();
  const payload = req.body || {};
  if (!payload.url) return res.status(400).json({ error: 'Upstream MCP URL is required' });
  let parsedUrl;
  try {
    parsedUrl = new URL(payload.url);
  } catch (error) {
    return res.status(400).json({ error: 'Upstream MCP URL must be an absolute URL' });
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    return res.status(400).json({ error: 'Upstream MCP URL must use HTTP(S) and cannot include embedded credentials' });
  }
  const generatedId = String(payload.name || 'mcp-server').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const id = String(payload.id || generatedId);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
    return res.status(400).json({ error: 'Server id must use 1-64 lowercase letters, numbers, hyphens, or underscores' });
  }
  if (servers.some((server) => server.id === id)) {
    return res.status(409).json({ error: `Server id '${id}' is already registered` });
  }
  const next = {
    id,
    name: payload.name || 'New MCP Server',
    url: parsedUrl.toString(),
    credentialCiphertext: encryptCredential(payload.credential || ''),
    status: 'Unreachable',
    enabled: payload.enabled !== false,
    tools: []
  };
  try {
    const discovery = await callUpstream(next, 'tools/list', {});
    next.tools = (discovery.result?.tools || []).map((tool) => tool.name);
    next.status = 'Connected';
  } catch (error) {
    return res.status(400).json({ error: `Could not connect to upstream MCP server: ${error.message}` });
  }
  servers.push(next);
  writeServers(servers);
  saveGatewayState({ servers });
  res.status(201).json(publicServer(next));
});

app.put('/api/servers/:id', requireAdmin, async (req, res) => {
  const servers = readServers();
  const index = servers.findIndex((server) => server.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'Server not found' });
  }
  const allowedFields = ['name', 'url', 'credential', 'enabled'];
  const updates = Object.fromEntries(Object.entries(req.body || {}).filter(([key]) => allowedFields.includes(key)));
  if (Object.prototype.hasOwnProperty.call(updates, 'credential')) {
    updates.credentialCiphertext = encryptCredential(updates.credential);
    delete updates.credential;
  }
  if (typeof updates.url === 'string') {
    let parsedUrl;
    try { parsedUrl = new URL(updates.url); } catch (error) {
      return res.status(400).json({ error: 'Upstream MCP URL must be an absolute URL' });
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
      return res.status(400).json({ error: 'Upstream MCP URL must use HTTP(S) and cannot include embedded credentials' });
    }
    updates.url = parsedUrl.toString();
  }
  const next = { ...servers[index], ...updates };
  if (updates.url || updates.credentialCiphertext) {
    next.status = 'Unreachable';
    next.tools = [];
    try {
      const discovery = await callUpstream(next, 'tools/list', {});
      next.tools = (discovery.result?.tools || []).map((tool) => tool.name);
      next.status = 'Connected';
    } catch (error) {
      return res.status(400).json({ error: `Could not connect to upstream MCP server: ${error.message}` });
    }
  }
  if (typeof updates.enabled === 'boolean') next.status = updates.enabled ? 'Unreachable' : 'Disabled';
  servers[index] = next;
  writeServers(servers);
  saveGatewayState({ servers });
  res.json(publicServer(next));
});

app.delete('/api/servers/:id', requireAdmin, (req, res) => {
  const servers = readServers().filter((server) => server.id !== req.params.id);
  writeServers(servers);
  saveGatewayState({ servers });
  res.status(204).send();
});

app.get('/api/tools', requireUser, async (req, res) => {
  const servers = getEnabledServers();
  const toolGroups = await Promise.all(servers.map(async (server) => {
    try {
      const response = await callUpstream(server, 'tools/list', {});
      return (response.result?.tools || []).map((tool) => ({
        ...tool,
        name: `${server.id}__${tool.name}`,
        description: `[${server.name}] ${tool.description || ''}`,
        annotations: { serverId: server.id, upstreamTool: tool.name }
      }));
    } catch (error) {
      console.warn(`Tool discovery failed for ${server.id}: ${error.message}`);
      return [];
    }
  }));
  res.json(toolGroups.flat());
});

app.post('/mcp', requireUser, async (req, res) => {
  const body = req.body || {};
  const method = body.method;
  const params = body.params || {};
  const name = params.name || body.toolName || null;
  const startedAt = Date.now();
  if (body.jsonrpc !== '2.0' || typeof method !== 'string') {
    return res.status(400).json({
      jsonrpc: '2.0',
      id: body.id ?? null,
      error: { code: -32600, message: 'Invalid JSON-RPC request' }
    });
  }

  try {
    if (method === 'initialize') {
      return res.json({
        jsonrpc: '2.0',
        id: body.id ?? null,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'team-mcp-gateway', version: '1.0.0' }
        }
      });
    }
    if (method === 'notifications/initialized' || method === 'ping') {
      return res.status(202).end();
    }
    if (method === 'tools/list') {
      const groups = await Promise.all(getEnabledServers().map(async (server) => {
        try {
          const response = await callUpstream(server, 'tools/list', {});
          return (response.result?.tools || []).map((tool) => ({
            ...tool,
            name: `${server.id}__${tool.name}`,
            description: `[${server.name}] ${tool.description || ''}`
          }));
        } catch (error) {
          console.warn(`Tool discovery failed for ${server.id}: ${error.message}`);
          return [];
        }
      }));
      return res.json({ jsonrpc: '2.0', id: body.id ?? null, result: { tools: groups.flat() } });
    }

    if (method === 'tools/call' || body.type === 'tool-call') {
      if (typeof name !== 'string' || name.length === 0) {
        appendAuditLog({
          user: req.user.name,
          server: 'gateway',
          tool: 'unknown',
          status: 'failed',
          durationMs: Date.now() - startedAt,
          method,
          error: 'A tool name is required'
        });
        return res.json({
          jsonrpc: '2.0',
          id: body.id ?? null,
          error: { code: -32602, message: 'A tool name is required' }
        });
      }
      const separator = name.indexOf('__');
      if (separator <= 0) {
        appendAuditLog({
          user: req.user.name,
          server: 'gateway',
          tool: name,
          status: 'failed',
          durationMs: Date.now() - startedAt,
          method,
          error: 'Tool name must include its server id prefix'
        });
        return res.status(400).json({ jsonrpc: '2.0', id: body.id ?? null, error: { code: -32602, message: 'Tool name must include its server id prefix' } });
      }
      const serverId = name.slice(0, separator);
      const upstreamTool = name.slice(separator + 2);
      const targetServer = getEnabledServers().find((server) => server.id === serverId);

      if (!targetServer) {
        appendAuditLog({
          user: req.user.name,
          server: serverId,
          tool: upstreamTool,
          status: 'failed',
          durationMs: Date.now() - startedAt,
          method,
          error: 'Tool server is not enabled'
        });
        return res.status(404).json({ jsonrpc: '2.0', id: body.id ?? null, error: { code: -32602, message: 'Tool server is not enabled' } });
      }

      const response = await callUpstream(targetServer, 'tools/call', { name: upstreamTool, arguments: params.arguments || {} });
      appendAuditLog({
        user: req.user.name,
        server: targetServer.name,
        tool: upstreamTool,
        status: response.result?.isError ? 'failed' : 'ok',
        durationMs: Date.now() - startedAt,
        method
      });
      return res.json({ ...response, id: body.id ?? null });
    }

    return res.json({
      jsonrpc: '2.0',
      id: body.id ?? null,
      error: { code: -32601, message: `Unsupported method ${method}` }
    });
  } catch (error) {
    appendAuditLog({
      user: req.user.name,
      server: 'gateway',
      tool: name || 'unknown',
      status: 'failed',
      durationMs: Date.now() - startedAt,
      method,
      error: error.message
    });
    res.status(502).json({
      jsonrpc: '2.0',
      id: body.id ?? null,
      error: { code: -32000, message: error.message }
    });
  }
});

app.listen(port, () => {
  console.log(`Gateway server listening on http://0.0.0.0:${port}`);
});
