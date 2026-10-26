const express = require('express');

const app = express();
const port = Number(process.env.PORT || 3005);
const shipments = [
  { tracking_number: 'UR-1001', status: 'in_transit', carrier: 'Northstar Parcel', eta: '2026-10-24' },
  { tracking_number: 'UR-1002', status: 'delivered', carrier: 'Northstar Parcel', eta: '2026-10-18' }
];

app.use(express.json());
app.use((req, res, next) => {
  res.set('MCP-Protocol-Version', '2025-03-26');
  next();
});
app.use((req, res, next) => {
  const expectedToken = process.env.SAMPLE_MCP_AUTH_TOKEN;
  if (!expectedToken || req.path === '/healthz') return next();
  if (req.get('authorization') !== `Bearer ${expectedToken}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, service: 'sample-mcp', port });
});

app.post('/mcp', (req, res) => {
  const { id = null, method, params = {} } = req.body || {};
  if (req.body?.jsonrpc !== '2.0' || typeof method !== 'string') {
    return res.status(400).json({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC request' } });
  }
  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'sample-shipping-mcp', version: '1.0.0' }
      }
    });
  }
  if (method === 'notifications/initialized' || method === 'ping') return res.status(202).end();
  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'lookup_shipment',
            description: 'Find a shipment by tracking number. Sample records include UR-1001 and UR-1002.',
            inputSchema: { type: 'object', properties: { tracking_number: { type: 'string' } }, required: ['tracking_number'] }
          },
          {
            name: 'list_shipping_regions',
            description: 'List regions supported by the sample shipping service.',
            inputSchema: { type: 'object', properties: {} }
          }
        ]
      }
    });
  }
  if (method !== 'tools/call') {
    return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported method: ${method}` } });
  }

  let value;
  if (params.name === 'lookup_shipment') {
    value = shipments.find((shipment) => shipment.tracking_number === params.arguments?.tracking_number);
    if (!value) value = { error: 'Shipment not found' };
  } else if (params.name === 'list_shipping_regions') {
    value = ['North America', 'Europe', 'Asia Pacific'];
  } else {
    return res.json({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${params.name}` } });
  }

  return res.json({
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      ...(value?.error ? { isError: true } : {})
    }
  });
});

app.listen(port, () => {
  console.log(`Sample MCP server listening on http://0.0.0.0:${port}`);
});
