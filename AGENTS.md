# AGENTS.md

Guide for AI coding agents and contributors working on this repository. Read it before
changing anything. Human-facing docs start at [README.md](README.md); architecture
diagrams are in [docs/architecture.md](docs/architecture.md).

## Layout

| Path | What |
| --- | --- |
| `apps/woo-mcp` | WooCommerce MCP server (Streamable HTTP; stdio via the CLI) |
| `apps/toolbox-mcp` | Small demo MCP server: header credential, colliding `echo` tool |
| `apps/gateway` | Gateway backend: upstream registry, `/mcp`, REST API, chat agent, migrations |
| `apps/dashboard` | React dashboard (Vite), served by the gateway |
| `packages/wook8-mcp` | npm CLI: stdio bridge to a gateway, standalone WooCommerce MCP |
| `plugin/`, `.claude-plugin/` | Claude Code plugin and its marketplace manifest |
| `charts/{store,upstreams,platform}` | Helm charts, one per namespace |
| `docker/` | One Dockerfile per image; build context is the repo root |
| `scripts/` | k3d config, quickstart, end-to-end check |
| `docs/` | Architecture, design, threat model, deployment, client setup, verification |

## Commands

```bash
pnpm install                 # once
make check                   # helm lint + typecheck + unit tests
./scripts/quickstart.sh      # cluster + build + install, from nothing
make up                      # rebuild changed images and upgrade the releases
make e2e                     # end-to-end checks against the running cluster
apps/gateway/dev.sh          # gateway outside the cluster, for backend/dashboard work
```

## Rules

- **Keep it small.** Take the smallest design that fully works. No abstractions, options or config "for later". Comment the
  why, never the what.
- `apps/woo-mcp` is written by us. Never install an existing WooCommerce MCP server or plugin.
- Helm only, no Kustomize. Local and production differ only through values files
  (`values-local.yaml`, `values-prod.yaml`).
- No secrets in source, charts or values files. Secrets are generated in the cluster
  by Helm (`randAlphaNum` plus `lookup` so upgrades keep them). The LLM key comes
  from a gitignored `values-secrets*.yaml`.
- Every workload has readiness and liveness probes and resource requests and limits.
- Our containers run as non-root with a read-only root filesystem and all capabilities dropped.
- **TypeScript runs directly on Node (type stripping, no build step)** for the apps
  (the published `wook8-mcp` CLI is the one bundled package): erasable syntax only (no enums, no parameter properties), relative imports
  end in `.ts`, `import type` for types. `tsc --noEmit` is the type checker.
- **Database types come from the Drizzle schema** in `apps/gateway/src/lib/schema.ts`
  (`typeof table.$inferSelect`). Narrow with `Pick`/`Omit`; never hand-write a row
  shape. No insert types where `db.insert().values()` already checks the shape.
- MCP SDK v2 packages only (`@modelcontextprotocol/server`, `/client`, `/node`),
  not the v1 `@modelcontextprotocol/sdk`. If unsure of an API, read the installed
  `.d.mts` in `node_modules` rather than guessing.
- Dependencies are pinned to exact versions. Add one with
  `pnpm --filter <app> add <pkg>@<version>` (one shared lockfile).
- New non-trivial logic gets one small test (`node --test`, files named `*.test.ts`).

## Decisions already made

Change these only with a design discussion; DESIGN.md explains each.

| Decision | Why |
| --- | --- |
| k3d locally, k3s on the VPS | Same distribution in both places: same Traefik ingress, `local-path` storage and NetworkPolicy enforcement, so "values only" differences hold. |
| Three charts, three namespaces: `store`, `upstreams`, `platform` | Each is an independently upgradable release, and the namespace is the isolation boundary the NetworkPolicies are written against. |
| The gateway serves the built dashboard | One origin (no CORS, plain cookie auth) and one fewer workload. |
| Postgres + Drizzle for gateway state | Gateway pods hold no state, so more than one replica can run. |
| Both our MCP servers and the gateway's `/mcp` are stateless (`createMcpHandler` + `toNodeHandler`) | No session lives in a pod, so any replica can answer any request. |
| Tools are always exposed as `<slug>__<tool>` | Collisions cannot happen, and a name never changes when another server is added. |
| The chat agent calls the same in-process `callTool()` as `/mcp` | One choke point for permissions and audit; the agent cannot bypass either. |
| The gateway health check is `tools/list` on a timer | One call both proves the upstream is alive and refreshes its tool cache. |
| Servers declared in Helm values are "managed" | Helm is their source of truth: re-applied on every start, can be disabled but not deleted in the dashboard. |
| `woo-mcp` uses the WooCommerce REST API, signed with OAuth 1.0a | Documented and versioned, runs WooCommerce's own validation. WooCommerce only allows Basic auth over HTTPS, and in-cluster traffic is HTTP. |
| LLM through OpenRouter (any OpenAI-compatible endpoint), default model `anthropic/claude-haiku-5.5` | One client; provider and model are values. |

