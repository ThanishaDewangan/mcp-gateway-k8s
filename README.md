# WooCommerce Team MCP Gateway on Kubernetes

This repository implements the assignment's single-store platform: a WordPress/WooCommerce store, a custom WooCommerce MCP server, a team gateway that aggregates upstream MCP servers, a React admin dashboard, and an LLM tool-calling chat agent. The services and stateful store run in Kubernetes; Helm values control local versus VPS configuration.

## Architecture and responsibilities

```text
Browser ── Ingress ── dashboard ── chat-agent ──┐
Storefront ─ Ingress ─ WordPress ─ MariaDB      ├── gateway (/mcp)
External MCP client ────────────────────────────┘       │
                                              ┌─────────┴──────────┐
                                         store-mcp            sample-mcp
                                              │                    │
                                      WooCommerce REST API    sample shipping data
```

- **WordPress/WooCommerce:** The custom WordPress image includes and activates WooCommerce. A startup script installs WordPress after MariaDB becomes ready. WordPress content and MariaDB data each have persistent volumes.
- **Store MCP (`services/store-mcp`):** An MCP server written for this project. It calls WooCommerce REST API v3 and exposes `list_products`, `create_product`, `list_orders`, `get_order`, and `update_order_status`. Its service is ClusterIP-only and a NetworkPolicy allows ingress only from the gateway.
- **Sample MCP (`services/sample-mcp`):** An optional second, internal MCP service with shipment lookup tools to demonstrate cross-server aggregation and upstream failure isolation.
- **Gateway (`services/gateway`):** Validates hashed team API keys, discovers tools from enabled upstreams, namespaces tool names as `<server-id>__<tool-name>`, routes calls, encrypts saved upstream credentials, and writes user-attributed audit entries.
- **Dashboard (`services/dashboard`):** React UI for upstream registration/status/control, team-member and API-key management, chat, and audit history. Administrative endpoints require the operator token.
- **Chat agent (`services/chat`):** Uses an OpenAI-compatible Chat Completions API for function/tool selection. It retrieves tools and performs every tool call via the gateway, using the same user API key as the chat user.

The gateway never forwards a caller's API key upstream. Upstream bearer credentials are encrypted in the gateway's persisted state using an AES-256-GCM key kept in a Kubernetes Secret. The WooCommerce REST key and secret are stored in Kubernetes Secrets and only loaded by the store MCP process.

## Local Kubernetes deployment (kind)

### Prerequisites

- Docker Desktop using its Linux container engine
- `kind`, `kubectl`, and Helm 3
- Node.js 20+ and npm (for local builds/checks)
- An OpenAI-compatible LLM API key for the chat demo

### 1. Install ingress-nginx for kind

From the repository root:

```powershell
kind create cluster --name mcp-gateway --config .\kind-config.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.12.0/deploy/static/provider/kind/deploy.yaml
kubectl wait --namespace ingress-nginx --for=condition=Ready pod --selector=app.kubernetes.io/component=controller --timeout=180s
```

The deployment script reuses that cluster if it already exists. If you do not have a cluster yet, it creates one from `kind-config.yaml`.

### 2. Build, provision Secrets, and install with Helm

```powershell
.\scripts\deploy-local.ps1
```

The script builds the MCP services and WooCommerce-enabled WordPress image, loads them into kind, generates random database/authentication/encryption credentials, creates the Kubernetes Secret, and deploys `helm/mcp-gateway` with `values-local.yaml`. It prompts for the LLM key (leave blank to set it later) and prints the initial dashboard token, WordPress admin password, and sample-MCP credential once. Save those values securely; do not commit them.

Map the local Ingress hosts in `C:\Windows\System32\drivers\etc\hosts` (edit as Administrator):

```text
127.0.0.1 dashboard.local
127.0.0.1 store.local
127.0.0.1 gateway.local
```

Open:

- Dashboard: `http://dashboard.local`
- Storefront: `http://store.local`
- External MCP endpoint: `http://gateway.local/mcp`

Paste the dashboard admin token into the dashboard's operator-token field.

### 3. Configure WooCommerce REST access

The WordPress bootstrap installs and activates WooCommerce. Sign in at `http://store.local/wp-admin` with user `store-admin` and the password emitted by the deployment script. In WooCommerce, open **Settings → Advanced → REST API**, create a read/write key, and update the Secret without replacing the other keys:

