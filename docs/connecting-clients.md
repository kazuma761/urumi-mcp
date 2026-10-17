# Connecting an AI client

Everything you need is the gateway's address and your own API key. Create the key in
the dashboard under **API keys**; it is shown once. You never need any upstream
server's credentials.

Below, replace `https://app.example.com` with your gateway (locally:
`http://app.127.0.0.1.nip.io`) and `ugw_...` with your key.

| Client | Fastest way |
| --- | --- |
| Claude Code | [Plugin](#claude-code-plugin) or [one command](#claude-code-one-command) |
| Codex | [`config.toml`](#codex) with the `wook8-mcp` bridge |
| Cursor, Claude Desktop, Windsurf, any `mcp.json` client | [JSON](#cursor-claude-desktop-and-other-mcpjson-clients) |
| MCP Inspector | [Streamable HTTP](#mcp-inspector) |
| Anything that only speaks stdio | [`npx wook8-mcp connect`](#any-stdio-client) |

## Claude Code: plugin

This repository is also a Claude Code plugin marketplace. The plugin adds the gateway
as an MCP server, plus a short skill that teaches Claude the `<server>__<tool>` names
and the store's tools.

```bash
export URUMI_GATEWAY_URL=https://app.example.com
export URUMI_API_KEY=ugw_...
```

Then, inside Claude Code:

```
/plugin marketplace add kazuma761/urumi-mcp
/plugin install urumi-gateway@wook8-mcp
```

Restart Claude Code so it picks up the two environment variables. `/mcp` lists the
`urumi` server and its tools.

## Claude Code: one command

```bash
claude mcp add --transport http urumi https://app.example.com/mcp \
  --header "Authorization: Bearer ugw_..."
```

## Codex

Codex starts MCP servers as local processes, so it uses the `wook8-mcp` bridge.
Add to `~/.codex/config.toml`:

```toml
[mcp_servers.urumi]
command = "npx"
args = ["-y", "wook8-mcp", "connect"]
env = { URUMI_GATEWAY_URL = "https://app.example.com", URUMI_API_KEY = "ugw_..." }
```

## Cursor, Claude Desktop and other `mcp.json` clients

Clients that support remote servers:

```json
{
  "mcpServers": {
    "urumi": {
      "url": "https://app.example.com/mcp",
      "headers": { "Authorization": "Bearer ugw_..." }
    }
  }
}
```

Clients that only start local processes:

```json
{
  "mcpServers": {
    "urumi": {
      "command": "npx",
      "args": ["-y", "wook8-mcp", "connect"],
      "env": { "URUMI_GATEWAY_URL": "https://app.example.com", "URUMI_API_KEY": "ugw_..." }
    }
  }
}
```

## MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Transport **Streamable HTTP**, URL `https://app.example.com/mcp`, header
`Authorization: Bearer ugw_...`.

## Any stdio client

```bash
npx -y wook8-mcp connect --url https://app.example.com --key ugw_...
```

The bridge speaks MCP over stdin/stdout and forwards every request to the gateway,
so the gateway's permissions, timeouts and audit log still apply.
`npx -y wook8-mcp config --url ... --key ...` prints all of the snippets on this
page, filled in.

## What you will see

Every enabled server's tools, named `<server>__<tool>`:

```
woo__list_orders      woo__get_order       woo__create_product
woo__list_products    woo__update_order_status
everything__echo      everything__get-sum  ...
toolbox__echo         toolbox__current_time ...
```

Try:

- "What orders came in today?"
- "Create a product called Demo Hoodie priced at 999."
- "List today's orders, then use the toolbox to tell me what percent of them are completed."
  (two servers in one prompt)

If an admin disables a server, its tools disappear from your list. If your key is
revoked, the next call fails with HTTP 401.

## Using the WooCommerce MCP server without a gateway

`wook8-mcp` also runs the WooCommerce MCP server on its own, against any store. Create
a REST key in **WooCommerce → Settings → Advanced → REST API** (read/write), then:

```json
{
  "mcpServers": {
    "woocommerce": {
      "command": "npx",
      "args": ["-y", "wook8-mcp", "woo"],
      "env": {
        "WOO_URL": "https://shop.example.com",
        "WOO_CONSUMER_KEY": "ck_...",
        "WOO_CONSUMER_SECRET": "cs_...",
        "STORE_TIMEZONE": "Asia/Kolkata"
      }
    }
  }
}
```

Over HTTPS the key is sent as HTTP Basic auth; over plain HTTP it is never sent, only
an OAuth 1.0a signature made with it.