## Contracts

Charts, backend and dashboard all depend on these. Change both sides together.

### Names

| Thing | Value |
| --- | --- |
| Namespaces and Helm releases | `store`, `upstreams`, `platform` (release name = namespace = chart folder name) |
| Public hosts | `store.<global.domain>`, `app.<global.domain>`; locally `global.domain` is `127.0.0.1.nip.io` |
| Services | `wordpress.store:80`, `mariadb.store:3306`, `woo-mcp.store:3000`, `everything.upstreams:3001`, `toolbox.upstreams:3000`, `gateway.platform:8080`, `postgres.platform:5432` |
| Pod label | `app.kubernetes.io/name: <component>`, one of `wordpress`, `mariadb`, `bootstrap`, `woo-mcp`, `everything`, `toolbox`, `gateway`, `postgres`. NetworkPolicies select on it. |
| Images | `urumi/woo-mcp`, `urumi/toolbox-mcp`, `urumi/gateway`, `urumi/everything`; repository and tag are values |
| Secrets in `store` | `mariadb` (`root-password`, `password`), `wordpress` (`admin-password`), `woo-rest` (`consumer-key`, `consumer-secret`), `woo-mcp` (`bearer-token`) |
| Secrets in `upstreams` | `toolbox` (`api-key`) |
| Secrets in `platform` | `postgres` (`password`), `gateway` (`admin-password`, `session-secret`, `encryption-key`, `llm-api-key`, `seed-servers`) |
| API key format | `ugw_` + 43 base64url characters |
| Exposed tool name | `<slug>__<tool>`; slug matches `^[a-z][a-z0-9-]{1,30}$` |

### Environment variables

`apps/woo-mcp` (listens on `PORT`, default 3000; `GET /healthz`; `POST /mcp` needs `Authorization: Bearer <MCP_BEARER_TOKEN>`):

| Variable | Meaning |
| --- | --- |
| `WOO_URL` | Where requests are sent, the in-cluster Service: `http://wordpress` |
| `WOO_PUBLIC_HOST` | Host (and port if not 80) of the store's public URL, e.g. `store.127.0.0.1.nip.io`. Signatures are computed for `http://<this>`, always `http`, even when the site is served over HTTPS, because TLS ends at the Ingress. |
| `WOO_CONSUMER_KEY`, `WOO_CONSUMER_SECRET` | From Secret `woo-rest` |
| `MCP_BEARER_TOKEN` | From Secret `woo-mcp` |
| `STORE_TIMEZONE` | IANA name, the same value the bootstrap Job sets in WordPress; defines "today" |
| `WOO_TIMEOUT_MS` | Optional, default 15000 |

`apps/toolbox-mcp` (port 3000; `GET /healthz`; `POST /mcp` needs header `X-Api-Key: <TOOLBOX_API_KEY>`): `PORT`, `TOOLBOX_API_KEY`.

`everything` (the MCP reference server, `@modelcontextprotocol/server-everything@2026.8.31`):
`PORT=3001`, command `node node_modules/@modelcontextprotocol/server-everything/dist/index.js streamableHttp`,
MCP at `/mcp`, no credential, probe with a TCP check.

`apps/gateway` (listens on `PORT`, default 8080; `GET /healthz` liveness; `GET /readyz` ready when Postgres answers):

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | `postgres://gateway:<password>@postgres:5432/gateway` |
| `SESSION_SECRET` | Signs dashboard cookies |
| `ENCRYPTION_KEY` | 32 random bytes, base64; encrypts upstream credentials |
| `COOKIE_SECURE` | `true` when served over HTTPS |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | First admin, created when the users table is empty |
| `SEED_SERVERS` | JSON array of managed servers, see below |
| `UPSTREAM_ALLOWED_HOSTS` | Comma-separated hosts an admin may register although they resolve to private addresses, e.g. `everything.upstreams.svc` |
| `UPSTREAM_CALL_TIMEOUT_MS`, `UPSTREAM_CONNECT_TIMEOUT_MS`, `UPSTREAM_HEALTH_INTERVAL_MS` | Optional; defaults 30000, 5000, 5000 |
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_MAX_STEPS` | Chat agent; defaults `https://openrouter.ai/api/v1`, `anthropic/claude-haiku-5.5`, empty (chat disabled), 8 |
| `DASHBOARD_DIR` | Folder with the built dashboard to serve at `/` |