```powershell
$patch = @{
  stringData = @{
    "woocommerce-consumer-key" = "ck_..."
    "woocommerce-consumer-secret" = "cs_..."
  }
} | ConvertTo-Json -Compress
kubectl -n mcp-gateway patch secret mcp-gateway-secrets --type merge -p $patch
kubectl -n mcp-gateway rollout restart deployment/store-mcp
kubectl -n mcp-gateway rollout status deployment/store-mcp
```

Create a product in WooCommerce or through the chat tool. Use the storefront to add it to the cart and place a test order (for example, Cash on Delivery). The resulting order is returned by `list_orders` and visible in the WooCommerce admin.

### 4. Invite users, connect the second MCP server, and run the demo

1. In the dashboard, issue a key for **User A**. For **User B**, invite a member and send their one-time user ID and enrollment token securely; the member redeems it in the dashboard to generate their own key. Keys are displayed once and stored as hashes.
2. Register the sample MCP server in the dashboard:
   - Stable ID: `sample-mcp`
   - Name: `Sample Shipping`
   - URL: `http://sample-mcp:3005/mcp`
   - Credential: the sample-MCP credential printed by the deployment script
3. Ask the dashboard chat (with User A's API key) to create a named product with a price. The LLM should call `woocommerce__create_product`; confirm it appears on the storefront.
4. Place an order for it from the storefront, then ask: “What orders came in today?” The LLM can call `woocommerce__list_orders` with today's UTC `after`/`before` range.
5. Connect an external client as User B using only the gateway URL and User B's bearer key. The client's visible tools include both `woocommerce__...` and `sample-mcp__...`.
6. Ask an external client prompt requiring store and shipping data (for example, “List products and look up shipment UR-1001”). The tools route to two separate upstream services and both calls appear in the audit log under User B.
7. Revoke User B's key in the dashboard; the next gateway request with that key returns HTTP 401. Disable the sample server and confirm its tools disappear. Delete the sample MCP pod and refresh status to see `Unreachable`; WooCommerce tools remain available.

Example Claude Code remote MCP server configuration (adjust to the client version's supported HTTP transport):

```json
{
  "mcpServers": {
    "team-gateway": {
      "type": "http",
      "url": "http://gateway.local/mcp",
      "headers": {
        "Authorization": "Bearer <USER_B_API_KEY>"
      }
    }
  }
}
```

The same URL/key pair can be used with MCP Inspector or another Streamable HTTP MCP client. Do not configure the upstream MCP URLs or credentials in the external client.

## Local development without Kubernetes

Install dependencies and run the test fixture services in four terminals. The in-memory store backend is intended only for development smoke tests; it is not a replacement for WooCommerce.

```powershell
npm install
$env:PORT="3001"; $env:STORE_BACKEND="memory"; npm run start:store
```

In the other terminals:

```powershell
$env:PORT="3002"; $env:UPSTREAM_MCP_URL="http://localhost:3001/mcp"; $env:DASHBOARD_ADMIN_TOKEN="<local-admin-token>"; npm run start:gateway
$env:PORT="3003"; $env:GATEWAY_URL="http://localhost:3002"; $env:CHAT_AGENT_URL="http://localhost:3004"; $env:DASHBOARD_ADMIN_TOKEN="<same-local-admin-token>"; npm run start:dashboard
$env:PORT="3004"; $env:GATEWAY_URL="http://localhost:3002"; $env:LLM_API_KEY="<provider-key>"; npm run start:chat
```

For a local gateway upstream with a non-empty credential, also set `STORE_MCP_AUTH_TOKEN` in both the store-MCP and gateway processes and set a stable `CREDENTIALS_ENCRYPTION_KEY` (base64 encoding of 32 random bytes) in the gateway process before it first initializes its state.

Run syntax checks and build the React assets:

```powershell
npm run check
npm test
npm run build
```

## Production-like k3s deployment

Build and push the application and WooCommerce images to a registry reachable by the VPS. Change the image repository/tag in `values-prod.yaml`. Create `mcp-gateway-secrets` in the target namespace with these keys:

- `credentials-encryption-key`: base64-encoded random 32-byte key
- `dashboard-admin-token`: long random operator token
- `store-mcp-auth-token`, `sample-mcp-auth-token`: independent random bearer tokens
- `mariadb-password`, `mariadb-root-password`, `wordpress-admin-password`
- `llm-api-key`
- `woocommerce-consumer-key`, `woocommerce-consumer-secret`

Then deploy the same chart:

```sh
helm upgrade --install mcp-gateway ./helm/mcp-gateway \
  --namespace mcp-gateway --create-namespace \
  --values ./helm/mcp-gateway/values-prod.yaml
```

Change only image references, DNS/Ingress class, storage class/capacity, TLS configuration, and Secret contents for the VPS. The sample `local-path` storage class suits a single-node k3s demonstration; choose a production storage class with tested backups and restore procedures for real use. Configure DNS for `shop.example.com`, `mcp.example.com`, and `dashboard.example.com`. `values-prod.yaml` references existing TLS Secrets for those hosts; create them with cert-manager or another certificate process before using the HTTPS store URL.

## Operations

- Inspect: `kubectl -n mcp-gateway get pods,svc,ingress,pvc`
- Logs: `kubectl -n mcp-gateway logs deploy/gateway` (or another deployment)
- Kill a sample upstream: `kubectl -n mcp-gateway delete pod -l app.kubernetes.io/name=sample-mcp`
- Upgrade: rebuild/push images, update `values-prod.yaml`, then run `helm upgrade --install ...`.
- Roll back: `helm -n mcp-gateway history mcp-gateway`, then `helm -n mcp-gateway rollback mcp-gateway <revision>`. Back up MariaDB and WordPress volumes before data/schema changes; Helm rollback does not reverse database migrations or restore volume data.

## System design and trade-offs

- The gateway discovers tools at request time, prefixes tool names with server IDs to avoid collisions, and routes based on that prefix. Failed upstream discovery returns an empty tool set for only that server, not a fabricated successful tool result. The dashboard actively probes upstreams and reports `Connected`, `Unreachable`, or `Disabled`.
- Gateway state, users, and audit JSON are persisted on a PVC and shared by the gateway and dashboard (one replica each). This keeps the demonstration easy to inspect but is not a high-availability database; concurrent writes and scaling require a transactional database.
- The store MCP server uses WooCommerce REST API v3 with a read/write WooCommerce key because product/order operations include writes. The WooCommerce plugin is packaged in the image and the store is initialized automatically; API credentials are created separately in the admin and placed into a Secret.
- The sample shipping MCP is a second independent service for demonstrating aggregation and pod-failure isolation. Remove it for a single-source deployment if it is not needed.
- The OpenAI-compatible model/provider are configurable through environment/Helm values. The LLM key remains server-side. The model chooses calls; the gateway remains the authorization/audit/routing boundary.

## Threat model and controls

- **Shared upstream credentials:** Team members can invoke only the operations exposed by upstream tools; credentials remain in Kubernetes Secrets or AES-GCM encrypted gateway state and are never returned by dashboard APIs.
- **Client tokens:** API keys are generated with cryptographically secure randomness, stored as SHA-256 hashes, compared in constant time, revocable, and not sent to upstream MCP servers.
- **Control-plane routes:** Server/team/audit management endpoints require the operator token. The admin token is kept in a Kubernetes Secret and should be rotated if disclosed.
- **Upstream isolation:** Store MCP and sample MCP use ClusterIP Services. A NetworkPolicy restricts store-MCP ingress to the gateway pods. The gateway validates URL schemes and disallows embedded URL credentials; administrators must register only trusted upstreams because arbitrary user-supplied endpoints can otherwise create SSRF risk.
- **Untrusted tool results:** Tool output is returned as data to the LLM/client, not executed as code. Review model-generated write operations and keep upstream credentials least-privileged.
- **Remaining production hardening:** Replace JSON state with a transactional database, add per-role/tool authorization, TLS/secure session handling, rate limits, stricter DNS/IP egress controls for upstream URLs, secret rotation procedures, and centralized/retained audit storage.

## Assignment scope and optional bonuses

Implemented core flows include one WooCommerce store, two MCP servers, one aggregated authenticated endpoint, React dashboard controls, API-key issue/revocation, LLM-backed gateway tool calls, audit attribution, Helm local/prod values, health probes, resource requests/limits, Secrets, and persistent store state. Optional per-tool role permissions, OAuth, multi-store provisioning, and large-tool-set filtering are not implemented.
