const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const rootDir = path.resolve(__dirname, '..');
const dataDir = process.env.DATA_DIR || path.join(rootDir, 'data');
const gatewayFile = path.join(dataDir, 'gateway-state.json');
const auditFile = path.join(dataDir, 'audit-log.json');
const userFile = path.join(dataDir, 'users.json');
const defaultStoreMcpUrl = process.env.UPSTREAM_MCP_URL || 'http://localhost:3001/mcp';

function ensureFile(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), 'utf8');
  }
}

function readJson(filePath, fallback) {
  ensureFile(filePath, fallback);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read state file ${filePath}: ${error.message}`);
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function getGatewayState() {
  return readJson(gatewayFile, {
    servers: [
      {
        id: 'woocommerce',
        name: 'WooCommerce Store',
        url: defaultStoreMcpUrl,
        credential: process.env.STORE_MCP_AUTH_TOKEN || '',
        status: 'Connected',
        enabled: true,
        tools: ['list_products', 'create_product', 'list_orders', 'get_order', 'update_order_status']
      }
    ]
  });
}

function saveGatewayState(state) {
  writeJson(gatewayFile, state);
}

function getAuditLog() {
  return readJson(auditFile, []);
}

function appendAuditLog(entry) {
  const logs = getAuditLog();
  logs.push({
    id: `audit-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    ts: new Date().toISOString(),
    ...entry
  });
  writeJson(auditFile, logs);
}

function getUsers() {
  return readJson(userFile, {
    users: [
      {
        id: 'user-a',
        name: 'User A',
        role: 'admin',
        apiKeyHashes: process.env.BOOTSTRAP_USER_A_API_KEY ? [hashApiKey(process.env.BOOTSTRAP_USER_A_API_KEY)] : []
      },
      {
        id: 'user-b',
        name: 'User B',
        role: 'member',
        apiKeyHashes: process.env.BOOTSTRAP_USER_B_API_KEY ? [hashApiKey(process.env.BOOTSTRAP_USER_B_API_KEY)] : []
      }
    ]
  });
}

function saveUsers(users) {
  writeJson(userFile, users);
}

function isValidApiKey(key) {
  return userFromApiKey(key) !== null;
}

function userFromApiKey(key) {
  if (!key) return null;
  const keyHash = hashApiKey(key);
  const state = getUsers();
  const user = state.users.find((entry) =>
    (entry.apiKeyHashes || []).some((storedHash) => {
      const a = Buffer.from(storedHash, 'hex');
      const b = Buffer.from(keyHash, 'hex');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    })
  );
  return user || null;
}

function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function generateApiKey() {
  return `mcp_${crypto.randomBytes(32).toString('base64url')}`;
}

module.exports = {
  getGatewayState,
  saveGatewayState,
  getAuditLog,
  appendAuditLog,
  getUsers,
  saveUsers,
  isValidApiKey,
  userFromApiKey,
  hashApiKey,
  generateApiKey
};
