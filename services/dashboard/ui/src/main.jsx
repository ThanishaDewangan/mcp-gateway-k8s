import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

async function api(url, options = {}, adminToken = '') {
  const headers = {
    ...(options.body ? { 'content-type': 'application/json' } : {}),
    ...(adminToken ? { 'x-admin-token': adminToken } : {}),
    ...(options.headers || {})
  };
  const response = await fetch(url, { ...options, headers });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
  return body;
}

function Dashboard() {
  const [adminToken, setAdminToken] = useState(() => sessionStorage.getItem('adminToken') || '');
  const [servers, setServers] = useState([]);
  const [users, setUsers] = useState([]);
  const [audit, setAudit] = useState([]);
  const [error, setError] = useState('');
  const [chatKey, setChatKey] = useState('');
  const [chatMessage, setChatMessage] = useState('');
  const [chatResult, setChatResult] = useState(null);
  const [inviteId, setInviteId] = useState('');
  const [inviteToken, setInviteToken] = useState('');

  const refresh = useCallback(async () => {
    if (!adminToken) return;
    try {
      const [nextServers, nextUsers, nextAudit] = await Promise.all([
        api('/api/servers', {}, adminToken),
        api('/api/users', {}, adminToken),
        api('/api/audit', {}, adminToken)
      ]);
      setServers(nextServers);
      setUsers(nextUsers);
      setAudit(nextAudit);
      setError('');
    } catch (cause) {
      setError(cause.message);
    }
  }, [adminToken]);

  useEffect(() => {
    sessionStorage.setItem('adminToken', adminToken);
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [adminToken, refresh]);

  async function submit(event, url, method) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    try {
      await api(url, { method, body: JSON.stringify(data) }, adminToken);
      form.reset();
      await refresh();
    } catch (cause) {
      setError(cause.message);
    }
  }

  async function toggleServer(server) {
    try {
      await api(`/api/servers/${encodeURIComponent(server.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: !server.enabled })
      }, adminToken);
      await refresh();
    } catch (cause) {
      setError(cause.message);
    }
  }

  async function editServer(server) {
    const name = window.prompt('Server display name:', server.name);
    if (name === null) return;
    const url = window.prompt('MCP Streamable HTTP endpoint:', server.url);
    if (url === null) return;
    const credential = window.prompt('New upstream bearer credential (leave blank to keep existing):', '');
    const changes = { name, url };
    if (credential) changes.credential = credential;
    try {
      await api(`/api/servers/${encodeURIComponent(server.id)}`, {
        method: 'PUT',
        body: JSON.stringify(changes)
      }, adminToken);
      await refresh();
    } catch (cause) {
      setError(cause.message);
    }
  }

  async function removeServer(server) {
    if (!window.confirm(`Remove ${server.name}?`)) return;
    try {
      await api(`/api/servers/${encodeURIComponent(server.id)}`, { method: 'DELETE' }, adminToken);
      await refresh();
    } catch (cause) {
      setError(cause.message);
    }
  }

  async function issueKey(user) {
    try {
      const result = await api(`/api/users/${encodeURIComponent(user.id)}/api-key`, { method: 'POST' }, adminToken);
      window.alert(`Copy this key now; it is only shown once:\n\n${result.key}`);
      await refresh();
    } catch (cause) {
      setError(cause.message);
    }
  }

  async function createMember(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    try {
      const invitation = await api('/api/users', {
        method: 'POST',
        body: JSON.stringify(data)
      }, adminToken);
      form.reset();
      window.alert(`Send these values to ${invitation.name} securely:\nUser ID: ${invitation.id}\nOne-time enrollment token: ${invitation.inviteToken}`);
      await refresh();
    } catch (cause) {
      setError(cause.message);
    }
  }

  async function redeemInvite(event) {
    event.preventDefault();
    try {
      const result = await api(`/api/invitations/${encodeURIComponent(inviteId)}/api-key`, {
        method: 'POST',
        body: JSON.stringify({ inviteToken })
      });
      setInviteToken('');
      window.alert(`Copy your new gateway API key now; it is only shown once:\n\n${result.key}`);
    } catch (cause) {
      setError(cause.message);
    }
  }

  async function revokeKeys(user) {
    if (!window.confirm(`Revoke all keys for ${user.name}?`)) return;
    try {
      await api(`/api/users/${encodeURIComponent(user.id)}/api-keys`, { method: 'DELETE' }, adminToken);
      await refresh();
    } catch (cause) {
      setError(cause.message);
    }
  }

  async function chat(event) {
    event.preventDefault();
    setChatResult(null);
    try {
      const result = await api('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ apiKey: chatKey, message: chatMessage })
      });
      setChatResult(result);
    } catch (cause) {
      setError(cause.message);
    }
  }

  return (
    <main>
      <header className="page-heading">
        <div><p className="eyebrow">TEAM TOOLING</p><h1>MCP Gateway</h1></div>
        <span className="live-indicator">● Live status</span>
      </header>
      <section className="panel admin-panel">
        <label htmlFor="admin-token">Dashboard admin token</label>
        <input id="admin-token" type="password" value={adminToken}
          onChange={(event) => setAdminToken(event.target.value)}
          placeholder="Operator-provided admin token" autoComplete="off" />
        <p className="hint">User API keys are hashed at rest and only displayed once when issued.</p>
      </section>
      <section className="panel admin-panel">
        <h2>Redeem team invitation</h2>
        <p className="hint">Use the one-time user ID and enrollment token sent by your administrator to create your own API key.</p>
        <form className="inline-form" onSubmit={redeemInvite}>
          <input value={inviteId} onChange={(event) => setInviteId(event.target.value)} placeholder="User ID" required />
          <input value={inviteToken} onChange={(event) => setInviteToken(event.target.value)} type="password" placeholder="One-time enrollment token" required />
          <button type="submit">Create my API key</button>
        </form>
      </section>
      {error && <div className="error-banner" role="alert">{error}</div>}

      <div className="columns">
        <section className="panel">
          <div className="section-title"><div><p className="eyebrow">UPSTREAMS</p><h2>MCP servers</h2></div><span className="count">{servers.length}</span></div>
          <div className="table-wrap"><table><thead><tr><th>Server</th><th>Status</th><th>Tools</th><th>Control</th></tr></thead>
            <tbody>{servers.map((server) => <tr key={server.id}>
              <td><strong>{server.name}</strong><small>{server.url}</small></td>
              <td><span className={`status ${server.status.toLowerCase()}`}>{server.status}</span></td>
              <td><div className="pills">{(server.tools || []).map((tool) => <span className="pill" key={tool}>{tool}</span>)}</div></td>
              <td className="actions"><button className="secondary" onClick={() => editServer(server)}>Edit</button>
                <button className="secondary" onClick={() => toggleServer(server)}>{server.enabled ? 'Disable' : 'Enable'}</button>
                <button className="danger" onClick={() => removeServer(server)}>Remove</button></td>
            </tr>)}</tbody></table></div>
          <form className="inline-form" onSubmit={(event) => submit(event, '/api/servers', 'POST')}>
            <h3>Register MCP server</h3>
              <input name="id" placeholder="Stable id (optional, e.g. sample-mcp)" />
              <input name="name" placeholder="Display name" required />
            <input name="url" type="url" placeholder="http://service.namespace:3001/mcp" required />
            <input name="credential" type="password" placeholder="Optional upstream bearer credential" autoComplete="new-password" />
            <button type="submit">Connect server</button>
          </form>
        </section>

        <section className="panel">
          <div className="section-title"><div><p className="eyebrow">ACCESS</p><h2>Team members</h2></div><span className="count">{users.length}</span></div>
          <div className="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>Active keys</th><th>Actions</th></tr></thead>
            <tbody>{users.map((user) => <tr key={user.id}>
              <td><strong>{user.name}</strong></td><td>{user.role}</td><td>{user.activeKeys}</td>
              <td className="actions"><button className="secondary" onClick={() => issueKey(user)}>Issue key</button>
                <button className="danger" onClick={() => revokeKeys(user)}>Revoke all</button></td>
            </tr>)}</tbody></table></div>
          <form className="inline-form" onSubmit={createMember}>
            <h3>Invite member</h3>
            <input name="name" placeholder="Member name" required />
            <select name="role" defaultValue="member"><option value="member">Member</option><option value="admin">Admin</option></select>
            <button type="submit">Add team member</button>
          </form>
        </section>
      </div>

      <section className="panel chat-panel">
        <p className="eyebrow">AI ASSISTANT</p><h2>Chat with your tools</h2>
        <p className="hint">The chat agent uses the same gateway and permissions as the API key you provide.</p>
        <form className="chat-form" onSubmit={chat}>
          <input type="password" value={chatKey} onChange={(event) => setChatKey(event.target.value)}
            placeholder="Your personal gateway API key" autoComplete="off" required />
          <div className="chat-input"><input value={chatMessage} onChange={(event) => setChatMessage(event.target.value)}
            placeholder="Ask about orders or request a product..." required />
            <button type="submit">Send</button></div>
        </form>
        {chatResult && <div className="chat-response"><p>{chatResult.response}</p>
          {!!chatResult.toolsCalled?.length && <div><strong>Tools called</strong>{chatResult.toolsCalled.map((tool, index) =>
            <pre key={`${tool.name}-${index}`}><code>{tool.name}\n{tool.result}</code></pre>)}</div>}
        </div>}
      </section>

      <section className="panel audit-panel">
        <div className="section-title"><div><p className="eyebrow">ACTIVITY</p><h2>Recent tool calls</h2></div></div>
        <div className="table-wrap"><table><thead><tr><th>When</th><th>User</th><th>Server</th><th>Tool</th><th>Duration</th><th>Result</th></tr></thead>
          <tbody>{audit.slice(-20).reverse().map((entry) => <tr key={entry.id}>
            <td>{new Date(entry.ts).toLocaleString()}</td><td>{entry.user}</td><td>{entry.server}</td><td>{entry.tool}</td>
            <td>{entry.durationMs} ms</td><td>{entry.status}</td>
          </tr>)}</tbody></table></div>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<Dashboard />);