`SEED_SERVERS` example (the platform chart builds it, reading the credentials from the other namespaces' Secrets with `lookup`):

```json
[
  { "slug": "woo", "name": "WooCommerce", "url": "http://woo-mcp.store.svc:3000/mcp", "authType": "bearer", "credential": "<store/woo-mcp bearer-token>" },
  { "slug": "everything", "name": "Everything", "url": "http://everything.upstreams.svc:3001/mcp", "authType": "none" },
  { "slug": "toolbox", "name": "Toolbox", "url": "http://toolbox.upstreams.svc:3000/mcp", "authType": "header", "authHeader": "X-Api-Key", "credential": "<upstreams/toolbox api-key>" }
]
```

### Gateway HTTP API (what the dashboard calls)

Same origin as the dashboard. JSON in and out. Auth is the httpOnly cookie
`urumi_session` set by login. Errors are `{ "error": "<message>" }` with a 4xx or 5xx status.
"admin" marks admin-only routes (403 otherwise).

| Route | Request | Response |
| --- | --- | --- |
| `POST /api/login` | `{ email, password }` | `{ user, chatEnabled }`; 401 on bad credentials, 429 when rate-limited |
| `POST /api/logout` | | 204 |
| `GET /api/me` | | `{ user, chatEnabled }`; 401 when not logged in |
| `POST /api/invite/accept` | `{ token, password }` (password at least 8 characters) | `{ user, chatEnabled }` and logs in |
| `GET /api/servers` | | `{ servers: Server[] }` |
| `POST /api/servers` admin | `{ slug, name, url, authType, authHeader?, credential? }` | 201 `{ server }` |
| `PATCH /api/servers/:id` admin | any of `{ name, url, authType, authHeader, credential, enabled }` | `{ server }` |
| `DELETE /api/servers/:id` admin | | 204; 409 for a managed server |
| `PUT /api/tool-access` admin | `{ tool: "<slug>__<tool>", memberAllowed: boolean }` | 204 |
| `GET /api/users` admin | | `{ users: (User & { keys: Key[] })[] }` |
| `POST /api/users` admin | `{ email, role }` | 201 `{ user, inviteToken }` |
| `POST /api/users/:id/invite` admin | | `{ inviteToken }`; a fresh token, also serves as a password reset |
| `DELETE /api/users/:id` admin | | 204; removes the member, their keys and their session. 409 for yourself |
| `GET /api/keys` | | `{ keys: Key[] }` (own keys) |
| `POST /api/keys` | `{ name, userId? }` (`userId` admin only: issue for a member) | 201 `{ key: Key, secret }`; `secret` is shown this once |
| `DELETE /api/keys/:id` | | 204; revokes (owner or admin) |
| `GET /api/audit?limit=100` | | `{ entries: AuditEntry[] }`; admins see all, members their own |
| `POST /api/chat` | `{ messages: { role: "user" \| "assistant", content: string }[] }` | stream, `application/x-ndjson`, one event per line |

```ts
type User = { id: string; email: string; role: "admin" | "member"; pending: boolean; createdAt: string };
type Key = { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };
type Server = {
  id: string; slug: string; name: string; enabled: boolean; managed: boolean;
  status: "connected" | "unreachable" | "disabled";
  // Upstream tool names without the prefix. Members only get the tools they may use.
  tools: { name: string; description: string; memberAllowed: boolean }[];
  // Admins only:
  error?: string | null; url?: string; authType?: "none" | "bearer" | "header"; authHeader?: string | null; hasCredential?: boolean;
};
type AuditEntry = {
  id: number; ts: string; userEmail: string; via: "mcp" | "chat"; server: string | null; tool: string | null;
  durationMs: number; outcome: "ok" | "error" | "timeout" | "unreachable" | "denied" | "not_found" | "rejected"; error: string | null;
};
type ChatEvent =
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; isError: boolean; text: string; durationMs: number }
  | { type: "message"; text: string }
  | { type: "error"; message: string };
```

Other facts the dashboard needs:

- The MCP endpoint to show users is `${location.origin}/mcp`, with header `Authorization: Bearer <key>`.
- The invite link is `${location.origin}/#/invite/<inviteToken>`. It lives in the URL
  fragment so the token is never sent to a server in a request line.
- Upstream credentials are write-only. No route ever returns one.
- Vite builds to `apps/dashboard/dist`. In dev, proxy `/api` and `/mcp` to `http://localhost:8080`.

## Checks

Run what applies to your change before you call it done, and say what you did not run.

```bash
pnpm install                                   # once, at the repo root
pnpm -r typecheck                              # every app
pnpm -r test                                   # node --test in every app
helm lint charts/<chart> -f charts/<chart>/values-local.yaml
helm template <release> charts/<chart> -f charts/<chart>/values-local.yaml   # read the output
kubectl --context k3d-urumi get pods -A
```

A real backend for local work (throwaway Postgres in Docker, toolbox-mcp as the one
upstream, a dead server to show "unreachable", and it serves `apps/dashboard/dist`):

```bash
apps/gateway/dev.sh            # http://localhost:8080, or PORT=8090 apps/gateway/dev.sh
apps/gateway/dev.sh stop       # stop it and drop the database
```

Login `admin@urumi.local` / `dev-admin-pw`. Chat needs `LLM_API_KEY=... apps/gateway/dev.sh`.

A quick MCP call against any of our servers (note the Accept header):

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer <token>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
