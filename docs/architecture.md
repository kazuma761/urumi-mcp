# Architecture

Diagrams of how the pieces fit and how a request moves through them. The reasoning
behind each choice is in [DESIGN.md](DESIGN.md); the security view is in
[THREAT_MODEL.md](THREAT_MODEL.md).

- [System overview](#system-overview)
- [Kubernetes topology](#kubernetes-topology)
- [A tool call, end to end](#a-tool-call-end-to-end)
- [How the gateway decides](#how-the-gateway-decides)
- [The chat agent's loop](#the-chat-agents-loop)
- [When an upstream dies](#when-an-upstream-dies)
- [Onboarding a teammate](#onboarding-a-teammate)
- [Where each credential stops](#where-each-credential-stops)
- [Data model](#data-model)

## System overview

```mermaid
flowchart LR
  subgraph people["People"]
    shopper["Shopper"]
    admin["Admin"]
    member["Team member"]
  end
  subgraph clients["MCP clients"]
    cc["Claude Code / Cursor / Codex"]
  end

  ingress["Traefik Ingress<br/>store.domain · app.domain"]

  subgraph cluster["Kubernetes"]
    subgraph store["namespace: store"]
      wp["WordPress + WooCommerce"]
      db[("MariaDB")]
      woo["woo-mcp<br/>our MCP server"]
    end
    subgraph platform["namespace: platform"]
      gw["gateway<br/>dashboard · /api · /mcp · chat agent"]
      pg[("Postgres")]
    end
    subgraph upstreams["namespace: upstreams"]
      ev["everything<br/>MCP reference server"]
      tb["toolbox<br/>demo MCP server"]
    end
  end

  llm["Model provider<br/>OpenAI-compatible"]

  shopper --> ingress
  admin --> ingress
  member --> ingress
  cc -- "one URL + personal API key" --> ingress
  ingress --> wp
  ingress --> gw
  gw --> pg
  gw -- "MCP + bearer token" --> woo
  gw -- "MCP" --> ev
  gw -- "MCP + X-Api-Key" --> tb
  gw -- "chat completions" --> llm
  woo -- "REST, OAuth 1.0a signed" --> wp
  wp --> db
```

| Piece | Code | What it does |
| --- | --- | --- |
| WordPress + WooCommerce | [`charts/store`](../charts/store) | The shop. A WP-CLI Job installs and configures it. |
| woo-mcp | [`apps/woo-mcp`](../apps/woo-mcp) | Five tools over the store's REST API. Internal only. |
| gateway | [`apps/gateway`](../apps/gateway) | Upstream registry, `/mcp`, dashboard API, audit log, chat agent. |
| dashboard | [`apps/dashboard`](../apps/dashboard) | React app, served by the gateway. |
| everything, toolbox | [`charts/upstreams`](../charts/upstreams) | Two more upstreams, one with a header credential and a colliding tool name. |
| urumi-mcp CLI | [`packages/urumi-mcp`](../packages/urumi-mcp) | Bridges any stdio MCP client to a gateway; runs woo-mcp on its own. |

## Kubernetes topology

Every namespace denies all traffic by default. The arrows are the only paths a
NetworkPolicy allows.

```mermaid
flowchart TB
  internet(("Internet"))
  subgraph ks["kube-system"]
    traefik["Traefik"]
    dns["CoreDNS"]
  end
  subgraph st["store"]
    wp["wordpress<br/>Deployment · PVC 2–10 Gi"]
    maria[("mariadb<br/>StatefulSet · PVC")]
    boot["bootstrap Job<br/>WP-CLI"]
    woomcp["woo-mcp<br/>ClusterIP, no Ingress"]
  end
  subgraph pf["platform"]
    gateway["gateway<br/>Deployment, stateless"]
    postgres[("postgres<br/>StatefulSet · PVC")]
  end
  subgraph up["upstreams"]
    everything["everything"]
    toolbox["toolbox"]
  end

  internet --> traefik
  traefik --> wp
  traefik --> gateway
  wp --> maria
  boot --> maria
  woomcp --> wp
  gateway --> postgres
  gateway --> woomcp
  gateway --> everything
  gateway --> toolbox
  gateway -. "443 to public addresses only" .-> internet
  boot -. "downloads WooCommerce" .-> internet
```

| Workload | Kind | Probes | Runs as |
| --- | --- | --- | --- |
| mariadb | StatefulSet + PVC | `healthcheck.sh` connect / InnoDB ready | uid 999, no capabilities |
| wordpress | Deployment (`Recreate`) + PVC | startup TCP, ready `GET /wp-login.php`, live TCP | image default (Apache drops to www-data) |
| bootstrap | Job (Helm hook) | n/a, runs to completion | uid 33 |
| woo-mcp | Deployment | `GET /healthz` | uid 1000, read-only root, no capabilities |
| gateway | Deployment | ready `GET /readyz` (Postgres), live `GET /healthz` | uid 1000, read-only root, no capabilities |
| postgres | StatefulSet + PVC | `pg_isready` | uid 70, no capabilities |
| everything, toolbox | Deployment | TCP | uid 1000, read-only root, no capabilities |

## A tool call, end to end

A member asks Claude Code "what orders came in today?".

```mermaid
sequenceDiagram
  autonumber
  actor M as Member
  participant C as Claude Code
  participant T as Traefik
  participant G as gateway
  participant DB as Postgres
  participant W as woo-mcp
  participant S as WooCommerce

  M->>C: what orders came in today?
  C->>T: POST app.domain/mcp · Bearer ugw_…
  T->>G: forward
  G->>DB: look up SHA-256(key) · revoked?
  DB-->>G: user, role
  Note over G: split woo__list_orders → server woo, tool list_orders<br/>enabled? allowed for role? connected? tool exists?
  G->>W: tools/call list_orders {date: today} · gateway's own token
  W->>S: GET /wp-json/wc/v3/orders · OAuth 1.0a signature
  S-->>W: orders JSON
  W-->>G: {total, orders: [...]}
  G->>DB: audit row: user · woo · list_orders · 182 ms · ok
  G-->>C: result
  C-->>M: "One order today: #18, ₹249"
```

The audit row is written before the result is returned, so a client never gets a
result that is not in the log.

## How the gateway decides

Every call, from an MCP client or from the chat agent, goes through the same function
([`gateway.ts`](../apps/gateway/src/gateway.ts)).

```mermaid
flowchart TD
  start(["tools/call server__tool"]) --> key{"API key valid<br/>and not revoked?"}
  key -- no --> r401["HTTP 401<br/>audit: rejected"]
  key -- yes --> exists{"server exists<br/>and enabled?"}
  exists -- no --> nf["Tool is not available<br/>audit: not_found"]
  exists -- yes --> perm{"member and the tool<br/>is admin-only?"}
  perm -- yes --> denied["You are not allowed to use it<br/>audit: denied"]
  perm -- no --> up{"server connected?"}
  up -- no --> unreach["Server is unreachable<br/>audit: unreachable"]
  up -- yes --> has{"tool in its<br/>cached list?"}
  has -- no --> nf
  has -- yes --> invoke["call upstream<br/>with its own credential"]
  invoke --> res{"answer within 30 s?"}
  res -- "no" --> timeout["did not respond within 30s<br/>audit: timeout"]
  res -- "tool error" --> err["upstream's error<br/>audit: error"]
  res -- "ok" --> ok["result<br/>audit: ok"]
```

## The chat agent's loop

```mermaid
sequenceDiagram
  autonumber
  actor U as Logged-in user
  participant D as Dashboard
  participant G as gateway /api/chat
  participant L as Model provider
  participant X as callTool()

  U->>D: Create a product called Demo Hoodie at 999
  D->>G: POST /api/chat (session cookie)
  G->>G: list tools this user may use, right now
  loop until the model answers, at most 8 steps
    G->>L: conversation + tool definitions
    L-->>G: call woo__create_product {...}
    G-->>D: event: tool_call
    G->>X: same path as /mcp, as this user, via = chat
    X-->>G: result (audited)
    G-->>D: event: tool_result + duration
    G->>L: tool result
  end
  L-->>G: final answer
  G-->>D: event: message
```

The agent never gets its own credentials or a separate path: it calls the same
function as an external client, so permissions and the audit log apply unchanged.

## When an upstream dies

```mermaid
sequenceDiagram
  participant G as gateway
  participant E as everything (pod)
  participant K as Kubernetes
  participant B as other upstreams

  loop every 5 s
    G->>E: tools/list (health check + cache refresh)
    E-->>G: tools
  end
  K->>E: pod deleted
  G->>E: tools/list
  E--xG: connection refused
  Note over G: everything → Unreachable<br/>its tools leave every tool list
  G->>B: calls to other servers keep working
  K->>E: replacement pod starts
  G->>E: connect + tools/list
  E-->>G: tools
  Note over G: everything → Connected<br/>its tools are back
```

Listing never waits on an upstream: `tools/list` is served from the cache of the
servers that are connected right now.

## Onboarding a teammate

```mermaid
sequenceDiagram
  actor A as Admin
  actor M as Member
  participant D as Dashboard
  participant G as gateway
  participant C as Member's MCP client

  A->>D: Users → invite member@team.com
  D->>G: POST /api/users
  G-->>D: single-use invite link
  A->>M: sends the link
  M->>D: opens link, sets a password
  M->>D: API keys → Generate
  G-->>D: ugw_… shown once (only its hash is stored)
  M->>C: claude mcp add --transport http urumi https://app.domain/mcp --header "Authorization: Bearer ugw_…"
  C->>G: tools/list
  G-->>C: every enabled server's tools, as woo__…, toolbox__…
```

## Where each credential stops

```mermaid
flowchart LR
  subgraph client["Member's machine"]
    k1["API key ugw_…"]
  end
  subgraph gwbox["gateway"]
    k2["woo-mcp bearer token<br/>AES-256-GCM in Postgres"]
  end
  subgraph woobox["woo-mcp"]
    k3["WooCommerce consumer secret<br/>Kubernetes Secret"]
  end
  store["WooCommerce"]

  k1 -- "stops here" --> gwbox
  k2 -- "stops here" --> woobox
  k3 -- "only an HMAC signature travels" --> store
```

No credential travels further than the hop it was issued for, and no client token
is ever forwarded to an upstream.

## Data model

Gateway state in Postgres ([`schema.ts`](../apps/gateway/src/lib/schema.ts), migrations
in [`apps/gateway/drizzle`](../apps/gateway/drizzle)).

```mermaid
erDiagram
  users ||--o{ api_keys : owns
  users ||--o{ audit_log : "made (set null on delete)"
  users {
    uuid id PK
    text email UK
    text role "admin | member"
    text password_hash "scrypt, null until invite accepted"
    text invite_hash "SHA-256 of pending invite"
  }
  api_keys {
    uuid id PK
    uuid user_id FK
    text prefix "shown in the UI"
    text key_hash UK "SHA-256 of the key"
    timestamptz revoked_at
  }
  servers {
    uuid id PK
    text slug UK "tool prefix"
    text url
    text auth_type "none | bearer | header"
    text credential_enc "AES-256-GCM"
    bool enabled
    bool managed "declared in Helm values"
  }
  audit_log {
    serial id PK
    timestamptz ts
    text user_email
    text via "mcp | chat"
    text server
    text tool
    int duration_ms
    text outcome
  }
  member_denied_tools {
    text tool PK "slug__tool"
  }
```
